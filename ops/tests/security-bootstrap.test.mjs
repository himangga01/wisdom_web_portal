import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  importAgeIdentity,
  importCodexApiCredential,
  importIndexNowKey,
  importSmtpCredential,
  installKeychainSecrets,
  loadKeychainEnvironment,
  parseKeychainExecArgs,
} from "../lib/keychain.mjs";
import * as macReleaseAdapter from "../lib/mac-release-adapter.mjs";
import { runPreflight } from "../lib/preflight.mjs";

const execute = promisify(execFileCallback);

const secretDefinitions = [
  { environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac", bytes: 32 },
  { environment: "DATA_ENCRYPTION_KEY", service: "com.jihye.portal.data-key", bytes: 32 },
];

const rotatableDefinition = {
  environment: "ADMIN_SESSION_SECRET",
  service: "com.jihye.portal.admin-session",
  bytes: 32,
};

test("Keychain bootstrap dry-run neither generates nor reveals secret values", async () => {
  let randomCalls = 0;
  let addCalls = 0;
  const result = await installKeychainSecrets({
    account: "wisdom",
    definitions: secretDefinitions,
    dryRun: true,
    mode: "bootstrap",
    adapter: {
      exists: async () => false,
      add: async () => addCalls++,
    },
    randomBytes: () => {
      randomCalls++;
      return Buffer.from("never-generate-on-dry-run");
    },
  });

  assert.equal(randomCalls, 0);
  assert.equal(addCalls, 0);
  assert.deepEqual(result, {
    dryRun: true,
    actions: [
      { action: "create", environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac" },
      { action: "create", environment: "DATA_ENCRYPTION_KEY", service: "com.jihye.portal.data-key" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /never-generate|[A-Za-z0-9+/]{43}=/);
});

test("Keychain bootstrap refuses overwrite unless rotation is explicit", async () => {
  const adapter = {
    exists: async ({ service }) => service.endsWith("control-hmac"),
    add: async () => assert.fail("bootstrap must not write over an existing item"),
  };

  await assert.rejects(
    installKeychainSecrets({
      account: "wisdom",
      definitions: secretDefinitions,
      dryRun: false,
      mode: "bootstrap",
      adapter,
    }),
    { code: "KEYCHAIN_ITEM_EXISTS" },
  );
});

test("explicit Keychain rotation replaces values without returning them", async () => {
  const writes = [];
  const result = await installKeychainSecrets({
    account: "wisdom",
    definitions: [rotatableDefinition],
    dryRun: false,
    mode: "rotate",
    adapter: {
      exists: async () => true,
      add: async (write) => writes.push(write),
    },
    randomBytes: (size) => Buffer.alloc(size, 0xa5),
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].replace, true);
  assert.equal(Buffer.from(writes[0].value, "base64").length, 32);
  assert.deepEqual(result.actions, [
    { action: "rotate", environment: "ADMIN_SESSION_SECRET", service: "com.jihye.portal.admin-session" },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /paWlpaWl/);
});

test("Keychain rotation refuses bulk changes and migration-sensitive keys", async () => {
  const adapter = {
    exists: async () => true,
    add: async () => assert.fail("unsafe rotation must not write"),
  };

  await assert.rejects(installKeychainSecrets({
    account: "wisdom",
    definitions: [rotatableDefinition, { ...rotatableDefinition, environment: "HERMES_HMAC_SECRET", service: "com.jihye.portal.hermes-hmac" }],
    dryRun: true,
    mode: "rotate",
    adapter,
  }), { code: "KEYCHAIN_BULK_ROTATION_FORBIDDEN" });

  for (const definition of [
    secretDefinitions[0],
    { environment: "HERMES_HMAC_SECRET", service: "com.jihye.portal.hermes-hmac", bytes: 32 },
    { environment: "PII_ENCRYPTION_KEY", service: "com.jihye.portal.pii-key", bytes: 32 },
    { environment: "WITHDRAWAL_TOKEN_SECRET", service: "com.jihye.portal.withdrawal-token", bytes: 32 },
  ]) {
    await assert.rejects(installKeychainSecrets({
      account: "wisdom",
      definitions: [definition],
      dryRun: true,
      mode: "rotate",
      adapter,
    }), { code: "KEYCHAIN_ROTATION_REQUIRES_MIGRATION" });
  }
});

test("age identity import accepts one stdin-style secret and never returns it", async () => {
  const fixture = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
  const writes = [];
  const result = await importAgeIdentity({
    account: "wisdom",
    value: `${fixture}\n`,
    dryRun: false,
    adapter: { add: async (write) => writes.push(write) },
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0].value, fixture);
  assert.equal(writes[0].replace, false);
  assert.deepEqual(result, {
    dryRun: false,
    action: "import-age-identity",
    service: "com.jihye.portal.age-identity",
  });
  assert.doesNotMatch(JSON.stringify(result), /AGE-SECRET/);

  await assert.rejects(importAgeIdentity({
    account: "wisdom",
    value: `${fixture}\n${fixture}\n`,
    dryRun: false,
    adapter: { add: async () => assert.fail("invalid identity must not write") },
  }), { code: "AGE_IDENTITY_INVALID" });
});

test("Codex API credential import uses a validated Keychain service and hides stdin", async () => {
  const fixture = "fixture-codex-credential-value-1234567890";
  const writes = [];
  const result = await importCodexApiCredential({
    account: "wisdom",
    service: "com.jihye.portal.codex-api",
    value: `${fixture}\n`,
    dryRun: false,
    adapter: { add: async (write) => writes.push(write) },
  });
  assert.equal(writes[0].value, fixture);
  assert.equal(writes[0].replace, false);
  assert.deepEqual(result, {
    dryRun: false,
    action: "import-codex-api",
    service: "com.jihye.portal.codex-api",
  });
  assert.doesNotMatch(JSON.stringify(result), /fixture-codex/u);
  await assert.rejects(importCodexApiCredential({
    account: "wisdom",
    service: "unsafe/service",
    value: fixture,
    dryRun: false,
    adapter: { add: async () => assert.fail("invalid service must not write") },
  }), { code: "INVALID_SECRET_MAPPING" });
});

test("IndexNow key import accepts the public ownership token without returning it", async () => {
  const fixture = "A1b2C3d4-IndexNow-ownership-2026";
  const writes = [];
  const result = await importIndexNowKey({
    account: "wisdom",
    service: "com.jihye.portal.indexnow",
    value: `${fixture}\n`,
    dryRun: false,
    adapter: { add: async (write) => writes.push(write) },
  });

  assert.equal(writes[0].value, fixture);
  assert.equal(writes[0].replace, false);
  assert.deepEqual(result, {
    dryRun: false,
    action: "import-indexnow-key",
    service: "com.jihye.portal.indexnow",
  });
  assert.doesNotMatch(JSON.stringify(result), /ownership-2026/u);
  await assert.rejects(importIndexNowKey({
    account: "wisdom",
    service: "unsafe/service",
    value: "not valid!",
    dryRun: false,
    adapter: { add: async () => assert.fail("invalid IndexNow key must not write") },
  }), { code: "INVALID_SECRET_MAPPING" });
});

test("SMTP credential import canonicalizes validated JSON without returning user or password", async () => {
  const writes = [];
  const result = await importSmtpCredential({
    account: "wisdom",
    service: "com.jihye.portal.smtp-owner",
    value: '{"password":"mail-secret-value-123","user":"owner@example.test"}\n',
    dryRun: false,
    adapter: { add: async (write) => writes.push(write) },
  });
  assert.equal(writes[0].value, '{"user":"owner@example.test","password":"mail-secret-value-123"}');
  assert.deepEqual(result, {
    dryRun: false,
    action: "import-smtp-json",
    service: "com.jihye.portal.smtp-owner",
  });
  assert.doesNotMatch(JSON.stringify(result), /owner@example|mail-secret/u);
  await assert.rejects(importSmtpCredential({
    account: "wisdom",
    service: "com.jihye.portal.smtp-owner",
    value: '{"user":"owner","password":"secret","extra":true}',
    dryRun: false,
    adapter: { add: async () => assert.fail("invalid SMTP JSON must not write") },
  }), { code: "SMTP_CREDENTIAL_INVALID" });
});

test("Keychain exec parser requires an absolute command after the separator", () => {
  assert.deepEqual(
    parseKeychainExecArgs([
      "--account",
      "wisdom",
      "--secret",
      "CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac",
      "--",
      "/opt/homebrew/bin/node",
      "/srv/control.js",
    ]),
    {
      account: "wisdom",
      mappings: [{ environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac" }],
      command: "/opt/homebrew/bin/node",
      args: ["/srv/control.js"],
    },
  );

  assert.throws(
    () => parseKeychainExecArgs(["--account", "wisdom", "--", "node", "server.js"]),
    { code: "COMMAND_NOT_ABSOLUTE" },
  );
  assert.throws(
    () => parseKeychainExecArgs(["--account", "wisdom", "--secret", "bad-name=service", "--", "/bin/true"]),
    { code: "INVALID_SECRET_MAPPING" },
  );
});

test("Keychain values are loaded into a child environment through an adapter", async () => {
  const environment = await loadKeychainEnvironment({
    account: "wisdom",
    mappings: [{ environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac" }],
    adapter: {
      read: async () => "fixture-secret-value",
    },
    baseEnvironment: { PATH: "/usr/bin" },
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    CONTROL_HMAC_SECRET: "fixture-secret-value",
  });
});

function successfulPreflightAdapter(overrides = {}) {
  return {
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "24.18.0",
    ensureWritable: async () => undefined,
    canonicalDeploymentPaths: async (paths) => paths,
    inspectBinary: async (name) => name === "age"
      ? { stdout: "age 1.3.1\n", stderr: "" }
      : { stdout: `${name} fixture`, stderr: "" },
    loadNativeModule: async () => undefined,
    sqliteVersion: async () => "3.53.2",
    verifyPublicCurrent: async () => ({ manifestVerified: true, indexVerified: true }),
    ...overrides,
  };
}

const root = path.parse(process.cwd()).root;
const preflightConfig = {
  releaseRoot: path.join(root, "fixture", "portal", "releases"),
  currentLink: path.join(root, "fixture", "portal", "current"),
  dataRoot: path.join(root, "fixture", "portal-data"),
  binaries: {
    caddy: path.join(root, "opt", "bin", "caddy"),
    cloudflared: path.join(root, "opt", "bin", "cloudflared"),
    age: path.join(root, "opt", "bin", "age"),
  },
  sqliteMinimum: "3.51.3",
  ageVersion: "1.3.1",
  publicReleaseRoot: path.join(root, "fixture", "portal", "public-releases"),
  publicCurrentLink: path.join(root, "fixture", "portal", "public-current"),
};

test("preflight accepts Apple silicon, Node 24, native SQLite and required binaries", async () => {
  const report = await runPreflight(preflightConfig, successfulPreflightAdapter());

  assert.equal(report.ok, true);
  assert.equal(report.architecture, "arm64");
  assert.equal(report.nodeVersion, "24.18.0");
  assert.equal(report.sqliteVersion, "3.53.2");
  assert.equal(report.ageVersion, "1.3.1");
  assert.deepEqual(report.checkedBinaries.sort(), ["age", "caddy", "cloudflared"]);
  assert.deepEqual(report.publicSite, { manifestVerified: true, indexVerified: true });
});

test("preflight rejects an age binary that does not match the pinned version", async () => {
  await assert.rejects(runPreflight(preflightConfig, successfulPreflightAdapter({
    inspectBinary: async (name) => name === "age"
      ? { stdout: "age 1.3.0\n", stderr: "" }
      : { stdout: `${name} fixture`, stderr: "" },
  })), { code: "UNSUPPORTED_AGE_VERSION" });
});

test("preflight blocks tunnel launch until public-current index and manifest are verified", async () => {
  await assert.rejects(runPreflight(preflightConfig, successfulPreflightAdapter({
    verifyPublicCurrent: async () => {
      throw Object.assign(new Error("not seeded"), { code: "PUBLIC_CURRENT_NOT_READY" });
    },
  })), { code: "PUBLIC_CURRENT_NOT_READY" });
});

test("preflight fails closed for the wrong architecture, Node, or SQLite runtime", async (t) => {
  const cases = [
    ["architecture", { arch: "x64" }, "UNSUPPORTED_ARCHITECTURE"],
    ["Node", { nodeVersion: "22.20.0" }, "UNSUPPORTED_NODE_VERSION"],
    ["SQLite", { sqliteVersion: async () => "3.51.2" }, "UNSAFE_SQLITE_VERSION"],
  ];

  for (const [name, overrides, code] of cases) {
    await t.test(name, async () => {
      await assert.rejects(runPreflight(preflightConfig, successfulPreflightAdapter(overrides)), { code });
    });
  }
});

test("preflight rejects non-absolute binaries and overlapping data/release roots", async () => {
  await assert.rejects(
    runPreflight({ ...preflightConfig, binaries: { ...preflightConfig.binaries, age: "age" } }, successfulPreflightAdapter()),
    { code: "PREFLIGHT_PATH_INVALID" },
  );
  await assert.rejects(
    runPreflight({ ...preflightConfig, dataRoot: path.join(preflightConfig.releaseRoot, "data") }, successfulPreflightAdapter()),
    { code: "PREFLIGHT_PATH_INVALID" },
  );
  await assert.rejects(
    runPreflight({ ...preflightConfig, dataRoot: preflightConfig.publicReleaseRoot }, successfulPreflightAdapter()),
    { code: "PREFLIGHT_PATH_INVALID" },
  );
});

test("preflight rejects identical or nested application and public deployment paths", async (t) => {
  const cases = [
    ["identical current pointers", { publicCurrentLink: preflightConfig.currentLink }],
    ["application current inside application releases", { currentLink: path.join(preflightConfig.releaseRoot, "current") }],
    ["application current inside public releases", { currentLink: path.join(preflightConfig.publicReleaseRoot, "current") }],
    ["public current inside application releases", { publicCurrentLink: path.join(preflightConfig.releaseRoot, "current") }],
    ["public current inside public releases", { publicCurrentLink: path.join(preflightConfig.publicReleaseRoot, "current") }],
    ["public releases inside application releases", { publicReleaseRoot: path.join(preflightConfig.releaseRoot, "public") }],
    ["application releases inside public releases", { releaseRoot: path.join(preflightConfig.publicReleaseRoot, "application") }],
    ["public current inside application current", { publicCurrentLink: path.join(preflightConfig.currentLink, "public") }],
    ["application current inside public current", { currentLink: path.join(preflightConfig.publicCurrentLink, "application") }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        runPreflight({ ...preflightConfig, ...overrides }, successfulPreflightAdapter()),
        { code: "PREFLIGHT_PATH_INVALID" },
      );
    });
  }
});

test("preflight rejects case-folded and canonical filesystem aliases", async () => {
  await assert.rejects(runPreflight({
    ...preflightConfig,
    publicReleaseRoot: preflightConfig.releaseRoot.toUpperCase(),
  }, successfulPreflightAdapter()), { code: "PREFLIGHT_PATH_INVALID" });

  await assert.rejects(runPreflight(preflightConfig, successfulPreflightAdapter({
    canonicalDeploymentPaths: async (paths) => ({
      ...paths,
      publicCurrentLink: paths.currentLink,
    }),
  })), { code: "PREFLIGHT_PATH_INVALID" });
});

test("mac release preflight forwards the application current pointer", async () => {
  const tempRoot = path.join(path.parse(process.cwd()).root, "fixture", "preflight-adapter");
  const currentLink = path.join(tempRoot, "portal", "current");
  assert.equal(typeof macReleaseAdapter.buildMacPreflightArguments, "function");
  const args = macReleaseAdapter.buildMacPreflightArguments({
    opsRoot: path.join(tempRoot, "ops"),
    nodeBinary: process.execPath,
    releaseRoot: path.join(tempRoot, "portal", "releases"),
    currentLink,
    dataRoot: path.join(tempRoot, "data"),
    caddyBinary: process.execPath,
    cloudflaredBinary: process.execPath,
    ageBinary: process.execPath,
    publicReleaseRoot: path.join(tempRoot, "portal", "public-releases"),
    publicCurrentLink: path.join(tempRoot, "portal", "public-current"),
  });

  assert.equal(args[args.indexOf("--current") + 1], currentLink);
});

test("mac release migration requires the rollback compatibility gate", () => {
  const fixtureRoot = path.join(path.parse(process.cwd()).root, "fixture", "migration-adapter");
  const npmBinary = path.join(fixtureRoot, "bin", "npm");
  assert.equal(typeof macReleaseAdapter.buildMacMigrationArguments, "function");

  const args = macReleaseAdapter.buildMacMigrationArguments({
    opsRoot: path.join(fixtureRoot, "ops"),
    keychainAccount: "fixture-account",
    runtimeConfig: path.join(fixtureRoot, "runtime.env"),
    npmBinary,
  }, path.join(fixtureRoot, "releases", "20260716T010203Z-abcdef1"));

  assert.deepEqual(args.slice(-8), [
    "--",
    npmBinary,
    "run",
    "db:migrate",
    "--workspace",
    "@wisdom/control",
    "--",
    "--require-rollback-compatible",
  ]);
});

test("preflight CLI maps --current into path validation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "wisdom-preflight-cli-"));
  const releaseRoot = path.join(tempRoot, "portal", "releases");
  const dataRoot = path.join(tempRoot, "data");
  await mkdir(releaseRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });

  await assert.rejects(execute(process.execPath, [
    path.resolve(import.meta.dirname, "../scripts/preflight.mjs"),
    "--release-root", releaseRoot,
    "--current", path.join(tempRoot, "portal", "current"),
    "--data-root", dataRoot,
    "--caddy", process.execPath,
    "--cloudflared", process.execPath,
    "--age", process.execPath,
    "--public-release-root", path.join(tempRoot, "portal", "public-releases"),
    "--public-current", path.join(tempRoot, "portal", "public-current"),
  ], { timeout: 10_000, windowsHide: true }), (error) => {
    assert.doesNotMatch(error.stderr, /PREFLIGHT_PATH_INVALID/u);
    return true;
  });
});
