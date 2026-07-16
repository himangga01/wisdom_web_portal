import { describe, expect, it } from "vitest";

import {
  parseActivateArguments,
  parseMigrateArguments,
  parsePurgeArguments,
  parseSeedArguments,
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
    expect(parsePurgeArguments([])).toEqual({ apply: false, batchSize: 100 });
    expect(parsePurgeArguments(["--apply", "--batch-size", "25"])).toEqual({
      apply: true,
      batchSize: 25,
    });
    expect(() => parsePurgeArguments(["--batch-size", "0"])).toThrow();
  });
});
