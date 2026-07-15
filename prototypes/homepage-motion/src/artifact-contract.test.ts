import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capture = readFileSync(resolve(process.cwd(), "scripts/capture-motion.mjs"), "utf8");
const standalone = readFileSync(resolve(process.cwd(), "scripts/build-standalone.mjs"), "utf8");
const verifier = readFileSync(resolve(process.cwd(), "scripts/verify-standalone.mjs"), "utf8");
const playwrightConfig = readFileSync(resolve(process.cwd(), "playwright.config.ts"), "utf8");
const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

describe("homepage demo artifact contract", () => {
  it("writes captures to the dynamic c1 artifact names", () => {
    expect(capture).toContain("wisdom-homepage-dynamic-c1-desktop.png");
    expect(capture).toContain("wisdom-homepage-dynamic-c1-mobile.png");
    expect(capture).toContain("wisdom-homepage-dynamic-c1-scroll.webm");
    expect(capture).not.toContain("wisdom-homepage-cinematic-desktop.png");
    expect(capture).not.toContain("wisdom-homepage-cinematic-mobile.png");
    expect(capture).not.toContain("wisdom-homepage-cinematic-scroll.webm");
  });

  it("uses the approved dynamic c1 standalone artifact", () => {
    expect(standalone).toContain("wisdom-homepage-dynamic-c1-demo.html");
    expect(verifier).toContain("wisdom-homepage-dynamic-c1-demo.html");
    expect(verifier).toContain("Expected 18 reveal targets");
  });

  it("waits 650ms after dynamic c1 reveals before capture", () => {
    const waits = [...capture.matchAll(/waitForTimeout\((\d+)\)/g)].map((match) => Number(match[1]));
    expect(new Set(waits)).toEqual(new Set([650]));
    expect(waits.every((wait) => wait > 500)).toBe(true);
  });

  it("starts the Playwright web server cross-platform and documents Chromium setup", () => {
    expect(playwrightConfig).toContain('command: "npm run dev -- --host 127.0.0.1 --port 4173"');
    expect(playwrightConfig).not.toContain('command: "npm.cmd');
    expect(readme).toContain("npx playwright install chromium");
    expect(readme).toContain("npx.cmd playwright install chromium");
  });

  it("uses the cross-platform verifier command in the generic workflow", () => {
    expect(readme).toContain("npm run standalone\nnpm run verify:standalone");
    expect(readme).not.toContain("npm run standalone\nnpm.cmd run verify:standalone");
    expect(readme).toContain("npm.cmd run verify:standalone");
  });

  it("documents the dynamic capture names and precise standalone checks", () => {
    expect(readme).toContain("wisdom-homepage-dynamic-c1-desktop.png");
    expect(readme).toContain("wisdom-homepage-dynamic-c1-mobile.png");
    expect(readme).toContain("wisdom-homepage-dynamic-c1-scroll.webm");
    for (const detail of [
      "key·direction·delay",
      "500ms",
      "±64px",
      "60ms",
      "console.error",
      "pageerror",
      "requestfailed",
      "390px",
    ]) {
      expect(readme).toContain(detail);
    }
  });
});
