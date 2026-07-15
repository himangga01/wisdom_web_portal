import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const windowRef = new Window();
windowRef.document.write(html);
const documentRef = windowRef.document;

describe("homepage contract", () => {
  it("contains the eight approved reveal targets", () => {
    const targets = Array.from(documentRef.querySelectorAll("[data-reveal]")) as unknown as globalThis.HTMLElement[];
    const keys = targets.map((target) => target.dataset.revealKey);

    expect(targets).toHaveLength(8);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(8);
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
