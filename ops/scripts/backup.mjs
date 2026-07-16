#!/usr/bin/env node
import path from "node:path";

import { createOnlineBackup } from "../lib/backup.mjs";
import { option, printJson } from "../lib/cli-options.mjs";
import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

async function main() {
  const argv = process.argv.slice(2);
  const input = {
    sourceDb: path.resolve(option(argv, "--source")),
    backupRoot: path.resolve(option(argv, "--root")),
    tempRoot: path.resolve(option(argv, "--temp-root")),
    ageRecipient: option(argv, "--recipient"),
    ageIdentity: process.env.AGE_IDENTITY,
    now: new Date(),
  };
  const executable = path.resolve(option(argv, "--age"));
  if (!argv.includes("--apply")) {
    printJson({
      dryRun: true,
      action: "online-encrypted-backup",
      sourceDb: input.sourceDb,
      backupRoot: input.backupRoot,
      tempRoot: input.tempRoot,
      retention: { hourly: 24, daily: 14 },
    });
    return;
  }
  if (!input.ageIdentity) throw Object.assign(new Error("AGE_IDENTITY is required through Keychain"), { code: "AGE_IDENTITY_REQUIRED" });
  const result = await createOnlineBackup(input, {
    sqlite: createSqliteAdapter(),
    age: createAgeAdapter({ executable }),
  });
  printJson({
    dryRun: false,
    verified: result.verified,
    artifact: path.basename(result.hourlyArtifact),
    encryptedSha256: result.encryptedSha256,
    encryptedBytes: result.encryptedBytes,
  });
}

main().catch((error) => {
  process.stderr.write(`Backup failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
