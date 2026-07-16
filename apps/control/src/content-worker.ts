import { randomUUID } from "node:crypto";

import { closeDatabase } from "./db/client.js";
import { initializeContentWorkerLanes } from "./articles/content-lanes.js";
import { runCodexTranslation } from "./articles/codex-executor.js";
import { deliverNextIndexNowOutbox } from "./articles/indexnow-outbox.js";
import {
  createIndexNowSender,
  resolveOptionalIndexNowKey,
} from "./articles/indexnow-sender.js";
import { createIndexNowDeliveryWorkerRunner } from "./articles/indexnow-worker.js";
import {
  claimArticleTranslationJob,
  commitArticleTranslationSuccess,
  failArticleTranslationJob,
  heartbeatArticleTranslationJob,
} from "./articles/translation-jobs.js";
import {
  createArticleTranslationWorkerRunner,
  processArticleTranslationCycle,
} from "./articles/translation-worker.js";
import {
  assertArticleCodexCliContract,
  createArticleCodexExecutorOptions,
  parseArticleWorkerConfig,
  resolveCodexApiKeyFromKeychain,
} from "./articles/worker-config.js";
import { createControlRuntime, loadLocalEnvironment } from "./runtime.js";

loadLocalEnvironment();
const runtime = createControlRuntime();
const safeLogger = { write: (event: object) => console.error(JSON.stringify(event)) };
const lanes = initializeContentWorkerLanes({
  createTranslation: () => {
    const workerConfig = parseArticleWorkerConfig(process.env);
    assertArticleCodexCliContract(workerConfig);
    const apiKey = resolveCodexApiKeyFromKeychain(workerConfig.keychainService);
    const executorOptions = createArticleCodexExecutorOptions(
      runtime.db,
      runtime.config.keyProvider,
      workerConfig,
      apiKey,
    );
    const articleWorkerId = `article-worker-${randomUUID()}`;
    return createArticleTranslationWorkerRunner({
      processNext: () => processArticleTranslationCycle({
        claim: () => claimArticleTranslationJob(runtime.db, {
          workerId: articleWorkerId,
          nowMs: Date.now(),
        }),
        heartbeat: (claim, nowMs) => heartbeatArticleTranslationJob(runtime.db, claim, nowMs),
        execute: (source, targetLocale) => runCodexTranslation(source, targetLocale, executorOptions),
        commit: (claim, result, nowMs) => commitArticleTranslationSuccess(
          runtime.db,
          runtime.config.keyProvider,
          claim,
          result,
          { nowMs, expectedModel: workerConfig.model },
        ),
        fail: (claim, errorCode, nowMs) => failArticleTranslationJob(
          runtime.db,
          claim,
          { nowMs, errorCode },
        ),
        now: Date.now,
        scheduleHeartbeat: (callback, intervalMs) => setInterval(callback, intervalMs),
        cancelHeartbeat: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      }),
      logger: safeLogger,
    });
  },
  createIndexNow: () => {
    const indexNowConfig = runtime.config.indexNow;
    if (!indexNowConfig) return null;
    const indexNowKey = resolveOptionalIndexNowKey(
      indexNowConfig.keychainService,
      safeLogger,
    );
    if (!indexNowKey) return undefined;
    const indexNowSender = createIndexNowSender(indexNowConfig, indexNowKey);
    const indexNowWorkerId = `indexnow-worker-${randomUUID()}`;
    return createIndexNowDeliveryWorkerRunner({
      processNext: () => deliverNextIndexNowOutbox(runtime.db, {
        workerId: indexNowWorkerId,
        now: Date.now,
        sendJson: indexNowSender,
      }),
      logger: safeLogger,
    });
  },
  logger: safeLogger,
});

lanes.start();
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await lanes.stop();
  closeDatabase(runtime.db);
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
