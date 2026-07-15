import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { preview } from "vite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const renderDir = resolve(workspaceRoot, ".superpowers/brainstorm/renders");
const desktopPng = resolve(renderDir, "h1-recommended-hybrid-motion-desktop.png");
const mobilePng = resolve(renderDir, "h1-recommended-hybrid-motion-mobile.png");
const scrollVideo = resolve(renderDir, "h1-recommended-hybrid-motion-scroll.webm");
const url = "http://127.0.0.1:4173";

await mkdir(renderDir, { recursive: true });

const server = await preview({
  root: prototypeRoot,
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  logLevel: "silent",
});

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Vite preview did not become ready");
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const desktop = await browser.newContext({ viewport: { width: 1440, height: 2200 } });
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(url, { waitUntil: "networkidle" });
  await desktopPage.screenshot({ path: desktopPng, fullPage: false });
  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 1600 },
    recordVideo: { dir: renderDir, size: { width: 390, height: 1600 } },
  });
  const mobilePage = await mobile.newPage();
  const video = mobilePage.video();
  await mobilePage.goto(url, { waitUntil: "networkidle" });
  await mobilePage.screenshot({ path: mobilePng, fullPage: false });
  const scrollHeight = await mobilePage.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= scrollHeight; y += 600) {
    await mobilePage.evaluate((nextY) => window.scrollTo({ top: nextY, behavior: "smooth" }), y);
    await mobilePage.waitForTimeout(450);
  }
  await mobile.close();
  if (video) await video.saveAs(scrollVideo);
} finally {
  await browser?.close();
  await server.close();
}
