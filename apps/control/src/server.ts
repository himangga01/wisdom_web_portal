import { getConnInfo } from "@hono/node-server/conninfo";
import { serve } from "@hono/node-server";

import { createControlApp } from "./app.js";
import {
  createArticlePublicationActions,
  createReleaseConsentAuthorityResolver,
  reconcilePublicationActivation,
} from "./articles/publication-release.js";
import { createIndexNowKeyCache } from "./articles/indexnow-sender.js";
import { createDatabaseConsentAuthorityResolver } from "./consent/service.js";
import { closeAnalyticsDatabase } from "./analytics/store.js";
import { closeDatabase } from "./db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "./runtime.js";

loadLocalEnvironment();
const runtime = createControlRuntime();
const indexNowKeyCache = runtime.config.indexNow
  ? createIndexNowKeyCache({
      service: runtime.config.indexNow.keychainService,
      logger: { write: (event) => console.error(JSON.stringify(event)) },
    })
  : undefined;
indexNowKeyCache?.start();
const articlePublication = runtime.config.publication
  ? (() => {
      reconcilePublicationActivation(runtime.db, {
        requestId: "startup-publication-reconcile",
        nowMs: Date.now(),
      }, runtime.config.publication);
      return createArticlePublicationActions(
        runtime.db,
        runtime.config.keyProvider,
        runtime.config.publication,
      );
    })()
  : undefined;
const consentAuthorityResolver = runtime.config.publication
  ? createReleaseConsentAuthorityResolver(runtime.db, runtime.config.publication)
  : createDatabaseConsentAuthorityResolver(runtime.db);
const app = createControlApp({
  db: runtime.db,
  analyticsDb: runtime.analyticsDb,
  keyProvider: runtime.config.keyProvider,
  allowedOrigins: runtime.config.allowedOrigins,
  enforceOrigin: runtime.config.enforceOrigin,
  hermesHmacSecret: runtime.config.hermesHmacSecret,
  consentAuthorityResolver,
  ...(articlePublication ? { articlePublication } : {}),
  ...(indexNowKeyCache ? { indexNowKeyProvider: () => indexNowKeyCache.get() } : {}),
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
  indexNowKeyCache?.stop();
  server.close(() => {
    closeDatabase(runtime.db);
    closeAnalyticsDatabase(runtime.analyticsDb);
    process.exitCode = 0;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
