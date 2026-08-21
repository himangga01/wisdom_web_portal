import { describe, expect, it } from "vitest";

import {
  parseActivateArguments,
  parseFirstPublicationArguments,
  parseMigrateArguments,
  parsePurgeArguments,
  parseSeedArguments,
  parseSitesReleaseArguments,
} from "./arguments.js";

describe("control CLI arguments", () => {
  it("requires an explicit rollback compatibility gate for deployment migrations", () => {
    expect(parseMigrateArguments([])).toEqual({ requireRollbackCompatible: true });
    expect(parseMigrateArguments(["--require-rollback-compatible"])).toEqual({
      requireRollbackCompatible: true,
    });
    expect(() => parseMigrateArguments(["--allow-incompatible-maintenance"]))
      .toThrow(/unknown db:migrate argument/i);
    expect(() => parseMigrateArguments(["--unknown"])).toThrow(/unknown/i);
  });

  it("requires explicit seed and activation inputs", () => {
    expect(parseSeedArguments(["--file", "consent.json"])).toEqual({ file: "consent.json" });
    expect(() => parseSeedArguments([])).toThrow();
    const digest = "a".repeat(64);
    expect(parseActivateArguments([
      "--bundle", "bundle-v1", "--confirm-sha", digest,
    ])).toEqual({ bundleId: "bundle-v1", confirmSha: digest });
    expect(() => parseActivateArguments([])).toThrow();
    expect(() => parseActivateArguments(["--bundle", "bundle-v1"])).toThrow();
  });

  it("keeps purge dry-run first and validates bounded batches", () => {
    expect(parsePurgeArguments([])).toEqual({ apply: false, batchSize: 100, maxBatches: 10 });
    expect(parsePurgeArguments([
      "--apply", "--batch-size", "25", "--max-batches", "3",
    ])).toEqual({
      apply: true,
      batchSize: 25,
      maxBatches: 3,
    });
    expect(() => parsePurgeArguments(["--batch-size", "0"])).toThrow();
    expect(() => parsePurgeArguments(["--max-batches", "0"])).toThrow();
    expect(() => parsePurgeArguments(["--max-batches", "101"])).toThrow();
  });

  it("requires exact one-time first publication identities", () => {
    const bootstrapReleaseId = "20260716T010203Z-abcdef1";
    const actorAdminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    expect(parseFirstPublicationArguments([
      "--bootstrap-release-id", bootstrapReleaseId,
      "--actor-admin-id", actorAdminId,
    ])).toEqual({
      bootstrapReleaseId,
      actorAdminId,
      apply: false,
    });
    const fingerprint = "a".repeat(64);
    expect(parseFirstPublicationArguments([
      "--bootstrap-release-id", bootstrapReleaseId,
      "--actor-admin-id", actorAdminId,
      "--apply",
      "--confirm-first-publication", fingerprint,
    ])).toEqual({
      bootstrapReleaseId,
      actorAdminId,
      apply: true,
      confirmFingerprint: fingerprint,
    });
    expect(() => parseFirstPublicationArguments([
      "--bootstrap-release-id", bootstrapReleaseId,
      "--actor-admin-id", actorAdminId,
      "--apply",
    ])).toThrow(/confirm-first-publication/u);
    expect(() => parseFirstPublicationArguments([
      "--bootstrap-release-id", bootstrapReleaseId,
      "--actor-admin-id", actorAdminId,
      "--unknown",
    ])).toThrow(/unknown/u);
  });

  it("requires exact state and deployment identities for every Sites release transition", () => {
    const common = [
      "--release-id", "release-2026-07-25",
      "--manifest-sha", "a".repeat(64),
      "--source-commit", "b".repeat(40),
      "--environment-revision", "environment-revision-1",
    ];
    expect(parseSitesReleaseArguments([
      "prepare",
      ...common,
      "--expected-state", "absent",
      "--bundle", "bundle-2026-07-25",
    ])).toMatchObject({
      action: "prepare",
      releaseId: "release-2026-07-25",
      expectedState: "absent",
      bundleId: "bundle-2026-07-25",
    });
    expect(parseSitesReleaseArguments([
      "record-deployment",
      ...common,
      "--expected-state", "pending",
      "--saved-version-id", "saved-version-1",
      "--deployment-id", "deployment-1",
    ])).toMatchObject({
      action: "record-deployment",
      expectedState: "pending",
      savedVersionId: "saved-version-1",
      deploymentId: "deployment-1",
    });
    expect(parseSitesReleaseArguments([
      "activate",
      ...common,
      "--expected-state", "retiring",
      "--saved-version-id", "saved-version-1",
      "--deployment-id", "deployment-rollback",
      "--retiring-window-ms", "7200000",
    ])).toMatchObject({
      action: "activate",
      expectedState: "retiring",
      retiringWindowMs: 7_200_000,
    });
    expect(parseSitesReleaseArguments([
      "abort",
      ...common,
      "--expected-state", "pending",
      "--expected-current-saved-version-id", "saved-version-1",
      "--expected-current-deployment-id", "deployment-1",
    ])).toMatchObject({
      action: "abort",
      expectedSavedVersionId: "saved-version-1",
      expectedDeploymentId: "deployment-1",
    });
    expect(() => parseSitesReleaseArguments([
      "activate",
      ...common,
      "--expected-state", "default",
      "--saved-version-id", "saved-version-1",
      "--deployment-id", "deployment-1",
      "--retiring-window-ms", "7200000",
    ])).toThrow(/expected-state/u);
    expect(() => parseSitesReleaseArguments([
      "record-deployment",
      ...common,
      "--expected-state", "retiring",
      "--saved-version-id", "saved-version-1",
      "--deployment-id", "deployment-2",
      "--expected-current-deployment-id", "deployment-1",
    ])).toThrow(/together/u);
  });
});
