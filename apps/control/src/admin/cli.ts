import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { closeDatabase } from "../db/client.js";
import { createControlRuntime, loadLocalEnvironment } from "../runtime.js";
import {
  bootstrapOwner,
  replaceOwnerMfa,
  resetOwnerPassword,
  type AdminCliServiceContext,
} from "./cli-service.js";

export type AdminCliArguments =
  | { command: "bootstrap"; username: string; displayName: string; outputPath: string }
  | { command: "password-reset"; username: string }
  | { command: "mfa-replace"; username: string; outputPath: string };

interface AdminCliIo {
  readStdin(): Promise<string>;
  writeStatus(value: string): void;
}

interface AdminCliExecutionOptions {
  nowMs?: number;
  requestId?: string;
}

const FORBIDDEN_CREDENTIAL_OPTION = /password|secret|recovery|totp|code/i;

function parseFlags(arguments_: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (!flag?.startsWith("--") || flag.includes("=") || !value || value.startsWith("--")) {
      throw new Error("Invalid administrator CLI arguments");
    }
    if (FORBIDDEN_CREDENTIAL_OPTION.test(flag)) {
      throw new Error("Credentials are forbidden in administrator CLI arguments");
    }
    if (parsed.has(flag)) throw new Error("Duplicate administrator CLI argument");
    parsed.set(flag, value);
  }
  return parsed;
}

function requireExactFlags(flags: Map<string, string>, expected: readonly string[]): void {
  if (flags.size !== expected.length || expected.some((flag) => !flags.has(flag))) {
    throw new Error("Invalid administrator CLI arguments");
  }
}

export function parseAdminCliArguments(arguments_: readonly string[]): AdminCliArguments {
  for (const argument of arguments_) {
    if (argument.startsWith("--") && FORBIDDEN_CREDENTIAL_OPTION.test(argument.split("=", 1)[0]!)) {
      throw new Error("Credentials are forbidden in administrator CLI arguments");
    }
  }
  const [command, ...rest] = arguments_;
  const flags = parseFlags(rest);
  if (command === "bootstrap") {
    requireExactFlags(flags, ["--username", "--display-name", "--output"]);
    return {
      command,
      username: flags.get("--username")!,
      displayName: flags.get("--display-name")!,
      outputPath: flags.get("--output")!,
    };
  }
  if (command === "password-reset") {
    requireExactFlags(flags, ["--username"]);
    return { command, username: flags.get("--username")! };
  }
  if (command === "mfa-replace") {
    requireExactFlags(flags, ["--username", "--output"]);
    return {
      command,
      username: flags.get("--username")!,
      outputPath: flags.get("--output")!,
    };
  }
  throw new Error("Unknown administrator CLI command");
}

function passwordFromStdin(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 4_096 || value.includes("\0")) {
    throw new Error("Invalid password input");
  }
  const password = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  if (!password || password.includes("\r") || password.includes("\n")) {
    throw new Error("Password stdin must contain exactly one line");
  }
  return password;
}

export async function runAdminCli(
  context: AdminCliServiceContext,
  arguments_: readonly string[],
  io: AdminCliIo,
  options: AdminCliExecutionOptions = {},
): Promise<void> {
  const parsed = parseAdminCliArguments(arguments_);
  const nowMs = options.nowMs ?? Date.now();
  const requestId = options.requestId ?? randomUUID();
  if (parsed.command === "bootstrap") {
    const password = passwordFromStdin(await io.readStdin());
    await bootstrapOwner(context, {
      username: parsed.username,
      displayName: parsed.displayName,
      password,
      outputPath: parsed.outputPath,
      nowMs,
      requestId,
    });
  } else if (parsed.command === "password-reset") {
    const password = passwordFromStdin(await io.readStdin());
    await resetOwnerPassword(context, {
      username: parsed.username,
      password,
      nowMs,
      requestId,
    });
  } else {
    await replaceOwnerMfa(context, {
      username: parsed.username,
      outputPath: parsed.outputPath,
      nowMs,
      requestId,
    });
  }
  io.writeStatus(JSON.stringify({ event: "admin.cli.succeeded", command: parsed.command }));
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > 4_096) throw new Error("Invalid password input");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let runtime: ReturnType<typeof createControlRuntime> | undefined;
  try {
    loadLocalEnvironment();
    runtime = createControlRuntime();
    await runAdminCli({
      db: runtime.db,
      keyProvider: runtime.config.keyProvider,
      authSecret: runtime.config.authSecret,
    }, process.argv.slice(2), {
      readStdin: readProcessStdin,
      writeStatus(value) {
        process.stdout.write(`${value}\n`);
      },
    });
  } catch {
    process.stderr.write(`${JSON.stringify({ event: "admin.cli.failed", status: "error" })}\n`);
    process.exitCode = 1;
  } finally {
    if (runtime) closeDatabase(runtime.db);
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) void main();
