import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { publishedConsentBundleSchema } from "@wisdom/shared";

import { verifySealedPublicationRelease } from "./publication-build.js";
import type {
  PublicationAuthorityWorkerInput,
  PublicationAuthorityWorkerResult,
} from "./publication-release.js";

export function verifyPublicationAuthorityFiles(
  input: PublicationAuthorityWorkerInput,
): PublicationAuthorityWorkerResult {
  const verified = verifySealedPublicationRelease(
    input.releasePath,
    input.publicOrigin,
  );
  if (verified.manifestSha256 !== input.expectedManifestSha256) {
    throw new Error("PUBLICATION_AUTHORITY_MANIFEST_MISMATCH");
  }
  return {
    manifestSha256: verified.manifestSha256,
    bundle: publishedConsentBundleSchema.parse(verified.consentBundle),
  };
}

if (!isMainThread) {
  try {
    parentPort?.postMessage({
      ok: true,
      result: verifyPublicationAuthorityFiles(
        workerData as PublicationAuthorityWorkerInput,
      ),
    });
  } catch {
    parentPort?.postMessage({ ok: false });
  }
}
