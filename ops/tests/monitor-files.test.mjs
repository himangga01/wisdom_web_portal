import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNormalizedAbsolutePath,
  assertSecureRealDirectory,
  assertSecureRegularFile,
  clearProtectedIncidentState,
  hashSecureRegularFile,
  loadProtectedIncidentState,
  readProtectedConfigFile,
  readSecureRegularFile,
  writeProtectedIncidentState,
} from "../lib/monitor-files.mjs";

async function fixture(t) {
  const created = await mkdtemp(path.join(os.tmpdir(), "wisdom-monitor-files-"));
  const root = await realpath(created);
  if (process.platform !== "win32") await chmod(root, 0o700);
  t.after(async () => rm(root, { force: true, recursive: true }));
  return root;
}

async function createSymlinkOrSkip(t, target, link, type) {
  try {
    await symlink(target, link, process.platform === "win32" && type === "dir" ? "junction" : type);
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip(`symbolic links are unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test("normalized absolute paths reject relative and lexical aliases", () => {
  const root = path.parse(process.cwd()).root;
  const canonical = path.join(root, "fixture", "monitor.json");
  assert.equal(assertNormalizedAbsolutePath(canonical, "MONITOR_PATH_INVALID"), canonical);
  assert.throws(
    () => assertNormalizedAbsolutePath("monitor.json", "MONITOR_PATH_INVALID"),
    { code: "MONITOR_PATH_INVALID" },
  );
  assert.throws(
    () => assertNormalizedAbsolutePath(
      `${path.join(root, "fixture")}${path.sep}..${path.sep}monitor.json`,
      "MONITOR_PATH_INVALID",
    ),
    { code: "MONITOR_PATH_INVALID" },
  );
});

test("protected config rejects a file larger than 64 KiB before parsing or returning content", async (t) => {
  const root = await fixture(t);
  const configPath = path.join(root, "monitoring.json");
  await writeFile(configPath, Buffer.alloc(64 * 1024 + 1, 0x7b), { mode: 0o600 });

  await assert.rejects(readProtectedConfigFile(configPath), (error) => {
    assert.equal(error.code, "MONITOR_CONFIG_PATH_INVALID");
    assert.doesNotMatch(error.message, /\{+/u);
    return true;
  });
});

test("protected config reads a bounded protected regular file", async (t) => {
  const root = await fixture(t);
  const configPath = path.join(root, "monitoring.json");
  const source = "{\"schemaVersion\":1}\n";
  await writeFile(configPath, source, { mode: 0o600 });

  assert.equal(await readProtectedConfigFile(configPath), source);
});

test("protected config rejects a final symbolic link", async (t) => {
  const root = await fixture(t);
  const realDirectory = path.join(root, "real");
  await mkdir(realDirectory, { mode: 0o700 });
  const realConfig = path.join(realDirectory, "monitoring.json");
  await writeFile(realConfig, "{}\n", { mode: 0o600 });

  const finalLink = path.join(root, "config-link.json");
  if (!await createSymlinkOrSkip(t, realConfig, finalLink, "file")) return;
  await assert.rejects(readProtectedConfigFile(finalLink), { code: "MONITOR_CONFIG_PATH_INVALID" });
});

test("protected config rejects a linked parent", async (t) => {
  const root = await fixture(t);
  const realDirectory = path.join(root, "real");
  await mkdir(realDirectory, { mode: 0o700 });
  await writeFile(path.join(realDirectory, "monitoring.json"), "{}\n", { mode: 0o600 });
  const parentLink = path.join(root, "linked-parent");
  if (!await createSymlinkOrSkip(t, realDirectory, parentLink, "dir")) return;
  await assert.rejects(
    readProtectedConfigFile(path.join(parentLink, "monitoring.json")),
    { code: "MONITOR_CONFIG_PATH_INVALID" },
  );
});

test("secure directory validation rejects non-directories", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "data");
  const regularFile = path.join(root, "file.db");
  await mkdir(directory, { mode: 0o700 });
  await writeFile(regularFile, "db", { mode: 0o600 });

  assert.equal(
    await assertSecureRealDirectory(directory, { code: "MONITOR_DIRECTORY_INVALID" }),
    directory,
  );
  await assert.rejects(
    assertSecureRealDirectory(regularFile, { code: "MONITOR_DIRECTORY_INVALID" }),
    { code: "MONITOR_DIRECTORY_INVALID" },
  );
});

test("secure directory validation rejects a canonical alias", async (t) => {
  const root = await fixture(t);
  const directory = path.join(root, "data");
  await mkdir(directory, { mode: 0o700 });
  const alias = path.join(root, "data-alias");
  if (!await createSymlinkOrSkip(t, directory, alias, "dir")) return;
  await assert.rejects(
    assertSecureRealDirectory(alias, { code: "MONITOR_DIRECTORY_INVALID" }),
    { code: "MONITOR_DIRECTORY_INVALID" },
  );
});

test("secure regular file validation accepts files and rejects directories", async (t) => {
  const root = await fixture(t);
  const data = path.join(root, "data");
  const database = path.join(data, "control.sqlite");
  await mkdir(data, { mode: 0o700 });
  await writeFile(database, "fixture", { mode: 0o600 });

  assert.deepEqual(
    await assertSecureRegularFile(database, { code: "MONITOR_DATABASE_INVALID" }),
    { canonicalPath: database, size: 7 },
  );
  await assert.rejects(
    assertSecureRegularFile(data, { code: "MONITOR_DATABASE_INVALID" }),
    { code: "MONITOR_DATABASE_INVALID" },
  );
});

test("secure regular file validation rejects a final link", async (t) => {
  const root = await fixture(t);
  const database = path.join(root, "control.sqlite");
  await writeFile(database, "fixture", { mode: 0o600 });
  const finalLink = path.join(root, "database-link.sqlite");
  if (!await createSymlinkOrSkip(t, database, finalLink, "file")) return;
  await assert.rejects(
    assertSecureRegularFile(finalLink, { code: "MONITOR_DATABASE_INVALID" }),
    { code: "MONITOR_DATABASE_INVALID" },
  );
});

test("secure regular file validation rejects a linked parent", async (t) => {
  const root = await fixture(t);
  const data = path.join(root, "data");
  await mkdir(data, { mode: 0o700 });
  await writeFile(path.join(data, "control.sqlite"), "fixture", { mode: 0o600 });
  const parentLink = path.join(root, "data-link");
  if (!await createSymlinkOrSkip(t, data, parentLink, "dir")) return;
  await assert.rejects(
    assertSecureRegularFile(path.join(parentLink, "control.sqlite"), { code: "MONITOR_DATABASE_INVALID" }),
    { code: "MONITOR_DATABASE_INVALID" },
  );
});

test("secure bounded read and hash keep file access within explicit limits", async (t) => {
  const root = await fixture(t);
  const artifactPath = path.join(root, "hourly.age");
  const content = Buffer.from("encrypted-backup-fixture", "utf8");
  await writeFile(artifactPath, content, { mode: 0o600 });

  assert.deepEqual(await readSecureRegularFile(artifactPath, {
    code: "MONITOR_BACKUP_INVALID",
    maxBytes: content.length,
  }), content);
  assert.deepEqual(await hashSecureRegularFile(artifactPath, {
    code: "MONITOR_BACKUP_INVALID",
    maxBytes: content.length,
  }), {
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  });
  await assert.rejects(
    readSecureRegularFile(artifactPath, { code: "MONITOR_BACKUP_INVALID", maxBytes: content.length - 1 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
  await assert.rejects(
    hashSecureRegularFile(artifactPath, { code: "MONITOR_BACKUP_INVALID", maxBytes: content.length - 1 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
});

test("secure bounded read and hash reject a linked parent", async (t) => {
  const root = await fixture(t);
  const realDirectory = path.join(root, "real");
  const artifactPath = path.join(realDirectory, "hourly.age");
  await mkdir(realDirectory, { mode: 0o700 });
  await writeFile(artifactPath, "fixture", { mode: 0o600 });
  const linkedParent = path.join(root, "linked-parent");
  if (!await createSymlinkOrSkip(t, realDirectory, linkedParent, "dir")) return;
  const aliasedArtifact = path.join(linkedParent, "hourly.age");

  await assert.rejects(
    readSecureRegularFile(aliasedArtifact, { code: "MONITOR_BACKUP_INVALID", maxBytes: 64 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
  await assert.rejects(
    hashSecureRegularFile(aliasedArtifact, { code: "MONITOR_BACKUP_INVALID", maxBytes: 64 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
});

test("secure bounded read and hash reject a final symbolic link", async (t) => {
  const root = await fixture(t);
  const artifactPath = path.join(root, "hourly.age");
  const linkedArtifact = path.join(root, "linked-hourly.age");
  await writeFile(artifactPath, "fixture", { mode: 0o600 });
  if (!await createSymlinkOrSkip(t, artifactPath, linkedArtifact, "file")) return;

  await assert.rejects(
    readSecureRegularFile(linkedArtifact, { code: "MONITOR_BACKUP_INVALID", maxBytes: 64 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
  await assert.rejects(
    hashSecureRegularFile(linkedArtifact, { code: "MONITOR_BACKUP_INVALID", maxBytes: 64 }),
    { code: "MONITOR_BACKUP_INVALID" },
  );
});

test("incident state is written atomically with protected permissions, loaded, and cleared", async (t) => {
  const root = await fixture(t);
  const statePath = path.join(root, "monitor-incident-state.json");
  const value = {
    formatVersion: 1,
    fingerprint: "a".repeat(64),
    lastSentAt: "2026-07-16T01:02:03.000Z",
  };

  await writeProtectedIncidentState(statePath, value);
  assert.deepEqual(await loadProtectedIncidentState(statePath), value);
  const replacement = { ...value, fingerprint: "b".repeat(64) };
  await writeProtectedIncidentState(statePath, replacement);
  assert.deepEqual(await loadProtectedIncidentState(statePath), replacement);
  const metadata = await lstat(statePath);
  assert.equal(metadata.isFile(), true);
  if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal((await readFile(statePath, "utf8")).endsWith("\n"), true);
  assert.equal(await clearProtectedIncidentState(statePath), true);
  assert.equal(await loadProtectedIncidentState(statePath), undefined);
  assert.equal(await clearProtectedIncidentState(statePath), false);
});

test("incident state rejects a final symlink without changing its target", async (t) => {
  const root = await fixture(t);
  const protectedDirectory = path.join(root, "protected");
  await mkdir(protectedDirectory, { mode: 0o700 });
  const statePath = path.join(protectedDirectory, "monitor-state.json");
  const outside = path.join(root, "outside.json");
  await writeFile(outside, "outside", { mode: 0o600 });

  if (!await createSymlinkOrSkip(t, outside, statePath, "file")) return;
  await assert.rejects(
    writeProtectedIncidentState(statePath, { formatVersion: 1 }),
    { code: "MONITOR_INCIDENT_STATE_INVALID" },
  );
  assert.equal(await readFile(outside, "utf8"), "outside");
});

test("incident state rejects a linked parent", async (t) => {
  const root = await fixture(t);
  const protectedDirectory = path.join(root, "protected");
  await mkdir(protectedDirectory, { mode: 0o700 });
  const linkedParent = path.join(root, "linked-protected");
  if (!await createSymlinkOrSkip(t, protectedDirectory, linkedParent, "dir")) return;
  await assert.rejects(
    writeProtectedIncidentState(path.join(linkedParent, "monitor-state.json"), { formatVersion: 1 }),
    { code: "MONITOR_INCIDENT_STATE_INVALID" },
  );
});

test("incident state load rejects a parent directory swapped after validation", async (t) => {
  const root = await fixture(t);
  const parent = path.join(root, "state");
  const replacement = path.join(root, "replacement");
  const moved = path.join(root, "state-original");
  await mkdir(parent, { mode: 0o700 });
  await mkdir(replacement, { mode: 0o700 });
  const original = { formatVersion: 1, fingerprint: "a".repeat(64), lastSentAt: "2026-07-16T01:00:00.000Z" };
  const injected = { ...original, fingerprint: "b".repeat(64) };
  await writeFile(path.join(parent, "incident.json"), JSON.stringify(original), { mode: 0o600 });
  await writeFile(path.join(replacement, "incident.json"), JSON.stringify(injected), { mode: 0o600 });

  await assert.rejects(loadProtectedIncidentState(path.join(parent, "incident.json"), {
    beforeRead: async () => {
      await rename(parent, moved);
      await rename(replacement, parent);
    },
  }), { code: "MONITOR_INCIDENT_STATE_INVALID" });
});

test("incident state rejects oversized JSON", async (t) => {
  const root = await fixture(t);
  const statePath = path.join(root, "monitor-state.json");
  await assert.rejects(
    writeProtectedIncidentState(statePath, { payload: "x".repeat(5_000) }),
    { code: "MONITOR_INCIDENT_STATE_INVALID" },
  );
});

test("incident state fails closed for permissive existing state files", async (t) => {
  const root = await fixture(t);
  const statePath = path.join(root, "monitor-state.json");
  await writeFile(statePath, "{\"formatVersion\":1}\n", { mode: 0o600 });
  if (process.platform === "win32") {
    t.skip("POSIX permission checks do not apply on Windows");
    return;
  }
  await chmod(statePath, 0o644);

  await assert.rejects(
    loadProtectedIncidentState(statePath),
    { code: "MONITOR_INCIDENT_STATE_INVALID" },
  );
  await assert.rejects(
    clearProtectedIncidentState(statePath),
    { code: "MONITOR_INCIDENT_STATE_INVALID" },
  );
});
