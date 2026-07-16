import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const sitePackageJson = JSON.parse(
  readFileSync(new URL("../apps/site/package.json", import.meta.url), "utf8"),
);

test("orders package workspaces before consuming app workspaces", () => {
  assert.deepEqual(packageJson.workspaces, ["packages/*", "apps/*"]);
});

test("builds shared output before typecheck, test, and e2e workspace commands", () => {
  assert.equal(
    packageJson.scripts["build:shared"],
    "npm run build --workspace @wisdom/shared",
  );

  for (const command of ["typecheck", "test", "test:e2e"]) {
    const script = packageJson.scripts[command];
    const sharedBuildIndex = script.indexOf("npm run build:shared");
    const workspaceCommandIndex = script.indexOf(
      `npm run ${command} --workspaces --if-present`,
    );

    assert.notEqual(sharedBuildIndex, -1, `${command} must build @wisdom/shared first`);
    assert.ok(
      workspaceCommandIndex > sharedBuildIndex,
      `${command} must run consuming workspaces after the shared build`,
    );
  }
});

test("keeps the orchestration contract in the root test and verify flows", () => {
  assert.match(
    packageJson.scripts.test,
    /node --test scripts\/workspace-orchestration\.test\.mjs/,
  );
  assert.match(packageJson.scripts.test, /scripts\/site-build-gate\.test\.mjs/);
  assert.equal(
    packageJson.scripts.verify,
    "npm run typecheck && npm run test && npm run build && npm run test:e2e",
  );
  assert.equal(packageJson.scripts["test:ops"], "node --test ops/tests/*.test.mjs");
  assert.match(packageJson.scripts.test, /npm run test:ops/);
});

test("keeps raw Site production builds gated and opts root verification into fixtures explicitly", () => {
  assert.equal(sitePackageJson.scripts.build, "node ./scripts/build.mjs");
  assert.equal(sitePackageJson.scripts["build:fixture"], "node ./scripts/build.mjs --fixture");
  assert.equal(
    packageJson.scripts.build,
    "npm run build:shared && npm run build --workspace @wisdom/control && npm run build:fixture --workspace @wisdom/site",
  );
});
