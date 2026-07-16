import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseControlConfig } from "../../apps/control/dist/config.js";
import {
  launchKeychainCommand,
  loadRuntimeConfigFile,
  parseRuntimeConfig,
} from "../lib/runtime-config.mjs";
import { renderTemplateFile } from "../lib/templates.mjs";

const opsRoot = path.resolve(import.meta.dirname, "..");
const hash = "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY";

test("runtime config accepts only the non-secret allowlist", () => {
  assert.deepEqual(parseRuntimeConfig([
    "NODE_ENV=production",
    "CONTROL_HOST=127.0.0.1",
    "CONTROL_PORT=8787",
    "PUBLIC_ORIGIN=https://www.example.test",
    "ADMIN_ORIGIN=https://admin.example.test",
    "DATABASE_PATH=/Users/wisdom/data/portal.sqlite",
    "PII_ACTIVE_KEY_ID=pii-v1",
    "HERMES_ENDPOINT=http://127.0.0.1:8788/notify",
    "EMAIL_PAYLOAD_MODE=receipt-only",
    "PUBLIC_RELEASE_ROOT=/Users/wisdom/portal/public-releases",
    "PUBLIC_CURRENT_LINK=/Users/wisdom/portal/public-current",
    "SITE_SOURCE_ROOT=/Users/wisdom/portal/current",
    "NODE_BINARY=/opt/homebrew/bin/node",
    "NPM_BINARY=/opt/homebrew/bin/npm",
    "PUBLICATION_BUILD_TIMEOUT_MS=300000",
    "NAVER_SITE_VERIFICATION_META=unit_test_naver_meta_token_1234567890",
    "INDEXNOW_KEYCHAIN_SERVICE=com.jihye.portal.indexnow",
    "INDEXNOW_KEY_LOCATION=https://www.example.test/indexnow-key.txt",
    "INDEXNOW_TIMEOUT_MS=10000",
    "CODEX_BINARY=/opt/homebrew/bin/codex",
    "GIT_BINARY=/usr/bin/git",
    "CODEX_MODEL=gpt-5-codex",
    "CODEX_TEMP_ROOT=/Users/wisdom/Library/Caches/WisdomPortalCodex",
    "CODEX_HOME=/Users/wisdom/Library/Application Support/WisdomPortalCodex",
    "CODEX_KEYCHAIN_SERVICE=com.jihye.portal.codex-api",
    "CODEX_TIMEOUT_MS=120000",
    `ADMIN_DUMMY_PASSWORD_HASH=${hash}`,
    "",
  ].join("\n")), {
    NODE_ENV: "production",
    CONTROL_HOST: "127.0.0.1",
    CONTROL_PORT: "8787",
    PUBLIC_ORIGIN: "https://www.example.test",
    ADMIN_ORIGIN: "https://admin.example.test",
    DATABASE_PATH: "/Users/wisdom/data/portal.sqlite",
    PII_ACTIVE_KEY_ID: "pii-v1",
    HERMES_ENDPOINT: "http://127.0.0.1:8788/notify",
    EMAIL_PAYLOAD_MODE: "receipt-only",
    PUBLIC_RELEASE_ROOT: "/Users/wisdom/portal/public-releases",
    PUBLIC_CURRENT_LINK: "/Users/wisdom/portal/public-current",
    SITE_SOURCE_ROOT: "/Users/wisdom/portal/current",
    NODE_BINARY: "/opt/homebrew/bin/node",
    NPM_BINARY: "/opt/homebrew/bin/npm",
    PUBLICATION_BUILD_TIMEOUT_MS: "300000",
    NAVER_SITE_VERIFICATION_META: "unit_test_naver_meta_token_1234567890",
    INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
    INDEXNOW_KEY_LOCATION: "https://www.example.test/indexnow-key.txt",
    INDEXNOW_TIMEOUT_MS: "10000",
    CODEX_BINARY: "/opt/homebrew/bin/codex",
    GIT_BINARY: "/usr/bin/git",
    CODEX_MODEL: "gpt-5-codex",
    CODEX_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalCodex",
    CODEX_HOME: "/Users/wisdom/Library/Application Support/WisdomPortalCodex",
    CODEX_KEYCHAIN_SERVICE: "com.jihye.portal.codex-api",
    CODEX_TIMEOUT_MS: "120000",
    ADMIN_DUMMY_PASSWORD_HASH: hash,
  });
  assert.deepEqual(
    parseRuntimeConfig("NAVER_SITE_VERIFICATION_FILE=naverunit_test_file_token_1234567890.html\n"),
    { NAVER_SITE_VERIFICATION_FILE: "naverunit_test_file_token_1234567890.html" },
  );

  for (const line of [
    "PII_ENCRYPTION_KEY=not-allowed-here",
    "NODE_OPTIONS=--require=/tmp/hook.cjs",
    "UNKNOWN_FLAG=value",
    "CONTROL_PORT=8787\nCONTROL_PORT=9999",
  ]) {
    assert.throws(() => parseRuntimeConfig(line), { code: "RUNTIME_CONFIG_REJECTED" });
  }
});

