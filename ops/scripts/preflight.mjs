#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import { constants } from "node:fs";
import { promisify } from "node:util";

import { runPreflight } from "../lib/preflight.mjs";
import { verifyPublicCurrent } from "../lib/public-release.mjs";
import { ensureRealDirectory } from "../lib/safe-paths.mjs";

const execFile = promisify(execFileCallback);

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  let Database;
  const adapter = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    ensureWritable: async (directory) => {
      const real = await ensureRealDirectory(directory, "PREFLIGHT_PATH_INVALID");
      await access(real, constants.R_OK | constants.W_OK | constants.X_OK);
    },
    inspectBinary: async (_name, executable) => execFile(executable, ["--version"], { timeout: 10_000 }),
    loadNativeModule: async () => {
      ({ default: Database } = await import("better-sqlite3"));
    },
    sqliteVersion: async () => {
      const database = new Database(":memory:");
      try {
        return database.prepare("SELECT sqlite_version() AS version").get().version;
      } finally {
        database.close();
      }
    },
    verifyPublicCurrent,
  };
  const report = await runPreflight({
    releaseRoot: option("--release-root"),
    dataRoot: option("--data-root"),
    binaries: {
      caddy: option("--caddy"),
      cloudflared: option("--cloudflared"),
      age: option("--age"),
    },
    sqliteMinimum: "3.51.3",
    publicReleaseRoot: option("--public-release-root"),
    publicCurrentLink: option("--public-current"),
  }, adapter);
  process.stdout.write(`${JSON.stringify({ ...report, host: os.hostname() })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Preflight failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
