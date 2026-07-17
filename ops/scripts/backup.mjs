#!/usr/bin/env node
import path from "node:path";

import { createOnlineBackup } from "../lib/backup.mjs";
import { printJson } from "../lib/cli-options.mjs";
import { createAgeAdapter, createSqliteAdapter } from "../lib/system-adapters.mjs";

function usage(message) {
  throw Object.assign(new Error(message), { code: "CLI_USAGE" });
}

function parseArgs(argv) {
  const valueFlags = new Set(["--source", "--root", "--temp-root", "--age", "--recipient"]);
  const booleanFlags = new Set(["--automatic", "--apply"]);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (booleans.has(flag)) usage(`Duplicate ${flag}`);
      booleans.add(flag);
      continue;
    }
    if (!valueFlags.has(flag)) usage(`Unknown option ${flag}`);
    if (values.has(flag)) usage(`Duplicate ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${flag}`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of valueFlags) {
    if (!values.has(flag)) usage(`Missing ${flag}`);
  }
  return {
    source: values.get("--source"),
    root: values.get("--root"),
    tempRoot: values.get("--temp-root"),
    age: values.get("--age"),
    recipient: values.get("--recipient"),
    automatic: booleans.has("--automatic"),
    apply: booleans.has("--apply"),
  };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const input = {
    sourceDb: path.resolve(parsed.source),
    backupRoot: path.resolve(parsed.root),
    tempRoot: path.resolve(parsed.tempRoot),
    ageRecipient: parsed.recipient,
    ageIdentity: process.env.AGE_IDENTITY,
    now: new Date(),
    ...(parsed.automatic ? { automatic: true } : {}),
  };
  const executable = path.resolve(parsed.age);
  if (!parsed.apply) {
    printJson({
      dryRun: true,
      action: "online-encrypted-backup",
      automatic: parsed.automatic,
      sourceDb: input.sourceDb,
      backupRoot: input.backupRoot,
      tempRoot: input.tempRoot,
      retention: { hourly: 24, daily: 14 },
    });
    return;
  }
  if (process.env.WISDOM_KEYCHAIN_EXEC !== "1") {
    throw Object.assign(new Error("Backup apply must run through keychain-exec"), {
      code: "BACKUP_KEYCHAIN_EXEC_REQUIRED",
    });
  }
  if (!input.ageIdentity) throw Object.assign(new Error("AGE_IDENTITY is required through Keychain"), { code: "AGE_IDENTITY_REQUIRED" });
  const result = await createOnlineBackup(input, {
    sqlite: createSqliteAdapter(),
    age: createAgeAdapter({ executable }),
  });
  if (result.verified === false) {
    printJson({
      dryRun: false,
      verified: false,
      outcome: result.outcome,
      controlRevision: result.controlRevision,
    });
    return;
  }
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
