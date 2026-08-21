import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  createReleaseBoundConsentAuthorityResolver,
  getConsentReleaseBinding,
} from "../consent/release-authority.js";
import {
  activateConsentBundle,
  createDatabaseConsentAuthorityResolver,
  getPublishedConsentBundleById,
  seedConsentDocuments,
} from "../consent/service.js";
import {
  abortSitesReleaseHandoff,
  activateSitesReleaseHandoff,
  getSitesReleaseHandoff,
  MIN_RETIRING_WINDOW_MS,
  prepareSitesReleaseHandoff,
  recordSitesReleaseDeployment,
} from "./sites-release-handoff.js";

let database: TestDatabase | undefined;
afterEach(() => database?.close());

const sourceA = "a".repeat(40);
const sourceB = "b".repeat(40);
const environmentRevision = "sites-environment-revision-1";

function publishControlRelease(
  current: TestDatabase,
  input: {
    releaseId: string;
    bundleId: string;
    suffix: string;
    manifestByte: number;
    nowMs: number;
  },
): string {
  seedConsentDocuments(
    current.db,
    consentBundle(input.bundleId, input.suffix),
    input.nowMs - 2,
  );
  activateConsentBundle(current.db, input.bundleId, input.nowMs - 1);
  const bundle = getPublishedConsentBundleById(current.db, input.bundleId)!;
  const contentFileSha256 = createHash("sha256")
    .update(`${JSON.stringify(bundle, null, 2)}\n`, "utf8")
    .digest("hex");
  current.db.sqlite.prepare(`
    UPDATE releases
    SET state = 'retired', rolled_back_at_ms = ?
    WHERE state = 'active'
  `).run(input.nowMs - 1);
  const manifest = Buffer.alloc(32, input.manifestByte);
  current.db.sqlite.prepare(`
    INSERT INTO releases (
      id, version, path, manifest_sha256, state, created_at_ms, activated_at_ms,
      created_by, verified_at_ms, verification_sha256, metadata_json
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, 'system', ?, ?, ?)
  `).run(
    input.releaseId,
    `version-${input.releaseId}`,
    `/releases/${input.releaseId}`,
    manifest,
    input.nowMs,
    input.nowMs,
    input.nowMs,
    manifest,
    JSON.stringify({
      consentBundle: { bundleId: input.bundleId, contentFileSha256 },
    }),
  );
  return manifest.toString("hex");
}

function handoffIdentity(
  releaseId: string,
  manifestSha256: string,
  sitesSourceCommit: string,
) {
  return {
    releaseId,
    manifestSha256,
    sitesSourceCommit,
    environmentRevision,
  };
}

function operator(nowMs: number) {
  return { nowMs, requestId: `sites-release-test-${nowMs}` };
}

