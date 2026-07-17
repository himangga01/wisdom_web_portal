import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildConfigurationPlan,
  CONFIG_TEMPLATE_DESCRIPTORS,
  CONFIG_TOKEN_NAMES,
  installConfiguration,
  parseProductionValues,
  readProductionValuesFile,
} from "../lib/config-installer.mjs";

const opsRoot = path.resolve(import.meta.dirname, "..");

const fixtureValues = Object.freeze({
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$example$dummy-public-hash",
  ADMIN_HOST: "admin.example.test",
  AGE_BINARY: "/opt/homebrew/bin/age",
  AGE_RECIPIENT: "age1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0savhh7m",
  APEX_HOST: "example.test",
  APP_ROOT: "/Users/wisdom/portal",
  BACKUP_ROOT: "/Users/wisdom/Backups/portal",
  BACKUP_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalBackup",
  CADDY_ADMIN_PORT: "2019",
  CADDY_BINARY: "/opt/homebrew/bin/caddy",
  CADDY_BIND: "127.0.0.1",
  CADDY_CONFIG: "/Users/wisdom/portal/shared/Caddyfile",
  CADDY_PORT: "8080",
  CLOUDFLARED_BINARY: "/opt/homebrew/bin/cloudflared",
  CLOUDFLARED_CONFIG: "/Users/wisdom/portal/shared/cloudflared.yml",
  CLOUDFLARED_CREDENTIALS_FILE: "/Users/wisdom/.cloudflared/00000000-0000-4000-8000-000000000000.json",
  CODEX_BINARY: "/opt/homebrew/bin/codex",
  CODEX_HOME: "/Users/wisdom/Library/Application Support/WisdomPortalCodex",
  CODEX_KEYCHAIN_SERVICE: "com.jihye.portal.codex-api",
  CODEX_MODEL: "gpt-5-codex",
  CODEX_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalCodex",
  CONTROL_HOST: "127.0.0.1",
  CONTROL_PORT: "8787",
  CURRENT_RELEASE: "/Users/wisdom/portal/current",
  DATA_ROOT: "/Users/wisdom/Library/Application Support/WisdomPortal",
  GIT_BINARY: "/usr/bin/git",
  INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
  LOG_ROOT: "/Users/wisdom/Library/Logs/WisdomPortal",
  NODE_BINARY: "/opt/homebrew/bin/node",
  NPM_BINARY: "/opt/homebrew/bin/npm",
  PUBLIC_CURRENT_RELEASE: "/Users/wisdom/portal/public-current",
  PUBLIC_HOST: "www.example.test",
  PUBLIC_RELEASE_ROOT: "/Users/wisdom/portal/public-releases",
  TUNNEL_ID: "00000000-0000-4000-8000-000000000000",
  USER_NAME: "wisdom",
});

test("production configuration inventory owns all thirteen templates and thirty-five tokens", () => {
  assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.length, 13);
  assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.filter(({ scope }) => scope === "user").length, 12);
  assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.filter(({ scope }) => scope === "system").length, 1);
  assert.equal(CONFIG_TOKEN_NAMES.length, 35);
  assert.equal(new Set(CONFIG_TOKEN_NAMES).size, CONFIG_TOKEN_NAMES.length);
  assert.deepEqual(CONFIG_TOKEN_NAMES, [...CONFIG_TOKEN_NAMES].sort());
  assert.equal(CONFIG_TEMPLATE_DESCRIPTORS.find(({ id }) => id === "runtime").target(fixtureValues), "/Users/wisdom/portal/shared/runtime.env");
  assert.equal(
    CONFIG_TEMPLATE_DESCRIPTORS.find(({ id }) => id === "launchd-control").target(fixtureValues),
    "/Users/wisdom/Library/LaunchAgents/com.jihye.portal.control.plist",
  );
  assert.equal(
    CONFIG_TEMPLATE_DESCRIPTORS.find(({ id }) => id === "newsyslog").target(fixtureValues),
    "/etc/newsyslog.d/wisdom-portal.conf",
  );
});

