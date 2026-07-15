import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capture = readFileSync(resolve(process.cwd(), "scripts/capture-motion.mjs"), "utf8");
const standalone = readFileSync(resolve(process.cwd(), "scripts/build-standalone.mjs"), "utf8");
const verifier = readFileSync(resolve(process.cwd(), "scripts/verify-standalone.mjs"), "utf8");

describe("homepage demo artifact contract", () => {
  it("keeps the approved cinematic capture artifacts", () => {
    expect(capture).toContain("wisdom-homepage-cinematic-desktop.png");
    expect(capture).toContain("wisdom-homepage-cinematic-mobile.png");
    expect(capture).toContain("wisdom-homepage-cinematic-scroll.webm");
  });

  it("uses the approved dynamic c1 standalone artifact", () => {
    expect(standalone).toContain("wisdom-homepage-dynamic-c1-demo.html");
    expect(verifier).toContain("wisdom-homepage-dynamic-c1-demo.html");
    expect(verifier).toContain("Expected 18 reveal targets");
  });

  it("waits long enough to record the previous 900ms cinematic capture", () => {
    expect(capture).toContain("waitForTimeout(1050)");
  });
});
