function valueAfter(arguments_: readonly string[], flag: string): string | undefined {
  const index = arguments_.indexOf(flag);
  if (index === -1) return undefined;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseMigrateArguments(arguments_: readonly string[]): {
  requireRollbackCompatible: boolean;
} {
  const supported = new Set([
    "--require-rollback-compatible",
  ]);
  const unknown = arguments_.find((argument) => !supported.has(argument));
  if (unknown !== undefined) throw new Error(`Unknown db:migrate argument: ${unknown}`);
  return { requireRollbackCompatible: true };
}

export function parseSeedArguments(arguments_: readonly string[]): { file: string } {
  const file = valueAfter(arguments_, "--file");
  if (!file) throw new Error("consent:seed requires --file <path>");
  return { file };
}

export function parseActivateArguments(arguments_: readonly string[]): {
  bundleId: string;
  confirmSha: string;
} {
  const bundleId = valueAfter(arguments_, "--bundle");
  if (!bundleId) throw new Error("consent:activate requires --bundle <id>");
  const confirmSha = valueAfter(arguments_, "--confirm-sha");
  if (!confirmSha || !/^[a-f0-9]{64}$/.test(confirmSha)) {
    throw new Error("consent:activate requires --confirm-sha <64 lowercase hex characters>");
  }
  return { bundleId, confirmSha };
}

export function parsePurgeArguments(arguments_: readonly string[]): {
  apply: boolean;
  batchSize: number;
  maxBatches: number;
} {
  const rawBatchSize = valueAfter(arguments_, "--batch-size");
  const batchSize = rawBatchSize === undefined ? 100 : Number(rawBatchSize);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  const rawMaxBatches = valueAfter(arguments_, "--max-batches");
  const maxBatches = rawMaxBatches === undefined ? 10 : Number(rawMaxBatches);
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
    throw new Error("--max-batches must be an integer between 1 and 100");
  }
  return { apply: arguments_.includes("--apply"), batchSize, maxBatches };
}

export function parseFirstPublicationArguments(arguments_: readonly string[]): {
  bootstrapReleaseId: string;
  actorAdminId: string;
  apply: boolean;
  confirmFingerprint?: string;
} {
  const supportedFlags = new Set([
    "--bootstrap-release-id",
    "--actor-admin-id",
    "--confirm-first-publication",
  ]);
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--apply") {
      if (apply) throw new Error("Duplicate --apply");
      apply = true;
      continue;
    }
    if (!supportedFlags.has(argument)) {
      throw new Error(`Unknown first-publication argument: ${argument}`);
    }
    if (values.has(argument)) throw new Error(`Duplicate ${argument}`);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    values.set(argument, value);
    index += 1;
  }
  const bootstrapReleaseId = values.get("--bootstrap-release-id");
  if (!bootstrapReleaseId || !/^\d{8}T\d{6}Z-[a-f0-9]{7,40}$/u.test(bootstrapReleaseId)) {
    throw new Error("first-publication requires --bootstrap-release-id <release-id>");
  }
  const actorAdminId = values.get("--actor-admin-id");
  if (!actorAdminId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(actorAdminId)) {
    throw new Error("first-publication requires --actor-admin-id <uuid>");
  }
  const confirmFingerprint = values.get("--confirm-first-publication");
  if (apply && (!confirmFingerprint || !/^[a-f0-9]{64}$/u.test(confirmFingerprint))) {
    throw new Error("first-publication --apply requires --confirm-first-publication <fingerprint>");
  }
  if (!apply && confirmFingerprint !== undefined) {
    throw new Error("--confirm-first-publication is valid only with --apply");
  }
  return {
    bootstrapReleaseId,
    actorAdminId,
    apply,
    ...(confirmFingerprint ? { confirmFingerprint } : {}),
  };
}

type SitesReleaseCommon = {
  releaseId: string;
  manifestSha256: string;
  sitesSourceCommit: string;
  environmentRevision: string;
};

export type SitesReleaseArguments =
  | (SitesReleaseCommon & {
      action: "prepare";
      expectedState: "absent";
      bundleId: string;
    })
  | (SitesReleaseCommon & {
      action: "record-deployment";
      expectedState: "pending" | "retiring";
      savedVersionId: string;
      deploymentId: string;
      expectedCurrentSavedVersionId?: string;
      expectedCurrentDeploymentId?: string;
    })
  | (SitesReleaseCommon & {
      action: "activate";
      expectedState: "pending" | "retiring";
      savedVersionId: string;
      deploymentId: string;
      retiringWindowMs: number;
    })
  | (SitesReleaseCommon & {
      action: "abort";
      expectedState: "pending";
      expectedSavedVersionId?: string;
      expectedDeploymentId?: string;
    });

function sitesReleaseValues(arguments_: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error("Every sites-release flag requires one value");
    }
    if (values.has(flag)) throw new Error(`Duplicate ${flag}`);
    values.set(flag, value);
  }
  return values;
}

function requiredSitesValue(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`sites-release requires ${flag} <value>`);
  return value;
}

