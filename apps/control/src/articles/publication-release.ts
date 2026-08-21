import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";

import {
  LOCALES,
  publishedConsentBundleSchema,
  type PublishedConsentBundle,
} from "@wisdom/shared";

import {
  getActivePublishedConsentBundle,
  getPublishedConsentBundleById,
  type ConsentAuthorityResolver,
} from "../consent/service.js";
import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import {
  checkArticleForRetainedConsultationPii,
  collectReleasePiiSegments,
} from "./no-pii.js";
import {
  INDEXNOW_MAX_ATTEMPTS,
  INDEXNOW_RETRYABLE_ERROR_CODES,
} from "./indexnow-outbox.js";
import {
  createIndexNowPayload,
  IndexNowPayloadValidationError,
  type CreatedIndexNowPayload,
} from "./indexnow-payload.js";
import {
  computePublicationSnapshotManifestSha256,
  runPublicationBuild,
  verifyAndSealPublicationBuild,
  verifySealedPublicationRelease,
  type SealedPublicationRelease,
} from "./publication-build.js";
import {
  capturePublicationSnapshot,
  writePublicationSnapshot,
  type PublicationPromotion,
  type PublicationSnapshot,
} from "./publication-snapshot.js";

export interface PublicationReleaseConfig {
  releaseRoot: string;
  currentLink: string;
  siteSourceRoot: string;
  npmBinary: string;
  nodeBinary: string;
  buildTimeoutMs: number;
  requiredCoreRoutes: readonly string[];
  forbiddenCanaries: readonly string[];
  publicOrigin: string;
  kakaoChatUrl?: string;
  naverSiteVerificationMeta?: string;
  naverSiteVerificationFile?: string;
}

export type PublicationActivationFaultPoint =
  | "before-switch"
  | "after-switch"
  | "before-db-commit"
  | "after-db-commit"
  | "after-rollback-pii-scan";

export interface PublicationReleaseDependencies {
  randomUUID: () => string;
  prepareRelease(input: {
    snapshot: PublicationSnapshot;
    snapshotDirectory: string;
    outputDirectory: string;
    buildHome: string;
    config: PublicationReleaseConfig;
  }): Promise<SealedPublicationRelease>;
  faultInjector?: (point: PublicationActivationFaultPoint) => void;
  switchCurrent?: (targetPath: string, currentLink: string, nonce: string) => void;
  activateAuthority?: (handoff: AuthorityActivationHandoff) => boolean;
}

export interface ReleaseConsentAuthorityResolverOptions {
  onFullVerification?: () => void;
  scheduleRefresh?: (task: () => void) => void;
  verifyAuthority?: (
    input: PublicationAuthorityWorkerInput,
  ) => Promise<PublicationAuthorityWorkerResult>;
  refreshIntervalMs?: number;
  now?: () => number;
}

export interface CachedReleaseConsentAuthorityResolver extends ConsentAuthorityResolver {
  activate(handoff: AuthorityActivationHandoff): boolean;
  refresh(): Promise<boolean>;
  stop(): void;
}

export interface AuthorityActivationHandoff {
  releaseId: string;
  activationGeneration: number;
  manifestSha256: string;
  bundle: PublishedConsentBundle;
}

export interface PublicationAuthorityWorkerInput {
  releasePath: string;
  publicOrigin: string;
  expectedManifestSha256: string;
}

export interface PublicationAuthorityWorkerResult {
  manifestSha256: string;
  bundle: PublishedConsentBundle;
}

export interface PublicationActionInput {
  actorAdminId: string;
  requestId: string;
  nowMs: number;
  mode?: "next-batch" | "policy-only";
  expectedFingerprint?: string;
}

export interface PublicationActionResult {
  releaseId: string;
  version: string;
  manifestSha256: string;
}

export interface PublicationBatchPreview {
  eligibleTotal: number;
  batchCount: number;
  remainingAfterBatch: number;
  mode: "next-batch" | "policy-only";
  fingerprint: string;
}

export interface PublicationBatchPlan extends PublicationBatchPreview {
  promotions: readonly PublicationPromotion[];
}

export type PublicationActivationOutcome =
  | { kind: "committed"; result: PublicationActionResult }
  | { kind: "reverted"; activationId: string; previousReleaseId: string | null }
  | { kind: "manual-recovery-required"; activationId: string; errorCode: string };

export class PublicationActivationSettlementError extends Error {
  readonly outcome: Exclude<PublicationActivationOutcome, { kind: "committed" }>;

  constructor(outcome: Exclude<PublicationActivationOutcome, { kind: "committed" }>) {
    super(outcome.kind === "reverted"
      ? "PUBLICATION_ACTIVATION_REVERTED"
      : "PUBLICATION_MANUAL_RECOVERY_REQUIRED");
    this.name = "PublicationActivationSettlementError";
    this.outcome = outcome;
  }
}

interface ReleaseRow {
  id: string;
  version: string;
  path: string;
  manifest_sha256: Buffer;
  state: "building" | "active" | "retired" | "failed";
  created_at_ms: number;
  created_by: string;
  activated_at_ms: number | null;
  activation_generation: number;
  metadata_json: string | null;
}

interface ActivationRow {
  id: string;
  release_id: string;
  previous_release_id: string | null;
  operation: "publish" | "rollback" | "reconcile";
  state: "prepared" | "switched";
  manifest_sha256: Buffer;
  target_path: string;
  previous_path: string | null;
}

interface PublicationReleaseMetadata {
  schemaVersion: 1;
  snapshotManifestSha256: string;
  baseReleaseId: string | null;
  baseReleaseGeneration: number;
  promotions: PublicationPromotion[];
  publicationMode?: "next-batch" | "policy-only";
  consentBundle: {
    bundleId: string;
    contentFileSha256: string;
  };
}

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function safeUuid(randomUUID: () => string): string {
  const value = randomUUID().toLowerCase();
  if (!UUID_PATTERN.test(value)) throw new Error("PUBLICATION_UUID_INVALID");
  return value;
}

function validateConfig(config: PublicationReleaseConfig): void {
  for (const [value, code] of [
    [config.releaseRoot, "PUBLICATION_RELEASE_ROOT_INVALID"],
    [config.currentLink, "PUBLICATION_CURRENT_LINK_INVALID"],
    [config.siteSourceRoot, "PUBLICATION_SITE_ROOT_INVALID"],
    [config.npmBinary, "PUBLICATION_NPM_BINARY_INVALID"],
    [config.nodeBinary, "PUBLICATION_NODE_BINARY_INVALID"],
  ] as const) if (!isAbsolute(value)) throw new Error(code);
  const releaseMetadata = lstatSync(config.releaseRoot);
  if (!releaseMetadata.isDirectory() || releaseMetadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_RELEASE_ROOT_INVALID");
  }
  const currentParent = dirname(config.currentLink);
  const parentMetadata = lstatSync(currentParent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_CURRENT_PARENT_INVALID");
  }
  if (statSync(realpathSync(config.releaseRoot)).dev !== statSync(realpathSync(currentParent)).dev) {
    throw new Error("PUBLICATION_CURRENT_LINK_CROSS_DEVICE");
  }
  if (realpathSync(currentParent) !== realpathSync(dirname(config.releaseRoot))) {
    throw new Error("PUBLICATION_CURRENT_LINK_NOT_RELEASE_ROOT_SIBLING");
  }
  const origin = new URL(config.publicOrigin);
  if (origin.origin !== config.publicOrigin || origin.username || origin.password) {
    throw new Error("PUBLICATION_ORIGIN_INVALID");
  }
}

function assertDirectReleasePath(releaseRoot: string, candidate: string): string {
  if (!isAbsolute(candidate)) throw new Error("PUBLICATION_RELEASE_PATH_INVALID");
  const metadata = lstatSync(candidate);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_RELEASE_PATH_INVALID");
  }
  const root = realpathSync(releaseRoot);
  const target = realpathSync(candidate);
  const containment = relative(root, target);
  if (!containment || containment.startsWith(`..${sep}`) || containment === ".."
    || isAbsolute(containment) || containment.includes(sep)) {
    throw new Error("PUBLICATION_RELEASE_PATH_INVALID");
  }
  return target;
}

