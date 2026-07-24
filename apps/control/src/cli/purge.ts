import { closeAnalyticsDatabase, pruneAnalytics } from "../analytics/store.js";
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
  // Analytics retention rides the same hourly launchd job: destroying expired
  // salts and per-day visitor hashes is idempotent and cheap, so no separate
  // schedule is needed. A dry run must not delete anything.
  if (arguments_.apply) {
    console.log(JSON.stringify({
      event: "analytics.pruned",
      ...pruneAnalytics(runtime.analyticsDb, Date.now()),
    }));
  }
} finally {
  closeDatabase(runtime.db);
  closeAnalyticsDatabase(runtime.analyticsDb);
}
