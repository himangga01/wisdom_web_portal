import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const windowRef = new Window();
windowRef.document.write(html);
const documentRef = windowRef.document;
const expectedRevealTargets = [
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

describe("homepage contract", () => {
  it("contains the eighteen approved dynamic reveal targets", () => {
    const targets = Array.from(documentRef.querySelectorAll("[data-reveal]")) as unknown as globalThis.HTMLElement[];
    const contract = targets.map((target) => ({
      key: target.dataset.revealKey,
      direction: target.dataset.revealDirection,
      delay: target.dataset.revealDelay,
    }));

    expect(targets).toHaveLength(18);
    expect(contract).toEqual(expectedRevealTargets);
    expect(new Set(contract.map(({ key }) => key)).size).toBe(18);
  });

  it("contains the cinematic progress indicator", () => {
    const progress = documentRef.querySelector(".scroll-progress") as unknown as globalThis.HTMLElement | null;

    expect(progress).not.toBeNull();
    expect(progress?.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps interactive reveal containers visible", () => {
    const targets = Array.from(documentRef.querySelectorAll("[data-reveal]")) as unknown as globalThis.HTMLElement[];
    targets.forEach((target) => {
      if (target.querySelector("a, button, input, label")) {
        expect(target.classList.contains("reveal-group")).toBe(true);
      }
    });
  });

  it("contains equal practice entries and multilingual controls", () => {
    expect(documentRef.querySelectorAll("#practice .practice-card")).toHaveLength(3);
    expect(documentRef.body.textContent).toContain("기업행정");
    expect(documentRef.body.textContent).toContain("공공조달");
    expect(documentRef.body.textContent).toContain("출입국·비자");

    for (const language of ["KO", "EN", "简", "繁"]) {
      expect(documentRef.body.textContent).toContain(language);
    }
  });

  it("uses a local Tailwind entry and no CDN", () => {
    expect(html).toContain('/src/main.ts');
    expect(html).not.toMatch(/cdn\.tailwindcss|@tailwindcss\/browser|https:\/\/cdn\./);
  });
});
