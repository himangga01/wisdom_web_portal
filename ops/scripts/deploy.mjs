#!/usr/bin/env node
import path from "node:path";

import { integerOption, option, printJson } from "../lib/cli-options.mjs";
import { deployRelease } from "../lib/release.mjs";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const input = {
    sourceRoot: path.resolve(option(argv, "--source")),
    releaseRoot: path.resolve(option(argv, "--release-root")),
    currentLink: path.resolve(option(argv, "--current")),
    releaseId: option(argv, "--release-id"),
    canaryPort: integerOption(argv, "--canary-port"),
    dryRun: !apply,
  };
  if (!apply) {
    printJson(await deployRelease(input, {}));
    return;
  }
  const { createMacReleaseAdapter } = await import("../lib/mac-release-adapter.mjs");
  const adapter = createMacReleaseAdapter({
    ...input,
    nodeBinary: path.resolve(option(argv, "--node")),
    npmBinary: path.resolve(option(argv, "--npm")),
    runtimeConfig: path.resolve(option(argv, "--runtime-config")),
    dataRoot: path.resolve(option(argv, "--data-root")),
    caddyBinary: path.resolve(option(argv, "--caddy")),
    cloudflaredBinary: path.resolve(option(argv, "--cloudflared")),
    ageBinary: path.resolve(option(argv, "--age")),
    publicReleaseRoot: path.resolve(option(argv, "--public-release-root")),
    publicCurrentLink: path.resolve(option(argv, "--public-current")),
    publicLiveUrl: option(argv, "--public-live-url"),
    keychainAccount: option(argv, "--account"),
  });
  printJson(await deployRelease(input, adapter));
}

main().catch((error) => {
  process.stderr.write(`Deploy failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
