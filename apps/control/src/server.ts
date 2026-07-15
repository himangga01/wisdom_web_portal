import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";

import { createControlApp } from "./app.js";
import { closeDatabase } from "./db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "./runtime.js";

loadLocalEnvironment();
const runtime = createControlRuntime();
const app = createControlApp({
  db: runtime.db,
  keyProvider: runtime.config.keyProvider,
  allowedOrigins: runtime.config.allowedOrigins,
  enforceOrigin: runtime.config.enforceOrigin,
  ...(runtime.config.publicOrigin && runtime.config.adminOrigin
    ? {
        publicOrigin: runtime.config.publicOrigin,
        adminOrigin: runtime.config.adminOrigin,
        authSecret: runtime.config.authSecret,
        withdrawalSecret: runtime.config.withdrawalSecret,
        dummyPasswordHash: runtime.config.dummyPasswordHash,
      }
    : {}),
  peerAddress: (context) => getConnInfo(context).remote.address ?? "unknown",
});

const server = serve({
  fetch: app.fetch,
  hostname: runtime.config.host,
  port: runtime.config.port,
}, (info) => {
  console.log(JSON.stringify({
    event: "control.started",
    host: runtime.config.host,
    port: info.port,
  }));
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  server.close(() => {
    closeDatabase(runtime.db);
    process.exitCode = 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
