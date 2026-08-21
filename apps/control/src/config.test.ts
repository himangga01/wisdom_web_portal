import { describe, expect, it } from "vitest";

import { parseControlConfig } from "./config.js";

const secrets = {
  ADMIN_SESSION_SECRET: "a".repeat(32),
  PII_ENCRYPTION_KEY: "b".repeat(32),
  CONTROL_HMAC_SECRET: "h".repeat(32),
  WITHDRAWAL_TOKEN_SECRET: "c".repeat(32),
  HERMES_HMAC_SECRET: "d".repeat(32),
  ADMIN_DUMMY_PASSWORD_HASH: "$argon2id$v=19$m=19456,t=2,p=1$BwcHBwcHBwcHBwcHBwcHBw$+PoSSRtbM306Z90yryZta7Qvu3hikTDby6TmJumCJEY",
  PUBLIC_RELEASE_ROOT: "/srv/wisdom/public-releases",
  PUBLIC_CURRENT_LINK: "/srv/wisdom/public-current",
  SITE_SOURCE_ROOT: "/srv/wisdom/app-current",
  NODE_BINARY: "/opt/homebrew/bin/node",
  NPM_BINARY: "/opt/homebrew/bin/npm",
  INDEXNOW_KEYCHAIN_SERVICE: "com.jihye.portal.indexnow",
  INDEXNOW_KEY_LOCATION: "https://www.example.test/indexnow-key.txt",
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
    for (const invalidOrigin of [
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.1",
      "https://portal.local",
      "https://portal",
    ]) {
      expect(() => parseControlConfig({
        ...base,
        ...origins,
        PUBLIC_ORIGIN: invalidOrigin,
      }), invalidOrigin).toThrow(/public DNS hostname/i);
    }
  });

  it("parses independent active/previous key IDs and normalized origin lists", () => {
    const config = parseControlConfig({
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      PII_ACTIVE_KEY_ID: "pii-v2",
      PII_PREVIOUS_KEYS_JSON: JSON.stringify({ "pii-v1": "e".repeat(32) }),
      ...origins,
      NAVER_SITE_VERIFICATION_META: "unit_test_naver_meta_token_1234567890",
      PUBLIC_KAKAO_CHAT_URL: "https://pf.kakao.com/_unit_test/chat",
      CONTROL_PORT: "9876",
    });
    expect(config.port).toBe(9876);
    expect(config.publicOrigin).toBe(origins.PUBLIC_ORIGIN);
    expect(config.adminOrigin).toBe(origins.ADMIN_ORIGIN);
    expect(config.allowedOrigins).toEqual([origins.PUBLIC_ORIGIN]);
    expect(config.keyProvider.active().id).toBe("pii-v2");
    expect(config.keyProvider.get("pii-v1")).toBeDefined();
    expect(config.publication).toMatchObject({
      releaseRoot: secrets.PUBLIC_RELEASE_ROOT,
      currentLink: secrets.PUBLIC_CURRENT_LINK,
      siteSourceRoot: secrets.SITE_SOURCE_ROOT,
      npmBinary: secrets.NPM_BINARY,
      nodeBinary: secrets.NODE_BINARY,
      publicOrigin: origins.PUBLIC_ORIGIN,
      kakaoChatUrl: "https://pf.kakao.com/_unit_test/chat",
      naverSiteVerificationMeta: "unit_test_naver_meta_token_1234567890",
    });
    expect(config.indexNow).toEqual({
      endpoint: "https://api.indexnow.org/indexnow",
      keychainService: secrets.INDEXNOW_KEYCHAIN_SERVICE,
      keyLocation: secrets.INDEXNOW_KEY_LOCATION,
      timeoutMs: 10_000,
    });
  });

  it("normalizes one optional Naver verification mode and rejects ambiguous or multiline values safely", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    const filename = "naverunit_test_file_token_1234567890.html";
    expect(parseControlConfig({
      ...base,
      NAVER_SITE_VERIFICATION_FILE: filename,
    }).publication).toMatchObject({ naverSiteVerificationFile: filename });
    expect(parseControlConfig({
      ...base,
      NAVER_SITE_VERIFICATION_META: "your-token-here",
    }).publication).not.toHaveProperty("naverSiteVerificationMeta");
    expect(() => parseControlConfig({
      ...base,
      NAVER_SITE_VERIFICATION_META: "unit_test_naver_meta_token_1234567890",
      NAVER_SITE_VERIFICATION_FILE: filename,
    })).toThrow("SEARCH_VERIFICATION_AMBIGUOUS");

    const multiline = "unit_test_naver_meta_token_1234567890\n";
    try {
      parseControlConfig({ ...base, NAVER_SITE_VERIFICATION_META: multiline });
      throw new Error("expected Naver verification validation to fail");
    } catch (error) {
      expect(error).toMatchObject({ message: "SEARCH_VERIFICATION_INVALID" });
      expect((error as Error).message).not.toContain(multiline);
    }
  });

  it("accepts only an exact secure Kakao publication URL", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    expect(parseControlConfig({
      ...base,
      PUBLIC_KAKAO_CHAT_URL: " https://pf.kakao.com/_unit_test/chat ",
    }).publication).toMatchObject({
      kakaoChatUrl: "https://pf.kakao.com/_unit_test/chat",
    });
    for (const value of [
      "http://pf.kakao.com/_unit_test/chat",
      "https://example.com/chat",
      "https://user@pf.kakao.com/_unit_test/chat",
      "https://pf.kakao.com/_unit_test/chat extra",
    ]) {
      expect(() => parseControlConfig({
        ...base,
        PUBLIC_KAKAO_CHAT_URL: value,
      }), value).toThrow(/PUBLIC_KAKAO_CHAT_URL/u);
    }
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
      "PUBLIC_RELEASE_ROOT",
      "PUBLIC_CURRENT_LINK",
      "SITE_SOURCE_ROOT",
      "NODE_BINARY",
      "NPM_BINARY",
      "INDEXNOW_KEYCHAIN_SERVICE",
      "INDEXNOW_KEY_LOCATION",
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

  it("requires absolute, distinct publication paths and a bounded production build timeout", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_PATH: "./data/wisdom.sqlite",
      ...secrets,
      ...origins,
    };
    expect(() => parseControlConfig({ ...base, PUBLIC_RELEASE_ROOT: "relative/releases" })).toThrow(/PUBLIC_RELEASE_ROOT/);
    expect(() => parseControlConfig({ ...base, PUBLIC_CURRENT_LINK: secrets.PUBLIC_RELEASE_ROOT })).toThrow(/distinct/i);
    expect(() => parseControlConfig({ ...base, NPM_BINARY: secrets.NODE_BINARY })).toThrow(/distinct/i);
    expect(() => parseControlConfig({ ...base, PUBLICATION_BUILD_TIMEOUT_MS: "999" })).toThrow(/timeout/i);
    expect(parseControlConfig({
      ...base,
      PUBLICATION_BUILD_TIMEOUT_MS: "180000",
    }).publication?.buildTimeoutMs).toBe(180_000);
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
