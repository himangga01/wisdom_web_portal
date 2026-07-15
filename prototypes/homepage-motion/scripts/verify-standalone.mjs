import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const prototypeRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(prototypeRoot, "../..");
const defaultFilePath = resolve(
  workspaceRoot,
  ".superpowers/brainstorm/renders/wisdom-homepage-dynamic-c1-demo.html",
);
const filePath = process.argv[2] ? resolve(process.argv[2]) : defaultFilePath;
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
];
const expectedRootTokens = { duration: "500ms", distance: "64px", stagger: "60ms" };
const html = await readFile(filePath, "utf8");

function attributeValue(tag, attribute) {
  const match = tag.match(new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  ));
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function openingTags(documentText, names) {
  return documentText.match(new RegExp(`<(?:${names.join("|")})\\b[^>]*>`, "gi")) ?? [];
}

function srcsetReferences(value) {
  const references = [];
  let remaining = value.trim();
  while (remaining) {
    const match = remaining.match(/^(data:[^\s]+|[^,\s]+)(?:\s+(?:\d+(?:\.\d+)?w|\d*\.?\d+x))?\s*(?:,|$)/i);
    if (!match) {
      references.push(remaining);
      break;
    }
    references.push(match[1]);
    remaining = remaining.slice(match[0].length).trim();
  }
  return references;
}

function isEmbeddedResource(reference) {
  const value = reference.trim();
  return value === ""
    || value.startsWith("#")
    || /^data:/i.test(value)
    || /^about:blank(?:#.*)?$/i.test(value);
}

function externalRenderedResources(documentText) {
  const resources = [];
  const collect = (names, attribute, filter = () => true) => {
    for (const tag of openingTags(documentText, names)) {
      if (!filter(tag)) continue;
      const value = attributeValue(tag, attribute);
      if (value !== null && !isEmbeddedResource(value)) {
        resources.push(`${names.join("|")}[${attribute}]=${value}`);
      }
    }
  };

  collect(["script"], "src");
  collect(["link"], "href", (tag) => {
    const rel = attributeValue(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    return rel.some((value) => ["stylesheet", "icon", "preload", "modulepreload"].includes(value));
  });
  collect(["img"], "src");
  collect(["source"], "src");
  collect(["video", "audio"], "src");
  collect(["iframe"], "src");
  collect(["object"], "data");
  collect(["embed"], "src");
  collect(["video"], "poster");

  for (const tag of openingTags(documentText, ["img", "source"])) {
    const value = attributeValue(tag, "srcset");
    if (value === null) continue;
    for (const reference of srcsetReferences(value)) {
      if (!isEmbeddedResource(reference)) resources.push(`img|source[srcset]=${reference}`);
    }
  }

  const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi;
  for (const match of documentText.matchAll(cssUrlPattern)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!isEmbeddedResource(value)) resources.push(`css[url]=${value}`);
  }

  return [...new Set(resources)];
}

const externalResources = externalRenderedResources(html);
if (externalResources.length > 0) {
  throw new Error(`Standalone HTML contains external rendered resources:\n${externalResources.join("\n")}`);
}
if (!html.includes("data:image/jpeg;base64,")) {
  throw new Error("Standalone HTML does not contain the embedded portrait");
}

function durationInMilliseconds(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized.endsWith("ms")) return Number.parseFloat(normalized);
  if (normalized.endsWith("s")) return Number.parseFloat(normalized) * 1000;
  return Number.NaN;
}

function normalizedDuration(value) {
  const milliseconds = durationInMilliseconds(value);
  return Number.isFinite(milliseconds) ? `${milliseconds}ms` : value.trim();
}

