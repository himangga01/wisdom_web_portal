import { closeDatabase } from "../db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";

loadLocalEnvironment();
const runtime = createControlRuntime();
try {
  console.log(JSON.stringify({ event: "database.migrated", status: "ok" }));
} finally {
  closeDatabase(runtime.db);
}
