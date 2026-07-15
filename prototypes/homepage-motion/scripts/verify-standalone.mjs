import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const filePath = resolve(
  workspaceRoot,
  ".superpowers/brainstorm/renders/wisdom-homepage-cinematic-demo.html",
);
const html = await readFile(filePath, "utf8");

if (/src="\/assets|href="\/assets|\/images\/representative-brochure/.test(html)) {
  throw new Error("Standalone HTML still contains external asset paths");
}
if (!html.includes("data:image/jpeg;base64,")) {
  throw new Error("Standalone HTML does not contain the embedded portrait");
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(pathToFileURL(filePath).href, { waitUntil: "load" });
  const targets = page.locator("[data-reveal]");
  if (await targets.count() !== 12) throw new Error("Expected 12 reveal targets");

  for (let index = 0; index < await targets.count(); index += 1) {
    await targets.nth(index).scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (key) => document.querySelector(`[data-reveal-key="${key}"]`)?.getAttribute("data-revealed") === "true",
      await targets.nth(index).getAttribute("data-reveal-key"),
    );
  }

  const result = await page.evaluate(() => ({
    headingVisible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
    revealed: document.querySelectorAll('[data-revealed="true"]').length,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  if (!result.headingVisible || result.revealed !== 12) {
    throw new Error(`Invalid standalone state: ${JSON.stringify(result)}`);
  }
  if (result.scrollWidth !== result.clientWidth) {
    throw new Error(`Standalone overflows: ${JSON.stringify(result)}`);
  }
  if (pageErrors.length > 0) throw new Error(`Page errors: ${pageErrors.join(" | ")}`);

  console.log(JSON.stringify({ filePath, ...result, pageErrors }));
} finally {
  await browser.close();
}