function normalizedPixels(value) {
  const normalized = value.trim().toLowerCase();
  return /^-?\d*\.?\d+px$/.test(normalized)
    ? `${Number.parseFloat(normalized)}px`
    : value.trim();
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const failures = {
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
};
page.on("console", (message) => {
  if (message.type() === "error") failures.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => failures.pageErrors.push(error.message));
page.on("requestfailed", (request) => {
  failures.requestFailures.push(
    `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`,
  );
});

try {
  await page.goto(pathToFileURL(filePath).href, { waitUntil: "load" });
  const targets = page.locator("[data-reveal]");
  if (await targets.count() !== expectedContract.length) throw new Error("Expected 18 reveal targets");

  const contract = await targets.evaluateAll((elements) => elements.map((element) => ({
    key: element.getAttribute("data-reveal-key"),
    direction: element.getAttribute("data-reveal-direction"),
    delay: element.getAttribute("data-reveal-delay"),
  })));
  if (JSON.stringify(contract) !== JSON.stringify(expectedContract)) {
    throw new Error(`Reveal contract mismatch: ${JSON.stringify(contract)}`);
  }

  const rawRootTokens = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return {
      duration: style.getPropertyValue("--duration-dynamic"),
      distance: style.getPropertyValue("--distance-dynamic"),
      stagger: style.getPropertyValue("--stagger-dynamic"),
    };
  });
  const rootTokens = {
    duration: normalizedDuration(rawRootTokens.duration),
    distance: normalizedPixels(rawRootTokens.distance),
    stagger: normalizedDuration(rawRootTokens.stagger),
  };
  if (JSON.stringify(rootTokens) !== JSON.stringify(expectedRootTokens)) {
    throw new Error(`Root motion token mismatch: ${JSON.stringify(rootTokens)}`);
  }

  await page.waitForTimeout(650);
  const rawInitialStates = await page.evaluate(() => {
    const state = (key) => {
      const target = document.querySelector(`[data-reveal-key="${key}"]`);
      if (!(target instanceof HTMLElement)) return null;
      const style = getComputedStyle(target);
      return {
        key,
        direction: target.dataset.revealDirection,
        revealed: target.dataset.revealed,
        translate: style.translate,
        duration: style.transitionDuration.split(",")[0],
      };
    };
    return {
      left: state("principles-heading"),
      right: state("navigator-choices"),
    };
  });
  const normalizeState = (state) => state === null ? null : ({
    key: state.key,
    direction: state.direction,
    revealed: state.revealed,
    translatePx: Number.parseFloat(state.translate),
    durationMs: durationInMilliseconds(state.duration),
  });
  const initialStates = {
    left: normalizeState(rawInitialStates.left),
    right: normalizeState(rawInitialStates.right),
  };
  if (
    initialStates.left?.direction !== "left"
    || initialStates.left.revealed !== "false"
    || initialStates.left.translatePx !== -64
    || initialStates.left.durationMs !== 500
    || initialStates.right?.direction !== "right"
    || initialStates.right.revealed !== "false"
    || initialStates.right.translatePx !== 64
    || initialStates.right.durationMs !== 500
  ) {
    throw new Error(`Unrevealed motion state mismatch: ${JSON.stringify(initialStates)}`);
  }

  const overflowChecks = [];
  const checkOverflow = async (stage) => {
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    const overflow = dimensions.scrollWidth !== dimensions.clientWidth;
    overflowChecks.push({ stage, overflow, ...dimensions });
    if (overflow) throw new Error(`Standalone overflows during ${stage}: ${JSON.stringify(dimensions)}`);
  };

  await checkOverflow("before-scroll");
  for (let index = 0; index < expectedContract.length; index += 1) {
    const target = targets.nth(index);
    const key = expectedContract[index].key;
    await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await page.waitForFunction(
      (revealKey) => document.querySelector(`[data-reveal-key="${revealKey}"]`)?.getAttribute("data-revealed") === "true",
      key,
    );
    await checkOverflow(`reveal:${key}`);
  }
  await page.waitForTimeout(550);
  await checkOverflow("after-all-reveals");

  const result = await page.evaluate(() => ({
    headingVisible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
    revealed: document.querySelectorAll('[data-revealed="true"]').length,
  }));
  if (!result.headingVisible || result.revealed !== expectedContract.length) {
    throw new Error(`Invalid standalone state: ${JSON.stringify(result)}`);
  }

  const failureCount = Object.values(failures).reduce((count, entries) => count + entries.length, 0);
  if (failureCount > 0) {
    throw new Error(`Standalone runtime failures: ${JSON.stringify(failures)}`);
  }

  console.log(JSON.stringify({
    filePath,
    ...result,
    contract,
    rootTokens,
    initialStates,
    overflowChecks,
    failures,
  }));
} finally {
  await browser.close();
}
