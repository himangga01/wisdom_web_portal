import { createHash, randomUUID } from "node:crypto";

import type { ControlDatabase } from "../db/client.js";
import { getPublishedConsentBundleById } from "../consent/service.js";
import type { ConsentReleaseState } from "../consent/release-authority.js";

export const MIN_RETIRING_WINDOW_MS = 2 * 60 * 60 * 1_000;
export const MAX_RETIRING_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface SitesReleaseHandoff {
  releaseId: string;
  bundleId: string;
  manifestSha256: string;
  sitesSourceCommit: string;
  savedVersionId: string | null;
  deploymentId: string | null;
  environmentRevision: string;
  state: ConsentReleaseState;
  acceptUntilMs: number | null;
  preparedAtMs: number;
  deploymentRecordedAtMs: number | null;
  activatedAtMs: number | null;
  updatedAtMs: number;
}

interface SitesReleaseHandoffRow {
  release_id: string;
  bundle_id: string;
  manifest_sha256: Buffer;
  sites_source_commit: string;
  saved_version_id: string | null;
  deployment_id: string | null;
  environment_revision: string;
  state: ConsentReleaseState;
  accept_until_ms: number | null;
  prepared_at_ms: number;
  deployment_recorded_at_ms: number | null;
  activated_at_ms: number | null;
  updated_at_ms: number;
}

interface HandoffIdentity {
  releaseId: string;
  manifestSha256: string;
  sitesSourceCommit: string;
  environmentRevision: string;
}

interface OperatorContext {
  nowMs: number;
  requestId: string;
}

