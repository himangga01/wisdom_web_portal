import { describe, expect, it } from "vitest";

import { parseControlConfig } from "./config.js";

const secrets = {
  ADMIN_SESSION_SECRET: "a".repeat(32),
  PII_ENCRYPTION_KEY: "b".repeat(32),
  CONTROL_HMAC_SECRET: "h".repeat(32),
  WITHDRAWAL_TOKEN_SECRET: "c".repeat(32),
  HERMES_HMAC_SECRET: "d".repeat(32),
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
};

const origins = {
  PUBLIC_ORIGIN: "https://www.example.test",
  ADMIN_ORIGIN: "https://admin.example.test",
};

describe("control environment", () => {
  it("provides isolated test defaults and a usable versioned provider", () => {
    const config = parseControlConfig({ NODE_ENV: "test" });
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 8787,
      databasePath: ":memory:",
      enforceOrigin: false,
    });
    expect(config.keyProvider.active().id).toBe("pii-v1");
  });

  it("requires distinct exact HTTPS production origins and never accepts a non-loopback bind host", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
    };
    expect(() => parseControlConfig(base)).toThrow(/PUBLIC_ORIGIN/);
    expect(() => parseControlConfig({
      ...base,
      ...origins,
      ADMIN_ORIGIN: origins.PUBLIC_ORIGIN,
    })).toThrow(/distinct/i);
    expect(() => parseControlConfig({
      ...base,
      PUBLIC_ORIGIN: "https://same.example.test:443",
      ADMIN_ORIGIN: "https://same.example.test:8443",
    })).toThrow();
    expect(() => parseControlConfig({
      ...base,
      PUBLIC_ORIGIN: "https://same.example.test",
      ADMIN_ORIGIN: "https://same.example.test:8443",
    })).toThrow(/hostname|distinct/i);
    expect(() => parseControlConfig({
      ...base,
      ...origins,
      CONTROL_HOST: "0.0.0.0",
    })).toThrow(/loopback/);
    expect(() => parseControlConfig({
      ...base,
      ...origins,
      PUBLIC_ORIGIN: "http://www.example.test",
    })).toThrow(/HTTPS/);
    expect(() => parseControlConfig({
      ...base,
      ...origins,
      ADMIN_ORIGIN: "https://admin.example.test/path",
    })).toThrow(/origin/i);
  });

  it("parses independent active/previous key IDs and normalized origin lists", () => {
    const config = parseControlConfig({
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      PII_ACTIVE_KEY_ID: "pii-v2",
      PII_PREVIOUS_KEYS_JSON: JSON.stringify({ "pii-v1": "e".repeat(32) }),
      ...origins,
      CONTROL_PORT: "9876",
    });
    expect(config.port).toBe(9876);
    expect(config.publicOrigin).toBe(origins.PUBLIC_ORIGIN);
    expect(config.adminOrigin).toBe(origins.ADMIN_ORIGIN);
    expect(config.allowedOrigins).toEqual([origins.PUBLIC_ORIGIN]);
    expect(config.keyProvider.active().id).toBe("pii-v2");
    expect(config.keyProvider.get("pii-v1")).toBeDefined();
  });

  it("fails production closed when any independent secret is missing, reused, or test-only", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    for (const name of [
      "ADMIN_SESSION_SECRET",
      "PII_ENCRYPTION_KEY",
      "CONTROL_HMAC_SECRET",
      "WITHDRAWAL_TOKEN_SECRET",
      "HERMES_HMAC_SECRET",
      "ADMIN_DUMMY_PASSWORD_HASH",
    ] as const) {
      expect(() => parseControlConfig({ ...base, [name]: undefined }), name).toThrow();
    }
    expect(() => parseControlConfig({
      ...base,
      HERMES_HMAC_SECRET: secrets.CONTROL_HMAC_SECRET,
    })).toThrow(/independent/i);
    expect(() => parseControlConfig({
      ...base,
      HERMES_HMAC_SECRET: "test-only-hermes-secret-00000001",
    })).toThrow(/test-only/i);
  });

  it("requires the production dummy password hash to match the frozen Argon2id policy", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    for (const invalidHash of [
      "not-a-password-hash",
      "$argon2i$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
      "$argon2id$v=19$m=12288,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
      "$argon2id$v=19$m=19456,t=3,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
      "$argon2id$v=19$m=19456,t=2,p=2$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
      "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$AQID",
    ]) {
      expect(() => parseControlConfig({
        ...base,
        ADMIN_DUMMY_PASSWORD_HASH: invalidHash,
      }), invalidHash).toThrow(/dummy password hash|argon2id/i);
    }
  });

  it("requires every previous PII key to be independent and non-test in production", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    for (const previousKeys of [
      { "pii-old": secrets.ADMIN_SESSION_SECRET },
      { "pii-old": secrets.PII_ENCRYPTION_KEY },
      { "pii-old-a": "e".repeat(32), "pii-old-b": "e".repeat(32) },
      { "pii-old": "test-only-previous-pii-key-000001" },
    ]) {
      expect(() => parseControlConfig({
        ...base,
        PII_PREVIOUS_KEYS_JSON: JSON.stringify(previousKeys),
      }), JSON.stringify(previousKeys)).toThrow(/independent|test-only/i);
    }
  });

  it("accepts only a literal loopback Hermes endpoint", () => {
    const valid = parseControlConfig({
      NODE_ENV: "test",
      HERMES_ENDPOINT: "http://127.0.0.42:8788/notify",
    });
    expect(valid.hermesEndpoint.href).toBe("http://127.0.0.42:8788/notify");
    expect(() => parseControlConfig({
      NODE_ENV: "test",
      HERMES_ENDPOINT: "http://localhost:8788/notify",
    })).toThrow(/literal loopback/i);
    expect(() => parseControlConfig({
      NODE_ENV: "test",
      HERMES_ENDPOINT: "https://10.0.0.1/notify",
    })).toThrow(/literal loopback/i);
  });

  it("rejects active and previous key IDs that cannot round-trip through encrypted envelopes", () => {
    expect(() => parseControlConfig({
      NODE_ENV: "test",
      PII_ACTIVE_KEY_ID: "pii v2",
    })).toThrow(/key id/i);
    expect(() => parseControlConfig({
      NODE_ENV: "test",
      PII_PREVIOUS_KEYS_JSON: JSON.stringify({ "pii v1": "d".repeat(32) }),
    })).toThrow(/key id/i);
    expect(() => parseControlConfig({
      NODE_ENV: "test",
      PII_ACTIVE_KEY_ID: " pii-v2 ",
    })).toThrow(/key id/i);
  });
});