function readCurrentTarget(config: PublicationReleaseConfig): string | null {
  let metadata;
  try {
    metadata = lstatSync(config.currentLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!metadata.isSymbolicLink()) throw new Error("PUBLICATION_CURRENT_LINK_NOT_SYMLINK");
  const raw = readlinkSync(config.currentLink);
  const candidate = isAbsolute(raw) ? raw : resolve(dirname(config.currentLink), raw);
  return assertDirectReleasePath(config.releaseRoot, candidate);
}

interface CurrentPointerIdentity {
  targetPath: string;
  rawTarget: string;
  pointerIdentity: string;
  targetIdentity: string;
}

function filesystemIdentity(metadata: Stats): string {
  return [
    metadata.dev,
    metadata.ino,
    metadata.mode,
    metadata.size,
    metadata.ctimeMs,
    metadata.mtimeMs,
  ].join(":");
}

function readCurrentPointerIdentity(config: PublicationReleaseConfig): CurrentPointerIdentity | null {
  let pointerMetadata: Stats;
  try {
    pointerMetadata = lstatSync(config.currentLink);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!pointerMetadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_CURRENT_LINK_NOT_SYMLINK");
  }
  const rawTarget = readlinkSync(config.currentLink);
  const candidate = isAbsolute(rawTarget)
    ? rawTarget
    : resolve(dirname(config.currentLink), rawTarget);
  const targetPath = assertDirectReleasePath(config.releaseRoot, candidate);
  return {
    targetPath,
    rawTarget,
    pointerIdentity: filesystemIdentity(pointerMetadata),
    targetIdentity: filesystemIdentity(lstatSync(targetPath)),
  };
}

function verifyBootstrapRelease(directory: string): string {
  const manifestPath = join(directory, ".ops-public-release.json");
  let manifestMetadata;
  try {
    manifestMetadata = lstatSync(manifestPath);
  } catch {
    throw new Error("PUBLICATION_BOOTSTRAP_MANIFEST_MISSING");
  }
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
    || manifestMetadata.size > 2 * 1_048_576) {
    throw new Error("PUBLICATION_BOOTSTRAP_MANIFEST_INVALID");
  }
  const bytes = readFileSync(manifestPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("PUBLICATION_BOOTSTRAP_MANIFEST_INVALID");
  }
  if (bytes.toString("utf8") !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error("PUBLICATION_BOOTSTRAP_MANIFEST_INVALID");
  }
  const manifest = parsed as {
    formatVersion?: unknown;
    kind?: unknown;
    releaseId?: unknown;
    createdAt?: unknown;
    files?: unknown;
  };
  if (Object.keys(manifest).sort().join("\0") !== "createdAt\0files\0formatVersion\0kind\0releaseId"
    || manifest.formatVersion !== 1 || manifest.kind !== "bootstrap"
    || typeof manifest.releaseId !== "string" || manifest.releaseId.length < 1
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) {
    throw new Error("PUBLICATION_BOOTSTRAP_MANIFEST_INVALID");
  }
  const files = manifest.files as Record<string, unknown>;
  const inventory: Array<{ path: string; bytes: Buffer }> = [];
  const visit = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const safePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (safePath === ".ops-public-release.json") continue;
      const child = join(current, entry.name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) throw new Error("PUBLICATION_BOOTSTRAP_SYMLINK_REJECTED");
      if (metadata.isDirectory()) visit(child, safePath);
      else if (metadata.isFile()) inventory.push({ path: safePath, bytes: readFileSync(child) });
      else throw new Error("PUBLICATION_BOOTSTRAP_SPECIAL_FILE_REJECTED");
    }
  };
  visit(directory, "");
  inventory.sort((left, right) => left.path.localeCompare(right.path));
  const expectedPaths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  if (inventory.map(({ path }) => path).join("\0") !== expectedPaths.join("\0")
    || !expectedPaths.includes("index.html")) {
    throw new Error("PUBLICATION_BOOTSTRAP_INVENTORY_MISMATCH");
  }
  for (const file of inventory) {
    const expected = files[file.path];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)
      || createHash("sha256").update(file.bytes).digest("hex") !== expected) {
      throw new Error("PUBLICATION_BOOTSTRAP_HASH_MISMATCH");
    }
  }
  return manifest.releaseId;
}

export function verifiedBootstrapReleaseId(config: PublicationReleaseConfig): string {
  validateConfig(config);
  const active = readCurrentTarget(config);
  if (active === null) throw new Error("PUBLICATION_BOOTSTRAP_POINTER_MISSING");
  return verifyBootstrapRelease(active);
}

