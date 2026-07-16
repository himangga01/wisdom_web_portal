#!/usr/bin/env node
import { spawn } from "node:child_process";

import { installKeychainSecrets } from "../lib/keychain.mjs";

const definitions = [
  { environment: "ADMIN_SESSION_SECRET", service: "com.jihye.portal.admin-session", bytes: 32 },
  { environment: "CONTROL_HMAC_SECRET", service: "com.jihye.portal.control-hmac", bytes: 32 },
  { environment: "HERMES_HMAC_SECRET", service: "com.jihye.portal.hermes-hmac", bytes: 32 },
  { environment: "PII_ENCRYPTION_KEY", service: "com.jihye.portal.pii-key", bytes: 32 },
  { environment: "WITHDRAWAL_TOKEN_SECRET", service: "com.jihye.portal.withdrawal-token", bytes: 32 },
];

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, { shell: false, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(Object.assign(new Error("security failed"), { code }))));
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  });
}

async function main() {
  const account = option("--account");
  const mode = option("--mode") ?? "bootstrap";
  const only = option("--only");
  const dryRun = !process.argv.includes("--apply");
  if (mode === "rotate" && !only) {
    throw Object.assign(new Error("Rotation requires --only ENVIRONMENT"), { code: "KEYCHAIN_BULK_ROTATION_FORBIDDEN" });
  }
  const selectedDefinitions = only
    ? definitions.filter(({ environment }) => environment === only)
    : definitions;
  if (selectedDefinitions.length === 0) {
    throw Object.assign(new Error("Unknown secret environment"), { code: "INVALID_SECRET_MAPPING" });
  }
  const adapter = {
    exists: async ({ account: itemAccount, service }) => {
      try {
        await security(["find-generic-password", "-a", itemAccount, "-s", service]);
        return true;
      } catch (error) {
        if (error.code === 44) return false;
        throw Object.assign(new Error("Unable to inspect Keychain"), { code: "KEYCHAIN_INSPECTION_FAILED", cause: error });
      }
    },
    add: async ({ account: itemAccount, service, value, replace }) => {
      const args = ["add-generic-password", "-a", itemAccount, "-s", service];
      if (replace) args.push("-U");
      args.push("-w");
      await security(args, value);
    },
  };
  const result = await installKeychainSecrets({ account, definitions: selectedDefinitions, dryRun, mode, adapter });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Secret bootstrap failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
