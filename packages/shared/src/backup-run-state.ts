import { z } from "zod";

const utcTimestampSchema = z.iso.datetime({ offset: true }).refine(
  (value) => value.endsWith("Z"),
  { message: "Timestamp must use UTC" },
);

export const backupRunOutcomeSchema = z.enum([
  "running",
  "verified",
  "not-due",
  "admin-disabled",
  "failed",
]);

export const backupRunErrorCodeSchema = z.enum([
  "BACKUP_CONTROL_INVALID",
  "BACKUP_OPERATION_FAILED",
]).nullable();

export const backupRunStateSchema = z.object({
  formatVersion: z.literal(1),
  runId: z.uuid(),
  startedAt: utcTimestampSchema.nullable(),
  finishedAt: utcTimestampSchema.nullable(),
  outcome: backupRunOutcomeSchema,
  controlRevision: z.int().positive().nullable(),
  lastVerifiedAt: utcTimestampSchema.nullable(),
  lastVerifiedArtifact: z.string()
    .regex(/^hourly-\d{8}T\d{6}Z\.age$/u)
    .nullable(),
  errorCode: backupRunErrorCodeSchema,
}).strict().superRefine((value, context) => {
  if (value.outcome === "running" && value.finishedAt !== null) {
    context.addIssue({
      code: "custom",
      path: ["finishedAt"],
      message: "A running backup must not have a finish time",
    });
  }
  if (
    value.outcome === "verified" &&
    (value.lastVerifiedAt === null || value.lastVerifiedArtifact === null)
  ) {
    context.addIssue({
      code: "custom",
      path: value.lastVerifiedAt === null ? ["lastVerifiedAt"] : ["lastVerifiedArtifact"],
      message: "A verified backup requires verified artifact details",
    });
  }
  if (value.outcome !== "failed" && value.errorCode !== null) {
    context.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "Only failed backups may include an error code",
    });
  }
  if (value.outcome === "failed" && value.errorCode === null) {
    context.addIssue({
      code: "custom",
      path: ["errorCode"],
      message: "A failed backup requires an error code",
    });
  }
  const revisionMayBeUnknown = value.outcome === "failed" &&
    value.errorCode === "BACKUP_CONTROL_INVALID";
  if (value.controlRevision === null && !revisionMayBeUnknown) {
    context.addIssue({
      code: "custom",
      path: ["controlRevision"],
      message: "A trusted backup control revision is required",
    });
  }
});

export type BackupRunState = z.infer<typeof backupRunStateSchema>;