function switchCurrentAtomic(targetPath: string, currentLink: string, nonce: string): void {
  const temporary = `${currentLink}.next-${nonce}`;
  const previous = `${currentLink}.previous-${nonce}`;
  if (existsSync(temporary) || existsSync(previous)) throw new Error("PUBLICATION_SWITCH_TEMP_EXISTS");
  symlinkSync(targetPath, temporary, process.platform === "win32" ? "junction" : "dir");
  try {
    if (process.platform === "win32" && existsSync(currentLink)) {
      renameSync(currentLink, previous);
      try {
        renameSync(temporary, currentLink);
      } catch (error) {
        renameSync(previous, currentLink);
        throw error;
      }
      unlinkSync(previous);
    } else {
      renameSync(temporary, currentLink);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function defaultPrepareRelease(input: {
  snapshot: PublicationSnapshot;
  snapshotDirectory: string;
  outputDirectory: string;
  buildHome: string;
  config: PublicationReleaseConfig;
}): Promise<SealedPublicationRelease> {
  await runPublicationBuild({
    siteSourceRoot: input.config.siteSourceRoot,
    snapshotDirectory: input.snapshotDirectory,
    outputDirectory: input.outputDirectory,
    buildHome: input.buildHome,
    npmBinary: input.config.npmBinary,
    nodeBinary: input.config.nodeBinary,
    timeoutMs: input.config.buildTimeoutMs,
    publicOrigin: input.config.publicOrigin,
    ...(input.config.kakaoChatUrl
      ? { kakaoChatUrl: input.config.kakaoChatUrl }
      : {}),
    ...(input.config.naverSiteVerificationMeta
      ? { naverSiteVerificationMeta: input.config.naverSiteVerificationMeta }
      : {}),
    ...(input.config.naverSiteVerificationFile
      ? { naverSiteVerificationFile: input.config.naverSiteVerificationFile }
      : {}),
  });
  return verifyAndSealPublicationBuild({
    outputDirectory: input.outputDirectory,
    snapshot: input.snapshot,
    requiredCoreRoutes: input.config.requiredCoreRoutes,
    forbiddenCanaries: input.config.forbiddenCanaries,
    publicOrigin: input.config.publicOrigin,
  });
}

function resolvedDependencies(
  dependencies?: Partial<PublicationReleaseDependencies>,
): PublicationReleaseDependencies {
  return {
    randomUUID: dependencies?.randomUUID ?? nodeRandomUUID,
    prepareRelease: dependencies?.prepareRelease ?? defaultPrepareRelease,
    ...(dependencies?.faultInjector ? { faultInjector: dependencies.faultInjector } : {}),
    ...(dependencies?.switchCurrent ? { switchCurrent: dependencies.switchCurrent } : {}),
    ...(dependencies?.activateAuthority
      ? { activateAuthority: dependencies.activateAuthority }
      : {}),
  };
}

function versionName(nowMs: number, releaseId: string): string {
  const timestamp = new Date(nowMs).toISOString().replace(/[-:.]/g, "");
  return `release-${timestamp}-${releaseId.slice(0, 8)}`;
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(message) ? message : "PUBLICATION_FAILED";
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function consentBundlesEqual(
  left: PublishedConsentBundle,
  right: PublishedConsentBundle,
): boolean {
  return canonicalJson(publishedConsentBundleSchema.parse(left))
    === canonicalJson(publishedConsentBundleSchema.parse(right));
}

function parsePublicationReleaseMetadata(value: string | null): PublicationReleaseMetadata {
  let parsed: unknown;
  try {
    parsed = value === null ? undefined : JSON.parse(value);
  } catch {
    throw new Error("PUBLICATION_RELEASE_METADATA_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PUBLICATION_RELEASE_METADATA_INVALID");
  }
  const record = parsed as Partial<PublicationReleaseMetadata>;
  const keys = Object.keys(record).sort().join("\0");
  if (
    ![
      "baseReleaseGeneration\0baseReleaseId\0consentBundle\0promotions\0schemaVersion\0snapshotManifestSha256",
      "baseReleaseGeneration\0baseReleaseId\0consentBundle\0promotions\0publicationMode\0schemaVersion\0snapshotManifestSha256",
    ].includes(keys)
    || record.schemaVersion !== 1
    || typeof record.snapshotManifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.snapshotManifestSha256)
    || (record.baseReleaseId !== null && typeof record.baseReleaseId !== "string")
    || !Number.isSafeInteger(record.baseReleaseGeneration)
    || (record.baseReleaseGeneration ?? -1) < 0
    || !Array.isArray(record.promotions)
    || record.promotions.length > 64
    || (
      record.publicationMode !== undefined &&
      !["next-batch", "policy-only"].includes(record.publicationMode)
    )
    || !record.consentBundle || typeof record.consentBundle !== "object"
    || Object.keys(record.consentBundle).sort().join("\0") !== "bundleId\0contentFileSha256"
    || typeof record.consentBundle.bundleId !== "string"
    || !record.consentBundle.bundleId.trim()
    || record.consentBundle.bundleId.length > 200
    || typeof record.consentBundle.contentFileSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(record.consentBundle.contentFileSha256)) {
    throw new Error("PUBLICATION_RELEASE_METADATA_INVALID");
  }
  const identities = new Set<string>();
  for (const promotion of record.promotions) {
    if (!promotion || typeof promotion !== "object" || Array.isArray(promotion)
      || Object.keys(promotion).sort().join("\0")
        !== "articleId\0expectedRowVersion\0locale\0revisionId"
      || typeof promotion.articleId !== "string" || !promotion.articleId
      || typeof promotion.revisionId !== "string" || !promotion.revisionId
      || !LOCALES.includes(promotion.locale)
      || !Number.isSafeInteger(promotion.expectedRowVersion)
      || promotion.expectedRowVersion < 1) {
      throw new Error("PUBLICATION_RELEASE_METADATA_INVALID");
    }
    const identity = `${promotion.articleId}\0${promotion.locale}`;
    if (identities.has(identity)) throw new Error("PUBLICATION_RELEASE_METADATA_INVALID");
    identities.add(identity);
  }
  return record as PublicationReleaseMetadata;
}

function recordPublicationDiagnostic(
  db: ControlDatabase,
  input: PublicationActionInput,
  releaseId: string,
  version: string,
  action: "article.release.build_failed" | "article.release.cleanup_failed",
  error: unknown,
  metadata: Record<string, string>,
): void {
  const errorCode = safeFailureCode(error);
  try {
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, ?, ?, ?, 'release-attempt', ?, ?, ?, ?)
    `).run(
      safeUuid(nodeRandomUUID),
      input.actorAdminId ? "admin" : "system",
      input.actorAdminId || "publication-service",
      action,
      releaseId,
      input.requestId,
      JSON.stringify({ releaseId, version, errorCode, ...metadata }),
      input.nowMs,
    );
  } catch {
    // Operational diagnostics must never replace the publication outcome.
  }
}

function recordBuildFailure(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  input: PublicationActionInput,
  releaseId: string,
  version: string,
  error: unknown,
): void {
  const errorCode = safeFailureCode(error);
  try {
    appendFileSync(
      join(config.releaseRoot, "failed-publication.log"),
      `${new Date(input.nowMs).toISOString()} ${errorCode}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // The original publication error remains authoritative.
  }
  recordPublicationDiagnostic(
    db,
    input,
    releaseId,
    version,
    "article.release.build_failed",
    error,
    { phase: "prepare" },
  );
}

function approvedPromotions(db: ControlDatabase, limit = 64): PublicationPromotion[] {
  return (db.sqlite.prepare(`
    SELECT article_id, locale, head_revision_id, row_version
    FROM article_locale_heads
    WHERE state = 'approved' AND approved_revision_id = head_revision_id
    ORDER BY article_id, locale
    LIMIT ?
  `).all(limit) as Array<{
    article_id: string;
    locale: PublicationPromotion["locale"];
    head_revision_id: string;
    row_version: number;
  }>).map((row) => ({
    articleId: row.article_id,
    locale: row.locale,
    revisionId: row.head_revision_id,
    expectedRowVersion: row.row_version,
  }));
}

export function createPublicationBatchPlan(
  db: ControlDatabase,
  mode: "next-batch" | "policy-only" = "next-batch",
): PublicationBatchPlan {
  return db.sqlite.transaction(() => {
    const eligibleTotal = Number(db.sqlite.prepare(`
      SELECT count(*) FROM article_locale_heads
      WHERE state = 'approved' AND approved_revision_id = head_revision_id
    `).pluck().get());
    const promotions = mode === "next-batch" ? approvedPromotions(db, 64) : [];
    const bundle = getActivePublishedConsentBundle(db);
    if (!bundle) throw new Error("PUBLICATION_CONSENT_BUNDLE_INVALID");
    const activeRelease = db.sqlite.prepare(`
      SELECT id, activation_generation, manifest_sha256
      FROM releases WHERE state = 'active'
    `).get() as {
      id: string;
      activation_generation: number;
      manifest_sha256: Buffer;
    } | undefined;
    const fingerprint = createHash("sha256")
      .update("wisdom:publication-batch:v1\0", "utf8")
      .update(JSON.stringify({
        mode,
        consentBundleId: bundle.bundleId,
        consentDocuments: bundle.documents.map((document) => [
          document.kind,
          document.locale,
          document.version,
          document.contentSha256,
        ]),
        activeRelease: activeRelease
          ? [
              activeRelease.id,
              activeRelease.activation_generation,
              activeRelease.manifest_sha256.toString("hex"),
            ]
          : null,
        promotions: promotions.map((promotion) => [
          promotion.articleId,
          promotion.locale,
          promotion.revisionId,
          promotion.expectedRowVersion,
        ]),
      }), "utf8")
      .digest("hex");
    return Object.freeze({
      eligibleTotal,
      batchCount: promotions.length,
      remainingAfterBatch: mode === "next-batch"
        ? Math.max(0, eligibleTotal - promotions.length)
        : eligibleTotal,
      mode,
      fingerprint,
      promotions: Object.freeze(promotions.map((promotion) => Object.freeze(promotion))),
    });
  }).deferred();
}

function assertBaseReleaseConsistent(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  snapshot: PublicationSnapshot,
): void {
  const active = db.sqlite.prepare(`
    SELECT id, path, manifest_sha256, activation_generation
    FROM releases WHERE state = 'active'
  `).get() as {
    id: string;
    path: string;
    manifest_sha256: Buffer;
    activation_generation: number;
  } | undefined;
  if ((active?.id ?? null) !== snapshot.baseReleaseId
    || (active?.activation_generation ?? 0) !== snapshot.baseReleaseGeneration) {
    throw new Error("PUBLICATION_BASE_RELEASE_CHANGED");
  }
  const current = readCurrentTarget(config);
  if (!active) {
    if (current !== null) verifyBootstrapRelease(current);
    return;
  }
  const path = assertDirectReleasePath(config.releaseRoot, active.path);
  if (current !== path) throw new Error("PUBLICATION_BASE_POINTER_MISMATCH");
  const verified = verifySealedPublicationRelease(path, config.publicOrigin);
  if (!active.manifest_sha256.equals(Buffer.from(verified.manifestSha256, "hex"))) {
    throw new Error("PUBLICATION_BASE_MANIFEST_MISMATCH");
  }
}

function assertConsentBundleConsistent(
  db: ControlDatabase,
  snapshot: PublicationSnapshot,
): PublishedConsentBundle {
  const active = getActivePublishedConsentBundle(db);
  if (!active || !consentBundlesEqual(active, snapshot.consentBundle)) {
    throw new Error("PUBLICATION_CONSENT_BUNDLE_CHANGED_DURING_BUILD");
  }
  return active;
}

function insertPreparedRelease(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  snapshot: PublicationSnapshot,
  input: PublicationActionInput,
  release: PublicationActionResult & {
    path: string;
    sourcePath: string;
    activationId: string;
    snapshotManifestSha256: string;
    consentBundle: {
      bundleId: string;
      contentFileSha256: string;
    };
  },
  config: PublicationReleaseConfig,
): SealedPublicationRelease {
  const sourcePath = assertDirectReleasePath(config.releaseRoot, release.sourcePath);
  const root = realpathSync(config.releaseRoot);
  if (dirname(resolve(release.path)) !== root
    || basename(release.path) !== release.version
    || existsSync(release.path)) {
    throw new Error("PUBLICATION_FINAL_PATH_INVALID");
  }
  let renamed = false;
  try {
    return db.sqlite.transaction(() => {
    const active = db.sqlite.prepare(`
      SELECT id, activation_generation FROM releases WHERE state = 'active'
    `).get() as { id: string; activation_generation: number } | undefined;
    if ((active?.id ?? null) !== snapshot.baseReleaseId
      || (active?.activation_generation ?? 0) !== snapshot.baseReleaseGeneration) {
      throw new Error("PUBLICATION_BASE_RELEASE_CHANGED");
    }
    const activeConsentBundle = assertConsentBundleConsistent(db, snapshot);
    const consentPii = checkArticleForRetainedConsultationPii(
      db,
      keyProvider,
      activeConsentBundle.documents.flatMap((document) => [document.title, document.bodyMarkdown]),
    );
    if (!consentPii.safe) throw new Error("PUBLICATION_PII_CHANGED_DURING_BUILD");
    for (const promotion of snapshot.promotions) {
      const head = db.sqlite.prepare(`
        SELECT state, head_revision_id, approved_revision_id, row_version
        FROM article_locale_heads WHERE article_id = ? AND locale = ?
      `).get(promotion.articleId, promotion.locale) as {
        state: string;
        head_revision_id: string;
        approved_revision_id: string | null;
        row_version: number;
      } | undefined;
      if (!head
        || head.state !== "approved"
        || head.head_revision_id !== promotion.revisionId
        || head.approved_revision_id !== promotion.revisionId
        || head.row_version !== promotion.expectedRowVersion) {
        throw new Error("PUBLICATION_PROMOTION_CHANGED_DURING_BUILD");
      }
    }
    for (const document of snapshot.documents) {
      const liveRevision = db.sqlite.prepare(`
        SELECT title, summary, body_markdown, sources_json
        FROM article_revisions WHERE id = ? AND article_id = ? AND locale = ?
      `).get(document.revisionId, document.articleId, document.locale) as {
        title: string;
        summary: string;
        body_markdown: string;
        sources_json: string;
      } | undefined;
      if (!liveRevision) throw new Error("PUBLICATION_REVISION_MISSING_DURING_BUILD");
      const sourceValues = (JSON.parse(liveRevision.sources_json) as Array<{ id?: unknown; url?: unknown }>)
        .flatMap((source) => [String(source.id ?? ""), String(source.url ?? "")]);
      const pii = checkArticleForRetainedConsultationPii(db, keyProvider, [
        liveRevision.title,
        liveRevision.summary,
        liveRevision.body_markdown,
        document.slug,
        document.route,
        ...sourceValues,
      ]);
      if (!pii.safe) throw new Error("PUBLICATION_PII_CHANGED_DURING_BUILD");
    }
    renameSync(sourcePath, release.path);
    renamed = true;
    const finalVerified = verifySealedPublicationRelease(release.path, config.publicOrigin);
    if (finalVerified.manifestSha256 !== release.manifestSha256
      || finalVerified.manifest.snapshotManifestSha256 !== release.snapshotManifestSha256
      || finalVerified.manifest.consentBundle.bundleId !== release.consentBundle.bundleId
      || finalVerified.manifest.consentBundle.contentFileSha256
        !== release.consentBundle.contentFileSha256) {
      throw new Error("PUBLICATION_FINAL_RELEASE_MISMATCH");
    }
    db.sqlite.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by,
        metadata_json, verified_at_ms, verification_sha256
      ) VALUES (?, ?, ?, ?, 'building', ?, ?, ?, ?, ?)
    `).run(
      release.releaseId,
      release.version,
      release.path,
      Buffer.from(release.manifestSha256, "hex"),
      input.nowMs,
      input.actorAdminId,
      JSON.stringify({
        schemaVersion: 1,
        snapshotManifestSha256: release.snapshotManifestSha256,
        baseReleaseId: snapshot.baseReleaseId,
        baseReleaseGeneration: snapshot.baseReleaseGeneration,
        promotions: snapshot.promotions,
        publicationMode: input.mode ?? "next-batch",
        consentBundle: release.consentBundle,
      }),
      input.nowMs,
      Buffer.from(release.manifestSha256, "hex"),
    );
    const insertEntry = db.sqlite.prepare(`
      INSERT INTO release_entries (
        release_id, article_id, locale, slug, revision_id, content_sha256, route
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of snapshot.entries) insertEntry.run(
      release.releaseId,
      entry.articleId,
      entry.locale,
      entry.slug,
      entry.revisionId,
      Buffer.from(entry.contentSha256, "hex"),
      entry.route,
    );
    db.sqlite.prepare(`
      INSERT INTO release_activations (
        id, release_id, previous_release_id, operation, state,
        manifest_sha256, target_path, previous_path, created_at_ms
      ) VALUES (?, ?, ?, 'publish', 'prepared', ?, ?, ?, ?)
    `).run(
      release.activationId,
      release.releaseId,
      snapshot.baseReleaseId,
      Buffer.from(release.manifestSha256, "hex"),
      release.path,
      snapshot.baseReleaseId
        ? (db.sqlite.prepare("SELECT path FROM releases WHERE id = ?").pluck().get(snapshot.baseReleaseId) as string)
        : readCurrentTarget(config),
      input.nowMs,
    );
    return finalVerified;
    }).immediate();
  } catch (error) {
    if (renamed && existsSync(release.path) && !existsSync(sourcePath)) {
      renameSync(release.path, sourcePath);
    }
    throw error;
  }
}

function releaseRow(db: ControlDatabase, releaseId: string): ReleaseRow {
  const row = db.sqlite.prepare(`
    SELECT id, version, path, manifest_sha256, state, created_at_ms,
      created_by, activated_at_ms, activation_generation, metadata_json
    FROM releases WHERE id = ?
  `).get(releaseId) as ReleaseRow | undefined;
  if (!row) throw new Error("PUBLICATION_RELEASE_NOT_FOUND");
  return row;
}

function verifyReleaseRow(config: PublicationReleaseConfig, row: ReleaseRow): SealedPublicationRelease {
  const path = assertDirectReleasePath(config.releaseRoot, row.path);
  const verified = verifySealedPublicationRelease(path, config.publicOrigin);
  if (!row.manifest_sha256.equals(Buffer.from(verified.manifestSha256, "hex"))) {
    throw new Error("PUBLICATION_RELEASE_DATABASE_MANIFEST_MISMATCH");
  }
  return verified;
}

function verifyReleaseMetadata(
  row: ReleaseRow,
  verified: SealedPublicationRelease,
): PublicationReleaseMetadata {
  const metadata = parsePublicationReleaseMetadata(row.metadata_json);
  if (metadata.snapshotManifestSha256 !== verified.manifest.snapshotManifestSha256
    || metadata.consentBundle.bundleId !== verified.manifest.consentBundle.bundleId
    || metadata.consentBundle.contentFileSha256
      !== verified.manifest.consentBundle.contentFileSha256) {
    throw new Error("PUBLICATION_RELEASE_METADATA_MISMATCH");
  }
  return metadata;
}

function verifyReleaseAuthority(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  row: ReleaseRow,
): { verified: SealedPublicationRelease; metadata: PublicationReleaseMetadata } {
  const verified = verifyReleaseRow(config, row);
  const metadata = verifyReleaseMetadata(row, verified);
  const databaseBundle = getPublishedConsentBundleById(
    db,
    verified.consentBundle.bundleId,
  );
  if (!databaseBundle || !consentBundlesEqual(databaseBundle, verified.consentBundle)) {
    throw new Error("PUBLICATION_RELEASE_CONSENT_BUNDLE_MISMATCH");
  }
  return { verified, metadata };
}

interface ReleaseAuthorityCacheKey {
  releaseId: string;
  manifestSha256: string;
  activationGeneration: number;
  releasePath: string;
  pointerTargetPath: string;
  pointerRawTarget: string;
  pointerIdentity: string;
  targetIdentity: string;
  sealedManifestIdentity: string;
  consentBundleIdentity: string;
}

function sealedAuthorityFileIdentity(releasePath: string, filename: string): string {
  const metadata = lstatSync(join(releasePath, filename));
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("PUBLICATION_RELEASE_AUTHORITY_FILE_INVALID");
  }
  return filesystemIdentity(metadata);
}

