#!/usr/bin/env node
import path from "node:path";

import { printJson } from "../lib/cli-options.mjs";
import { createMacServiceAdapter } from "../lib/mac-services.mjs";
import { planRestore, restoreBackup } from "../lib/restore.mjs";
import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

function usage(message) {
  throw Object.assign(new Error(message), { code: "CLI_USAGE" });
}

function parseArgs(argv) {
  const requiredValueFlags = new Set([
    "--backup-root",
    "--backup",
    "--target",
    "--temp-root",
    "--age",
  ]);
  const valueFlags = new Set([
    ...requiredValueFlags,
    "--confirm-destroy",
    "--automatic-backup-after-restore",
  ]);
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      if (apply) usage("Duplicate --apply");
      apply = true;
      continue;
    }
    if (!valueFlags.has(flag)) usage(`Unknown option ${flag}`);
    if (values.has(flag)) usage(`Duplicate ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of requiredValueFlags) {
    if (!values.has(flag)) usage(`Missing ${flag}`);
  }
  if (apply && !values.has("--confirm-destroy")) usage("Missing --confirm-destroy");
  const automaticBackupAfterRestore = values.get("--automatic-backup-after-restore");
  if (
    automaticBackupAfterRestore !== undefined &&
    automaticBackupAfterRestore !== "enabled" &&
    automaticBackupAfterRestore !== "disabled"
  ) usage("--automatic-backup-after-restore must be enabled or disabled");
  return {
    backupRoot: values.get("--backup-root"),
    backup: values.get("--backup"),
    target: values.get("--target"),
    tempRoot: values.get("--temp-root"),
    age: values.get("--age"),
    confirmDestroy: values.get("--confirm-destroy"),
    automaticBackupAfterRestore,
    apply,
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const input = {
    backupRoot: path.resolve(parsed.backupRoot),
    backup: path.resolve(parsed.backup),
    target: path.resolve(parsed.target),
    tempRoot: path.resolve(parsed.tempRoot),
    dryRun: !parsed.apply,
    ...(parsed.apply ? { confirmDestroy: parsed.confirmDestroy } : {}),
    ...(parsed.automaticBackupAfterRestore === undefined ? {} : {
      automaticBackupAfterRestore: parsed.automaticBackupAfterRestore === "enabled",
    }),
    ageIdentity: process.env.AGE_IDENTITY,
  };
  const ageExecutable = path.resolve(parsed.age);
  if (!parsed.apply) {
    printJson(planRestore(input));
    return;
  }
  if (process.env.WISDOM_KEYCHAIN_EXEC !== "1") {
    throw Object.assign(new Error("Restore apply must run through keychain-exec"), { code: "RESTORE_KEYCHAIN_EXEC_REQUIRED" });
  }
  if (!input.ageIdentity) throw Object.assign(new Error("AGE_IDENTITY is required through Keychain"), { code: "AGE_IDENTITY_REQUIRED" });
  planRestore(input);
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
    automaticBackupAfterRestore: result.automaticBackupAfterRestore,
    automaticBackupPolicySource: result.automaticBackupPolicySource,
  });
}

main().catch((error) => {
  process.stderr.write(`Restore failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