describe("Sites release handoff", () => {
  it("keeps old, pending, default, retiring, and rollback consent authorities exact", () => {
    database = createTestDatabase();
    const manifestA = publishControlRelease(database, {
      releaseId: "release-a",
      bundleId: "bundle-a",
      suffix: "a",
      manifestByte: 21,
      nowMs: 1_000,
    });
    const identityA = handoffIdentity("release-a", manifestA, sourceA);
    prepareSitesReleaseHandoff(database.db, {
      ...identityA,
      expectedState: "absent",
      bundleId: "bundle-a",
    }, operator(1_100));
    recordSitesReleaseDeployment(database.db, {
      ...identityA,
      expectedState: "pending",
      savedVersionId: "sites-version-a",
      deploymentId: "sites-deployment-a",
    }, operator(1_200));
    activateSitesReleaseHandoff(database.db, {
      ...identityA,
      expectedState: "pending",
      savedVersionId: "sites-version-a",
      deploymentId: "sites-deployment-a",
      retiringWindowMs: MIN_RETIRING_WINDOW_MS,
    }, operator(1_300));

    const manifestB = publishControlRelease(database, {
      releaseId: "release-b",
      bundleId: "bundle-b",
      suffix: "b",
      manifestByte: 22,
      nowMs: 2_000,
    });
    const identityB = handoffIdentity("release-b", manifestB, sourceB);
    prepareSitesReleaseHandoff(database.db, {
      ...identityB,
      expectedState: "absent",
      bundleId: "bundle-b",
    }, operator(2_100));
    recordSitesReleaseDeployment(database.db, {
      ...identityB,
      expectedState: "pending",
      savedVersionId: "sites-version-b",
      deploymentId: "sites-deployment-b",
    }, operator(2_200));

    const resolver = createReleaseBoundConsentAuthorityResolver(
      database.db,
      createDatabaseConsentAuthorityResolver(database.db),
    );
    expect(resolver({ nowMs: 2_300 })?.bundle.bundleId).toBe("bundle-a");
    expect(resolver({ releaseId: "release-a", nowMs: 2_300 })?.bundle.bundleId).toBe("bundle-a");
    expect(resolver({ releaseId: "release-b", nowMs: 2_300 })?.bundle.bundleId).toBe("bundle-b");
    expect(getConsentReleaseBinding(database.db)?.releaseId).toBe("release-a");

    expect(() => activateSitesReleaseHandoff(database!.db, {
      ...identityB,
      expectedState: "pending",
      savedVersionId: "sites-version-b",
      deploymentId: "wrong-deployment",
      retiringWindowMs: MIN_RETIRING_WINDOW_MS,
    }, operator(2_400))).toThrow("SITES_DEPLOYMENT_IDENTITY_MISMATCH");
    expect(getConsentReleaseBinding(database.db)?.releaseId).toBe("release-a");

    activateSitesReleaseHandoff(database.db, {
      ...identityB,
      expectedState: "pending",
      savedVersionId: "sites-version-b",
      deploymentId: "sites-deployment-b",
      retiringWindowMs: MIN_RETIRING_WINDOW_MS,
    }, operator(2_500));
    expect(resolver({ nowMs: 2_501 })?.bundle.bundleId).toBe("bundle-b");
    expect(resolver({ releaseId: "release-a", nowMs: 2_501 })?.bundle.bundleId).toBe("bundle-a");
    expect(resolver({
      releaseId: "release-a",
      nowMs: 2_500 + MIN_RETIRING_WINDOW_MS,
    })).toBeUndefined();

    recordSitesReleaseDeployment(database.db, {
      ...identityA,
      expectedState: "retiring",
      expectedCurrentSavedVersionId: "sites-version-a",
      expectedCurrentDeploymentId: "sites-deployment-a",
      savedVersionId: "sites-version-a",
      deploymentId: "sites-deployment-a-rollback",
    }, operator(3_000));
    activateSitesReleaseHandoff(database.db, {
      ...identityA,
      expectedState: "retiring",
      savedVersionId: "sites-version-a",
      deploymentId: "sites-deployment-a-rollback",
      retiringWindowMs: MIN_RETIRING_WINDOW_MS,
    }, operator(3_100));
    expect(resolver({ nowMs: 3_101 })?.bundle.bundleId).toBe("bundle-a");
    expect(getSitesReleaseHandoff(database.db, "release-b")).toMatchObject({
      state: "retiring",
      acceptUntilMs: 3_100 + MIN_RETIRING_WINDOW_MS,
    });
    expect(database.db.sqlite.prepare(`
      SELECT action FROM audit_events
      WHERE target_type = 'sites-release' ORDER BY created_at_ms, action
    `).all()).toEqual(expect.arrayContaining([
      { action: "sites.release.prepared" },
      { action: "sites.release.deployment-recorded" },
      { action: "sites.release.activated" },
      { action: "sites.release.rolled-back" },
    ]));
  });

  it("aborts only the exact pending handoff and preserves an immutable audit event", () => {
    database = createTestDatabase();
    const manifest = publishControlRelease(database, {
      releaseId: "release-abort",
      bundleId: "bundle-abort",
      suffix: "abort",
      manifestByte: 31,
      nowMs: 1_000,
    });
    const identity = handoffIdentity("release-abort", manifest, sourceA);
    prepareSitesReleaseHandoff(database.db, {
      ...identity,
      expectedState: "absent",
      bundleId: "bundle-abort",
    }, operator(1_100));
    recordSitesReleaseDeployment(database.db, {
      ...identity,
      expectedState: "pending",
      savedVersionId: "sites-version-abort",
      deploymentId: "sites-deployment-abort",
    }, operator(1_200));

    expect(() => abortSitesReleaseHandoff(database!.db, {
      ...identity,
      expectedState: "pending",
      expectedSavedVersionId: "sites-version-abort",
      expectedDeploymentId: "wrong-deployment",
    }, operator(1_300))).toThrow("SITES_DEPLOYMENT_IDENTITY_MISMATCH");
    expect(getSitesReleaseHandoff(database.db, "release-abort")).toBeDefined();

    abortSitesReleaseHandoff(database.db, {
      ...identity,
      expectedState: "pending",
      expectedSavedVersionId: "sites-version-abort",
      expectedDeploymentId: "sites-deployment-abort",
    }, operator(1_400));
    expect(getSitesReleaseHandoff(database.db, "release-abort")).toBeUndefined();
    expect(database.db.sqlite.prepare(`
      SELECT action, target_id FROM audit_events
      WHERE action = 'sites.release.aborted'
    `).get()).toEqual({
      action: "sites.release.aborted",
      target_id: "release-abort",
    });
  });
});
