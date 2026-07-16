import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { EnvironmentSource } from "@wisdom/shared";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { buildCodexExecArguments } from "./codex-executor.js";
import type { CodexExecutorOptions, CodexTranslationSource } from "./codex-executor.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/;
const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_ENVIRONMENT_VALUE = /^[^\0\r\n]+$/;

export interface ArticleWorkerConfig {
  codexBinary: string;
  gitBinary: string;
  model: string;
  temporaryRoot: string;
  codexHome: string;
  keychainService: string;
  timeoutMs: number;
  environment: Readonly<Record<string, string>>;
}

function required(source: EnvironmentSource, name: string): string {
  const value = source[name];
  if (!value || !SAFE_ENVIRONMENT_VALUE.test(value)) throw new Error(`${name} is required and must be a single line`);
  return value;
}

function existingFile(source: EnvironmentSource, name: string): string {
  const configured = required(source, name);
  if (!isAbsolute(configured)) throw new Error(`${name} must be an absolute path`);
  let resolved: string;
  try {
    resolved = realpathSync(configured);
    if (!statSync(resolved).isFile()) throw new Error();
    if (process.platform !== "win32" && (statSync(resolved).mode & 0o111) === 0) throw new Error();
  } catch {
    throw new Error(`${name} must resolve to an executable regular file`);
  }
  return resolved;
}

function existingDirectory(source: EnvironmentSource, name: string): string {
  const configured = required(source, name);
  if (!isAbsolute(configured)) throw new Error(`${name} must be an absolute path`);
  try {
    const metadata = lstatSync(configured);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error();
    return realpathSync(configured);
  } catch {
    throw new Error(`${name} must resolve to a non-symlink directory`);
  }
}

function optionalAbsoluteFile(source: EnvironmentSource, name: string): string | undefined {
  const value = source[name];
  if (value === undefined) return undefined;
  if (!SAFE_ENVIRONMENT_VALUE.test(value) || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute single-line path`);
  }
  try {
    const resolved = realpathSync(value);
    if (!statSync(resolved).isFile()) throw new Error();
    return resolved;
  } catch {
    throw new Error(`${name} must resolve to a regular file`);
  }
}

export function parseArticleWorkerConfig(source: EnvironmentSource): ArticleWorkerConfig {
  const codexBinary = existingFile(source, "CODEX_BINARY");
  const gitBinary = existingFile(source, "GIT_BINARY");
  if (codexBinary === gitBinary) throw new Error("Codex and Git binaries must be distinct");
  const temporaryRoot = existingDirectory(source, "CODEX_TEMP_ROOT");
  const codexHome = existingDirectory(source, "CODEX_HOME");
  if (temporaryRoot === codexHome) throw new Error("CODEX_TEMP_ROOT and CODEX_HOME must be distinct");
  const model = required(source, "CODEX_MODEL");
  if (!MODEL_PATTERN.test(model)) throw new Error("CODEX_MODEL must be a fixed model identifier");
  const keychainService = required(source, "CODEX_KEYCHAIN_SERVICE");
  if (!KEYCHAIN_SERVICE_PATTERN.test(keychainService)) {
    throw new Error("CODEX_KEYCHAIN_SERVICE must be a Keychain service name");
  }
  const timeoutMs = source.CODEX_TIMEOUT_MS === undefined ? 120_000 : Number(source.CODEX_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000) {
    throw new Error("CODEX_TIMEOUT_MS must be between 1000 and 600000");
  }
  const path = source.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin";
  const lang = source.LANG ?? "en_US.UTF-8";
  if (!SAFE_ENVIRONMENT_VALUE.test(path) || !SAFE_ENVIRONMENT_VALUE.test(lang)) {
    throw new Error("Worker PATH and LANG must be single-line values");
  }
  const sslCertFile = optionalAbsoluteFile(source, "SSL_CERT_FILE");
  const sslCertDir = source.SSL_CERT_DIR === undefined
    ? undefined
    : existingDirectory(source, "SSL_CERT_DIR");
  const environment = Object.freeze({
    CODEX_HOME: codexHome,
    HOME: codexHome,
    LANG: lang,
    LC_ALL: lang,
    PATH: path,
    ...(sslCertDir ? { SSL_CERT_DIR: sslCertDir } : {}),
    ...(sslCertFile ? { SSL_CERT_FILE: sslCertFile } : {}),
    TMPDIR: temporaryRoot,
  });
  return Object.freeze({
    codexBinary,
    gitBinary,
    model,
    temporaryRoot,
    codexHome,
    keychainService,
    timeoutMs,
    environment,
  });
}

export type CodexContractCommand = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    maxBuffer: number;
    env: Readonly<Record<string, string>>;
  },
) => string;

const defaultCodexContractCommand: CodexContractCommand = (file, args, options) =>
  execFileSync(file, [...args], { ...options, env: { ...options.env } });

export function assertArticleCodexCliContract(
  config: ArticleWorkerConfig,
  execute: CodexContractCommand = defaultCodexContractCommand,
): void {
  try {
    const output = execute(
      config.codexBinary,
      buildCodexExecArguments({
        workspace: config.temporaryRoot,
        model: config.model,
        outputSchemaPath: join(config.temporaryRoot, "contract-output-schema.json"),
        outputPath: join(config.temporaryRoot, "contract-result.json"),
        finalArgument: "--help",
      }),
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 65_536,
        env: config.environment,
      },
    );
    if (
      !output.includes("Usage: codex exec")
      || !output.includes("--ignore-user-config")
      || !output.includes("--ignore-rules")
      || !output.includes("--output-schema")
    ) throw new Error("Codex CLI help contract is incomplete");
  } catch {
    throw new Error("Configured Codex CLI contract is unsupported");
  }
}

export type KeychainCommand = (
  file: string,
  args: readonly string[],
  options: {
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    maxBuffer: number;
  },
) => string;

const defaultKeychainCommand: KeychainCommand = (file, args, options) =>
  execFileSync(file, [...args], options);

export function resolveCodexApiKeyFromKeychain(
  service: string,
  execute: KeychainCommand = defaultKeychainCommand,
): string {
  if (!KEYCHAIN_SERVICE_PATTERN.test(service)) {
    throw new Error("Codex Keychain service reference is invalid");
  }
  let value: string;
  try {
    value = execute(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 8_192,
      },
    ).trim();
  } catch {
    throw new Error("Codex Keychain credential is unavailable");
  }
  if (value.length < 20 || value.length > 4_096 || !/^[!-~]+$/.test(value)) {
    throw new Error("Codex Keychain credential is invalid");
  }
  return value;
}

export function createArticleCodexExecutorOptions(
  db: ControlDatabase,
  keyProvider: KeyProvider,
  config: ArticleWorkerConfig,
  apiKey: string,
): CodexExecutorOptions {
  if (apiKey.length < 20 || apiKey.length > 4_096 || !/^[!-~]+$/.test(apiKey)) {
    throw new Error("Codex API credential is invalid");
  }
  return {
    codexBinary: config.codexBinary,
    gitBinary: config.gitBinary,
    model: config.model,
    temporaryRoot: config.temporaryRoot,
    timeoutMs: config.timeoutMs,
    environment: Object.freeze({ CODEX_API_KEY: apiKey, ...config.environment }),
    async assertNoPii(source: CodexTranslationSource): Promise<void> {
      const result = checkArticleForRetainedConsultationPii(db, keyProvider, [
        source.title,
        source.summary,
        source.bodyMarkdown,
        ...source.sources.flatMap(({ id, url }) => [id, url]),
      ]);
      if (!result.safe) throw new Error("Public-content privacy gate rejected the article");
    },
  };
}