test("production values require the exact versioned thirty-five-token object", () => {
  const parsed = parseProductionValues(JSON.stringify({ schemaVersion: 1, values: fixtureValues }));

  assert.deepEqual(Object.keys(parsed).sort(), [...CONFIG_TOKEN_NAMES]);
  assert.ok(Object.isFrozen(parsed));
  assert.throws(() => parseProductionValues(JSON.stringify({
    schemaVersion: 1,
    values: { ...fixtureValues, TELEGRAM_BOT_TOKEN: "forbidden" },
  })), { code: "CONFIG_VALUES_INVALID" });
  const { USER_NAME: _missing, ...missing } = fixtureValues;
  assert.throws(() => parseProductionValues(JSON.stringify({ schemaVersion: 1, values: missing })), {
    code: "CONFIG_VALUES_INVALID",
  });
});

test("production values reject malformed scalar and network contracts", () => {
  const documents = [
    null,
    [],
    { schemaVersion: 2, values: fixtureValues },
    { schemaVersion: 1, values: { ...fixtureValues, USER_NAME: "" } },
    { schemaVersion: 1, values: { ...fixtureValues, USER_NAME: "wisdom\nroot" } },
    { schemaVersion: 1, values: { ...fixtureValues, CONTROL_HOST: "0.0.0.0" } },
    { schemaVersion: 1, values: { ...fixtureValues, CADDY_BIND: "::1" } },
    { schemaVersion: 1, values: { ...fixtureValues, PUBLIC_HOST: "https://www.example.test" } },
    { schemaVersion: 1, values: { ...fixtureValues, PUBLIC_HOST: "WWW.example.test" } },
    { schemaVersion: 1, values: { ...fixtureValues, PUBLIC_HOST: fixtureValues.ADMIN_HOST } },
    { schemaVersion: 1, values: { ...fixtureValues, PUBLIC_HOST: "127.0.0.2" } },
    { schemaVersion: 1, values: { ...fixtureValues, CADDY_PORT: "08080" } },
    { schemaVersion: 1, values: { ...fixtureValues, CADDY_PORT: "65536" } },
    { schemaVersion: 1, values: { ...fixtureValues, CONTROL_PORT: fixtureValues.CADDY_PORT } },
    { schemaVersion: 1, values: { ...fixtureValues, TUNNEL_ID: "not-a-uuid" } },
    { schemaVersion: 1, values: { ...fixtureValues, AGE_RECIPIENT: "AGE-SECRET-KEY-1" } },
    { schemaVersion: 1, values: { ...fixtureValues, AGE_RECIPIENT: "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq" } },
    { schemaVersion: 1, values: { ...fixtureValues, USER_NAME: "../root" } },
  ];

  for (const document of documents) {
    assert.throws(() => parseProductionValues(JSON.stringify(document)), { code: "CONFIG_VALUES_INVALID" });
  }
});

test("production values derive one canonical Mac layout and reject unsafe root overlap", () => {
  const invalidValues = [
    { APP_ROOT: "portal" },
    { APP_ROOT: "/Users/wisdom/other" },
    { CADDY_CONFIG: "/Users/wisdom/portal/other-Caddyfile" },
    { CLOUDFLARED_CONFIG: "/Users/wisdom/portal/shared/other.yml" },
    { CURRENT_RELEASE: "/Users/wisdom/portal/releases/current" },
    { PUBLIC_CURRENT_RELEASE: "/Users/wisdom/portal/current" },
    { PUBLIC_RELEASE_ROOT: "/Users/wisdom/portal/releases" },
    { DATA_ROOT: "/Users/wisdom/portal/data" },
    { BACKUP_TEMP_ROOT: "/Users/wisdom/Backups/portal/temp" },
    { CODEX_TEMP_ROOT: "/Users/wisdom/Library/Application Support/WisdomPortal" },
    { NODE_BINARY: "/opt/homebrew/bin/../bin/node" },
    { BACKUP_ROOT: "/" },
    { BACKUP_ROOT: "/Users/wisdom/Backups/portal/" },
  ];

  for (const changes of invalidValues) {
    assert.throws(() => parseProductionValues(JSON.stringify({
      schemaVersion: 1,
      values: { ...fixtureValues, ...changes },
    })), { code: "CONFIG_VALUES_INVALID" });
  }
});

