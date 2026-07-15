import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const prototypeRoot = process.cwd();
const workspaceRoot = resolve(prototypeRoot, "../..");
const verifierPath = resolve(prototypeRoot, "scripts/verify-standalone.mjs");
const standalonePath = resolve(
  workspaceRoot,
  ".superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html",
);
const expectedContract = [
  { key: "hero-copy", direction: "left", delay: "0" },
  { key: "portrait", direction: "right", delay: "0" },
  { key: "practice-enterprise", direction: "left", delay: "0" },
  { key: "practice-procurement", direction: "right", delay: "60" },
  { key: "practice-visa", direction: "left", delay: "120" },
  { key: "navigator-copy", direction: "left", delay: "0" },
  { key: "navigator-choices", direction: "right", delay: "0" },
  { key: "principles-heading", direction: "left", delay: "0" },
  { key: "principle-direct", direction: "right", delay: "0" },
  { key: "principle-alternative", direction: "left", delay: "60" },
  { key: "principle-field", direction: "right", delay: "120" },
  { key: "insights-heading", direction: "right", delay: "0" },
  { key: "insight-procurement", direction: "left", delay: "0" },
  { key: "insight-enterprise", direction: "right", delay: "60" },
  { key: "insight-visa", direction: "left", delay: "120" },
  { key: "credentials", direction: "right", delay: "0" },
  { key: "consultation-copy", direction: "left", delay: "0" },
  { key: "consultation-card", direction: "right", delay: "0" },
] as const;

let baseHtml = "";
let fixtureDir = "";

test.beforeAll(() => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required to build the standalone fixture");
  execFileSync(process.execPath, [npmCli, "run", "standalone"], {
    cwd: prototypeRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  baseHtml = readFileSync(standalonePath, "utf8");
  fixtureDir = mkdtempSync(join(tmpdir(), "wisdom-standalone-"));
});

test.afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
});

function writeFixture(name: string, html: string): string {
  const filePath = resolve(fixtureDir, name);
  writeFileSync(filePath, html, "utf8");
  return filePath;
}

function runVerifier(filePath: string) {
  const result = spawnSync(process.execPath, [verifierPath, filePath], {
    cwd: prototypeRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
  };
}

function successPayload(stdout: string) {
  const outputLine = stdout.trim().split(/\r?\n/).at(-1);
  if (!outputLine) throw new Error("Verifier did not emit a result payload");
  return JSON.parse(outputLine) as {
    contract: unknown;
    rootTokens: unknown;
    initialStates: {
      left: { direction: string; translatePx: number; durationMs: number };
      right: { direction: string; translatePx: number; durationMs: number };
    };
    overflowChecks: Array<{ stage: string; overflow: boolean }>;
    failures: {
      consoleErrors: string[];
      pageErrors: string[];
      requestFailures: string[];
    };
  };
}

test("verifies the complete pre-scroll contract and every overflow checkpoint", () => {
  const navigationLinks = `
    <a href="https://example.com/guide">External guide</a>
    <a href="mailto:hello@example.com">Email</a>
    <a href="tel:+821012345678">Telephone</a>
    <a href="#main-content">Page section</a>
  `;
  const fixture = writeFixture(
    "valid-navigation.html",
    baseHtml.replace("</footer>", `</footer>${navigationLinks}`),
  );
  const result = runVerifier(fixture);

  expect(result.status, result.output).toBe(0);
  const payload = successPayload(result.stdout);
  expect(payload.contract).toEqual(expectedContract);
  expect(payload.rootTokens).toEqual({ duration: "500ms", distance: "64px", stagger: "60ms" });
  expect(payload.initialStates.left).toMatchObject({ direction: "left", translatePx: -64, durationMs: 500 });
  expect(payload.initialStates.right).toMatchObject({ direction: "right", translatePx: 64, durationMs: 500 });
  expect(payload.overflowChecks).toHaveLength(20);
  expect(payload.overflowChecks.every(({ overflow }) => !overflow)).toBe(true);
  expect(payload.failures).toEqual({ consoleErrors: [], pageErrors: [], requestFailures: [] });
});

test("rejects a changed reveal order or token before scrolling", () => {
  const changedContract = baseHtml.replace(
    'data-reveal-key="hero-copy" data-reveal-direction="left" data-reveal-delay="0"',
    'data-reveal-key="hero-copy" data-reveal-direction="left" data-reveal-delay="60"',
  );
  const contractResult = runVerifier(writeFixture("changed-contract.html", changedContract));
  expect(contractResult.status, contractResult.output).not.toBe(0);
  expect(contractResult.output).toContain("Reveal contract mismatch");

  const changedToken = baseHtml.replace("--distance-dynamic:64px", "--distance-dynamic:63px");
  const tokenResult = runVerifier(writeFixture("changed-token.html", changedToken));
  expect(tokenResult.status, tokenResult.output).not.toBe(0);
  expect(tokenResult.output).toContain("Root motion token mismatch");
});

test("rejects an incorrect representative unrevealed motion state", () => {
  const changedState = baseHtml.replace(
    "translate:calc(var(--distance-dynamic) * -1) 0",
    "translate:-63px 0",
  );
  expect(changedState).not.toBe(baseHtml);
  const result = runVerifier(writeFixture("changed-state.html", changedState));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("Unrevealed motion state mismatch");
});

test("rejects external executable and rendered resources without rejecting navigation", () => {
  const resources = `
    <script src="./app.js"></script>
    <link rel="stylesheet" href="./site.css">
    <img src="./image.png" srcset="./image-2x.png 2x" alt="">
    <source src="./clip.mp4">
    <video src="./video.mp4" poster="./poster.jpg"></video>
    <audio src="./audio.mp3"></audio>
    <iframe src="./frame.html"></iframe>
    <object data="./document.pdf"></object>
    <embed src="./graphic.svg">
    <style>.external-background { background-image: url("./background.png"); }</style>
    <a href="https://example.com/safe-navigation">Allowed navigation</a>
  `;
  const result = runVerifier(writeFixture(
    "external-resources.html",
    baseHtml.replace("</body>", `${resources}</body>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  for (const resource of [
    "./app.js",
    "./site.css",
    "./image.png",
    "./image-2x.png",
    "./clip.mp4",
    "./video.mp4",
    "./poster.jpg",
    "./audio.mp3",
    "./frame.html",
    "./document.pdf",
    "./graphic.svg",
    "./background.png",
  ]) {
    expect(result.output).toContain(resource);
  }
  expect(result.output).not.toContain("https://example.com/safe-navigation");
});

test("fails on console errors, page errors, and failed requests", () => {
  const runtimeFailures = `
    <script>
      console.error("fixture console failure");
      setTimeout(() => { throw new Error("fixture page failure"); }, 0);
      fetch("http://127.0.0.1:1/fixture-request-failure").catch(() => {});
    </script>
  `;
  const result = runVerifier(writeFixture(
    "runtime-failures.html",
    baseHtml.replace("</body>", `${runtimeFailures}</body>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("fixture console failure");
  expect(result.output).toContain("fixture page failure");
  expect(result.output).toContain("fixture-request-failure");
});
