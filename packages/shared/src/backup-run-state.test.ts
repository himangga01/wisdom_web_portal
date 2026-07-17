import { describe, expect, it } from "vitest";

import { backupRunStateSchema } from "./backup-run-state.js";

const verifiedState = {
  formatVersion: 1,
  runId: "00000000-0000-4000-8000-000000000702",
  startedAt: "2026-07-17T04:00:00.000Z",
  finishedAt: "2026-07-17T04:00:03.000Z",
  outcome: "verified",
  controlRevision: 2,
  lastVerifiedAt: "2026-07-17T04:00:03.000Z",
  lastVerifiedArtifact: "hourly-20260717T040000Z.age",
  errorCode: null,
} as const;

describe("backup run-state contract", () => {
  it("accepts the strict verified observation shape", () => {
    const value = backupRunStateSchema.parse(verifiedState);

    expect(value.outcome).toBe("verified");
  });

  it.each([
    ["extra keys", { ...verifiedState, secret: "must-not-pass" }],
    ["non-UTC started times", { ...verifiedState, startedAt: "2026-07-17T13:00:00.000+09:00" }],
    ["non-UTC finished times", { ...verifiedState, finishedAt: "2026-07-17T13:00:03.000+09:00" }],
    ["non-UTC verified times", { ...verifiedState, lastVerifiedAt: "2026-07-17T13:00:03.000+09:00" }],
    ["absolute artifact paths", { ...verifiedState, lastVerifiedArtifact: "/private/backups/hourly-20260717T040000Z.age" }],
    ["unknown outcomes", { ...verifiedState, outcome: "succeeded" }],
    ["unknown error codes", { ...verifiedState, outcome: "failed", errorCode: "AGE_FAILED" }],
  ])("rejects %s", (_label, value) => {
    expect(() => backupRunStateSchema.parse(value)).toThrow();
  });

  it("requires running observations to remain unfinished", () => {
    expect(() => backupRunStateSchema.parse({
      ...verifiedState,
      outcome: "running",
      finishedAt: verifiedState.finishedAt,
      lastVerifiedAt: null,
      lastVerifiedArtifact: null,
    })).toThrow();
  });

  it("requires verified observations to identify the verified timestamp and artifact", () => {
    for (const missing of ["lastVerifiedAt", "lastVerifiedArtifact"] as const) {
      expect(() => backupRunStateSchema.parse({
        ...verifiedState,
        [missing]: null,
      })).toThrow();
    }
  });

  it.each(["running", "verified", "not-due", "admin-disabled"] as const)(
    "requires a trusted control revision and no error for %s observations",
    (outcome) => {
      const state = {
        ...verifiedState,
        outcome,
        ...(outcome === "running" ? { finishedAt: null } : {}),
      };
      expect(() => backupRunStateSchema.parse({ ...state, controlRevision: null })).toThrow();
      expect(() => backupRunStateSchema.parse({
        ...state,
        errorCode: "BACKUP_OPERATION_FAILED",
      })).toThrow();
    },
  );

  it("allows only an invalid-control failure to omit the control revision", () => {
    const failed = {
      ...verifiedState,
      outcome: "failed",
      errorCode: "BACKUP_CONTROL_INVALID",
      controlRevision: null,
    } as const;
    expect(backupRunStateSchema.parse(failed)).toEqual(failed);
    expect(() => backupRunStateSchema.parse({
      ...failed,
      errorCode: "BACKUP_OPERATION_FAILED",
    })).toThrow();
  });
});
