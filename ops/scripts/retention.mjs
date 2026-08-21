#!/usr/bin/env node
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { acquireDatabaseMaintenanceLock } from "../lib/database-maintenance-lock.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export async function runRetentionMaintenance(
  { databasePath, command, args = [] },
  {
    acquireLock = acquireDatabaseMaintenanceLock,
    spawnChild = spawn,
  } = {},
) {
  if (
    typeof databasePath !== "string" ||
    typeof command !== "string" ||
    command.length === 0 ||
    !Array.isArray(args)
  ) {
    fail("RETENTION_ARGUMENT_INVALID", "Retention maintenance arguments are invalid");
  }
  const releaseLock = await acquireLock(databasePath);
  try {
    const child = spawnChild(command, args, {
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) {
      fail(
        "RETENTION_CHILD_FAILED",
        `Retention command failed with ${result.signal ?? `exit ${result.code}`}`,
      );
    }
    return { completed: true };
  } finally {
    await releaseLock();
  }
}

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  const databaseIndex = argv.indexOf("--database");
  if (
    separator < 0 ||
    databaseIndex < 0 ||
    databaseIndex + 1 >= separator ||
    separator + 1 >= argv.length
  ) {
    fail(
      "RETENTION_ARGUMENT_INVALID",
      "Usage: retention.mjs --database <absolute-path> -- <command> [args...]",
    );
  }
  return {
    databasePath: argv[databaseIndex + 1],
    command: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

async function main() {
  await runRetentionMaintenance(parseArguments(process.argv.slice(2)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Retention failed: ${error.code ?? "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