export function parseSitesReleaseArguments(
  arguments_: readonly string[],
): SitesReleaseArguments {
  const action = arguments_[0];
  if (!["prepare", "record-deployment", "activate", "abort"].includes(action ?? "")) {
    throw new Error("sites-release requires prepare, record-deployment, activate, or abort");
  }
  if (arguments_.length % 2 === 0) {
    throw new Error("Every sites-release flag requires one value");
  }
  const values = sitesReleaseValues(arguments_);
  const allowedByAction = {
    prepare: new Set([
      "--release-id", "--bundle", "--manifest-sha", "--source-commit",
      "--environment-revision", "--expected-state",
    ]),
    "record-deployment": new Set([
      "--release-id", "--manifest-sha", "--source-commit", "--environment-revision",
      "--expected-state", "--saved-version-id", "--deployment-id",
      "--expected-current-saved-version-id", "--expected-current-deployment-id",
    ]),
    activate: new Set([
      "--release-id", "--manifest-sha", "--source-commit", "--environment-revision",
      "--expected-state", "--saved-version-id", "--deployment-id", "--retiring-window-ms",
    ]),
    abort: new Set([
      "--release-id", "--manifest-sha", "--source-commit", "--environment-revision",
      "--expected-state", "--expected-current-saved-version-id",
      "--expected-current-deployment-id",
    ]),
  } as const;
  const selectedAction = action as keyof typeof allowedByAction;
  const unknown = [...values.keys()].find((flag) => !allowedByAction[selectedAction].has(flag));
  if (unknown) throw new Error(`Unknown sites-release ${selectedAction} argument: ${unknown}`);
  const manifestSha256 = requiredSitesValue(values, "--manifest-sha");
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) {
    throw new Error("--manifest-sha must contain 64 lowercase hex characters");
  }
  const sitesSourceCommit = requiredSitesValue(values, "--source-commit");
  if (!/^[a-f0-9]{7,64}$/u.test(sitesSourceCommit)) {
    throw new Error("--source-commit must be an exact lowercase Git commit");
  }
  const common: SitesReleaseCommon = {
    releaseId: requiredSitesValue(values, "--release-id"),
    manifestSha256,
    sitesSourceCommit,
    environmentRevision: requiredSitesValue(values, "--environment-revision"),
  };
  const expectedState = requiredSitesValue(values, "--expected-state");

  if (selectedAction === "prepare") {
    if (expectedState !== "absent") throw new Error("prepare requires --expected-state absent");
    return {
      action: "prepare",
      ...common,
      expectedState,
      bundleId: requiredSitesValue(values, "--bundle"),
    };
  }
  if (selectedAction === "record-deployment") {
    if (!["pending", "retiring"].includes(expectedState)) {
      throw new Error("record-deployment requires --expected-state pending or retiring");
    }
    const expectedCurrentSavedVersionId = values.get("--expected-current-saved-version-id");
    const expectedCurrentDeploymentId = values.get("--expected-current-deployment-id");
    if ((expectedCurrentSavedVersionId === undefined) !== (expectedCurrentDeploymentId === undefined)) {
      throw new Error("Current saved version and deployment confirmations must be provided together");
    }
    return {
      action: "record-deployment",
      ...common,
      expectedState: expectedState as "pending" | "retiring",
      savedVersionId: requiredSitesValue(values, "--saved-version-id"),
      deploymentId: requiredSitesValue(values, "--deployment-id"),
      ...(expectedCurrentSavedVersionId === undefined
        ? {}
        : {
            expectedCurrentSavedVersionId,
            expectedCurrentDeploymentId: expectedCurrentDeploymentId!,
          }),
    };
  }
  if (selectedAction === "activate") {
    if (!["pending", "retiring"].includes(expectedState)) {
      throw new Error("activate requires --expected-state pending or retiring");
    }
    const retiringWindowMs = Number(requiredSitesValue(values, "--retiring-window-ms"));
    if (!Number.isSafeInteger(retiringWindowMs)) {
      throw new Error("--retiring-window-ms must be an integer");
    }
    return {
      action: "activate",
      ...common,
      expectedState: expectedState as "pending" | "retiring",
      savedVersionId: requiredSitesValue(values, "--saved-version-id"),
      deploymentId: requiredSitesValue(values, "--deployment-id"),
      retiringWindowMs,
    };
  }
  if (expectedState !== "pending") throw new Error("abort requires --expected-state pending");
  const expectedSavedVersionId = values.get("--expected-current-saved-version-id");
  const expectedDeploymentId = values.get("--expected-current-deployment-id");
  if ((expectedSavedVersionId === undefined) !== (expectedDeploymentId === undefined)) {
    throw new Error("Current saved version and deployment confirmations must be provided together");
  }
  return {
    action: "abort",
    ...common,
    expectedState,
    ...(expectedSavedVersionId === undefined
      ? {}
      : { expectedSavedVersionId, expectedDeploymentId: expectedDeploymentId! }),
  };
}
