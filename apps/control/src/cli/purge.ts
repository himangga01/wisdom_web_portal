import { closeDatabase } from "../db/client.js";
import { purgeExpiredConsultations } from "../retention/purge.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import { parsePurgeArguments } from "./arguments.js";

const arguments_ = parsePurgeArguments(process.argv.slice(2));
loadLocalEnvironment();
const runtime = createControlRuntime();
try {
  const result = purgeExpiredConsultations(runtime.db, {
    nowMs: Date.now(),
    apply: arguments_.apply,
    batchSize: arguments_.batchSize,
  });
  console.log(JSON.stringify({
    event: arguments_.apply ? "retention.purged" : "retention.dry-run",
    ...result,
  }));
} finally {
  closeDatabase(runtime.db);
}
