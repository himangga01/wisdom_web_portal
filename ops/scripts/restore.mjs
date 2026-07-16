#!/usr/bin/env node
import path from "node:path";

import { option, printJson } from "../lib/cli-options.mjs";
import { createMacServiceAdapter } from "../lib/mac-services.mjs";
import { planRestore, restoreBackup } from "../lib/restore.mjs";
import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const input = {
    backupRoot: path.resolve(option(argv, "--backup-root")),
    backup: path.resolve(option(argv, "--backup")),
    target: path.resolve(option(argv, "--target")),
    tempRoot: path.resolve(option(argv, "--temp-root")),
    dryRun: !apply,
    ...(apply ? { confirmDestroy: option(argv, "--confirm-destroy") } : {}),
    ageIdentity: process.env.AGE_IDENTITY,
  };
  const ageExecutable = path.resolve(option(argv, "--age"));
  if (!apply) {
    printJson(planRestore(input));
    return;
  }
  if (process.env.WISDOM_KEYCHAIN_EXEC !== "1") {
    throw Object.assign(new Error("Restore apply must run through keychain-exec"), { code: "RESTORE_KEYCHAIN_EXEC_REQUIRED" });
  }
  if (!input.ageIdentity) throw Object.assign(new Error("AGE_IDENTITY is required through Keychain"), { code: "AGE_IDENTITY_REQUIRED" });
  const result = await restoreBackup(input, {
    sqlite: createSqliteAdapter(),
    age: createAgeAdapter({ executable: ageExecutable }),
    services: createMacServiceAdapter(),
  });
  printJson({
    dryRun: false,
    restored: true,
    quarantinePath: result.quarantinePath,
    retentionPurgedCount: result.retentionPurgedCount,
  });
}

main().catch((error) => {
  process.stderr.write(`Restore failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
