import { describe, expect, it } from "vitest";

import { parseControlConfig } from "./config.js";

const secrets = {
  ADMIN_SESSION_SECRET: "a".repeat(32),
  PII_ENCRYPTION_KEY: "b".repeat(32),
  CONTROL_HMAC_SECRET: "h".repeat(32),
  WITHDRAWAL_TOKEN_SECRET: "c".repeat(32),
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

  it("fails production closed without HTTPS origins and never accepts a non-loopback host", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
    };
    expect(() => parseControlConfig(base)).toThrow(/PUBLIC_ORIGINS/);
    expect(() => parseControlConfig({
      ...base,
      CONTROL_HMAC_SECRET: undefined,
      PUBLIC_ORIGINS: "https://www.example.test",
    })).toThrow(/CONTROL_HMAC_SECRET/);
    expect(() => parseControlConfig({
      ...base,
      PUBLIC_ORIGINS: "https://www.example.test",
      CONTROL_HOST: "0.0.0.0",
    })).toThrow(/loopback/);
    expect(() => parseControlConfig({
      ...base,
      PUBLIC_ORIGINS: "http://www.example.test",
    })).toThrow(/HTTPS/);
  });

  it("parses independent active/previous key IDs and normalized origin lists", () => {
    const config = parseControlConfig({
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      PII_ACTIVE_KEY_ID: "pii-v2",
      PII_PREVIOUS_KEYS_JSON: JSON.stringify({ "pii-v1": "d".repeat(32) }),
      PUBLIC_ORIGINS: " https://www.example.test,https://admin.example.test ",
      CONTROL_PORT: "9876",
    });
    expect(config.port).toBe(9876);
    expect(config.allowedOrigins).toEqual([
      "https://www.example.test",
      "https://admin.example.test",
    ]);
    expect(config.keyProvider.active().id).toBe("pii-v2");
    expect(config.keyProvider.get("pii-v1")).toBeDefined();
  });
});
