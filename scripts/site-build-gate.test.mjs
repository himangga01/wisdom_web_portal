import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workspaceRoot = resolve(import.meta.dirname, "..");
const buildScript = join(workspaceRoot, "apps", "site", "scripts", "build.mjs");
const fixtureRoot = join(
  workspaceRoot,
  "apps",
  "site",
  "src",
  "content",
  "__fixtures__",
  "published-content",
);

function runBuild(argumentsForBuild, environment = {}) {
  const env = { ...process.env };
  delete env.WISDOM_PUBLISHED_CONTENT_DIR;
  delete env.PUBLIC_ORIGIN;
  Object.assign(env, environment);
  return spawnSync(process.execPath, [buildScript, ...argumentsForBuild], {
    cwd: workspaceRoot,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
}

test("canonical publication fixtures stay LF-only across Git checkouts", () => {
  const attributesPath = join(workspaceRoot, ".gitattributes");
  assert.equal(existsSync(attributesPath), true, ".gitattributes must pin canonical fixture bytes");
  assert.match(
    readFileSync(attributesPath, "utf8"),
    /^\* text=auto eol=lf$/m,
  );
  assert.match(
    readFileSync(attributesPath, "utf8"),
    /^apps\/site\/src\/content\/__fixtures__\/published-content\/\*\* text eol=lf$/m,
  );

  const fixturePaths = [
    join(fixtureRoot, "manifest.json"),
    join(fixtureRoot, "consent-bundle.json"),
    ...readdirSync(join(fixtureRoot, "articles"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(fixtureRoot, "articles", name)),
  ];
  for (const fixturePath of fixturePaths) {
    assert.equal(
      readFileSync(fixturePath, "utf8").includes("\r"),
      false,
      `${fixturePath} must retain canonical LF bytes`,
    );
  }
});

test("raw Site production build rejects a missing publication snapshot before Astro starts", () => {
  const output = mkdtempSync(join(tmpdir(), "wisdom-site-raw-gate-"));
  try {
    const result = runBuild(["--outDir", output]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /SITE_BUILD_PUBLISHED_CONTENT_REQUIRED/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("raw Site production build rejects a relative publication snapshot before Astro starts", () => {
  const output = mkdtempSync(join(tmpdir(), "wisdom-site-relative-gate-"));
  try {
    const result = runBuild(["--outDir", output], {
      WISDOM_PUBLISHED_CONTENT_DIR: "./published-content",
      PUBLIC_ORIGIN: "https://www.jihye-office.kr",
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /SITE_BUILD_PUBLISHED_CONTENT_NOT_ABSOLUTE/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("explicit fixture build succeeds without an ambient publication snapshot", { timeout: 120_000 }, () => {
  const output = mkdtempSync(join(tmpdir(), "wisdom-site-fixture-build-"));
  try {
    const result = runBuild(["--fixture", "--outDir", output]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
