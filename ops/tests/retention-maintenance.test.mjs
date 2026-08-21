import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runRetentionMaintenance } from "../scripts/retention.mjs";

test("retention holds the database maintenance lock until its child exits", async () => {
  const events = [];
  const child = new EventEmitter();
  const resultPromise = runRetentionMaintenance({
    databasePath: "/var/private/portal.sqlite",
    command: "/opt/homebrew/bin/node",
    args: ["purge.js", "--apply"],
  }, {
    acquireLock: async () => {
      events.push("lock");
      return async () => events.push("unlock");
    },
    spawnChild: (command, args, options) => {
      events.push(["spawn", command, args, options.shell, options.stdio]);
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });

  assert.deepEqual(await resultPromise, { completed: true });
  assert.deepEqual(events, [
    "lock",
    ["spawn", "/opt/homebrew/bin/node", ["purge.js", "--apply"], false, "inherit"],
    "unlock",
  ]);
});

test("retention never starts purge when the maintenance lock is busy", async () => {
  let spawned = false;
  await assert.rejects(runRetentionMaintenance({
    databasePath: "/var/private/portal.sqlite",
    command: "/opt/homebrew/bin/node",
  }, {
    acquireLock: async () => {
      throw Object.assign(new Error("busy"), { code: "DATABASE_MAINTENANCE_LOCKED" });
    },
    spawnChild: () => {
      spawned = true;
      return new EventEmitter();
    },
  }), { code: "DATABASE_MAINTENANCE_LOCKED" });
  assert.equal(spawned, false);
});
