import { describe, expect, it } from "vitest";

import * as environmentModule from "./environment.js";

type EnvironmentSource = Record<string, string | undefined>;
type EnvironmentParser = (source: EnvironmentSource) => Record<string, unknown>;

const environment = environmentModule as unknown as Record<string, unknown>;

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
    ADMIN_SESSION_SECRET: "a".repeat(32),
    CONSULTATION_ENCRYPTION_KEY: "b".repeat(32),
    WITHDRAWAL_TOKEN_SECRET: "c".repeat(32),
    ...overrides,
  };
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
    expect(parsed.consultationEncryptionKey).toMatch(/^test-only-/);
    expect(parsed.withdrawalTokenSecret).toMatch(/^test-only-/);
  });

  it("fails closed when any production secret is missing", () => {
    const parse = environmentParser();

    for (const secret of [
      "ADMIN_SESSION_SECRET",
      "CONSULTATION_ENCRYPTION_KEY",
      "WITHDRAWAL_TOKEN_SECRET",
    ]) {
      const source = productionEnvironment({ [secret]: undefined });
      expect(() => parse(source), secret).toThrow();
    }
  });

  it("accepts complete production configuration and defaults email to receipt-only", () => {
    expect(parseEnvironment(productionEnvironment())).toEqual({
      nodeEnv: "production",
      databasePath: "./data/wisdom.sqlite",
      adminSessionSecret: "a".repeat(32),
      consultationEncryptionKey: "b".repeat(32),
      withdrawalTokenSecret: "c".repeat(32),
      emailPayloadMode: "receipt-only",
    });
  });

  it("rejects weak production secrets and an in-memory production database", () => {
    const parse = environmentParser();

    expect(() => parse(productionEnvironment({ ADMIN_SESSION_SECRET: "too-short" }))).toThrow();
    expect(() => parse(productionEnvironment({ DATABASE_PATH: ":memory:" }))).toThrow();
  });

  it("never accepts a test-only secret in production", () => {
    const parse = environmentParser();

    expect(() =>
      parse(
        productionEnvironment({
          ADMIN_SESSION_SECRET: "test-only-admin-session-secret-0001",
        }),
      ),
    ).toThrow();
  });

  it("requires an approved environment and email payload mode", () => {
    const parse = environmentParser();

    expect(() => parse({ NODE_ENV: "staging" })).toThrow();
    expect(() => parse(productionEnvironment({ EMAIL_PAYLOAD_MODE: "raw-message" }))).toThrow();
    expect(parse(productionEnvironment({ EMAIL_PAYLOAD_MODE: "full-inquiry" }))).toMatchObject({
      emailPayloadMode: "full-inquiry",
    });
  });
});
