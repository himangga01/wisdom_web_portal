#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import os from "node:os";
import { constants } from "node:fs";
import path from "node:path";
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
    canonicalDeploymentPaths: async (paths) => ({
      releaseRoot: await realpath(paths.releaseRoot),
      currentLink: path.join(await realpath(path.dirname(paths.currentLink)), path.basename(paths.currentLink)),
      dataRoot: await realpath(paths.dataRoot),
      publicReleaseRoot: await realpath(paths.publicReleaseRoot),
      publicCurrentLink: path.join(
        await realpath(path.dirname(paths.publicCurrentLink)),
        path.basename(paths.publicCurrentLink),
      ),
    }),
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
    currentLink: option("--current"),
    dataRoot: option("--data-root"),
    binaries: {
      caddy: option("--caddy"),
      cloudflared: option("--cloudflared"),
      age: option("--age"),
    },
    sqliteMinimum: "3.51.3",
    ageVersion: "1.3.1",
    publicReleaseRoot: option("--public-release-root"),
    publicCurrentLink: option("--public-current"),
    allowBootstrapLocalStaging: process.argv.includes("--allow-bootstrap-local-staging"),
  }, adapter);
  process.stdout.write(`${JSON.stringify({ ...report, host: os.hostname() })}\n`);
}

main().catch((error) => {
  process.stderr.write(`Preflight failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
