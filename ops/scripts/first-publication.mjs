#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { option, printJson } from "../lib/cli-options.mjs";
import { createMacServiceAdapter } from "../lib/mac-services.mjs";
import { verifyPublicCurrent } from "../lib/public-release.mjs";
import { acquireReleaseOperationLock } from "../lib/release-operation-lock.mjs";

const SECRET_MAPPINGS = [
  "ADMIN_SESSION_SECRET=com.jihye.portal.admin-session",
  "CONTROL_HMAC_SECRET=com.jihye.portal.control-hmac",
  "HERMES_HMAC_SECRET=com.jihye.portal.hermes-hmac",
  "PII_ENCRYPTION_KEY=com.jihye.portal.pii-key",
  "WITHDRAWAL_TOKEN_SECRET=com.jihye.portal.withdrawal-token",
];

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function runInherited(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error("First publication child failed"), {
        code: "FIRST_PUBLICATION_CHILD_FAILED",
        exitCode: code,
        signal,
      }));
    });
  });
}

export function buildFirstPublicationKeychainArguments(input) {
  for (const candidate of [
    input.applicationRelease,
    input.nodeBinary,
    input.runtimeConfig,
  ]) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      fail("FIRST_PUBLICATION_PATH_INVALID", "First publication paths must be absolute");
    }
  }
  const keychainExec = path.join(input.applicationRelease, "ops", "scripts", "keychain-exec.mjs");
  const controlCli = path.join(
    input.applicationRelease,
    "apps",
    "control",
    "dist",
    "cli",
    "publication-first.js",
  );
  return [
    keychainExec,
    "--account",
    input.keychainAccount,
    "--config",
    input.runtimeConfig,
    ...SECRET_MAPPINGS.flatMap((mapping) => ["--secret", mapping]),
    "--",
    input.nodeBinary,
    controlCli,
    "--bootstrap-release-id",
    input.bootstrapReleaseId,
    "--actor-admin-id",
    input.actorAdminId,
    ...(input.apply
      ? ["--apply", "--confirm-first-publication", input.confirmFingerprint]
      : []),
  ];
}

export async function executeFirstPublication(input, overrides = {}) {
  const dependencies = {
    acquireOperationLock: acquireReleaseOperationLock,
    assertTunnelUnloaded: () => createMacServiceAdapter({
      labels: ["com.jihye.portal.cloudflared"],
    }).assertUnloaded(),
    verifyPublicCurrent,
    runControl: runInherited,
    ...overrides,
  };
  const releaseOperationLock = await dependencies.acquireOperationLock(input.publicReleaseRoot);
  try {
    await dependencies.assertTunnelUnloaded();
    const bootstrap = await dependencies.verifyPublicCurrent({
      publicReleaseRoot: input.publicReleaseRoot,
      publicCurrentLink: input.publicCurrentLink,
    });
    if (bootstrap.format !== "ops-bootstrap" || typeof bootstrap.releaseId !== "string") {
      fail("FIRST_PUBLICATION_BOOTSTRAP_REQUIRED", "Verified bootstrap release is required");
    }
    const applicationRelease = await realpath(input.applicationCurrent);
    const applicationMetadata = await lstat(applicationRelease);
    if (!applicationMetadata.isDirectory() || applicationMetadata.isSymbolicLink()) {
      fail("FIRST_PUBLICATION_PATH_INVALID", "Application current must resolve to a release directory");
    }
    const childInput = {
      ...input,
      applicationRelease,
      bootstrapReleaseId: bootstrap.releaseId,
    };
    await dependencies.runControl(
      input.nodeBinary,
      buildFirstPublicationKeychainArguments(childInput),
      { cwd: applicationRelease },
    );
    if (input.apply) {
      const published = await dependencies.verifyPublicCurrent({
        publicReleaseRoot: input.publicReleaseRoot,
        publicCurrentLink: input.publicCurrentLink,
        requireWisdom: true,
      });
      if (published.format !== "wisdom") {
        fail("FIRST_PUBLICATION_POSTCONDITION_FAILED", "Wisdom release verification failed");
      }
    }
    return { verified: true, bootstrapReleaseId: bootstrap.releaseId };
  } finally {
    await releaseOperationLock();
  }
}

export function firstPublicationDryRun(input) {
  return {
    dryRun: true,
    action: "first-publication",
    publicReleaseRoot: input.publicReleaseRoot,
    steps: [
      "acquire-public-release-operation-lock",
      "prove-cloudflared-unloaded",
      "verify-bootstrap-public-current",
      "load-keychain-backed-control-runtime",
      "compute-exact-publication-fingerprint",
      "apply-only-with-exact-fingerprint",
      "verify-wisdom-public-current",
    ],
  };
}

export async function main(argv = process.argv.slice(2)) {
  const plan = argv.includes("--plan");
  const apply = argv.includes("--apply");
  if (plan && apply) fail("FIRST_PUBLICATION_USAGE", "--plan and --apply are mutually exclusive");
  const confirmFingerprint = option(argv, "--confirm-first-publication", { required: false });
  if (apply && (!confirmFingerprint || !/^[a-f0-9]{64}$/u.test(confirmFingerprint))) {
    fail("FIRST_PUBLICATION_USAGE", "--apply requires an exact publication fingerprint");
  }
  if (!apply && confirmFingerprint !== undefined) {
    fail("FIRST_PUBLICATION_USAGE", "Confirmation is valid only with --apply");
  }
  const input = {
    publicReleaseRoot: path.resolve(option(argv, "--public-release-root")),
    publicCurrentLink: path.resolve(option(argv, "--public-current")),
    applicationCurrent: path.resolve(option(argv, "--application-current")),
    runtimeConfig: path.resolve(option(argv, "--runtime-config")),
    nodeBinary: path.resolve(option(argv, "--node")),
    keychainAccount: option(argv, "--account"),
    actorAdminId: option(argv, "--admin-id"),
    apply,
    ...(confirmFingerprint ? { confirmFingerprint } : {}),
  };
  if (!plan && !apply) {
    printJson(firstPublicationDryRun(input));
    return;
  }
  await executeFirstPublication(input);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`First publication failed: ${error.code ?? "UNKNOWN"}\n`);
    process.exitCode = 1;
  });
}
