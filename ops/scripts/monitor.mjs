#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import {
  createSystemMonitoringAdapters,
  loadMonitoringConfigFile,
  runLocalMonitor,
} from "../lib/monitoring.mjs";

function parseArgs(argv) {
  const configIndexes = argv.flatMap((value, index) => value === "--config" ? [index] : []);
  if (configIndexes.length !== 1 || !argv[configIndexes[0] + 1] || argv[configIndexes[0] + 1].startsWith("--")) {
    throw Object.assign(new Error("One config path is required"), { code: "MONITOR_CLI_USAGE" });
  }
  const allowed = new Set(["--config", "--validate-only", "--dry-run", "--apply"]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!allowed.has(value) && index !== configIndexes[0] + 1) {
      throw Object.assign(new Error("Unknown monitor option"), { code: "MONITOR_CLI_USAGE" });
    }
  }
  const modes = ["--validate-only", "--dry-run", "--apply"].filter((flag) => argv.includes(flag));
  if (modes.length !== 1) throw Object.assign(new Error("Select exactly one monitor mode"), { code: "MONITOR_CLI_USAGE" });
  return { configPath: argv[configIndexes[0] + 1], mode: modes[0] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadMonitoringConfigFile(options.configPath);
  if (options.mode === "--validate-only") {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      valid: true,
      externalPublicSeparate: true,
      keychainService: config.local.hermes.keychainService,
    })}\n`);
    return;
  }
  const apply = options.mode === "--apply";
  if (apply && process.env.WISDOM_KEYCHAIN_EXEC !== "1") {
    throw Object.assign(new Error("Applied monitoring requires Keychain execution"), { code: "MONITOR_KEYCHAIN_EXEC_REQUIRED" });
  }
  const secret = process.env.MONITOR_HERMES_HMAC_SECRET;
  const report = await runLocalMonitor({
    config,
    runId: randomUUID(),
    dryRun: !apply,
    ...(apply && typeof secret === "string" ? { secret: Buffer.from(secret, "utf8") } : {}),
  }, createSystemMonitoringAdapters());
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.exitCode;
}

main().catch((error) => {
  process.stderr.write(`Monitoring failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 3;
});
