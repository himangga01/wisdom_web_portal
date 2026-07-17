import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createMacConfigurationAdapters,
  main,
  parseConfigInstallArguments,
} from "../scripts/config-install.mjs";

const absoluteValuesPath = path.resolve(os.tmpdir(), "wisdom-production-values.json");

function successfulChild(onSpawn) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  queueMicrotask(() => {
    onSpawn?.();
    stdout.end();
    stderr.end();
    child.emit("close", 0, null);
  });
  return child;
}

test("parseConfigInstallArguments accepts only exact dry-run and scoped apply forms", () => {
  assert.deepEqual(parseConfigInstallArguments([
    "--values", absoluteValuesPath,
    "--scope", "user",
  ]), {
    valuesPath: absoluteValuesPath,
    scope: "user",
    apply: false,
  });

  assert.deepEqual(parseConfigInstallArguments([
    "--scope", "user",
    "--confirm-user-home", "/Users/wisdom",
    "--values", absoluteValuesPath,
    "--apply",
    "--confirm-app-root", "/Users/wisdom/portal",
  ]), {
    valuesPath: absoluteValuesPath,
    scope: "user",
    apply: true,
    confirmAppRoot: "/Users/wisdom/portal",
    confirmUserHome: "/Users/wisdom",
  });

  assert.deepEqual(parseConfigInstallArguments([
    "--values", absoluteValuesPath,
    "--scope", "system",
    "--apply",
    "--confirm-system-target", "/etc/newsyslog.d/wisdom-portal.conf",
  ]), {
    valuesPath: absoluteValuesPath,
    scope: "system",
    apply: true,
    confirmSystemTarget: "/etc/newsyslog.d/wisdom-portal.conf",
  });
});

test("parseConfigInstallArguments rejects ambiguous, secret-shaped, and cross-scope arguments", () => {
  const invalid = [
    [],
    ["--values", absoluteValuesPath],
    ["--scope", "user"],
    ["--values", "relative.json", "--scope", "user"],
    ["--values", absoluteValuesPath, "--scope", "other"],
    ["--values", absoluteValuesPath, "--scope", "user", "positional"],
    ["--values", absoluteValuesPath, "--values", absoluteValuesPath, "--scope", "user"],
    ["--values", absoluteValuesPath, "--scope", "user", "--apply", "--apply"],
    ["--values", absoluteValuesPath, "--scope", "user", "--apply"],
    ["--values", absoluteValuesPath, "--scope", "system", "--apply"],
    ["--values", absoluteValuesPath, "--scope", "user", "--confirm-app-root", "/Users/wisdom/portal"],
    ["--values", absoluteValuesPath, "--scope", "system", "--apply", "--confirm-app-root", "/Users/wisdom/portal", "--confirm-system-target", "/etc/newsyslog.d/wisdom-portal.conf"],
    ["--values", absoluteValuesPath, "--scope", "user", "--apply", "--confirm-app-root", "/Users/wisdom/portal", "--confirm-user-home", "/Users/wisdom", "--confirm-system-target", "/etc/newsyslog.d/wisdom-portal.conf"],
    ["--values", absoluteValuesPath, "--scope", "user", "--telegram-token", "secret"],
    ["--values", "--scope", "user"],
  ];

  for (const argv of invalid) {
    assert.throws(() => parseConfigInstallArguments(argv), { code: "CONFIG_INPUT_INVALID" }, JSON.stringify(argv));
  }
});

