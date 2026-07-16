#!/usr/bin/env node
import { spawn } from "node:child_process";

import { option, printJson } from "../lib/cli-options.mjs";
import {
  importAgeIdentity,
  importCodexApiCredential,
  importIndexNowKey,
  importSmtpCredential,
} from "../lib/keychain.mjs";

function securityAdd({ account, service, value }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/security",
      ["add-generic-password", "-a", account, "-s", service, "-w"],
      { shell: false, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error("security failed"), { code: "KEYCHAIN_IMPORT_FAILED" }));
    });
    child.stdin.end(`${value}\n`);
  });
}

async function readBoundedStdin(limit = 256) {
  process.stdin.setEncoding("utf8");
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (value.length > limit) throw Object.assign(new Error("Secret input too large"), { code: "AGE_IDENTITY_INVALID" });
  }
  return value;
}

async function main() {
  const argv = process.argv.slice(2);
  const account = option(argv, "--account");
  const kind = option(argv, "--kind", { required: false }) ?? "age-identity";
  if (!["age-identity", "codex-api", "indexnow-key", "smtp-json"].includes(kind)) {
    throw Object.assign(new Error("Unsupported import kind"), { code: "CLI_USAGE" });
  }
  const service = kind === "age-identity" ? undefined : option(argv, "--service");
  if (!argv.includes("--apply")) {
    const result = kind === "age-identity"
      ? await importAgeIdentity({ account, dryRun: true })
      : kind === "codex-api"
        ? await importCodexApiCredential({ account, service, dryRun: true })
        : kind === "indexnow-key"
          ? await importIndexNowKey({ account, service, dryRun: true })
          : await importSmtpCredential({ account, service, dryRun: true });
    printJson(result);
    return;
  }
  const value = await readBoundedStdin(
    kind === "age-identity" ? 256 : kind === "indexnow-key" ? 129 : kind === "codex-api" ? 4_097 : 8_192,
  );
  const adapter = { add: securityAdd };
  const result = kind === "age-identity"
    ? await importAgeIdentity({ account, value, dryRun: false, adapter })
    : kind === "codex-api"
      ? await importCodexApiCredential({ account, service, value, dryRun: false, adapter })
      : kind === "indexnow-key"
        ? await importIndexNowKey({ account, service, value, dryRun: false, adapter })
        : await importSmtpCredential({ account, service, value, dryRun: false, adapter });
  printJson(result);
}

main().catch((error) => {
  process.stderr.write(`Secret import failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
