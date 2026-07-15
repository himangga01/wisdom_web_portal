import { ZodError } from "zod";
import { describe, expect, it } from "vitest";

import * as environmentModule from "./environment.js";

type EnvironmentSource = Record<string, string | undefined>;
type EnvironmentParser = (source: EnvironmentSource) => Record<string, unknown>;

const environment = environmentModule as unknown as Record<string, unknown>;

const PRODUCTION_SECRETS = [
  {
    envName: "ADMIN_SESSION_SECRET",
    outputName: "adminSessionSecret",
    validValue: "a".repeat(32),
    testOnlyValue: "test-only-admin-session-secret-0001",
  },
  {
    envName: "PII_ENCRYPTION_KEY",
    outputName: "piiEncryptionKey",
    validValue: "b".repeat(32),
    testOnlyValue: "test-only-pii-encryption-key-00001",
  },
  {
    envName: "WITHDRAWAL_TOKEN_SECRET",
    outputName: "withdrawalTokenSecret",
    validValue: "c".repeat(32),
    testOnlyValue: "test-only-withdrawal-token-000001",
  },
] as const;

function environmentParser(): EnvironmentParser {
  const candidate = environment.parseEnvironment;
  expect(candidate, "parseEnvironment must be exported").toBeTypeOf("function");
  return candidate as EnvironmentParser;
}

function parseEnvironment(source: EnvironmentSource): Record<string, unknown> {
  return environmentParser()(source);
}

function productionEnvironment(overrides: EnvironmentSource = {}): EnvironmentSource {
  return {
    NODE_ENV: "production",
    DATABASE_PATH: "./data/wisdom.sqlite",
    ADMIN_SESSION_SECRET: PRODUCTION_SECRETS[0].validValue,
    PII_ENCRYPTION_KEY: PRODUCTION_SECRETS[1].validValue,
    WITHDRAWAL_TOKEN_SECRET: PRODUCTION_SECRETS[2].validValue,
    ...overrides,
  };
}

function expectRejectedAt(
  parse: EnvironmentParser,
  source: EnvironmentSource,
  outputName: string,
): void {
  let caught: unknown;

  try {
    parse(source);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ZodError);
  if (caught instanceof ZodError) {
    expect(caught.issues.map((issue) => issue.path.map(String).join("."))).toContain(outputName);
  }
}

describe("environment parsing", () => {
  it("provides isolated, receipt-only defaults in test mode", () => {
    const parsed = parseEnvironment({ NODE_ENV: "test" });

    expect(parsed).toMatchObject({
      nodeEnv: "test",
      databasePath: ":memory:",
      emailPayloadMode: "receipt-only",
    });
    expect(parsed.adminSessionSecret).toMatch(/^test-only-/);
    expect(parsed.piiEncryptionKey).toMatch(/^test-only-/);
    expect(parsed.withdrawalTokenSecret).toMatch(/^test-only-/);
  });

  it.each(PRODUCTION_SECRETS)("fails closed when $envName is missing", ({ envName, outputName }) => {
    const parse = environmentParser();
    expectRejectedAt(parse, productionEnvironment({ [envName]: undefined }), outputName);
  });

  it("accepts complete production configuration and defaults email to receipt-only", () => {
    expect(parseEnvironment(productionEnvironment())).toEqual({
      nodeEnv: "production",
      databasePath: "./data/wisdom.sqlite",
      adminSessionSecret: "a".repeat(32),
      piiEncryptionKey: "b".repeat(32),
      withdrawalTokenSecret: "c".repeat(32),
      emailPayloadMode: "receipt-only",
    });
  });

  it.each(PRODUCTION_SECRETS)(
    "rejects a weak $envName production value",
    ({ envName, outputName }) => {
      const parse = environmentParser();
      expectRejectedAt(parse, productionEnvironment({ [envName]: "too-short" }), outputName);
    },
  );

  it("rejects an in-memory production database", () => {
    const parse = environmentParser();
    expectRejectedAt(parse, productionEnvironment({ DATABASE_PATH: ":memory:" }), "databasePath");
  });

  it.each(PRODUCTION_SECRETS)(
    "never accepts a test-only $envName value in production",
    ({ envName, outputName, testOnlyValue }) => {
      const parse = environmentParser();
      expectRejectedAt(parse, productionEnvironment({ [envName]: testOnlyValue }), outputName);
    },
  );

  it("requires an approved environment and email payload mode", () => {
    const parse = environmentParser();

    expect(() => parse({ NODE_ENV: "staging" })).toThrow();
    expect(() => parse(productionEnvironment({ EMAIL_PAYLOAD_MODE: "raw-message" }))).toThrow();
    expect(parse(productionEnvironment({ EMAIL_PAYLOAD_MODE: "full-inquiry" }))).toMatchObject({
      emailPayloadMode: "full-inquiry",
    });
  });
});
