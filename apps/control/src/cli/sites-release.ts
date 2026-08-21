import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  abortSitesReleaseHandoff,
  activateSitesReleaseHandoff,
  prepareSitesReleaseHandoff,
  recordSitesReleaseDeployment,
} from "../articles/sites-release-handoff.js";
import { closeDatabase } from "../db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import { parseSitesReleaseArguments } from "./arguments.js";

export function main(arguments_ = process.argv.slice(2)): void {
  const options = parseSitesReleaseArguments(arguments_);
  loadLocalEnvironment();
  const runtime = createControlRuntime();
  const context = {
    nowMs: Date.now(),
    requestId: `sites-release-${randomUUID()}`,
  };
  try {
    const identity = {
      releaseId: options.releaseId,
      manifestSha256: options.manifestSha256,
      sitesSourceCommit: options.sitesSourceCommit,
      environmentRevision: options.environmentRevision,
    };
    switch (options.action) {
      case "prepare": {
        const handoff = prepareSitesReleaseHandoff(runtime.db, {
          ...identity,
          expectedState: options.expectedState,
          bundleId: options.bundleId,
        }, context);
        process.stdout.write(`${JSON.stringify({ event: "sites.release.prepared", handoff })}\n`);
        break;
      }
      case "record-deployment": {
        const handoff = recordSitesReleaseDeployment(runtime.db, {
          ...identity,
          expectedState: options.expectedState,
          savedVersionId: options.savedVersionId,
          deploymentId: options.deploymentId,
          ...(options.expectedCurrentSavedVersionId === undefined
            ? {}
            : {
                expectedCurrentSavedVersionId: options.expectedCurrentSavedVersionId,
                expectedCurrentDeploymentId: options.expectedCurrentDeploymentId!,
              }),
        }, context);
        process.stdout.write(`${JSON.stringify({ event: "sites.release.deployment-recorded", handoff })}\n`);
        break;
      }
      case "activate": {
        const handoff = activateSitesReleaseHandoff(runtime.db, {
          ...identity,
          expectedState: options.expectedState,
          savedVersionId: options.savedVersionId,
          deploymentId: options.deploymentId,
          retiringWindowMs: options.retiringWindowMs,
        }, context);
        process.stdout.write(`${JSON.stringify({ event: "sites.release.activated", handoff })}\n`);
        break;
      }
      case "abort": {
        abortSitesReleaseHandoff(runtime.db, {
          ...identity,
          expectedState: options.expectedState,
          ...(options.expectedSavedVersionId === undefined
            ? {}
            : {
                expectedSavedVersionId: options.expectedSavedVersionId,
                expectedDeploymentId: options.expectedDeploymentId!,
              }),
        }, context);
        process.stdout.write(`${JSON.stringify({
          event: "sites.release.aborted",
          releaseId: options.releaseId,
        })}\n`);
        break;
      }
    }
  } finally {
    closeDatabase(runtime.db);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "SITES_RELEASE_FAILED"}\n`);
    process.exitCode = 1;
  }
}