test("production values file must be a protected bounded regular non-symlink", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-config-values-"));
  const source = `${JSON.stringify({ schemaVersion: 1, values: fixtureValues })}\n`;
  const valid = path.join(root, "production-values.json");
  await writeFile(valid, source, { mode: 0o600 });

  assert.deepEqual(await readProductionValuesFile(valid), fixtureValues);

  const malformedUtf8 = path.join(root, "malformed-utf8.json");
  const malformedBytes = Buffer.from(source, "utf8");
  malformedBytes[malformedBytes.indexOf("dummy-public-hash")] = 0x80;
  await writeFile(malformedUtf8, malformedBytes, { mode: 0o600 });
  await assert.rejects(readProductionValuesFile(malformedUtf8), { code: "CONFIG_INPUT_INVALID" });
  await assert.rejects(readProductionValuesFile("production-values.json"), {
    code: "CONFIG_INPUT_INVALID",
  });

  if (process.platform === "win32") {
    t.diagnostic("POSIX mode fixture runs on macOS/Linux");
  } else {
    await chmod(valid, 0o644);
    await assert.rejects(readProductionValuesFile(valid), { code: "CONFIG_INPUT_INVALID" });
    await chmod(valid, 0o600);
  }

  const directory = path.join(root, "directory.json");
  await mkdir(directory);
  await assert.rejects(readProductionValuesFile(directory), {
    code: "CONFIG_INPUT_INVALID",
  });

  const link = path.join(root, "link.json");
  try {
    await symlink(valid, link);
    await assert.rejects(readProductionValuesFile(link), {
      code: "CONFIG_INPUT_INVALID",
    });
  } catch (error) {
    if (error.code === "EPERM") t.diagnostic("symlink fixture unavailable on this Windows host");
    else throw error;
  }
});

test("production values example is exact, parseable, and credential-free", async () => {
  const source = await readFile(path.resolve(import.meta.dirname, "../config/production-values.example.json"), "utf8");
  const parsed = parseProductionValues(source);

  assert.deepEqual(Object.keys(parsed).sort(), [...CONFIG_TOKEN_NAMES]);
  assert.doesNotMatch(source, /AGE-SECRET-KEY-1|ghp_[A-Za-z0-9]+|sk-[A-Za-z0-9]{20,}|TELEGRAM.*TOKEN|CODEX_API_KEY/u);
});

test("dry-run renders and validates every selected artifact without exposing values or targets", async () => {
  const externalCalls = [];
  const adapters = {
    validateExternal: async ({ id, kind, source }) => {
      externalCalls.push({ id, kind, bytes: Buffer.byteLength(source, "utf8") });
    },
    readExistingTarget: async () => undefined,
  };

  const userPlan = await buildConfigurationPlan({ opsRoot, values: fixtureValues, scope: "user" }, adapters);
  assert.equal(userPlan.schemaVersion, 1);
  assert.equal(userPlan.scope, "user");
  assert.equal(userPlan.applied, false);
  assert.equal(userPlan.artifacts.length, 12);
  assert.ok(userPlan.artifacts.every((artifact) => (
    Object.keys(artifact).sort().join(",") === "changed,id,sha256" &&
    artifact.changed === true && /^[0-9a-f]{64}$/u.test(artifact.sha256)
  )));
  assert.equal(externalCalls.length, 10);
  assert.deepEqual(new Set(externalCalls.map(({ kind }) => kind)), new Set(["plist", "caddy", "cloudflared"]));
  assert.doesNotMatch(JSON.stringify(userPlan), /example\.test|\/Users\/wisdom|127\.0\.0\.1/u);

  externalCalls.length = 0;
  const systemPlan = await buildConfigurationPlan({ opsRoot, values: fixtureValues, scope: "system" }, adapters);
  assert.equal(systemPlan.artifacts.length, 1);
  assert.deepEqual(externalCalls.map(({ kind }) => kind), ["newsyslog"]);
});

async function createTemplateFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-config-templates-"));
  for (const { source } of CONFIG_TEMPLATE_DESCRIPTORS) {
    const destination = path.join(root, source);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(path.join(opsRoot, source)));
  }
  return root;
}

test("runtime planning rejects a repository template outside the fixed inventory", async () => {
  const fixtureRoot = await createTemplateFixture();
  await writeFile(path.join(fixtureRoot, "config/unowned.template"), "UNOWNED=value\n");

  await assert.rejects(buildConfigurationPlan({ opsRoot: fixtureRoot, values: fixtureValues, scope: "user" }, {
    validateExternal: async () => undefined,
    readExistingTarget: async () => undefined,
  }), { code: "CONFIG_VALIDATION_FAILED" });
});

