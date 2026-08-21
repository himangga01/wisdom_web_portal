import type { PublishedConsentBundle } from "@wisdom/shared";

import type { ControlDatabase } from "../db/client.js";
import {
  getConsentBundleDigest,
  getPublishedConsentBundleById,
  type ConsentAuthority,
  type ConsentAuthorityResolver,
} from "./service.js";

export type ConsentReleaseState = "pending" | "default" | "retiring";

export interface ConsentReleaseBinding {
  releaseId: string;
  bundleId: string;
  manifestSha256: string;
  state: ConsentReleaseState;
  acceptUntilMs: number | null;
}

export interface ConsentAuthorityIdentity {
  releaseId: string;
  bundleId: string;
  manifestSha256: string;
}

interface SitesReleaseHandoffRow {
  release_id: string;
  bundle_id: string;
  manifest_sha256: Buffer;
  state: ConsentReleaseState;
  accept_until_ms: number | null;
}

interface ReleaseRow {
  manifest_sha256: Buffer;
  state: string;
  verified_at_ms: number | null;
  verification_sha256: Buffer | null;
}

export function isConsentReleaseId(value: string): boolean {
  return value.length >= 1
    && value.length <= 128
    && value === value.trim()
    && !/[\u0000-\u0020\u007f]/u.test(value);
}

function releaseRowIsVerified(row: ReleaseRow, manifestSha256: Buffer): boolean {
  return ["active", "retired"].includes(row.state)
    && row.verified_at_ms !== null
    && Buffer.isBuffer(row.verification_sha256)
    && row.manifest_sha256.equals(manifestSha256)
    && row.verification_sha256.equals(manifestSha256);
}

function boundAuthority(
  db: ControlDatabase,
  row: SitesReleaseHandoffRow,
  nowMs: number,
): ConsentAuthority | undefined {
  if (row.state === "retiring" && (row.accept_until_ms === null || row.accept_until_ms <= nowMs)) {
    return undefined;
  }
  const release = db.sqlite.prepare(`
    SELECT manifest_sha256, state, verified_at_ms, verification_sha256
    FROM releases WHERE id = ?
  `).get(row.release_id) as ReleaseRow | undefined;
  if (!release || !releaseRowIsVerified(release, row.manifest_sha256)) return undefined;
  const bundle = getPublishedConsentBundleById(db, row.bundle_id);
  if (!bundle) return undefined;
  return {
    source: "release",
    releaseId: row.release_id,
    releaseManifestSha256: row.manifest_sha256.toString("hex"),
    bundle,
  };
}

function bindingRow(
  db: ControlDatabase,
  releaseId: string | undefined,
): SitesReleaseHandoffRow | undefined {
  if (releaseId !== undefined) {
    if (!isConsentReleaseId(releaseId)) return undefined;
    return db.sqlite.prepare(`
      SELECT release_id, bundle_id, manifest_sha256, state, accept_until_ms
      FROM sites_release_handoffs WHERE release_id = ?
    `).get(releaseId) as SitesReleaseHandoffRow | undefined;
  }
  return db.sqlite.prepare(`
    SELECT release_id, bundle_id, manifest_sha256, state, accept_until_ms
    FROM sites_release_handoffs WHERE state = 'default'
  `).get() as SitesReleaseHandoffRow | undefined;
}

export function getConsentReleaseBinding(
  db: ControlDatabase,
  releaseId?: string,
): ConsentReleaseBinding | undefined {
  const row = bindingRow(db, releaseId);
  return row
    ? {
        releaseId: row.release_id,
        bundleId: row.bundle_id,
        manifestSha256: row.manifest_sha256.toString("hex"),
        state: row.state,
        acceptUntilMs: row.accept_until_ms,
      }
    : undefined;
}

export function consentAuthorityIdentity(
  db: ControlDatabase,
  authority: ConsentAuthority,
): ConsentAuthorityIdentity {
  return authority.source === "release"
    ? {
        releaseId: authority.releaseId,
        bundleId: authority.bundle.bundleId,
        manifestSha256: authority.releaseManifestSha256,
      }
    : {
        releaseId: `database:${authority.bundle.bundleId}`,
        bundleId: authority.bundle.bundleId,
        manifestSha256: getConsentBundleDigest(db, authority.bundle.bundleId),
      };
}

function sameIdentity(
  left: ConsentAuthorityIdentity,
  right: ConsentAuthorityIdentity,
): boolean {
  return left.releaseId === right.releaseId
    && left.bundleId === right.bundleId
    && left.manifestSha256 === right.manifestSha256;
}

export function createReleaseBoundConsentAuthorityResolver(
  db: ControlDatabase,
  fallback?: ConsentAuthorityResolver,
): ConsentAuthorityResolver {
  return (request = {}) => {
    const nowMs = request.nowMs ?? Date.now();
    const row = bindingRow(db, request.releaseId);
    if (row) return boundAuthority(db, row, nowMs);
    if (request.releaseId !== undefined && !isConsentReleaseId(request.releaseId)) return undefined;
    const fallbackAuthority = fallback?.(request);
    if (!fallbackAuthority) return undefined;
    if (request.releaseId === undefined) return fallbackAuthority;
    const expected: ConsentAuthorityIdentity = {
      releaseId: request.releaseId,
      bundleId: fallbackAuthority.bundle.bundleId,
      manifestSha256: fallbackAuthority.source === "release"
        ? fallbackAuthority.releaseManifestSha256
        : getConsentBundleDigest(db, fallbackAuthority.bundle.bundleId),
    };
    return sameIdentity(consentAuthorityIdentity(db, fallbackAuthority), expected)
      ? fallbackAuthority
      : undefined;
  };
}

export function publicConsentRelease(
  db: ControlDatabase,
  authority: ConsentAuthority,
): ConsentAuthorityIdentity & { bundle: PublishedConsentBundle } {
  return {
    ...consentAuthorityIdentity(db, authority),
    bundle: authority.bundle,
  };
}
