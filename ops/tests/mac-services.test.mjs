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