function releaseAuthorityCacheKey(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
): { key: ReleaseAuthorityCacheKey; row: ReleaseRow } | undefined {
  return db.sqlite.transaction(() => {
    const pending = db.sqlite.prepare(`
      SELECT 1 present FROM release_activations
      WHERE state IN ('prepared', 'switched') LIMIT 1
    `).get();
    if (pending) return undefined;
    const activeRows = db.sqlite.prepare(`
      SELECT id, version, path, manifest_sha256, state, created_at_ms,
        created_by, activated_at_ms, activation_generation, metadata_json
      FROM releases WHERE state = 'active'
    `).all() as ReleaseRow[];
    if (activeRows.length !== 1) return undefined;
    const row = activeRows[0]!;
    const releasePath = assertDirectReleasePath(config.releaseRoot, row.path);
    const pointer = readCurrentPointerIdentity(config);
    if (!pointer || pointer.targetPath !== releasePath) return undefined;
    return {
      row,
      key: {
        releaseId: row.id,
        manifestSha256: row.manifest_sha256.toString("hex"),
        activationGeneration: row.activation_generation,
        releasePath,
        pointerTargetPath: pointer.targetPath,
        pointerRawTarget: pointer.rawTarget,
        pointerIdentity: pointer.pointerIdentity,
        targetIdentity: pointer.targetIdentity,
        sealedManifestIdentity: sealedAuthorityFileIdentity(
          releasePath,
          ".wisdom-release-manifest.json",
        ),
        consentBundleIdentity: sealedAuthorityFileIdentity(releasePath, "consent-bundle.json"),
      },
    };
  }).deferred();
}

function releaseAuthorityKeysEqual(
  left: ReleaseAuthorityCacheKey,
  right: ReleaseAuthorityCacheKey,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function verifyAuthorityInWorker(
  input: PublicationAuthorityWorkerInput,
): Promise<PublicationAuthorityWorkerResult> {
  return new Promise((resolveWorker, rejectWorker) => {
    const worker = new Worker(
      new URL("./publication-authority-worker.js", import.meta.url),
      { workerData: input },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      rejectWorker(new Error("PUBLICATION_AUTHORITY_WORKER_TIMEOUT"));
    }, 60_000);
    timeout.unref();
    const finish = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    worker.once("message", (message: unknown) => {
      finish(() => {
        if (
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          (message as { ok?: unknown }).ok !== true
        ) {
          rejectWorker(new Error("PUBLICATION_AUTHORITY_WORKER_FAILED"));
          return;
        }
        resolveWorker((message as {
          ok: true;
          result: PublicationAuthorityWorkerResult;
        }).result);
      });
    });
    worker.once("error", () => {
      finish(() => rejectWorker(new Error("PUBLICATION_AUTHORITY_WORKER_FAILED")));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => rejectWorker(new Error("PUBLICATION_AUTHORITY_WORKER_FAILED")));
      }
    });
  });
}

