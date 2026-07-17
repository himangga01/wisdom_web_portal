import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG_TEMPLATE_DESCRIPTORS,
  CONFIG_TOKEN_NAMES,
  parseProductionValues,
  readProductionValuesFile,
} from "../lib/config-installer.mjs";

const fixtureValues = Object.freeze({
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$example$dummy-public-hash",
  ADMIN_HOST: "admin.example.test",
  AGE_BINARY: "/opt/homebrew/bin/age",
  AGE_RECIPIENT: "age1operatorreplacebeforeinstall",
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
    { schemaVersion: 1, values: { ...fixtureValues, CADDY_PORT: "08080" } },
    { schemaVersion: 1, values: { ...fixtureValues, CADDY_PORT: "65536" } },
    { schemaVersion: 1, values: { ...fixtureValues, CONTROL_PORT: fixtureValues.CADDY_PORT } },
    { schemaVersion: 1, values: { ...fixtureValues, TUNNEL_ID: "not-a-uuid" } },
    { schemaVersion: 1, values: { ...fixtureValues, AGE_RECIPIENT: "AGE-SECRET-KEY-1PRIVATE" } },
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
