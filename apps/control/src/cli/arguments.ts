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