export function createReleaseConsentAuthorityResolver(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  options: ReleaseConsentAuthorityResolverOptions = {},
): CachedReleaseConsentAuthorityResolver {
  validateConfig(config);
  const now = options.now ?? Date.now;
  const scheduleRefresh = options.scheduleRefresh ?? ((task: () => void) => {
    const immediate = setImmediate(task);
    immediate.unref();
  });
  const verifyAuthority = options.verifyAuthority ?? verifyAuthorityInWorker;
  let cache: {
    key: ReleaseAuthorityCacheKey;
    authority: NonNullable<ReturnType<ConsentAuthorityResolver>>;
  } | undefined;
  let refreshScheduled = false;
  let refreshing = false;
  let stopped = false;
  let lastFailedKey: string | undefined;
  let retryAfterMs = 0;

  const refreshNow = async (force: boolean): Promise<boolean> => {
    if (stopped || refreshing) return false;
    refreshing = true;
    let candidate: ReturnType<typeof releaseAuthorityCacheKey>;
    try {
      candidate = releaseAuthorityCacheKey(db, config);
      if (!candidate) {
        cache = undefined;
        return false;
      }
      const fingerprint = JSON.stringify(candidate.key);
      if (!force && fingerprint === lastFailedKey && now() < retryAfterMs) return false;
      options.onFullVerification?.();
      const workerResult = await verifyAuthority({
        releasePath: candidate.key.releasePath,
        publicOrigin: config.publicOrigin,
        expectedManifestSha256: candidate.key.manifestSha256,
      });
      if (workerResult.manifestSha256 !== candidate.key.manifestSha256) {
        throw new Error("PUBLICATION_RELEASE_DATABASE_MANIFEST_MISMATCH");
      }
      const bundle = publishedConsentBundleSchema.parse(workerResult.bundle);
      const databaseBundle = getPublishedConsentBundleById(db, bundle.bundleId);
      if (!databaseBundle || !consentBundlesEqual(databaseBundle, bundle)) {
        throw new Error("PUBLICATION_RELEASE_CONSENT_BUNDLE_MISMATCH");
      }
      const after = releaseAuthorityCacheKey(db, config);
      if (!after || !releaseAuthorityKeysEqual(candidate.key, after.key)) {
        throw new Error("PUBLICATION_RELEASE_CHANGED_DURING_AUTHORITY_REFRESH");
      }
      cache = {
        key: after.key,
        authority: freezeDeep({
          source: "release" as const,
          releaseId: candidate.row.id,
          releaseManifestSha256: workerResult.manifestSha256,
          bundle,
        }),
      };
      lastFailedKey = undefined;
      retryAfterMs = 0;
      return true;
    } catch {
      if (
        candidate &&
        cache &&
        releaseAuthorityKeysEqual(cache.key, candidate.key)
      ) {
        cache = undefined;
      }
      try {
        const failed = candidate ?? releaseAuthorityCacheKey(db, config);
        lastFailedKey = failed ? JSON.stringify(failed.key) : undefined;
      } catch {
        lastFailedKey = undefined;
      }
      retryAfterMs = now() + 30_000;
      return false;
    } finally {
      refreshing = false;
    }
  };

  const requestBackgroundRefresh = (key: ReleaseAuthorityCacheKey): void => {
    if (stopped || refreshScheduled || refreshing) return;
    const fingerprint = JSON.stringify(key);
    if (fingerprint === lastFailedKey && now() < retryAfterMs) return;
    refreshScheduled = true;
    try {
      scheduleRefresh(() => {
        refreshScheduled = false;
        void refreshNow(false);
      });
    } catch {
      refreshScheduled = false;
    }
  };

  const resolver = (() => {
    if (stopped) return undefined;
    try {
      const current = releaseAuthorityCacheKey(db, config);
      if (!current) {
        cache = undefined;
        return undefined;
      }
      if (cache && releaseAuthorityKeysEqual(cache.key, current.key)) return cache.authority;
      cache = undefined;
      requestBackgroundRefresh(current.key);
      return undefined;
    } catch {
      cache = undefined;
      return undefined;
    }
  }) as CachedReleaseConsentAuthorityResolver;

  resolver.activate = (handoff) => {
    if (stopped) return false;
    try {
      const current = releaseAuthorityCacheKey(db, config);
      if (
        !current ||
        current.row.id !== handoff.releaseId ||
        current.key.activationGeneration !== handoff.activationGeneration ||
        current.key.manifestSha256 !== handoff.manifestSha256
      ) return false;
      const bundle = publishedConsentBundleSchema.parse(handoff.bundle);
      const databaseBundle = getPublishedConsentBundleById(db, bundle.bundleId);
      if (!databaseBundle || !consentBundlesEqual(databaseBundle, bundle)) return false;
      cache = {
        key: current.key,
        authority: freezeDeep({
          source: "release" as const,
          releaseId: handoff.releaseId,
          releaseManifestSha256: handoff.manifestSha256,
          bundle,
        }),
      };
      lastFailedKey = undefined;
      retryAfterMs = 0;
      return true;
    } catch {
      return false;
    }
  };
  resolver.refresh = () => refreshNow(true);
  let interval: ReturnType<typeof setInterval> | undefined;
  const refreshIntervalMs = options.refreshIntervalMs ?? 60_000;
  if (refreshIntervalMs > 0) {
    interval = setInterval(() => { void refreshNow(true); }, refreshIntervalMs);
    interval.unref();
  }
  resolver.stop = () => {
    stopped = true;
    cache = undefined;
    if (interval) clearInterval(interval);
    interval = undefined;
  };
  return resolver;
}

function activationIndexNowPayload(
  config: PublicationReleaseConfig,
  targetUrls: readonly string[],
  previousUrls: readonly string[],
): CreatedIndexNowPayload {
  try {
    return createIndexNowPayload({
      publicOrigin: config.publicOrigin,
      urls: [...new Set([...targetUrls, ...previousUrls])],
    });
  } catch (error) {
    if (!(error instanceof IndexNowPayloadValidationError)) throw error;
    if (error.code === "INDEXNOW_URL_COUNT_EXCEEDED"
      || error.code === "INDEXNOW_PAYLOAD_BYTES_EXCEEDED") {
      throw new Error("PUBLICATION_INDEXNOW_PAYLOAD_LIMIT_EXCEEDED");
    }
    throw new Error("PUBLICATION_INDEXNOW_PAYLOAD_INVALID");
  }
}

function applyReleaseHeads(
  db: ControlDatabase,
  target: ReleaseRow,
  nowMs: number,
): void {
  const entries = db.sqlite.prepare(`
    SELECT article_id, locale, revision_id FROM release_entries WHERE release_id = ?
    ORDER BY article_id, locale
  `).all(target.id) as Array<{ article_id: string; locale: string; revision_id: string }>;
  const targetKeys = new Set(entries.map((entry) => `${entry.article_id}\0${entry.locale}`));
  const published = db.sqlite.prepare(`
    SELECT article_id, locale FROM article_locale_heads WHERE state = 'published'
  `).all() as Array<{ article_id: string; locale: string }>;
  for (const head of published) {
    if (targetKeys.has(`${head.article_id}\0${head.locale}`)) continue;
    const changed = db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'approved', published_revision_id = NULL, published_at_ms = NULL,
        row_version = row_version + 1, updated_at_ms = ?
      WHERE article_id = ? AND locale = ? AND state = 'published'
    `).run(nowMs, head.article_id, head.locale);
    if (changed.changes !== 1) throw new Error("PUBLICATION_HEAD_RETIRE_CONFLICT");
  }
  for (const entry of entries) {
    const head = db.sqlite.prepare(`
      SELECT state, head_revision_id, approved_by_admin_id, approved_at_ms
      FROM article_locale_heads WHERE article_id = ? AND locale = ?
    `).get(entry.article_id, entry.locale) as {
      state: string;
      head_revision_id: string;
      approved_by_admin_id: string | null;
      approved_at_ms: number | null;
    } | undefined;
    if (!head) throw new Error("PUBLICATION_RELEASE_HEAD_MISSING");
    if (head.state === "published" && head.head_revision_id === entry.revision_id) continue;
    const approver = head.approved_by_admin_id ?? target.created_by;
    const approvedAt = head.approved_at_ms ?? target.created_at_ms;
    const changed = db.sqlite.prepare(`
      UPDATE article_locale_heads
      SET state = 'published', head_revision_id = ?, approved_revision_id = ?,
        published_revision_id = ?, approved_by_admin_id = ?, approved_at_ms = ?,
        published_at_ms = ?, row_version = row_version + 1, updated_at_ms = ?
      WHERE article_id = ? AND locale = ?
    `).run(
      entry.revision_id,
      entry.revision_id,
      entry.revision_id,
      approver,
      approvedAt,
      nowMs,
      nowMs,
      entry.article_id,
      entry.locale,
    );
    if (changed.changes !== 1) throw new Error("PUBLICATION_RELEASE_HEAD_CONFLICT");
  }
  db.sqlite.prepare(`
    UPDATE articles
    SET state = (
      SELECT head.state FROM article_locale_heads head
      WHERE head.article_id = articles.id AND head.locale = articles.source_locale
    ),
    current_revision_id = (
      SELECT head.head_revision_id FROM article_locale_heads head
      WHERE head.article_id = articles.id AND head.locale = articles.source_locale
    ),
    published_at_ms = (
      SELECT head.published_at_ms FROM article_locale_heads head
      WHERE head.article_id = articles.id AND head.locale = articles.source_locale
    ),
    updated_at_ms = ?
    WHERE EXISTS (
      SELECT 1 FROM article_locale_heads head WHERE head.article_id = articles.id
    )
  `).run(nowMs);
}

function commitActivation(
  db: ControlDatabase,
  activationId: string,
  input: { actorAdminId?: string; requestId: string; nowMs: number },
  config: PublicationReleaseConfig,
  dependencies: PublicationReleaseDependencies,
): PublicationActionResult {
  const activation = db.sqlite.prepare(`
    SELECT id, release_id, previous_release_id, operation, state,
      manifest_sha256, target_path, previous_path
    FROM release_activations WHERE id = ?
  `).get(activationId) as ActivationRow | undefined;
  if (!activation || !["prepared", "switched"].includes(activation.state)) {
    throw new Error("PUBLICATION_ACTIVATION_NOT_PENDING");
  }
  const target = releaseRow(db, activation.release_id);
  const { verified, metadata } = verifyReleaseAuthority(db, config, target);
  if (verified.manifestSha256 !== activation.manifest_sha256.toString("hex")) {
    throw new Error("PUBLICATION_ACTIVATION_MANIFEST_MISMATCH");
  }
  const previousUrls = activation.previous_release_id
    ? verifyReleaseAuthority(
        db,
        config,
        releaseRow(db, activation.previous_release_id),
      ).verified.sitemapUrls
    : [];
  const indexNowPayload = activationIndexNowPayload(
    config,
    verified.sitemapUrls,
    previousUrls,
  );
  const current = readCurrentTarget(config);
  const targetPath = assertDirectReleasePath(config.releaseRoot, target.path);
  if (current !== targetPath) throw new Error("PUBLICATION_ACTIVATION_POINTER_MISMATCH");

  const result = db.sqlite.transaction(() => {
    const liveActivation = db.sqlite.prepare(`
      SELECT state FROM release_activations WHERE id = ?
    `).pluck().get(activationId) as string | undefined;
    if (!liveActivation || !["prepared", "switched"].includes(liveActivation)) {
      throw new Error("PUBLICATION_ACTIVATION_FENCE_LOST");
    }
    const liveTarget = releaseRow(db, activation.release_id);
    const { verified: liveVerified } = verifyReleaseAuthority(db, config, liveTarget);
    if (liveVerified.manifestSha256 !== activation.manifest_sha256.toString("hex")) {
      throw new Error("PUBLICATION_ACTIVATION_MANIFEST_MISMATCH");
    }
    const active = db.sqlite.prepare(`
      SELECT id FROM releases WHERE state = 'active'
    `).get() as { id: string } | undefined;
    if ((active?.id ?? null) !== activation.previous_release_id) {
      throw new Error("PUBLICATION_ACTIVE_RELEASE_CONFLICT");
    }
    if (activation.operation === "publish") {
      const liveConsentBundle = getActivePublishedConsentBundle(db);
      if (!liveConsentBundle || !consentBundlesEqual(liveConsentBundle, liveVerified.consentBundle)) {
        throw new Error("PUBLICATION_CONSENT_BUNDLE_CHANGED_DURING_BUILD");
      }
    }
    if (active && active.id !== target.id) {
      db.sqlite.prepare(`
        UPDATE releases SET state = 'retired',
          rolled_back_at_ms = CASE WHEN ? = 'rollback' THEN ? ELSE rolled_back_at_ms END
        WHERE id = ? AND state = 'active'
      `).run(activation.operation, input.nowMs, active.id);
    }
    db.sqlite.prepare(`
      UPDATE releases
      SET state = 'active', activated_at_ms = ?, rolled_back_at_ms = NULL,
        activation_generation = activation_generation + 1
      WHERE id = ? AND state IN ('building', 'retired')
    `).run(input.nowMs, target.id);
    applyReleaseHeads(db, target, input.nowMs);
    db.sqlite.prepare(`
      UPDATE release_activations
      SET state = 'committed', switched_at_ms = COALESCE(switched_at_ms, ?),
        committed_at_ms = ?, error_code = NULL
      WHERE id = ? AND state IN ('prepared', 'switched')
    `).run(input.nowMs, input.nowMs, activationId);

    const outboxId = safeUuid(dependencies.randomUUID);
    db.sqlite.prepare(`
      INSERT INTO publication_outbox (
        id, release_id, event_type, manifest_sha256, payload_json, state,
        available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'indexnow', ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(release_id, event_type, manifest_sha256) DO UPDATE SET
        payload_json = excluded.payload_json,
        state = 'pending', attempt_count = 0,
        available_at_ms = excluded.available_at_ms,
        locked_at_ms = NULL, lease_expires_at_ms = NULL,
        locked_by = NULL, fencing_token = NULL,
        last_error_code = NULL, provider_message_id = NULL,
        updated_at_ms = excluded.updated_at_ms, sent_at_ms = NULL
      WHERE publication_outbox.state IN ('sent', 'failed')
        OR json_extract(publication_outbox.payload_json, '$.urlSetSha256')
          IS NOT json_extract(excluded.payload_json, '$.urlSetSha256')
    `).run(
      outboxId,
      target.id,
      target.manifest_sha256,
      indexNowPayload.payloadJson,
      input.nowMs,
      input.nowMs,
      input.nowMs,
    );
    const auditId = safeUuid(dependencies.randomUUID);
    db.sqlite.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, ?, ?, ?, 'release', ?, ?, ?, ?)
    `).run(
      auditId,
      input.actorAdminId ? "admin" : "system",
      input.actorAdminId ?? "publication-reconciler",
      activation.operation === "rollback"
        ? "article.release.rolled_back"
        : activation.operation === "reconcile"
          ? "article.release.reconciled"
          : "article.release.published",
      target.id,
      input.requestId,
      JSON.stringify({
        version: target.version,
        manifestSha256: verified.manifestSha256,
        activationId,
        mode: metadata.publicationMode ?? "next-batch",
        batchCount: metadata.promotions.length,
        remainingAfterBatch: Number(db.sqlite.prepare(`
          SELECT count(*) FROM article_locale_heads
          WHERE state = 'approved' AND approved_revision_id = head_revision_id
        `).pluck().get()),
      }),
      input.nowMs,
    );
    return {
      releaseId: target.id,
      version: target.version,
      manifestSha256: verified.manifestSha256,
    };
  }).immediate();
  const activationGeneration = db.sqlite.prepare(
    "SELECT activation_generation FROM releases WHERE id = ? AND state = 'active'",
  ).pluck().get(target.id) as number | undefined;
  if (activationGeneration !== undefined) {
    dependencies.activateAuthority?.({
      releaseId: target.id,
      activationGeneration,
      manifestSha256: verified.manifestSha256,
      bundle: verified.consentBundle,
    });
  }
  return result;
}

