import { closeDatabase } from "../db/client.js";
import { drainExpiredConsultations } from "../retention/purge.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import { parsePurgeArguments } from "./arguments.js";

const arguments_ = parsePurgeArguments(process.argv.slice(2));
loadLocalEnvironment();
const runtime = createControlRuntime();
try {
  const result = drainExpiredConsultations(runtime.db, {
    nowMs: Date.now(),
    apply: arguments_.apply,
    batchSize: arguments_.batchSize,
    maxBatches: arguments_.maxBatches,
  });
  const incomplete = arguments_.apply && !result.complete;
  console.log(JSON.stringify({
    event: incomplete
      ? "retention.incomplete"
      : arguments_.apply ? "retention.purged" : "retention.dry-run",
    ...result,
  }));
  if (incomplete) process.exitCode = 1;
} finally {
  closeDatabase(runtime.db);
}
