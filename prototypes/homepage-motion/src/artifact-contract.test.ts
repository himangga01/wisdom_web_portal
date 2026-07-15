import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const capture = readFileSync(resolve(process.cwd(), "scripts/capture-motion.mjs"), "utf8");
const standalone = readFileSync(resolve(process.cwd(), "scripts/build-standalone.mjs"), "utf8");

describe("cinematic artifact contract", () => {
  it("uses the approved cinematic artifact names", () => {
    expect(capture).toContain("wisdom-homepage-cinematic-desktop.png");
    expect(capture).toContain("wisdom-homepage-cinematic-mobile.png");
    expect(capture).toContain("wisdom-homepage-cinematic-scroll.webm");
    expect(standalone).toContain("wisdom-homepage-cinematic-demo.html");
  });

  it("waits long enough to record the 900ms reveal", () => {
    expect(capture).toContain("waitForTimeout(1050)");
  });
});
