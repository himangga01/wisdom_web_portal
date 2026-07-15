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
    preReveal: {
      motionEnabled: boolean;
      states: Array<{
        key: string;
        direction: string;
        delay: string;
        revealed: string;
        opacity: number;
        filter: string;
        translate: { x: number; y: number };
        durationMs: number;
        delayMs: number;
        transitionProperties: string[];
        timingFunctions: string[];
      }>;
      overflow: { scrollWidth: number; clientWidth: number; overflow: boolean };
    };
    final: {
      states: Array<{
        key: string;
        revealed: string;
        opacity: number;
        filter: string;
        translate: string;
      }>;
    };
    overflow: {
      sampleCount: number;
      overflowedFrames: Array<{ scrollWidth: number; clientWidth: number }>;
      maxDurationDelayMs: number;
      waitedMs: number;
    };
    failures: {
      consoleErrors: string[];
      pageErrors: string[];
      requestFailures: string[];
      externalRequests: string[];
    };
  };
}

test("verifies all pre-reveal and final motion states with continuous overflow evidence", () => {
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
  expect(payload.preReveal.motionEnabled).toBe(true);
  expect(payload.preReveal.states).toHaveLength(18);
  expect(payload.preReveal.states.map(({ key, direction, delay }) => ({ key, direction, delay }))).toEqual(expectedContract);
  payload.preReveal.states.forEach((state, index) => {
    expect(state).toMatchObject({
      revealed: "false",
      opacity: 0.08,
      filter: "blur(2px)",
      translate: {
        x: expectedContract[index].direction === "left" ? -64 : 64,
        y: 0,
      },
      durationMs: 500,
      delayMs: Number(expectedContract[index].delay),
      transitionProperties: ["opacity", "filter", "translate"],
      timingFunctions: [
        "cubic-bezier(0.16, 1, 0.3, 1)",
        "cubic-bezier(0.16, 1, 0.3, 1)",
        "cubic-bezier(0.16, 1, 0.3, 1)",
      ],
    });
  });
  expect(payload.preReveal.overflow).toMatchObject({ overflow: false, scrollWidth: 390, clientWidth: 390 });
  expect(payload.final.states).toHaveLength(18);
  expect(payload.final.states.map(({ key }) => key)).toEqual(expectedContract.map(({ key }) => key));
  payload.final.states.forEach((state) => {
    expect(state).toMatchObject({ revealed: "true", opacity: 1, filter: "none", translate: "none" });
  });
  expect(payload.overflow.sampleCount).toBeGreaterThan(0);
  expect(payload.overflow.overflowedFrames).toEqual([]);
  expect(payload.overflow.maxDurationDelayMs).toBe(620);
  expect(payload.overflow.waitedMs).toBeGreaterThanOrEqual(650);
  expect(payload.failures).toEqual({
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    externalRequests: [],
  });
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

test("rejects changed computed 60ms and 120ms delay mappings", () => {
  const mutations = [
    ["changed-computed-60ms.html", "--reveal-delay:var(--stagger-dynamic)", "--reveal-delay:61ms"],
    ["changed-computed-120ms.html", "--reveal-delay:.12s", "--reveal-delay:121ms"],
  ] as const;
  for (const [fileName, currentValue, changedValue] of mutations) {
    const changedDelay = baseHtml.replace(currentValue, changedValue);
    expect(changedDelay).not.toBe(baseHtml);
    const result = runVerifier(writeFixture(fileName, changedDelay));
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("Unrevealed motion state mismatch");
  }
});

test("rejects malformed two-axis translate and malformed duration or delay tokens", () => {
  const malformedTranslate = baseHtml.replace(
    "translate:calc(var(--distance-dynamic) * -1) 0",
    "translate:-64px 40px",
  );
  const translateResult = runVerifier(writeFixture("malformed-translate.html", malformedTranslate));
  expect(translateResult.status, translateResult.output).not.toBe(0);
  expect(translateResult.output).toContain("Unrevealed motion state mismatch");

  const malformedDuration = baseHtml
    .replace(/--duration-dynamic:(?:500ms|\.5s)/, "--duration-dynamic:500garbagems")
    .replace("</head>", "<style>.motion-enabled [data-reveal]{transition-duration:500ms!important}</style></head>");
  expect(malformedDuration).toContain("--duration-dynamic:500garbagems");
  const durationResult = runVerifier(writeFixture("malformed-duration.html", malformedDuration));
  expect(durationResult.status, durationResult.output).not.toBe(0);
  expect(durationResult.output).toContain("Root motion token mismatch");

  const malformedDelay = baseHtml.replace(
    "--reveal-delay:var(--stagger-dynamic)",
    "--reveal-delay:60garbagems",
  );
  const delayResult = runVerifier(writeFixture("malformed-delay.html", malformedDelay));
  expect(delayResult.status, delayResult.output).not.toBe(0);
  expect(delayResult.output).toContain("Unrevealed motion state mismatch");
});

test("rejects overflow that exists only in the frozen pre-reveal state", () => {
  const style = `<style>
    html.motion-enabled:has([data-reveal-key="hero-copy"][data-revealed="false"]) body::before {
      content: "";
      position: absolute;
      left: 0;
      top: 0;
      width: calc(100vw + 80px);
      height: 1px;
    }
  </style>`;
  const result = runVerifier(writeFixture(
    "pre-reveal-overflow.html",
    baseHtml.replace("</head>", `${style}</head>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("pre-reveal");
  expect(result.output).toContain("scrollWidth");
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

test("rejects quoted greater-than attributes and additional DOM resource forms", () => {
  const resources = `
    <iframe title="quoted > marker" src="about:blank?quoted-resource"></iframe>
    <video><track src="about:blank?track-resource" default></video>
    <input type="image" src="about:blank?input-image-resource" alt="submit">
    <svg xmlns="http://www.w3.org/2000/svg">
      <image href="about:blank?svg-image-resource"></image>
      <use href="about:blank?svg-use-resource#icon"></use>
    </svg>
  `;
  const result = runVerifier(writeFixture(
    "additional-dom-resources.html",
    baseHtml.replace("</body>", `${resources}</body>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  for (const resource of [
    "about:blank?quoted-resource",
    "about:blank?track-resource",
    "about:blank?input-image-resource",
    "about:blank?svg-image-resource",
    "about:blank?svg-use-resource#icon",
  ]) {
    expect(result.output).toContain(resource);
  }
});

test("rejects CSS @import and image-set references from actual rules", () => {
  const resources = `<style>
    @import "http://127.0.0.1:4173/src/dynamic-motion.css";
    .external-image-set {
      width: 1px;
      height: 1px;
      background-image: image-set("http://127.0.0.1:4173/images/representative-brochure.jpg" 1x);
    }
  </style><div class="external-image-set"></div>`;
  const result = runVerifier(writeFixture(
    "css-rule-resources.html",
    baseHtml.replace("</body>", `${resources}</body>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("http://127.0.0.1:4173/src/dynamic-motion.css");
  expect(result.output).toContain("http://127.0.0.1:4173/images/representative-brochure.jpg");
});

test("rejects an external rendered resource nested in an embedded CSS import", () => {
  const externalUrl = "https://example.com/dormant-imported-background.png";
  const importedCss = `.unused-imported-resource { background-image: url("${externalUrl}"); }`;
  const embeddedImport = `data:text/css,${encodeURIComponent(importedCss)}`;
  const result = runVerifier(writeFixture(
    "embedded-css-import.html",
    baseHtml.replace("</head>", `<style>@import url("${embeddedImport}");</style></head>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("Standalone HTML contains external rendered resources");
  expect(result.output).toContain(externalUrl);
  expect(result.output).not.toContain("External browser requests");
});

test("rejects a successful dynamically initiated external request", () => {
  const runtimeRequest = `<script>
    const requestProbe = new Image();
    requestProbe.addEventListener("load", () => requestProbe.remove(), { once: true });
    requestProbe.src = "http://127.0.0.1:4173/images/representative-brochure.jpg";
    document.documentElement.append(requestProbe);
  </script>`;
  const result = runVerifier(writeFixture(
    "successful-runtime-request.html",
    baseHtml.replace("</body>", `${runtimeRequest}</body>`),
  ));

  expect(result.status, result.output).not.toBe(0);
  expect(result.output).toContain("External browser requests");
  expect(result.output).toContain("http://127.0.0.1:4173/images/representative-brochure.jpg");
});

test("allows data-src and inert url text in comments and scripts", () => {
  const inertText = `
    <!-- url("https://example.com/comment-only.png") -->
    <div data-src="https://example.com/lazy-only.png"></div>
    <script>window.__inertResourceText = 'url("https://example.com/script-only.png")';</script>
  `;
  const result = runVerifier(writeFixture(
    "inert-resource-text.html",
    baseHtml.replace("</body>", `${inertText}</body>`),
  ));

  expect(result.status, result.output).toBe(0);
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