test("configuration planning sanitizes parser, template, and external validation failures", async () => {
  const cases = [
    {
      readTemplate: async (templatePath) => templatePath.endsWith("runtime.env.template")
        ? "UNKNOWN=value\n"
        : readFile(templatePath, "utf8"),
      validateExternal: async () => undefined,
    },
    {
      readTemplate: async () => "{{MISSING_TOKEN}}\n",
      validateExternal: async () => undefined,
    },
    {
      validateExternal: async () => { throw new Error(`validator leaked ${fixtureValues.APEX_HOST}`); },
    },
  ];

  for (const adapters of cases) {
    await assert.rejects(
      buildConfigurationPlan({ opsRoot, values: fixtureValues, scope: "user" }, {
        readExistingTarget: async () => undefined,
        ...adapters,
      }),
      (error) => error.code === "CONFIG_VALIDATION_FAILED" &&
        !error.message.includes(fixtureValues.APEX_HOST) && !error.message.includes("MISSING_TOKEN"),
    );
  }
});

test("dry-run refuses a symlink or non-regular existing target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-config-plan-target-"));
  const real = path.join(root, "real-runtime");
  const linked = path.join(root, "linked-runtime");
  await writeFile(real, "not-the-rendered-value\n");
  try {
    await symlink(real, linked);
  } catch (error) {
    if (error.code === "EPERM") {
      t.diagnostic("symlink fixture unavailable on this Windows host");
      return;
    }
    throw error;
  }

  await assert.rejects(buildConfigurationPlan({ opsRoot, values: fixtureValues, scope: "user" }, {
    validateExternal: async () => undefined,
    resolveTarget: (_target, { id }) => id === "runtime" ? linked : path.join(root, `${id}.missing`),
  }), { code: "CONFIG_TARGET_INVALID" });
});

test("install is dry-run first and apply requires platform, privilege, and exact confirmations", async () => {
  const base = { opsRoot, values: fixtureValues, scope: "user" };
  let mutations = 0;
  const dryRun = await installConfiguration(base, {
    validateExternal: async () => undefined,
    readExistingTarget: async () => undefined,
    beforePublish: async () => { mutations += 1; },
  });
  assert.equal(dryRun.applied, false);
  assert.equal(mutations, 0);

  for (const changes of [
    { platform: "win32", confirmAppRoot: fixtureValues.APP_ROOT, confirmUserHome: "/Users/wisdom" },
    { platform: "darwin", confirmAppRoot: "/Users/wisdom/wrong", confirmUserHome: "/Users/wisdom" },
    { platform: "darwin", confirmAppRoot: fixtureValues.APP_ROOT, confirmUserHome: "/Users/other" },
  ]) {
    await assert.rejects(installConfiguration({ ...base, apply: true, ...changes }, {
      validateExternal: async () => undefined,
      readExistingTarget: async () => undefined,
    }), { code: "CONFIG_TARGET_INVALID" });
  }

  const system = { opsRoot, values: fixtureValues, scope: "system", apply: true, platform: "darwin" };
  await assert.rejects(installConfiguration({
    ...system,
    confirmSystemTarget: "/etc/newsyslog.d/wisdom-portal.conf",
  }, { getuid: () => 501, validateExternal: async () => undefined }), { code: "CONFIG_TARGET_INVALID" });
  await assert.rejects(installConfiguration({
    ...system,
    confirmSystemTarget: "/etc/newsyslog.d/wrong.conf",
  }, { getuid: () => 0, validateExternal: async () => undefined }), { code: "CONFIG_TARGET_INVALID" });
});

async function applyFixture({ beforePublish, beforeRollback, beforeStage, beforeVerify } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-config-install-"));
  await chmod(root, 0o700);
  const owner = (await stat(root)).uid;
  const physical = (id) => path.join(root, `${id}.installed`);
  const adapters = {
    getuid: () => owner,
    validateExternal: async () => undefined,
    resolveTarget: (_target, { id }) => physical(id),
    beforePublish,
    beforeRollback,
    beforeStage,
    beforeVerify,
  };
  const input = {
    opsRoot,
    values: fixtureValues,
    scope: "user",
    apply: true,
    platform: "darwin",
    confirmAppRoot: fixtureValues.APP_ROOT,
    confirmUserHome: "/Users/wisdom",
  };
  return { adapters, input, owner, physical, root };
}