function markActivationSwitched(db: ControlDatabase, activationId: string, nowMs: number): void {
  const changed = db.sqlite.prepare(`
    UPDATE release_activations SET state = 'switched', switched_at_ms = ?
    WHERE id = ? AND state = 'prepared'
  `).run(nowMs, activationId);
  if (changed.changes !== 1) throw new Error("PUBLICATION_ACTIVATION_FENCE_LOST");
}

function markActivationReverted(
  db: ControlDatabase,
  activation: ActivationRow,
  errorCode: string,
): void {
  db.sqlite.transaction(() => {
    const changed = db.sqlite.prepare(`
      UPDATE release_activations
      SET state = 'failed', error_code = ?
      WHERE id = ? AND state IN ('prepared', 'switched')
    `).run(errorCode, activation.id);
    if (changed.changes !== 1) throw new Error("PUBLICATION_ACTIVATION_FENCE_LOST");
    db.sqlite.prepare(`
      UPDATE releases SET state = 'failed'
      WHERE id = ? AND state = 'building'
    `).run(activation.release_id);
  }).immediate();
}

function recordManualRecovery(
  db: ControlDatabase,
  activationId: string,
  errorCode: string,
): void {
  try {
    db.sqlite.prepare(`
      UPDATE release_activations SET error_code = ?
      WHERE id = ? AND state IN ('prepared', 'switched')
    `).run(errorCode, activationId);
  } catch {
    // The pending activation remains the fail-closed readiness signal.
  }
}

function committedActivationResult(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  activation: Pick<ActivationRow, "release_id">,
): PublicationActionResult {
  const target = releaseRow(db, activation.release_id);
  if (target.state !== "active") throw new Error("PUBLICATION_ACTIVATION_STATE_MISMATCH");
  const { verified } = verifyReleaseAuthority(db, config, target);
  return {
    releaseId: target.id,
    version: target.version,
    manifestSha256: verified.manifestSha256,
  };
}

export function settlePublicationActivation(
  db: ControlDatabase,
  activationId: string,
  input: { actorAdminId?: string; requestId: string; nowMs: number },
  config: PublicationReleaseConfig,
  dependencyOverrides?: Partial<PublicationReleaseDependencies>,
): PublicationActivationOutcome {
  const dependencies = resolvedDependencies(dependencyOverrides);
  const activation = db.sqlite.prepare(`
    SELECT id, release_id, previous_release_id, operation, state,
      manifest_sha256, target_path, previous_path
    FROM release_activations WHERE id = ?
  `).get(activationId) as (
    Omit<ActivationRow, "state"> & {
      state: ActivationRow["state"] | "committed" | "failed";
    }
  ) | undefined;
  if (!activation) {
    return {
      kind: "manual-recovery-required",
      activationId,
      errorCode: "PUBLICATION_ACTIVATION_MISSING",
    };
  }
  if (activation.state === "committed") {
    return { kind: "committed", result: committedActivationResult(db, config, activation) };
  }
  if (activation.state === "failed") {
    return { kind: "reverted", activationId, previousReleaseId: activation.previous_release_id };
  }

  let current: string | null;
  let target: string;
  let previous: string | null;
  try {
    current = readCurrentTarget(config);
    target = assertDirectReleasePath(config.releaseRoot, activation.target_path);
    previous = activation.previous_path
      ? assertDirectReleasePath(config.releaseRoot, activation.previous_path)
      : null;
  } catch {
    recordManualRecovery(db, activationId, "PUBLICATION_RECOVERY_PATH_INVALID");
    return {
      kind: "manual-recovery-required",
      activationId,
      errorCode: "PUBLICATION_RECOVERY_PATH_INVALID",
    };
  }

  if (current === target) {
    try {
      if (activation.state === "prepared") {
        markActivationSwitched(db, activationId, input.nowMs);
      }
      return {
        kind: "committed",
        result: commitActivation(db, activationId, input, config, dependencies),
      };
    } catch {
      // Fall through to verified previous-pointer recovery.
    }
  } else if (current === previous) {
    try {
      markActivationReverted(db, activation as ActivationRow, "PUBLICATION_SWITCH_NOT_COMMITTED");
      return {
        kind: "reverted",
        activationId,
        previousReleaseId: activation.previous_release_id,
      };
    } catch {
      recordManualRecovery(db, activationId, "PUBLICATION_RECOVERY_DATABASE_FAILED");
      return {
        kind: "manual-recovery-required",
        activationId,
        errorCode: "PUBLICATION_RECOVERY_DATABASE_FAILED",
      };
    }
  } else {
    recordManualRecovery(db, activationId, "PUBLICATION_RECOVERY_POINTER_UNKNOWN");
    return {
      kind: "manual-recovery-required",
      activationId,
      errorCode: "PUBLICATION_RECOVERY_POINTER_UNKNOWN",
    };
  }

  if (previous === null) {
    recordManualRecovery(db, activationId, "PUBLICATION_RECOVERY_PREVIOUS_MISSING");
    return {
      kind: "manual-recovery-required",
      activationId,
      errorCode: "PUBLICATION_RECOVERY_PREVIOUS_MISSING",
    };
  }
  try {
    if (activation.previous_release_id) {
      const previousRow = releaseRow(db, activation.previous_release_id);
      verifyReleaseAuthority(db, config, previousRow);
      if (assertDirectReleasePath(config.releaseRoot, previousRow.path) !== previous) {
        throw new Error("PUBLICATION_RECOVERY_PREVIOUS_MISMATCH");
      }
    } else {
      verifyBootstrapRelease(previous);
    }
    (dependencies.switchCurrent ?? switchCurrentAtomic)(
      previous,
      config.currentLink,
      `${activationId}-revert`,
    );
    if (readCurrentTarget(config) !== previous) {
      throw new Error("PUBLICATION_RECOVERY_POINTER_MISMATCH");
    }
    markActivationReverted(db, activation as ActivationRow, "PUBLICATION_COMMIT_REVERTED");
    return {
      kind: "reverted",
      activationId,
      previousReleaseId: activation.previous_release_id,
    };
  } catch {
    recordManualRecovery(db, activationId, "PUBLICATION_RECOVERY_FAILED");
    return {
      kind: "manual-recovery-required",
      activationId,
      errorCode: "PUBLICATION_RECOVERY_FAILED",
    };
  }
}

