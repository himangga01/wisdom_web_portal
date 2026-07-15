import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const controlPackageUrl = new URL("../apps/control/package.json", import.meta.url);

test("provides the loopback control workspace and required operations", () => {
  assert.equal(
    existsSync(controlPackageUrl),
    true,
    "Task 3 must provide apps/control/package.json",
  );

  const packageJson = JSON.parse(readFileSync(controlPackageUrl, "utf8"));
  assert.equal(packageJson.name, "@wisdom/control");
  assert.equal(packageJson.dependencies["@wisdom/shared"], "0.1.0");

  for (const dependency of [
    "@hono/node-server",
    "better-sqlite3",
    "drizzle-orm",
    "hono",
    "zod",
  ]) {
    assert.equal(typeof packageJson.dependencies[dependency], "string", dependency);
  }

  for (const script of [
    "build",
    "typecheck",
    "test",
    "db:migrate",
    "consent:seed",
    "consent:activate",
    "retention:purge",
  ]) {
    assert.equal(typeof packageJson.scripts[script], "string", script);
  }
});
