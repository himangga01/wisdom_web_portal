import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupRunStateOpenFlags, readBackupRunState } from "./run-state.js";

const verifiedState = {
  formatVersion: 1,
  runId: "00000000-0000-4000-8000-000000000702",
  startedAt: "2026-07-17T04:00:00.000Z",
  finishedAt: "2026-07-17T04:00:03.000Z",
  outcome: "verified",
  controlRevision: 2,
  lastVerifiedAt: "2026-07-17T04:00:03.000Z",
  lastVerifiedArtifact: "hourly-20260717T040000Z.age",
  errorCode: null,
} as const;

function writeOwnerOnly(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

async function expectInvalid(path: string, forbidden: readonly string[] = []): Promise<void> {
  let failure: unknown;
  try {
    await readBackupRunState(path);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    code: "BACKUP_RUN_STATE_INVALID",
    message: "Backup run state is invalid",
  });
  const message = failure instanceof Error ? failure.message : String(failure);
  expect(message).not.toContain(path);
  for (const value of forbidden) expect(message).not.toContain(value);
}

describe("protected backup run-state reader", () => {
  let root: string;
  let statePath: string;

  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), "wisdom-backup-run-state-"));
    statePath = join(root, "backup-run-state.json");
    writeOwnerOnly(statePath, JSON.stringify(verifiedState));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("opens POSIX paths with no-follow and nonblocking flags", () => {
    const posixConstants = {
      O_RDONLY: 0,
      O_NOFOLLOW: 0x100,
      O_NONBLOCK: 0x200,
    };

    expect(backupRunStateOpenFlags("darwin", posixConstants)).toBe(0x300);
    expect(backupRunStateOpenFlags("linux", posixConstants)).toBe(0x300);
    expect(backupRunStateOpenFlags("win32", posixConstants)).toBe(0);
  });

  it("reads a bounded owner-only regular-file observation", async () => {
    await expect(readBackupRunState(statePath)).resolves.toMatchObject({ outcome: "verified" });
  });

  it("returns no observation when the file is absent", async () => {
    const missingPath = join(root, "missing.json");

    await expect(readBackupRunState(missingPath)).resolves.toBeUndefined();
  });

  it("rejects non-absolute paths", async () => {
    await expectInvalid("backup-run-state.json");
  });

  it("rejects a final symlink or junction", async () => {
    const target = join(root, process.platform === "win32" ? "target-directory" : "target.json");
    const linked = join(root, "linked-state.json");
    if (process.platform === "win32") {
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, linked, "junction");
    } else {
      writeOwnerOnly(target, JSON.stringify(verifiedState));
      symlinkSync(target, linked, "file");
    }

    await expectInvalid(linked);
  });

  it("rejects a linked parent directory", async () => {
    const actualParent = join(root, "actual-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(actualParent, { mode: 0o700 });
    writeOwnerOnly(join(actualParent, "state.json"), JSON.stringify(verifiedState));
    symlinkSync(actualParent, linkedParent, process.platform === "win32" ? "junction" : "dir");

    await expectInvalid(join(linkedParent, "state.json"));
  });

  it("rejects non-regular files", async () => {
    const directoryPath = join(root, "state-directory");
    mkdirSync(directoryPath, { mode: 0o700 });

    await expectInvalid(directoryPath);
  });

  it("rejects observations over 4 KiB", async () => {
    const oversizedPath = join(root, "oversized.json");
    writeOwnerOnly(oversizedPath, "x".repeat(4_097));

    await expect(readBackupRunState(oversizedPath)).rejects.toMatchObject({
      code: "BACKUP_RUN_STATE_INVALID",
    });
    await expectInvalid(oversizedPath, ["x".repeat(64)]);
  });

  it.skipIf(process.platform === "win32")("rejects permissive POSIX modes", async () => {
    chmodSync(statePath, 0o640);

    await expectInvalid(statePath);
  });

  it("rejects malformed JSON without exposing source content", async () => {
    const sourceContent = '{"private":"AGE-SECRET-KEY-DO-NOT-LEAK"';
    writeOwnerOnly(statePath, sourceContent);

    await expectInvalid(statePath, [sourceContent, "AGE-SECRET-KEY-DO-NOT-LEAK"]);
  });

  it("rejects schema-invalid JSON without exposing source content", async () => {
    const sourceContent = JSON.stringify({
      ...verifiedState,
      lastVerifiedArtifact: "C:\\private\\hourly-20260717T040000Z.age",
    });
    writeOwnerOnly(statePath, sourceContent);

    await expectInvalid(statePath, [sourceContent, "C:\\private"]);
  });
});