function cleanSuccessfulTemporaryDirectory(releaseRoot: string, candidate: string): void {
  const root = realpathSync(releaseRoot);
  const target = realpathSync(candidate);
  const containment = relative(root, target);
  if (!containment || containment.includes(sep) || !basename(target).startsWith(".")) {
    throw new Error("PUBLICATION_TEMP_PATH_INVALID");
  }
  rmSync(target, { recursive: true, force: false });
}

interface PublicationTemporary {
  kind: "building" | "snapshot" | "home";
  path: string;
}

function cleanupPublicationTemporaries(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  input: PublicationActionInput,
  releaseId: string,
  version: string,
  temporaries: readonly PublicationTemporary[],
): void {
  for (const temporary of temporaries) {
    if (!existsSync(temporary.path)) continue;
    try {
      cleanSuccessfulTemporaryDirectory(config.releaseRoot, temporary.path);
    } catch (error) {
      recordPublicationDiagnostic(
        db,
        input,
        releaseId,
        version,
        "article.release.cleanup_failed",
        error,
        { temporaryKind: temporary.kind },
      );
    }
  }
}

export function createRetentionPruningPath(
  releaseRoot: string,
  randomUUID: () => string,
): string {
  return join(resolve(releaseRoot), `.pruning-${safeUuid(randomUUID)}`);
}

function hasLivePublicationOutboxReference(
  db: ControlDatabase,
  releaseId: string,
): boolean {
  const retryablePlaceholders = INDEXNOW_RETRYABLE_ERROR_CODES.map(() => "?").join(", ");
  return Boolean(db.sqlite.prepare(`
    SELECT 1 present FROM publication_outbox
    WHERE release_id = ? AND (
      state IN ('pending', 'processing')
      OR (
        state = 'failed' AND attempt_count < ?
        AND last_error_code IN (${retryablePlaceholders})
      )
    )
    LIMIT 1
  `).get(releaseId, INDEXNOW_MAX_ATTEMPTS, ...INDEXNOW_RETRYABLE_ERROR_CODES));
}

export function pruneRetiredPublicationReleases(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  input: { nowMs: number; randomUUID?: () => string },
): { prunedReleaseIds: string[] } {
  validateConfig(config);
  const randomUUID = input.randomUUID ?? nodeRandomUUID;
  const current = readCurrentTarget(config);
  const retired = db.sqlite.prepare(`
    SELECT id, version, path, manifest_sha256, state, created_at_ms,
      created_by, activated_at_ms, activation_generation, metadata_json
    FROM releases
    WHERE state = 'retired'
    ORDER BY COALESCE(activated_at_ms, created_at_ms) DESC, created_at_ms DESC, id DESC
  `).all() as ReleaseRow[];
  const candidates: ReleaseRow[] = [];
  let verifiedKeepers = 0;
  for (const candidate of retired) {
    try {
      verifyReleaseRow(config, candidate);
    } catch {
      db.sqlite.prepare(`
        UPDATE releases
        SET state = 'failed', metadata_json = ?
        WHERE id = ? AND state = 'retired'
      `).run(JSON.stringify({
        retention: { state: "verification-failed", detectedAtMs: input.nowMs },
      }), candidate.id);
      continue;
    }
    if (verifiedKeepers < 2) {
      verifiedKeepers += 1;
      continue;
    }
    candidates.push(candidate);
  }
  const prunedReleaseIds: string[] = [];
  for (const candidate of candidates) {
    const pendingReference = db.sqlite.prepare(`
      SELECT 1 present FROM release_activations
      WHERE state IN ('prepared', 'switched')
        AND (release_id = ? OR previous_release_id = ?)
      LIMIT 1
    `).get(candidate.id, candidate.id);
    if (pendingReference) continue;
    if (hasLivePublicationOutboxReference(db, candidate.id)) continue;
    const releasePath = assertDirectReleasePath(config.releaseRoot, candidate.path);
    if (current === releasePath) throw new Error("PUBLICATION_RETENTION_ACTIVE_POINTER");
    const pruningPath = createRetentionPruningPath(config.releaseRoot, randomUUID);
    if (existsSync(pruningPath)) throw new Error("PUBLICATION_RETENTION_TEMP_EXISTS");
    renameSync(releasePath, pruningPath);
    let changed = false;
    try {
      changed = db.sqlite.transaction(() => {
        const liveReference = db.sqlite.prepare(`
          SELECT 1 present FROM release_activations
          WHERE state IN ('prepared', 'switched')
            AND (release_id = ? OR previous_release_id = ?)
          LIMIT 1
        `).get(candidate.id, candidate.id);
        if (liveReference) return false;
        if (hasLivePublicationOutboxReference(db, candidate.id)) return false;
        let metadata: Record<string, unknown> = {};
        try {
          const parsed = candidate.metadata_json ? JSON.parse(candidate.metadata_json) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          metadata = {};
        }
        const update = db.sqlite.prepare(`
          UPDATE releases
          SET state = 'failed', metadata_json = ?
          WHERE id = ? AND state = 'retired'
        `).run(JSON.stringify({
          ...metadata,
          retention: { state: "pruned", prunedAtMs: input.nowMs },
        }), candidate.id);
        if (update.changes !== 1) return false;
        db.sqlite.prepare(`
          INSERT INTO audit_events (
            id, actor_type, actor_id, action, target_type, target_id,
            request_id, metadata_json, created_at_ms
          ) VALUES (?, 'system', 'publication-retention',
            'article.release.pruned', 'release', ?, ?, ?, ?)
        `).run(
          safeUuid(randomUUID),
          candidate.id,
          `publication-retention-${candidate.id}`,
          JSON.stringify({ version: candidate.version }),
          input.nowMs,
        );
        return true;
      }).immediate();
    } catch (error) {
      renameSync(pruningPath, releasePath);
      throw error;
    }
    if (!changed) {
      renameSync(pruningPath, releasePath);
      continue;
    }
    const verifiedPruningPath = assertDirectReleasePath(config.releaseRoot, pruningPath);
    rmSync(verifiedPruningPath, { recursive: true, force: false });
    prunedReleaseIds.push(candidate.id);
  }
  return { prunedReleaseIds };
}

