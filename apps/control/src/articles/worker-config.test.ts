import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { blindIndex, createStaticKeyProvider, encryptPii } from "../crypto/index.js";
import {
  assertArticleCodexCliContract,
  createArticleCodexExecutorOptions,
  parseArticleWorkerConfig,
  resolveCodexApiKeyFromKeychain,
} from "./worker-config.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function validEnvironment() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wisdom-worker-config-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const codexBinary = join(root, "codex-bin");
  const gitBinary = join(root, "git-bin");
  writeFileSync(codexBinary, "binary");
  writeFileSync(gitBinary, "binary");
  chmodSync(codexBinary, 0o700);
  chmodSync(gitBinary, 0o700);
  const temporaryRoot = join(root, "temporary");
  const codexHome = join(root, "codex-home");
  const certificate = join(root, "cert.pem");
  mkdirSync(temporaryRoot);
  mkdirSync(codexHome);
  writeFileSync(certificate, "certificate");
  return {
    NODE_ENV: "test",
    CODEX_BINARY: codexBinary,
    GIT_BINARY: gitBinary,
    CODEX_MODEL: "fixed-model-1",
    CODEX_TEMP_ROOT: temporaryRoot,
    CODEX_HOME: codexHome,
    CODEX_KEYCHAIN_SERVICE: "com.jihye.portal.codex-api-key",
    PATH: `${root};C:\\Windows\\System32`,
    LANG: "en_US.UTF-8",
    SSL_CERT_FILE: certificate,
  };
}

