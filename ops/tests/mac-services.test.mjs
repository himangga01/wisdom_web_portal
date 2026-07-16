import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { resolveMacReleaseScripts, stopCanaryProcess } from "../lib/mac-release-adapter.mjs";
import { createMacServiceAdapter } from "../lib/mac-services.mjs";

test("service inspection accepts only launchctl's known missing-service error", async () => {
  const missing = createMacServiceAdapter({
    labels: ["com.example.missing"],
    userId: 501,
    execute: async () => {
      throw Object.assign(new Error("launchctl print failed"), {
        code: 113,
        stderr: 'Could not find service "com.example.missing" in domain for user gui: 501\n',
      });
    },
  });
  await missing.assertStopped();

  const denied = createMacServiceAdapter({
    labels: ["com.example.denied"],
    userId: 501,
    execute: async () => {
      throw Object.assign(new Error("launchctl print failed"), { code: 1, stderr: "Operation not permitted\n" });
    },
  });
  await assert.rejects(denied.assertStopped(), { code: "SERVICE_INSPECTION_FAILED" });
});

test("service inspection rejects running launch agents", async () => {
  const adapter = createMacServiceAdapter({
    labels: ["com.example.running"],
    userId: 501,
    execute: async () => ({ stdout: "state = running\n", stderr: "" }),
  });
  await assert.rejects(adapter.assertStopped(), { code: "SERVICES_RUNNING" });
});

test("tunnel disable inspection requires the launch agent to be fully unloaded", async (t) => {
  for (const [name, stdout] of [
    ["running", "state = running\n"],
    ["loaded but stopped", "state = exited\n"],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const adapter = createMacServiceAdapter({
        labels: ["com.jihye.portal.cloudflared"],
        userId: 501,
        execute: async (_file, args) => {
          calls.push(args);
          return { stdout, stderr: "" };
        },
      });
      await assert.rejects(adapter.assertUnloaded(), { code: "SERVICE_STILL_LOADED" });
      assert.deepEqual(calls, [["print", "gui/501/com.jihye.portal.cloudflared"]]);
    });
  }

  await t.test("unloaded", async () => {
    const adapter = createMacServiceAdapter({
      labels: ["com.jihye.portal.cloudflared"],
      userId: 501,
      execute: async () => {
        throw Object.assign(new Error("missing"), {
          stderr: 'Could not find service "com.jihye.portal.cloudflared" in domain for user gui: 501\n',
        });
      },
    });
    await adapter.assertUnloaded();
  });

  await t.test("unknown inspection error", async () => {
    const adapter = createMacServiceAdapter({
      labels: ["com.jihye.portal.cloudflared"],
      userId: 501,
      execute: async () => {
        throw Object.assign(new Error("denied"), { stderr: "Operation not permitted\n" });
      },
    });
    await assert.rejects(adapter.assertUnloaded(), { code: "SERVICE_INSPECTION_FAILED" });
  });
});

test("post-restart service verification requires every launch agent to remain running", async () => {
  const adapter = createMacServiceAdapter({
    labels: ["com.example.control", "com.example.worker"],
    userId: 501,
    execute: async (_file, args) => ({
      stdout: args.at(-1).endsWith("worker") ? "state = exited\n" : "state = running\n",
      stderr: "",
    }),
  });
  await assert.rejects(adapter.assertRunning(), { code: "SERVICE_NOT_RUNNING" });
});

test("service stop waits until every launch agent is confirmed stopped", async () => {
  let inspections = 0;
  let delays = 0;
  let bootedOut = false;
  const adapter = createMacServiceAdapter({
    labels: ["com.example.control"],
    userId: 501,
    stopAttempts: 3,
    stopDelayMs: 1,
    delay: async () => { delays++; },
    execute: async (_file, args) => {
      if (args[0] === "bootout") {
        bootedOut = true;
        return { stdout: "", stderr: "" };
      }
      inspections++;
      return {
        stdout: !bootedOut || inspections === 2 ? "state = running\n" : "state = exited\n",
        stderr: "",
      };
    },
  });

  await adapter.stop();
  assert.equal(inspections, 3);
  assert.equal(delays, 1);
});

test("service start bootstraps an unloaded launch agent before kickstart", async () => {
  const calls = [];
  const root = path.join(path.parse(process.cwd()).root, "Users", "fixture", "Library", "LaunchAgents");
  const adapter = createMacServiceAdapter({
    labels: ["com.example.control"],
    launchAgentRoot: root,
    userId: 501,
    execute: async (_file, args) => {
      calls.push(args);
      if (args[0] === "print") {
        throw Object.assign(new Error("missing"), {
          stderr: 'Could not find service "com.example.control" in domain for user gui: 501\n',
        });
      }
      return { stdout: "", stderr: "" };
    },
  });

  await adapter.start();
  assert.deepEqual(calls, [
    ["print", "gui/501/com.example.control"],
    ["bootstrap", "gui/501", path.join(root, "com.example.control.plist")],
    ["kickstart", "-k", "gui/501/com.example.control"],
  ]);
});

test("canary shutdown escalates a stuck SIGTERM to bounded SIGKILL", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
    return true;
  };

  await stopCanaryProcess(child, { graceMs: 5, killWaitMs: 25 });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("rollback preflight resolves from explicit ops root while release commands use destination", () => {
  const root = path.parse(process.cwd()).root;
  const opsRoot = path.join(root, "srv", "portal", "current", "ops");
  const destination = path.join(root, "srv", "portal", "releases", "20260716T010203Z-abcdef1");
  assert.deepEqual(resolveMacReleaseScripts({ opsRoot, destination }), {
    preflight: path.join(opsRoot, "scripts", "preflight.mjs"),
    keychainExec: path.join(destination, "ops", "scripts", "keychain-exec.mjs"),
  });
});
