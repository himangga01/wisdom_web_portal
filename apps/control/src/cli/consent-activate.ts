import { activateConsentBundle } from "../consent/service.js";
import { closeDatabase } from "../db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import { parseActivateArguments } from "./arguments.js";

const arguments_ = parseActivateArguments(process.argv.slice(2));
loadLocalEnvironment();
const runtime = createControlRuntime();
try {
  activateConsentBundle(runtime.db, arguments_.bundleId, Date.now(), arguments_.confirmSha);
  console.log(JSON.stringify({
    event: "consent.activated",
    bundleId: arguments_.bundleId,
    publicAuthority: "pending-publication",
    nextAction: "publish a verified release from /admin/publish/preview",
  }));
} finally {
  closeDatabase(runtime.db);
}
