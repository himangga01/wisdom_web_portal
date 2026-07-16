#!/usr/bin/env node
import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

import { parseKeychainExecArgs } from "../lib/keychain.mjs";
import { launchKeychainCommand, loadRuntimeConfigFile } from "../lib/runtime-config.mjs";

const execFile = promisify(execFileCallback);

async function main() {
  const parsed = parseKeychainExecArgs(process.argv.slice(2));
  if (!parsed.configPath) throw Object.assign(new Error("Runtime config is required"), { code: "RUNTIME_CONFIG_REQUIRED" });
  const runtimeConfig = await loadRuntimeConfigFile(parsed.configPath);
  const code = await launchKeychainCommand({
    parsed,
    hostEnvironment: process.env,
    runtimeConfig,
    keychainAdapter: {
      read: async ({ account, service }) => {
        const { stdout } = await execFile("/usr/bin/security", [
          "find-generic-password",
          "-w",
          "-a",
          account,
          "-s",
          service,
        ], { encoding: "utf8", maxBuffer: 16 * 1024 });
        return stdout.replace(/[\r\n]+$/u, "");
      },
    },
    spawnChild: (command, args, options) => spawn(command, args, options),
    signalSource: process,
  });
  process.exitCode = code;
}

main().catch((error) => {
  process.stderr.write(`Keychain execution failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