test("apply atomically publishes all changed files with exact modes and no temporary residue", async () => {
  let stageCalls = 0;
  const fixture = await applyFixture({ beforeStage: async () => { stageCalls += 1; } });
  await writeFile(fixture.physical("runtime"), "previous-runtime\n", { mode: 0o600 });

  const result = await installConfiguration(fixture.input, fixture.adapters);

  assert.equal(result.applied, true);
  assert.equal(result.artifacts.length, 12);
  assert.ok(result.artifacts.every(({ changed }) => changed));
  assert.equal(stageCalls, 12);
  assert.match(await readFile(fixture.physical("runtime"), "utf8"), /^NODE_ENV=production$/mu);
  if (process.platform !== "win32") {
    assert.equal((await stat(fixture.physical("runtime"))).mode & 0o777, 0o600);
    assert.equal((await stat(fixture.physical("launchd-control"))).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.includes(".wisdom-config-")), []);
});

test("a mid-publication failure restores replaced files, removes created files, and cleans temporary files", async () => {
  const fixture = await applyFixture({
    beforePublish: async ({ index }) => {
      if (index === 2) throw new Error("injected publication failure");
    },
  });
  await writeFile(fixture.physical("runtime"), "previous-runtime\n", { mode: 0o600 });

  await assert.rejects(installConfiguration(fixture.input, fixture.adapters), {
    code: "CONFIG_INSTALL_FAILED",
  });
  assert.equal(await readFile(fixture.physical("runtime"), "utf8"), "previous-runtime\n");
  await assert.rejects(lstat(fixture.physical("monitoring")), { code: "ENOENT" });
  assert.deepEqual((await readdir(fixture.root)).filter((name) => name.includes(".wisdom-config-")), []);
});

test("rollback failure has a distinct sanitized fatal code", async () => {
  const fixture = await applyFixture({
    beforePublish: async ({ index }) => {
      if (index === 1) throw new Error("injected publication failure");
    },
    beforeRollback: async () => { throw new Error(`rollback leaked ${fixtureValues.APP_ROOT}`); },
  });
  await writeFile(fixture.physical("runtime"), "previous-runtime\n", { mode: 0o600 });

  await assert.rejects(installConfiguration(fixture.input, fixture.adapters), (error) => (
    error.code === "CONFIG_ROLLBACK_FAILED" && !error.message.includes(fixtureValues.APP_ROOT)
  ));
});

test("unchanged reapply preserves file identity and reports no changes", async () => {
  const fixture = await applyFixture();
  await installConfiguration(fixture.input, fixture.adapters);
  const before = await stat(fixture.physical("runtime"));

  const result = await installConfiguration(fixture.input, fixture.adapters);
  const after = await stat(fixture.physical("runtime"));

  assert.ok(result.artifacts.every(({ changed }) => changed === false));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("dry-run reports byte-identical files with mode drift as changed", async () => {
  const fixture = await applyFixture();
  await installConfiguration(fixture.input, fixture.adapters);
  const runtimeBytes = await readFile(fixture.physical("runtime"));

  const result = await buildConfigurationPlan({
    opsRoot,
    values: fixtureValues,
    scope: "user",
  }, {
    validateExternal: async () => undefined,
    resolveTarget: fixture.adapters.resolveTarget,
    readExistingTarget: async (_target, { id }) => id === "runtime"
      ? { bytes: runtimeBytes, mode: 0o644, uid: fixture.owner }
      : undefined,
  });

  assert.equal(result.artifacts.find(({ id }) => id === "runtime").changed, true);
});

test("post-publication verification failure rolls every changed file back", async () => {
  let verificationCalls = 0;
  const fixture = await applyFixture({
    beforeVerify: async () => {
      verificationCalls += 1;
      if (verificationCalls === 1) throw new Error("injected verification failure");
    },
  });
  await writeFile(fixture.physical("runtime"), "previous-runtime\n", { mode: 0o600 });

  await assert.rejects(installConfiguration(fixture.input, fixture.adapters), {
    code: "CONFIG_INSTALL_FAILED",
  });
  assert.equal(await readFile(fixture.physical("runtime"), "utf8"), "previous-runtime\n");
  await assert.rejects(lstat(fixture.physical("monitoring")), { code: "ENOENT" });
});