test("createMacConfigurationAdapters stages privately and invokes exact bounded validators", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "wisdom-config-cli-test-"));
  const calls = [];
  const timers = [];
  const requestedModes = [];
  const values = {
    CADDY_BINARY: "/opt/homebrew/bin/caddy",
    CLOUDFLARED_BINARY: "/opt/homebrew/bin/cloudflared",
  };

  try {
    const adapters = createMacConfigurationAdapters(values, {
      temporaryRoot,
      scheduleTimer(callback, delay) {
        timers.push({ callback, delay });
        return { unref() {} };
      },
      cancelTimer() {},
      async setMode(target, mode) {
        requestedModes.push([target, mode]);
        await chmod(target, mode);
      },
      spawnChild(command, args, options) {
        const stagedPath = args.find((argument) => path.dirname(argument) !== "." && existsSync(argument));
        calls.push({
          command,
          args,
          options,
          stagedPath,
        });
        return successfulChild();
      },
    });

    assert.equal(
      adapters.resolveTarget("/etc/newsyslog.d/wisdom-portal.conf", { id: "newsyslog" }),
      "/private/etc/newsyslog.d/wisdom-portal.conf",
    );

    await adapters.validateExternal({ id: "launchd-control", kind: "plist", source: "<plist/>\n" });
    await adapters.validateExternal({ id: "caddy", kind: "caddy", source: "example.test {}\n" });
    await adapters.validateExternal({ id: "cloudflared", kind: "cloudflared", source: "tunnel: example\n" });
    await adapters.validateExternal({ id: "newsyslog", kind: "newsyslog", source: "/tmp/a 600 7 * @T00 J\n" });

    assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
      ["/usr/bin/plutil", ["-lint", calls[0].stagedPath]],
      [values.CADDY_BINARY, ["validate", "--config", calls[1].stagedPath, "--adapter", "caddyfile"]],
      [values.CLOUDFLARED_BINARY, ["--config", calls[2].stagedPath, "tunnel", "ingress", "validate"]],
      ["/usr/sbin/newsyslog", ["-n", "-f", calls[3].stagedPath]],
    ]);
    assert.equal(calls.every(({ options }) => options.shell === false), true);
    assert.equal(calls.every(({ options }) => options.stdio?.join(",") === "ignore,pipe,pipe"), true);
    assert.equal(calls.every(({ options }) => Object.keys(options.env).length === 0), true);
    assert.deepEqual(requestedModes.map(([, mode]) => mode), [
      0o700, 0o600,
      0o700, 0o600,
      0o700, 0o600,
      0o700, 0o600,
    ]);
    assert.equal(timers.length, 4);
    assert.equal(timers.every(({ delay }) => delay === 10_000), true);
    assert.equal(calls.every(({ stagedPath }) => !existsSync(path.dirname(stagedPath))), true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("external validators kill on combined output overflow and expose only a stable code", async () => {
  const killed = [];
  const adapters = createMacConfigurationAdapters({
    CADDY_BINARY: "/opt/homebrew/bin/caddy",
    CLOUDFLARED_BINARY: "/opt/homebrew/bin/cloudflared",
  }, {
    scheduleTimer() {
      return { unref() {} };
    },
    cancelTimer() {},
    spawnChild() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        killed.push(signal);
        return true;
      };
      queueMicrotask(() => child.stdout.write(Buffer.alloc(4_097)));
      return child;
    },
  });

  await assert.rejects(
    adapters.validateExternal({ id: "caddy", kind: "caddy", source: "example.test {}\n" }),
    (error) => {
      assert.equal(error.code, "CONFIG_VALIDATION_FAILED");
      assert.equal(error.message.includes("example.test"), false);
      return true;
    },
  );
  assert.deepEqual(killed, ["SIGKILL"]);
});

test("external validators kill when the exact ten-second deadline expires", async () => {
  let timeoutCallback;
  const killed = [];
  const adapters = createMacConfigurationAdapters({
    CADDY_BINARY: "/opt/homebrew/bin/caddy",
    CLOUDFLARED_BINARY: "/opt/homebrew/bin/cloudflared",
  }, {
    scheduleTimer(callback, delay) {
      assert.equal(delay, 10_000);
      timeoutCallback = callback;
      return { unref() {} };
    },
    cancelTimer() {},
    spawnChild() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => {
        killed.push(signal);
        return true;
      };
      queueMicrotask(() => timeoutCallback());
      return child;
    },
  });

  await assert.rejects(
    adapters.validateExternal({ id: "newsyslog", kind: "newsyslog", source: "/tmp/a 600 7 * @T00 J\n" }),
    { code: "CONFIG_VALIDATION_FAILED" },
  );
  assert.deepEqual(killed, ["SIGKILL"]);
});

test("main reads protected values, installs the selected scope, and prints only the report", async () => {
  const values = Object.freeze({ APP_ROOT: "/Users/wisdom/portal" });
  const adapters = Object.freeze({ marker: "mac-adapters" });
  const reports = [];
  const calls = [];
  const report = Object.freeze({ schemaVersion: 1, scope: "user", applied: false, artifacts: [] });

  const result = await main([
    "--values", absoluteValuesPath,
    "--scope", "user",
  ], {
    opsRoot: path.resolve(os.tmpdir(), "ops"),
    readProductionValuesFile: async (filePath) => {
      calls.push(["read", filePath]);
      return values;
    },
    createMacConfigurationAdapters(receivedValues) {
      assert.equal(receivedValues, values);
      return adapters;
    },
    installConfiguration: async (input, receivedAdapters) => {
      calls.push(["install", input, receivedAdapters]);
      return report;
    },
    printJson(value) {
      reports.push(value);
    },
  });

  assert.equal(result, report);
  assert.deepEqual(reports, [report]);
  assert.deepEqual(calls, [
    ["read", absoluteValuesPath],
    ["install", {
      opsRoot: path.resolve(os.tmpdir(), "ops"),
      values,
      scope: "user",
      apply: false,
    }, adapters],
  ]);
});

test("executable failures emit one sanitized code and exit one", () => {
  const scriptPath = path.resolve(import.meta.dirname, "../scripts/config-install.mjs");
  const child = spawnSync(process.execPath, [scriptPath, "--not-a-real-flag", "secret-value"], {
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "Configuration install failed: CONFIG_INPUT_INVALID\n");
  assert.equal(child.stderr.includes("secret-value"), false);
});
