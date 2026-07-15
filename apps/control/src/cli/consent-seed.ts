import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  getConsentBundleDigest,
  seedCompleteConsentBundles,
  type ConsentDocumentSeed,
} from "../consent/service.js";
import { closeDatabase } from "../db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import { parseSeedArguments } from "./arguments.js";

const arguments_ = parseSeedArguments(process.argv.slice(2));
const untrusted: unknown = JSON.parse(readFileSync(resolve(arguments_.file), "utf8"));
if (!Array.isArray(untrusted)) throw new Error("Consent seed file must contain a JSON array");

loadLocalEnvironment();
const runtime = createControlRuntime();
try {
  const inserted = seedCompleteConsentBundles(
    runtime.db,
    untrusted as ConsentDocumentSeed[],
  );
  const bundleIds = [...new Set((untrusted as ConsentDocumentSeed[]).map((document) => document.bundleId))];
  const bundles = bundleIds.map((bundleId) => ({
    bundleId,
    confirmSha: getConsentBundleDigest(runtime.db, bundleId),
  }));
  console.log(JSON.stringify({ event: "consent.seeded", inserted, bundles }));
} finally {
  closeDatabase(runtime.db);
}