describe("article worker startup configuration", () => {
  it("resolves existing absolute binaries and isolated directories without loading a secret", () => {
    const source = validEnvironment();
    const config = parseArticleWorkerConfig(source);
    expect(config).toMatchObject({
      codexBinary: source.CODEX_BINARY,
      gitBinary: source.GIT_BINARY,
      model: "fixed-model-1",
      temporaryRoot: source.CODEX_TEMP_ROOT,
      codexHome: source.CODEX_HOME,
      keychainService: "com.jihye.portal.codex-api-key",
    });
    expect(config).not.toHaveProperty("apiKey");
    expect(JSON.stringify(config)).not.toContain("codex-private-token");
  });

  it.each([
    ["relative Codex binary", { CODEX_BINARY: "codex" }],
    ["missing Git binary", { GIT_BINARY: "C:\\missing\\git.exe" }],
    ["unsafe model", { CODEX_MODEL: "model with spaces" }],
    ["relative temp", { CODEX_TEMP_ROOT: "tmp" }],
    ["shared temp and home", { sameRoots: true }],
    ["invalid Keychain service", { CODEX_KEYCHAIN_SERVICE: "keychain:bad/service" }],
    ["control character in PATH", { PATH: "safe\nunsafe" }],
  ])("rejects %s before claiming a job", (_name, patch) => {
    const source = validEnvironment() as Record<string, string> & { sameRoots?: boolean };
    Object.assign(source, patch);
    if (source.sameRoots) source.CODEX_HOME = source.CODEX_TEMP_ROOT!;
    expect(() => parseArticleWorkerConfig(source)).toThrow();
  });

  it("reads the Codex credential from one exact Keychain service without exposing diagnostics", () => {
    const execute = vi.fn(() => "codex-private-token-1234567890\n");
    expect(resolveCodexApiKeyFromKeychain(
      "com.jihye.portal.codex-api-key",
      execute,
    )).toBe("codex-private-token-1234567890");
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/security",
      ["find-generic-password", "-s", "com.jihye.portal.codex-api-key", "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 8_192,
      },
    );
    expect(() => resolveCodexApiKeyFromKeychain("bad/service", execute)).toThrow(
      "Codex Keychain service reference is invalid",
    );
    expect(() => resolveCodexApiKeyFromKeychain(
      "com.jihye.portal.codex-api-key",
      () => "contains whitespace token",
    )).toThrow("Codex Keychain credential is invalid");
  });

  it("bounds Keychain lookup time and output while mapping failures to one redacted error", () => {
    let receivedOptions: unknown;
    const execute = vi.fn((
      _file: string,
      _args: readonly string[],
      options: unknown,
    ) => {
      receivedOptions = options;
      throw new Error("ETIMEDOUT private-keychain-diagnostic");
    });
    let message = "";
    try {
      resolveCodexApiKeyFromKeychain("com.jihye.portal.codex-api-key", execute);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(receivedOptions).toMatchObject({ timeout: 5_000, maxBuffer: 8_192 });
    expect(message).toBe("Codex Keychain credential is unavailable");
    expect(message).not.toContain("private-keychain-diagnostic");
  });

  it("probes the configured Codex CLI contract without a model or network call", () => {
    const config = parseArticleWorkerConfig(validEnvironment());
    const execute = vi.fn(() => [
      "Run Codex non-interactively",
      "Usage: codex exec [OPTIONS] [PROMPT]",
      "--disable <FEATURE>",
      "--ignore-user-config",
      "--ignore-rules",
      "--output-schema <FILE>",
    ].join("\n"));
    expect(() => assertArticleCodexCliContract(config, execute)).not.toThrow();
    expect(execute).toHaveBeenCalledWith(
      config.codexBinary,
      [
        "--ask-for-approval", "never", "--disable", "shell_tool", "exec",
        "-C", config.temporaryRoot,
        "--model", config.model,
        "--sandbox", "read-only",
        "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
        "-c", 'web_search="disabled"',
        "-c", 'shell_environment_policy.inherit="none"',
        "-c", 'shell_environment_policy.set={ PATH = "/usr/bin:/bin" }',
        "-c", "allow_login_shell=false",
        "--output-schema", join(config.temporaryRoot, "contract-output-schema.json"),
        "-o", join(config.temporaryRoot, "contract-result.json"),
        "--help",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 65_536,
        env: config.environment,
      },
    );
    expect(() => assertArticleCodexCliContract(config, () => {
      throw new Error("private-cli-diagnostic");
    })).toThrow("Configured Codex CLI contract is unsupported");
  });

  it("builds a minimal executor environment and rejects retained consultation PII", async () => {
    const source = validEnvironment();
    const config = parseArticleWorkerConfig(source);
    const database: TestDatabase = createTestDatabase();
    cleanups.push(() => database.close());
    const provider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 111) });
    database.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('private-row', 'private-receipt', 'received', 'ko', 'procurement',
        'email', ?, 'pii-v1', ?, ?, 'pii-v1', 0, 0, 0, 999999, 1)
    `).run(
      encryptPii(provider, "private-row", {
        name: "Private Customer",
        phone: "+821012345678",
        email: "private@example.com",
        company: "Private Company",
        message: "This private consultation message is long enough for encryption.",
      }),
      blindIndex(provider, "phone", "+821012345678"),
      blindIndex(provider, "email", "private@example.com"),
    );
    const options = createArticleCodexExecutorOptions(
      database.db,
      provider,
      config,
      "codex-private-token-1234567890",
    );
    expect(options.environment).toEqual({
      CODEX_API_KEY: "codex-private-token-1234567890",
      CODEX_HOME: source.CODEX_HOME,
      HOME: source.CODEX_HOME,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: source.PATH,
      SSL_CERT_FILE: source.SSL_CERT_FILE,
      TMPDIR: source.CODEX_TEMP_ROOT,
    });
    const publicSource = {
      articleId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      locale: "ko" as const,
      title: "Public title",
      summary: "Public summary",
      bodyMarkdown: "## Public answer\n",
      sources: [{
        id: "official",
        url: "https://example.com/official",
        sourceTimestamp: "2026-07-16T00:00:00.000Z",
      }],
    };
    await expect(options.assertNoPii(publicSource)).resolves.toBeUndefined();
    await expect(options.assertNoPii({
      ...publicSource,
      summary: "Contact private@example.com",
    })).rejects.toThrow("Public-content privacy gate rejected the article");
  });
});