test("runtime config file must be absolute and cannot be a symlink", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisdom-runtime-"));
  const config = path.join(directory, "runtime.env");
  await writeFile(config, "NODE_ENV=production\n", { mode: 0o600 });

  assert.deepEqual(await loadRuntimeConfigFile(config), { NODE_ENV: "production" });
  await assert.rejects(loadRuntimeConfigFile("runtime.env"), { code: "RUNTIME_CONFIG_PATH_INVALID" });

  const link = path.join(directory, "runtime-link.env");
  try {
    await (await import("node:fs/promises")).symlink(config, link);
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  await assert.rejects(loadRuntimeConfigFile(link), { code: "RUNTIME_CONFIG_PATH_INVALID" });
});

test("rendered production runtime plus independent secrets passes parseControlConfig", async () => {
  const rendered = await renderTemplateFile(path.join(opsRoot, "config/runtime.env.template"), {
    ADMIN_DUMMY_PASSWORD_HASH: hash,
    ADMIN_HOST: "admin.example.test",
    CONTROL_PORT: "8787",
    DATA_ROOT: "/Users/wisdom/Library/Application Support/WisdomPortal",
    PUBLIC_HOST: "www.example.test",
    PUBLIC_RELEASE_ROOT: "/Users/wisdom/portal/public-releases",
    PUBLIC_CURRENT_RELEASE: "/Users/wisdom/portal/public-current",
    CODEX_BINARY: "/opt/homebrew/bin/codex",
    GIT_BINARY: "/usr/bin/git",
    CODEX_MODEL: "gpt-5-codex",
    CODEX_TEMP_ROOT: "/Users/wisdom/Library/Caches/WisdomPortalCodex",
    CODEX_HOME: "/Users/wisdom/Library/Application Support/WisdomPortalCodex",
    CODEX_KEYCHAIN_SERVICE: "com.jihye.portal.codex-api",
    CURRENT_RELEASE: "/Users/wisdom/portal/current",
    NODE_BINARY: "/opt/homebrew/bin/node",
    NPM_BINARY: "/opt/homebrew/bin/npm",
    INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
  });
  const runtime = parseRuntimeConfig(rendered);
  const config = parseControlConfig({
    ...runtime,
    ADMIN_SESSION_SECRET: "admin-session-independent-secret-00001",
    PII_ENCRYPTION_KEY: "pii-encryption-independent-secret-0001",
    WITHDRAWAL_TOKEN_SECRET: "withdrawal-independent-secret-0000001",
    CONTROL_HMAC_SECRET: "control-hmac-independent-secret-000001",
    HERMES_HMAC_SECRET: "hermes-hmac-independent-secret-0000001",
  });

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 8787);
  assert.equal(config.publicOrigin, "https://www.example.test");
  assert.equal(config.adminOrigin, "https://admin.example.test");
  assert.equal(config.publication.siteSourceRoot, "/Users/wisdom/portal/current");
  assert.equal(config.indexNow.keychainService, "com.jihye.portal.indexnow");
});

test("launcher allowlists host environment, disables shell, and relays stop signals", async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  const kills = [];
  child.kill = (signal) => {
    kills.push(signal);
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  let invocation;
  const completion = launchKeychainCommand({
    parsed: {
      account: "wisdom",
      mappings: [{ environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac" }],
      command: path.join(path.parse(process.cwd()).root, "opt", "bin", "node"),
      args: ["server.js"],
      configPath: path.join(path.parse(process.cwd()).root, "fixture", "runtime.env"),
    },
    hostEnvironment: {
      PATH: "/usr/bin",
      HOME: "/Users/wisdom",
      TMPDIR: "/tmp",
      LANG: "ko_KR.UTF-8",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
      NODE_OPTIONS: "--require=/tmp/evil.cjs",
    },
    runtimeConfig: { NODE_ENV: "production", CONTROL_HOST: "127.0.0.1" },
    keychainAdapter: { read: async () => "keychain-value" },
    spawnChild: (command, args, options) => {
      invocation = { command, args, options };
      return child;
    },
    signalSource,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, "inherit");
  assert.deepEqual(invocation.options.env, {
    PATH: "/usr/bin",
    HOME: "/Users/wisdom",
    TMPDIR: "/tmp",
    LANG: "ko_KR.UTF-8",
    WISDOM_KEYCHAIN_EXEC: "1",
    NODE_ENV: "production",
    CONTROL_HOST: "127.0.0.1",
    CONTROL_HMAC_SECRET: "keychain-value",
  });
  signalSource.emit("SIGTERM");
  assert.deepEqual(kills, ["SIGTERM"]);
  assert.equal(await completion, 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
});
