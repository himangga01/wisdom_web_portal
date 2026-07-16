#!/usr/bin/env node
import path from "node:path";

import {
  databaseMaintenanceLockPath,
  recoverDatabaseMaintenanceLock,
} from "../lib/database-maintenance-lock.mjs";
import { option, printJson } from "../lib/cli-options.mjs";
import {
  recoverReleaseOperationLock,
  releaseOperationLockPath,
} from "../lib/release-operation-lock.mjs";

function fail(message) {
  throw Object.assign(new Error(message), { code: "LOCK_RECOVERY_USAGE" });
}

function absoluteOption(argv, name) {
  const value = option(argv, name);
  if (!path.isAbsolute(value) || /[\0\r\n]/u.test(value)) fail(`${name} must be absolute`);
  const resolved = path.resolve(value);
  if (resolved !== value) fail(`${name} must be an exact normalized absolute path`);
  return resolved;
}

async function main() {
  const argv = process.argv.slice(2);
  const kind = option(argv, "--kind");
  const suppliedLock = absoluteOption(argv, "--lock");
  const apply = argv.includes("--apply");
  const recoveryOptions = {
    dryRun: !apply,
    ...(apply ? {
      confirmLockPath: absoluteOption(argv, "--confirm-lock"),
      confirmedAction: option(argv, "--confirm-action"),
    } : {}),
  };

  let expectedLock;
  let result;
  if (kind === "release") {
    const releaseRoot = absoluteOption(argv, "--release-root");
    expectedLock = releaseOperationLockPath(releaseRoot);
    if (suppliedLock !== expectedLock) fail("--lock must exactly match the release operation lock");
    result = await recoverReleaseOperationLock(releaseRoot, recoveryOptions);
  } else if (kind === "database") {
    const database = absoluteOption(argv, "--database");
    expectedLock = databaseMaintenanceLockPath(database);
    if (suppliedLock !== expectedLock) fail("--lock must exactly match the database maintenance lock");
    result = await recoverDatabaseMaintenanceLock(database, recoveryOptions);
  } else fail("--kind must be release or database");

  printJson(result);
}

main().catch((error) => {
  process.stderr.write(`Lock recovery failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
