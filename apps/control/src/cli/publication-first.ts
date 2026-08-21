import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { getActivePublishedConsentBundle } from "../consent/service.js";
import { parseControlConfig } from "../config.js";
import { closeDatabase, openDatabase, type ControlDatabase } from "../db/client.js";
import {
  publishApprovedArticles,
  verifiedBootstrapReleaseId,
  type PublicationActionResult,
  type PublicationReleaseConfig,
} from "../articles/publication-release.js";
import { loadLocalEnvironment } from "../runtime.js";
import { parseFirstPublicationArguments } from "./arguments.js";

export interface FirstPublicationPlan {
  action: "first-publication";
  bootstrapReleaseId: string;
  consentBundleId: string;
  eligiblePromotionCount: number;
  fingerprint: string;
}

interface FirstPublicationInput {
  bootstrapReleaseId: string;
  actorAdminId: string;
  nowMs: number;
}

function fail(code: string): never {
  throw new Error(code);
}

export function createFirstPublicationPlan(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  input: Pick<FirstPublicationInput, "bootstrapReleaseId" | "actorAdminId">,
): FirstPublicationPlan {
  const releaseCount = Number(db.sqlite.prepare(
    "SELECT count(*) count FROM releases",
  ).pluck().get());
  const pendingActivationCount = Number(db.sqlite.prepare(`
    SELECT count(*) count FROM release_activations
    WHERE state IN ('prepared', 'switched')
  `).pluck().get());
  if (releaseCount !== 0 || pendingActivationCount !== 0) {
    fail("FIRST_PUBLICATION_ALREADY_COMPLETED");
  }
  const bootstrapReleaseId = verifiedBootstrapReleaseId(config);
  if (bootstrapReleaseId !== input.bootstrapReleaseId) {
    fail("FIRST_PUBLICATION_BOOTSTRAP_CHANGED");
  }
  const admin = db.sqlite.prepare(
    "SELECT status FROM admins WHERE id = ?",
  ).get(input.actorAdminId) as { status: string } | undefined;
  if (admin?.status !== "active") fail("FIRST_PUBLICATION_ADMIN_INVALID");
  const bundle = getActivePublishedConsentBundle(db);
  if (!bundle) fail("FIRST_PUBLICATION_CONSENT_INCOMPLETE");
  const promotions = db.sqlite.prepare(`
    SELECT article_id, locale, head_revision_id, row_version
    FROM article_locale_heads
    WHERE state = 'approved' AND approved_revision_id = head_revision_id
    ORDER BY article_id, locale
  `).all() as Array<{
    article_id: string;
    locale: string;
    head_revision_id: string;
    row_version: number;
  }>;
  const fingerprint = createHash("sha256")
    .update("wisdom:first-publication:v1\0", "utf8")
    .update(JSON.stringify({
      bootstrapReleaseId,
      actorAdminId: input.actorAdminId,
      consentBundle: bundle,
      promotions: promotions.map((promotion) => [
        promotion.article_id,
        promotion.locale,
        promotion.head_revision_id,
        promotion.row_version,
      ]),
    }), "utf8")
    .digest("hex");
  return Object.freeze({
    action: "first-publication",
    bootstrapReleaseId,
    consentBundleId: bundle.bundleId,
    eligiblePromotionCount: promotions.length,
    fingerprint,
  });
}

export async function executeFirstPublication(
  db: ControlDatabase,
  keyProvider: ReturnType<typeof parseControlConfig>["keyProvider"],
  config: PublicationReleaseConfig,
  input: FirstPublicationInput & { apply: boolean; confirmFingerprint?: string },
  dependencies: {
    publish?: typeof publishApprovedArticles;
  } = {},
): Promise<FirstPublicationPlan | (PublicationActionResult & {
  action: "first-publication";
  fingerprint: string;
})> {
  const plan = createFirstPublicationPlan(db, config, input);
  if (!input.apply) return plan;
  if (input.confirmFingerprint !== plan.fingerprint) {
    fail("FIRST_PUBLICATION_CONFIRMATION_MISMATCH");
  }
  const result = await (dependencies.publish ?? publishApprovedArticles)(
    db,
    keyProvider,
    {
      actorAdminId: input.actorAdminId,
      requestId: `first-publication-${plan.fingerprint.slice(0, 16)}`,
      nowMs: input.nowMs,
    },
    config,
  );
  const active = db.sqlite.prepare(
    "SELECT id FROM releases WHERE state = 'active'",
  ).pluck().get();
  if (active !== result.releaseId) fail("FIRST_PUBLICATION_POSTCONDITION_FAILED");
  return {
    action: "first-publication",
    fingerprint: plan.fingerprint,
    ...result,
  };
}

export async function main(arguments_ = process.argv.slice(2)): Promise<void> {
  if (process.env.WISDOM_KEYCHAIN_EXEC !== "1") {
    fail("FIRST_PUBLICATION_KEYCHAIN_EXEC_REQUIRED");
  }
  const options = parseFirstPublicationArguments(arguments_);
  loadLocalEnvironment();
  const config = parseControlConfig(process.env);
  if (!config.publication) fail("FIRST_PUBLICATION_NOT_CONFIGURED");
  const db = openDatabase(config.databasePath);
  try {
    const result = await executeFirstPublication(
      db,
      config.keyProvider,
      config.publication,
      {
        bootstrapReleaseId: options.bootstrapReleaseId,
        actorAdminId: options.actorAdminId,
        nowMs: Date.now(),
        apply: options.apply,
        ...(options.confirmFingerprint
          ? { confirmFingerprint: options.confirmFingerprint }
          : {}),
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    closeDatabase(db);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "FIRST_PUBLICATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