function pruneWithoutAffectingActivation(
  db: ControlDatabase,
  config: PublicationReleaseConfig,
  nowMs: number,
  dependencies: PublicationReleaseDependencies,
): void {
  try {
    pruneRetiredPublicationReleases(db, config, {
      nowMs,
      randomUUID: dependencies.randomUUID,
    });
  } catch {
    appendFileSync(
      join(config.releaseRoot, "failed-publication.log"),
      `${new Date(nowMs).toISOString()} PUBLICATION_RETENTION_FAILED\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
}

export async function publishApprovedArticles(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  input: PublicationActionInput,
  config: PublicationReleaseConfig,
  dependencyOverrides?: Partial<PublicationReleaseDependencies>,
): Promise<PublicationActionResult> {
  validateConfig(config);
  const dependencies = resolvedDependencies(dependencyOverrides);
  const mode = input.mode ?? "next-batch";
  const batchPlan = createPublicationBatchPlan(db, mode);
  if (
    input.expectedFingerprint !== undefined &&
    input.expectedFingerprint !== batchPlan.fingerprint
  ) {
    throw new Error("PUBLICATION_BATCH_CHANGED");
  }
  const snapshot = capturePublicationSnapshot(db, keyProvider, {
    promote: batchPlan.promotions,
    nowMs: input.nowMs,
  });
  assertBaseReleaseConsistent(db, config, snapshot);
  const releaseId = safeUuid(dependencies.randomUUID);
  const activationId = safeUuid(dependencies.randomUUID);
  const version = versionName(input.nowMs, releaseId);
  const finalPath = join(config.releaseRoot, version);
  const outputDirectory = join(config.releaseRoot, `.building-${releaseId}`);
  const temporaries: PublicationTemporary[] = [{
    kind: "building",
    path: outputDirectory,
  }];
  let activationPrepared = false;
  try {
    const snapshotDirectory = mkdtempSync(join(config.releaseRoot, `.snapshot-${releaseId}-`));
    temporaries.push({ kind: "snapshot", path: snapshotDirectory });
    const buildHome = mkdtempSync(join(config.releaseRoot, `.home-${releaseId}-`));
    temporaries.push({ kind: "home", path: buildHome });
    writePublicationSnapshot(snapshot, snapshotDirectory);
    let sealed: SealedPublicationRelease;
    try {
      sealed = await dependencies.prepareRelease({
        snapshot,
        snapshotDirectory,
        outputDirectory,
        buildHome,
        config,
      });
    } catch (error) {
      recordBuildFailure(db, config, input, releaseId, version, error);
      throw error;
    }
    const independent = verifySealedPublicationRelease(outputDirectory, config.publicOrigin);
    if (independent.manifestSha256 !== sealed.manifestSha256) {
      throw new Error("PUBLICATION_PREPARED_MANIFEST_MISMATCH");
    }
    if (independent.manifest.snapshotManifestSha256
      !== computePublicationSnapshotManifestSha256(snapshot)) {
      throw new Error("PUBLICATION_SNAPSHOT_MANIFEST_MISMATCH");
    }
    assertConsentBundleConsistent(db, snapshot);
    if (createPublicationBatchPlan(db, mode).fingerprint !== batchPlan.fingerprint) {
      throw new Error("PUBLICATION_BATCH_CHANGED_DURING_BUILD");
    }
    const previousUrls = snapshot.baseReleaseId
      ? verifyReleaseRow(config, releaseRow(db, snapshot.baseReleaseId)).sitemapUrls
      : [];
    activationIndexNowPayload(config, independent.sitemapUrls, previousUrls);
    insertPreparedRelease(db, keyProvider, snapshot, input, {
      releaseId,
      activationId,
      version,
      path: finalPath,
      sourcePath: outputDirectory,
      manifestSha256: independent.manifestSha256,
      snapshotManifestSha256: independent.manifest.snapshotManifestSha256,
      consentBundle: independent.manifest.consentBundle,
    }, config);
    activationPrepared = true;
    dependencies.faultInjector?.("before-switch");
    (dependencies.switchCurrent ?? switchCurrentAtomic)(finalPath, config.currentLink, activationId);
    dependencies.faultInjector?.("after-switch");
    markActivationSwitched(db, activationId, input.nowMs);
    dependencies.faultInjector?.("before-db-commit");
    const result = commitActivation(db, activationId, input, config, dependencies);
    dependencies.faultInjector?.("after-db-commit");
    pruneWithoutAffectingActivation(db, config, input.nowMs, dependencies);
    return result;
  } catch (error) {
    if (activationPrepared) {
      const outcome = settlePublicationActivation(
        db,
        activationId,
        input,
        config,
        dependencies,
      );
      if (outcome.kind === "committed") return outcome.result;
      throw new PublicationActivationSettlementError(outcome);
    }
    throw error;
  } finally {
    cleanupPublicationTemporaries(
      db,
      config,
      input,
      releaseId,
      version,
      temporaries,
    );
  }
}

export function rollbackPublication(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  input: PublicationActionInput & { releaseId: string },
  config: PublicationReleaseConfig,
  dependencyOverrides?: Partial<PublicationReleaseDependencies>,
): PublicationActionResult {
  validateConfig(config);
  const dependencies = resolvedDependencies(dependencyOverrides);
  const privacyGeneration = () => Number(db.sqlite.prepare(`
    SELECT generation FROM publication_privacy_generation WHERE singleton = 1
  `).pluck().get());
  const scannedPrivacyGeneration = privacyGeneration();
  const target = releaseRow(db, input.releaseId);
  if (target.state !== "retired") throw new Error("PUBLICATION_ROLLBACK_TARGET_NOT_RETIRED");
  const { verified } = verifyReleaseAuthority(db, config, target);
  const pii = checkArticleForRetainedConsultationPii(
    db,
    keyProvider,
    collectReleasePiiSegments(verified),
  );
  if (!pii.safe) throw new Error("PUBLICATION_ROLLBACK_PII_REJECTED");
  dependencies.faultInjector?.("after-rollback-pii-scan");
  const active = db.sqlite.prepare(`
    SELECT id, path FROM releases WHERE state = 'active'
  `).get() as { id: string; path: string } | undefined;
  if (!active) throw new Error("PUBLICATION_ACTIVE_RELEASE_MISSING");
  const current = readCurrentTarget(config);
  if (current !== assertDirectReleasePath(config.releaseRoot, active.path)) {
    throw new Error("PUBLICATION_BASE_POINTER_MISMATCH");
  }
  const activeVerified = verifyReleaseAuthority(
    db,
    config,
    releaseRow(db, active.id),
  ).verified;
  activationIndexNowPayload(config, verified.sitemapUrls, activeVerified.sitemapUrls);
  const activationId = safeUuid(dependencies.randomUUID);
  db.sqlite.prepare(`
    INSERT INTO release_activations (
      id, release_id, previous_release_id, operation, state,
      manifest_sha256, target_path, previous_path, created_at_ms
    ) VALUES (?, ?, ?, 'rollback', 'prepared', ?, ?, ?, ?)
  `).run(
    activationId,
    target.id,
    active.id,
    Buffer.from(verified.manifestSha256, "hex"),
    target.path,
    active.path,
    input.nowMs,
  );
  try {
    dependencies.faultInjector?.("before-switch");
    db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (privacyGeneration() !== scannedPrivacyGeneration) {
        throw new Error("PUBLICATION_PRIVACY_GENERATION_CHANGED");
      }
      (dependencies.switchCurrent ?? switchCurrentAtomic)(
        target.path,
        config.currentLink,
        activationId,
      );
      dependencies.faultInjector?.("after-switch");
      markActivationSwitched(db, activationId, input.nowMs);
      db.sqlite.exec("COMMIT");
    } catch (error) {
      if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
      if (
        error instanceof Error &&
        error.message === "PUBLICATION_PRIVACY_GENERATION_CHANGED"
      ) {
        const activation = db.sqlite.prepare(`
          SELECT id, release_id, previous_release_id, operation, state,
            manifest_sha256, target_path, previous_path
          FROM release_activations WHERE id = ?
        `).get(activationId) as ActivationRow;
        markActivationReverted(
          db,
          activation,
          "PUBLICATION_PRIVACY_GENERATION_CHANGED",
        );
      }
      throw error;
    }
    dependencies.faultInjector?.("before-db-commit");
    const result = commitActivation(db, activationId, input, config, dependencies);
    dependencies.faultInjector?.("after-db-commit");
    pruneWithoutAffectingActivation(db, config, input.nowMs, dependencies);
    return result;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "PUBLICATION_PRIVACY_GENERATION_CHANGED"
    ) throw error;
    const outcome = settlePublicationActivation(
      db,
      activationId,
      input,
      config,
      dependencies,
    );
    if (outcome.kind === "committed") return outcome.result;
    throw new PublicationActivationSettlementError(outcome);
  }
}

export function reconcilePublicationActivation(
  db: ControlDatabase,
  input: { requestId: string; nowMs: number },
  config: PublicationReleaseConfig,
  dependencyOverrides?: Partial<PublicationReleaseDependencies>,
): { kind: "already-consistent" | "committed" | "reverted"; releaseId?: string } {
  validateConfig(config);
  const dependencies = resolvedDependencies(dependencyOverrides);
  const pending = db.sqlite.prepare(`
    SELECT id, release_id, previous_release_id, operation, state,
      manifest_sha256, target_path, previous_path
    FROM release_activations
    WHERE state IN ('prepared', 'switched')
  `).get() as ActivationRow | undefined;
  const current = readCurrentTarget(config);
  if (!pending) {
    const active = db.sqlite.prepare(`
      SELECT id, path, manifest_sha256 FROM releases WHERE state = 'active'
    `).get() as { id: string; path: string; manifest_sha256: Buffer } | undefined;
    if (!active) {
      if (current !== null) verifyBootstrapRelease(current);
      return { kind: "already-consistent" };
    }
    if (active && current === assertDirectReleasePath(config.releaseRoot, active.path)) {
      const activeRow = releaseRow(db, active.id);
      const { verified } = verifyReleaseAuthority(db, config, activeRow);
      if (!active.manifest_sha256.equals(Buffer.from(verified.manifestSha256, "hex"))) {
        throw new Error("PUBLICATION_ACTIVE_MANIFEST_MISMATCH");
      }
      return { kind: "already-consistent" };
    }
    throw new Error("PUBLICATION_UNJOURNALED_POINTER_DRIFT");
  }
  const target = assertDirectReleasePath(config.releaseRoot, pending.target_path);
  if (current === target) {
    if (pending.state === "prepared") markActivationSwitched(db, pending.id, input.nowMs);
    const result = commitActivation(db, pending.id, input, config, dependencies);
    return { kind: "committed", releaseId: result.releaseId };
  }
  const previous = pending.previous_path
    ? assertDirectReleasePath(config.releaseRoot, pending.previous_path)
    : null;
  if (current === previous) {
    db.sqlite.transaction(() => {
      db.sqlite.prepare(`
        UPDATE release_activations SET state = 'failed', error_code = 'SWITCH_NOT_APPLIED'
        WHERE id = ? AND state IN ('prepared', 'switched')
      `).run(pending.id);
      db.sqlite.prepare(`
        UPDATE releases SET state = 'failed'
        WHERE id = ? AND state = 'building'
      `).run(pending.release_id);
    }).immediate();
    return { kind: "reverted", releaseId: pending.release_id };
  }
  throw new Error("PUBLICATION_RECONCILIATION_POINTER_UNKNOWN");
}

export function createArticlePublicationActions(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  config: PublicationReleaseConfig,
  dependencyOverrides?: Partial<PublicationReleaseDependencies>,
): {
  publish(input: PublicationActionInput): Promise<PublicationActionResult>;
  rollback(input: PublicationActionInput & { releaseId: string }): Promise<PublicationActionResult>;
} {
  return Object.freeze({
    publish: (input: PublicationActionInput) => publishApprovedArticles(
      db,
      keyProvider,
      input,
      config,
      dependencyOverrides,
    ),
    rollback: (input: PublicationActionInput & { releaseId: string }) => Promise.resolve(
      rollbackPublication(db, keyProvider, input, config, dependencyOverrides),
    ),
  });
}
