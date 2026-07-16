#!/usr/bin/env node
import { lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";

import { option, printJson } from "../lib/cli-options.mjs";
import { copyPublicDist, verifyPublicReleaseDirectory, writePublicReleaseManifest } from "../lib/public-release.mjs";
import { atomicSwitchRelease } from "../lib/release-system.mjs";
import { assertNoSymlinkPath, ensureRealDirectory } from "../lib/safe-paths.mjs";

const RELEASE_ID = /^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/u;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function normalized(candidate) {
  const resolved = path.resolve(candidate);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function overlaps(left, right) {
  const relative = path.relative(normalized(left), normalized(right));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function pointsTo(currentLink, destination) {
  try {
    const metadata = await lstat(currentLink);
    return metadata.isSymbolicLink() && normalized(await realpath(currentLink)) === normalized(await realpath(destination));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function seedPublicRelease(input) {
  if (!RELEASE_ID.test(input.releaseId)) fail("PUBLIC_RELEASE_INVALID", "Release ID is invalid");

  const sourceMetadata = await lstat(input.sourceDist);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    fail("PUBLIC_RELEASE_INVALID", "Source dist must be a real directory");
  }
  await assertNoSymlinkPath(input.sourceDist, "PUBLIC_RELEASE_INVALID");
  const sourceReal = await realpath(input.sourceDist);
  const releaseReal = await ensureRealDirectory(input.publicReleaseRoot, "PUBLIC_RELEASE_INVALID");
  const pointerParent = await realpath(path.dirname(input.publicCurrentLink));
  if (normalized(pointerParent) !== normalized(path.dirname(releaseReal))) {
    fail("PUBLIC_RELEASE_INVALID", "Public current pointer must be a sibling of the release root");
  }
  if (overlaps(sourceReal, releaseReal) || overlaps(releaseReal, sourceReal)) {
    fail("PUBLIC_RELEASE_INVALID", "Source dist and public release root overlap");
  }
  if (normalized(path.dirname(input.destination)) !== normalized(releaseReal) || path.basename(input.destination) !== input.releaseId) {
    fail("PUBLIC_RELEASE_INVALID", "Destination must be a direct release-root child");
  }
  if (await exists(input.destination)) fail("PUBLIC_RELEASE_INVALID", "Destination already exists");
  if (await exists(input.publicCurrentLink) && !(await lstat(input.publicCurrentLink)).isSymbolicLink()) {
    fail("PUBLIC_RELEASE_INVALID", "Public current pointer must be a symlink");
  }

  let created = false;
  try {
    await copyPublicDist(sourceReal, input.destination);
    created = true;
    await writePublicReleaseManifest(input.destination, input.releaseId);
    await verifyPublicReleaseDirectory(input.destination, { allowBootstrap: true });
    await atomicSwitchRelease(input.destination, input.publicCurrentLink);
    return { dryRun: false, action: "seed-public-current", destination: input.destination, verified: true };
  } catch (error) {
    if (created && !(await pointsTo(input.publicCurrentLink, input.destination))) {
      await rm(input.destination, { recursive: true, force: true });
    }
    throw error;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const publicReleaseRoot = path.resolve(option(argv, "--public-release-root"));
  const releaseId = option(argv, "--release-id");
  const input = {
    sourceDist: path.resolve(option(argv, "--source-dist")),
    publicReleaseRoot,
    publicCurrentLink: path.resolve(option(argv, "--public-current")),
    releaseId,
    destination: path.join(publicReleaseRoot, releaseId),
  };

  if (!argv.includes("--apply")) {
    printJson({
      dryRun: true,
      action: "seed-public-current",
      destination: input.destination,
      steps: ["validate-realpaths-and-no-symlinks", "copy-public-dist", "write-and-verify-manifest", "atomic-pointer-switch"],
    });
    return;
  }
  printJson(await seedPublicRelease(input));
}

main().catch((error) => {
  process.stderr.write(`Public seed failed: ${error.code ?? "UNKNOWN"}\n`);
  process.exitCode = 1;
});