interface DeploymentIdentity {
  savedVersionId: string;
  deploymentId: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function exactText(value: string, maximumBytes: number, code: string): string {
  if (
    value !== value.trim() ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

function identity(input: HandoffIdentity): HandoffIdentity {
  exactText(input.releaseId, 128, "SITES_RELEASE_ID_INVALID");
  if (!/^[a-f0-9]{64}$/u.test(input.manifestSha256)) fail("SITES_RELEASE_MANIFEST_INVALID");
  if (!/^[a-f0-9]{7,64}$/u.test(input.sitesSourceCommit)) fail("SITES_SOURCE_COMMIT_INVALID");
  exactText(input.environmentRevision, 256, "SITES_ENVIRONMENT_REVISION_INVALID");
  return input;
}

function deployment(input: DeploymentIdentity): DeploymentIdentity {
  exactText(input.savedVersionId, 256, "SITES_SAVED_VERSION_ID_INVALID");
  exactText(input.deploymentId, 256, "SITES_DEPLOYMENT_ID_INVALID");
  return input;
}

function timestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) fail("SITES_HANDOFF_TIME_INVALID");
  return value;
}

function rowToHandoff(row: SitesReleaseHandoffRow): SitesReleaseHandoff {
  return {
    releaseId: row.release_id,
    bundleId: row.bundle_id,
    manifestSha256: row.manifest_sha256.toString("hex"),
    sitesSourceCommit: row.sites_source_commit,
    savedVersionId: row.saved_version_id,
    deploymentId: row.deployment_id,
    environmentRevision: row.environment_revision,
    state: row.state,
    acceptUntilMs: row.accept_until_ms,
    preparedAtMs: row.prepared_at_ms,
    deploymentRecordedAtMs: row.deployment_recorded_at_ms,
    activatedAtMs: row.activated_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function selectHandoff(
  db: ControlDatabase,
  releaseId: string,
): SitesReleaseHandoffRow | undefined {
  return db.sqlite.prepare(`
    SELECT release_id, bundle_id, manifest_sha256, sites_source_commit,
      saved_version_id, deployment_id, environment_revision, state,
      accept_until_ms, prepared_at_ms, deployment_recorded_at_ms,
      activated_at_ms, updated_at_ms
    FROM sites_release_handoffs WHERE release_id = ?
  `).get(releaseId) as SitesReleaseHandoffRow | undefined;
}

export function getSitesReleaseHandoff(
  db: ControlDatabase,
  releaseId: string,
): SitesReleaseHandoff | undefined {
  const row = selectHandoff(db, releaseId);
  return row ? rowToHandoff(row) : undefined;
}

function assertIdentity(row: SitesReleaseHandoffRow, input: HandoffIdentity): void {
  identity(input);
  if (
    row.release_id !== input.releaseId ||
    row.manifest_sha256.toString("hex") !== input.manifestSha256 ||
    row.sites_source_commit !== input.sitesSourceCommit ||
    row.environment_revision !== input.environmentRevision
  ) fail("SITES_HANDOFF_IDENTITY_MISMATCH");
}

function audit(
  db: ControlDatabase,
  action: string,
  releaseId: string,
  context: OperatorContext,
  metadata: Record<string, unknown>,
): void {
  db.sqlite.prepare(`
    INSERT INTO audit_events (
      id, actor_type, action, target_type, target_id, request_id,
      metadata_json, created_at_ms
    ) VALUES (?, 'system', ?, 'sites-release', ?, ?, ?, ?)
  `).run(
    randomUUID(),
    action,
    releaseId,
    exactText(context.requestId, 256, "SITES_HANDOFF_REQUEST_ID_INVALID"),
    JSON.stringify(metadata),
    timestamp(context.nowMs),
  );
}

function transaction<T>(db: ControlDatabase, operation: () => T): T {
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function releaseConsentMetadata(value: string | null): {
  bundleId: string;
  contentFileSha256: string;
} {
  let parsed: unknown;
  try {
    parsed = value === null ? undefined : JSON.parse(value);
  } catch {
    fail("SITES_CONTROL_RELEASE_METADATA_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("SITES_CONTROL_RELEASE_METADATA_INVALID");
  }
  const consentBundle = (parsed as { consentBundle?: unknown }).consentBundle;
  if (!consentBundle || typeof consentBundle !== "object" || Array.isArray(consentBundle)) {
    fail("SITES_CONTROL_RELEASE_METADATA_INVALID");
  }
  const record = consentBundle as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !== "bundleId\0contentFileSha256" ||
    typeof record.bundleId !== "string" ||
    typeof record.contentFileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.contentFileSha256)
  ) fail("SITES_CONTROL_RELEASE_METADATA_INVALID");
  return {
    bundleId: record.bundleId,
    contentFileSha256: record.contentFileSha256,
  };
}

export function prepareSitesReleaseHandoff(
  db: ControlDatabase,
  input: HandoffIdentity & {
    expectedState: "absent";
    bundleId: string;
  },
  context: OperatorContext,
): SitesReleaseHandoff {
  identity(input);
  exactText(input.bundleId, 128, "SITES_CONSENT_BUNDLE_ID_INVALID");
  timestamp(context.nowMs);
  return transaction(db, () => {
    if (selectHandoff(db, input.releaseId)) fail("SITES_HANDOFF_ALREADY_EXISTS");
    const manifest = Buffer.from(input.manifestSha256, "hex");
    const release = db.sqlite.prepare(`
      SELECT state, verified_at_ms, verification_sha256, metadata_json
      FROM releases WHERE id = ? AND manifest_sha256 = ?
    `).get(input.releaseId, manifest) as {
      state: string;
      verified_at_ms: number | null;
      verification_sha256: Buffer | null;
      metadata_json: string | null;
    } | undefined;
    if (
      !release ||
      !["active", "retired"].includes(release.state) ||
      release.verified_at_ms === null ||
      !Buffer.isBuffer(release.verification_sha256) ||
      !release.verification_sha256.equals(manifest)
    ) fail("SITES_CONTROL_RELEASE_UNVERIFIED");
    const bundle = getPublishedConsentBundleById(db, input.bundleId);
    if (!bundle) {
      fail("SITES_CONSENT_BUNDLE_UNPUBLISHED");
    }
    const consentMetadata = releaseConsentMetadata(release.metadata_json);
    const contentFileSha256 = createHash("sha256")
      .update(`${JSON.stringify(bundle, null, 2)}\n`, "utf8")
      .digest("hex");
    if (
      consentMetadata.bundleId !== input.bundleId ||
      consentMetadata.contentFileSha256 !== contentFileSha256
    ) fail("SITES_CONTROL_RELEASE_CONSENT_MISMATCH");
    db.sqlite.prepare(`
      INSERT INTO sites_release_handoffs (
        release_id, bundle_id, manifest_sha256, sites_source_commit,
        environment_revision, state, prepared_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.releaseId,
      input.bundleId,
      manifest,
      input.sitesSourceCommit,
      input.environmentRevision,
      context.nowMs,
      context.nowMs,
    );
    audit(db, "sites.release.prepared", input.releaseId, context, {
      bundleId: input.bundleId,
      manifestSha256: input.manifestSha256,
      sitesSourceCommit: input.sitesSourceCommit,
      environmentRevision: input.environmentRevision,
    });
    return rowToHandoff(selectHandoff(db, input.releaseId)!);
  });
}

export function recordSitesReleaseDeployment(
  db: ControlDatabase,
  input: HandoffIdentity & DeploymentIdentity & {
    expectedState: "pending" | "retiring";
    expectedCurrentSavedVersionId?: string;
    expectedCurrentDeploymentId?: string;
  },
  context: OperatorContext,
): SitesReleaseHandoff {
  identity(input);
  deployment(input);
  timestamp(context.nowMs);
  return transaction(db, () => {
    const row = selectHandoff(db, input.releaseId);
    if (!row) fail("SITES_HANDOFF_NOT_FOUND");
    assertIdentity(row, input);
    if (row.state !== input.expectedState) fail("SITES_HANDOFF_STATE_MISMATCH");
    const hasCurrent = row.saved_version_id !== null || row.deployment_id !== null;
    if (hasCurrent) {
      if (
        row.saved_version_id !== input.expectedCurrentSavedVersionId ||
        row.deployment_id !== input.expectedCurrentDeploymentId
      ) fail("SITES_CURRENT_DEPLOYMENT_MISMATCH");
    } else if (
      input.expectedCurrentSavedVersionId !== undefined ||
      input.expectedCurrentDeploymentId !== undefined
    ) {
      fail("SITES_CURRENT_DEPLOYMENT_MISMATCH");
    }
    if (
      row.saved_version_id === input.savedVersionId &&
      row.deployment_id === input.deploymentId
    ) return rowToHandoff(row);
    db.sqlite.prepare(`
      UPDATE sites_release_handoffs
      SET saved_version_id = ?, deployment_id = ?,
        deployment_recorded_at_ms = ?, updated_at_ms = ?
      WHERE release_id = ?
    `).run(
      input.savedVersionId,
      input.deploymentId,
      context.nowMs,
      context.nowMs,
      input.releaseId,
    );
    audit(db, "sites.release.deployment-recorded", input.releaseId, context, {
      savedVersionId: input.savedVersionId,
      deploymentId: input.deploymentId,
      replacedSavedVersionId: row.saved_version_id,
      replacedDeploymentId: row.deployment_id,
    });
    return rowToHandoff(selectHandoff(db, input.releaseId)!);
  });
}

export function activateSitesReleaseHandoff(
  db: ControlDatabase,
  input: HandoffIdentity & DeploymentIdentity & {
    expectedState: "pending" | "retiring";
    retiringWindowMs: number;
  },
  context: OperatorContext,
): SitesReleaseHandoff {
  identity(input);
  deployment(input);
  timestamp(context.nowMs);
  if (
    !Number.isSafeInteger(input.retiringWindowMs) ||
    input.retiringWindowMs < MIN_RETIRING_WINDOW_MS ||
    input.retiringWindowMs > MAX_RETIRING_WINDOW_MS
  ) fail("SITES_RETIRING_WINDOW_INVALID");
  return transaction(db, () => {
    const target = selectHandoff(db, input.releaseId);
    if (!target) fail("SITES_HANDOFF_NOT_FOUND");
    assertIdentity(target, input);
    if (target.state !== input.expectedState) fail("SITES_HANDOFF_STATE_MISMATCH");
    if (
      target.saved_version_id !== input.savedVersionId ||
      target.deployment_id !== input.deploymentId
    ) fail("SITES_DEPLOYMENT_IDENTITY_MISMATCH");
    if (
      target.state === "retiring" &&
      (target.accept_until_ms === null || target.accept_until_ms <= context.nowMs)
    ) fail("SITES_ROLLBACK_WINDOW_EXPIRED");

    const previous = db.sqlite.prepare(`
      SELECT release_id FROM sites_release_handoffs WHERE state = 'default'
    `).get() as { release_id: string } | undefined;
    if (previous?.release_id === input.releaseId) fail("SITES_HANDOFF_STATE_MISMATCH");
    if (previous) {
      db.sqlite.prepare(`
        UPDATE sites_release_handoffs
        SET state = 'retiring', accept_until_ms = ?, updated_at_ms = ?
        WHERE release_id = ? AND state = 'default'
      `).run(
        context.nowMs + input.retiringWindowMs,
        context.nowMs,
        previous.release_id,
      );
    }
    const changed = db.sqlite.prepare(`
      UPDATE sites_release_handoffs
      SET state = 'default', accept_until_ms = NULL,
        activated_at_ms = ?, updated_at_ms = ?
      WHERE release_id = ? AND state = ?
    `).run(context.nowMs, context.nowMs, input.releaseId, input.expectedState);
    if (changed.changes !== 1) fail("SITES_HANDOFF_STATE_RACE");
    audit(db, target.state === "retiring" ? "sites.release.rolled-back" : "sites.release.activated", input.releaseId, context, {
      previousReleaseId: previous?.release_id ?? null,
      savedVersionId: input.savedVersionId,
      deploymentId: input.deploymentId,
      retiringWindowMs: input.retiringWindowMs,
    });
    return rowToHandoff(selectHandoff(db, input.releaseId)!);
  });
}

export function abortSitesReleaseHandoff(
  db: ControlDatabase,
  input: HandoffIdentity & {
    expectedState: "pending";
    expectedSavedVersionId?: string;
    expectedDeploymentId?: string;
  },
  context: OperatorContext,
): void {
  identity(input);
  timestamp(context.nowMs);
  transaction(db, () => {
    const row = selectHandoff(db, input.releaseId);
    if (!row) fail("SITES_HANDOFF_NOT_FOUND");
    assertIdentity(row, input);
    if (row.state !== input.expectedState) fail("SITES_HANDOFF_STATE_MISMATCH");
    if (
      row.saved_version_id !== (input.expectedSavedVersionId ?? null) ||
      row.deployment_id !== (input.expectedDeploymentId ?? null)
    ) fail("SITES_DEPLOYMENT_IDENTITY_MISMATCH");
    audit(db, "sites.release.aborted", input.releaseId, context, {
      savedVersionId: row.saved_version_id,
      deploymentId: row.deployment_id,
    });
    const deleted = db.sqlite.prepare(
      "DELETE FROM sites_release_handoffs WHERE release_id = ? AND state = 'pending'",
    ).run(input.releaseId);
    if (deleted.changes !== 1) fail("SITES_HANDOFF_STATE_RACE");
  });
}
