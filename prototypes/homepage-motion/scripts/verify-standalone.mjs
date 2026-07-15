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
const documentUrl = pathToFileURL(filePath).href;
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
const expectedRevealProperties = ["opacity", "filter", "translate"];
const expectedTimingFunction = "cubic-bezier(0.16, 1, 0.3, 1)";
const preRevealSettleMs = 650;
const transitionFrameMarginMs = 30;

function strictDurationInMilliseconds(value) {
  const match = value.trim().toLowerCase().match(
    /^(-?(?:\d+(?:\.\d+)?|\.\d+))(ms|s)$/,
  );
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}

function normalizedDuration(value) {
  const milliseconds = strictDurationInMilliseconds(value);
  return Number.isFinite(milliseconds) ? `${milliseconds}ms` : value.trim();
}

function strictPixels(value) {
  const match = value.trim().toLowerCase().match(
    /^(-?(?:\d+(?:\.\d+)?|\.\d+))px$/,
  );
  return match ? Number(match[1]) : Number.NaN;
}

function normalizedPixels(value) {
  const pixels = strictPixels(value);
  return Number.isFinite(pixels) ? `${pixels}px` : value.trim();
}

function strictOpacity(value) {
  const match = value.trim().match(/^(?:\d+(?:\.\d+)?|\.\d+)$/);
  return match ? Number(value) : Number.NaN;
}

function strictTranslate(value) {
  const parts = value.trim().toLowerCase().split(/\s+/);
  if (parts.length < 1 || parts.length > 2 || parts[0] === "none") return null;
  const x = strictPixels(parts[0]);
  if (!Number.isFinite(x)) return null;
  if (parts.length === 1) return { x, y: 0 };
  const y = parts[1] === "0" ? 0 : strictPixels(parts[1]);
  return Number.isFinite(y) ? { x, y } : null;
}

function listValue(values, index) {
  return values.length > 0 ? values[index % values.length] : "";
}

function isRuntimeEmbedded(url) {
  return /^(?:data:|blob:)/i.test(url) || /^about:blank(?:#.*)?$/i.test(url);
}

function runtimeFailureCount(failures) {
  return Object.values(failures).reduce((count, entries) => count + entries.length, 0);
}

function assertNoRuntimeFailures(failures) {
  if (runtimeFailureCount(failures) === 0) return;
  const externalMessage = failures.externalRequests.length > 0
    ? " External browser requests are forbidden."
    : "";
  throw new Error(`Standalone runtime failures.${externalMessage} ${JSON.stringify(failures)}`);
}

function watchPage(page, label, failures) {
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(`${label}: ${message.text()}`);
  });
  page.on("pageerror", (error) => failures.pageErrors.push(`${label}: ${error.message}`));
}

async function inspectRenderedResources(page) {
  return page.evaluate(() => {
    const resources = [];
    const isEmbedded = (reference) => {
      const value = reference.trim();
      return value === ""
        || value.startsWith("#")
        || /^(?:data:|blob:)/i.test(value)
        || /^about:blank(?:#.*)?$/i.test(value);
    };
    const add = (label, reference) => {
      if (reference !== null && !isEmbedded(reference)) {
        resources.push(`${label}=${reference.trim()}`);
      }
    };
    const collectAttribute = (selector, attribute, label = `${selector}[${attribute}]`) => {
      document.querySelectorAll(selector).forEach((element) => {
        add(label, element.getAttribute(attribute));
      });
    };

    collectAttribute("script[src]", "src");
    document.querySelectorAll("link[href]").forEach((element) => {
      const resourceRels = new Set([
        "stylesheet", "icon", "preload", "modulepreload", "manifest", "prefetch",
        "dns-prefetch", "preconnect", "apple-touch-icon", "mask-icon",
      ]);
      const rels = (element.getAttribute("rel") ?? "").toLowerCase().split(/\s+/);
      if (rels.some((rel) => resourceRels.has(rel))) add("link[href]", element.getAttribute("href"));
    });
    collectAttribute("img[src]", "src");
    collectAttribute("source[src]", "src");
    collectAttribute("video[src]", "src");
    collectAttribute("audio[src]", "src");
    collectAttribute("track[src]", "src");
    collectAttribute("iframe[src]", "src");
    collectAttribute("object[data]", "data");
    collectAttribute("embed[src]", "src");
    collectAttribute("video[poster]", "poster");
    collectAttribute('input[type="image" i][src]', "src", "input[type=image][src]");

    document.querySelectorAll("svg image, svg use").forEach((element) => {
      const reference = element.getAttribute("href")
        ?? element.getAttribute("xlink:href")
        ?? element.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      add(`${element.localName}[href]`, reference);
    });

    const srcsetReferences = (value) => {
      const references = [];
      let remaining = value.trim();
      while (remaining) {
        const match = remaining.match(
          /^(data:[^\s]+|[^,\s]+)(?:\s+(?:\d+(?:\.\d+)?w|\d*\.?\d+x))?\s*(?:,|$)/i,
        );
        if (!match) {
          references.push(remaining);
          break;
        }
        references.push(match[1]);
        remaining = remaining.slice(match[0].length).trim();
      }
      return references;
    };
    document.querySelectorAll("img[srcset], source[srcset]").forEach((element) => {
      const value = element.getAttribute("srcset") ?? "";
      srcsetReferences(value).forEach((reference) => add(`${element.localName}[srcset]`, reference));
    });

    const scanCssValue = (label, value) => {
      const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi;
      for (const match of value.matchAll(urlPattern)) {
        add(`${label}:url`, (match[1] ?? match[2] ?? match[3] ?? "").trim());
      }
      if (!/(?:-webkit-)?image-set\(/i.test(value)) return;
      const open = value.indexOf("(");
      const close = value.lastIndexOf(")");
      if (open < 0 || close <= open) return;
      const candidates = value.slice(open + 1, close).split(",");
      candidates.forEach((candidate) => {
        const match = candidate.trim().match(/^(?:"([^"]*)"|'([^']*)')(?:\s|$)/);
        if (match) add(`${label}:image-set`, match[1] ?? match[2] ?? "");
      });
    };
    const scanStyle = (style, label) => {
      for (const property of style) scanCssValue(`${label}:${property}`, style.getPropertyValue(property));
    };
    document.querySelectorAll("[style]").forEach((element) => {
      scanStyle(element.style, `${element.localName}[style]`);
    });
    const visitedRuleLists = new Set();
    const walkRules = (rules, label) => {
      if (visitedRuleLists.has(rules)) return;
      visitedRuleLists.add(rules);
      for (const rule of rules) {
        if (rule.type === CSSRule.IMPORT_RULE) {
          add(`${label}:@import`, rule.href);
          try {
            walkRules(rule.styleSheet.cssRules, label);
          } catch {
            // The import href is already reported when its child sheet cannot be inspected.
          }
        }
        if ("style" in rule && rule.style instanceof CSSStyleDeclaration) {
          scanStyle(rule.style, `${label}:rule`);
        }
        if ("cssRules" in rule) {
          try {
            walkRules(rule.cssRules, label);
          } catch {
            // The owning link/import is already reported by its real DOM/CSSOM reference.
          }
        }
      }
    };
    const styleSheets = [...document.styleSheets, ...document.adoptedStyleSheets];
    styleSheets.forEach((sheet, index) => {
      try {
        walkRules(sheet.cssRules, `stylesheet[${index}]`);
      } catch {
        // Cross-origin sheets are reported through link[href] or CSSImportRule.href.
      }
    });

    const portrait = document.querySelector(".portrait-frame");
    const embeddedPortrait = portrait instanceof Element
      && getComputedStyle(portrait).backgroundImage.includes("data:image/jpeg;base64,");
    return {
      externalResources: [...new Set(resources)],
      embeddedPortrait,
    };
  });
}

async function readContract(page) {
  return page.locator("[data-reveal]").evaluateAll((elements) => elements.map((element) => ({
    key: element.getAttribute("data-reveal-key"),
    direction: element.getAttribute("data-reveal-direction"),
    delay: element.getAttribute("data-reveal-delay"),
  })));
}

async function readRootTokens(page) {
  const raw = await page.locator("html").evaluate((root) => {
    const style = getComputedStyle(root);
    return {
      duration: style.getPropertyValue("--duration-dynamic"),
      distance: style.getPropertyValue("--distance-dynamic"),
      stagger: style.getPropertyValue("--stagger-dynamic"),
    };
  });
  return {
    duration: normalizedDuration(raw.duration),
    distance: normalizedPixels(raw.distance),
    stagger: normalizedDuration(raw.stagger),
  };
}

async function readPreRevealStates(page) {
  const rawStates = await page.locator("[data-reveal]").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    const split = (value) => {
      const items = [];
      let depth = 0;
      let start = 0;
      for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "(") depth += 1;
        else if (value[index] === ")") depth -= 1;
        else if (value[index] === "," && depth === 0) {
          items.push(value.slice(start, index).trim());
          start = index + 1;
        }
      }
      items.push(value.slice(start).trim());
      return items;
    };
    return {
      key: element.getAttribute("data-reveal-key"),
      direction: element.getAttribute("data-reveal-direction"),
      delay: element.getAttribute("data-reveal-delay"),
      revealed: element.getAttribute("data-revealed"),
      opacity: style.opacity,
      filter: style.filter,
      translate: style.translate,
      transitionProperties: split(style.transitionProperty),
      transitionDurations: split(style.transitionDuration),
      transitionDelays: split(style.transitionDelay),
      timingFunctions: split(style.transitionTimingFunction),
    };
  }));

  return rawStates.map((raw) => {
    const durations = expectedRevealProperties.map((_, index) => (
      strictDurationInMilliseconds(listValue(raw.transitionDurations, index))
    ));
    const delays = expectedRevealProperties.map((_, index) => (
      strictDurationInMilliseconds(listValue(raw.transitionDelays, index))
    ));
    const timingFunctions = expectedRevealProperties.map((_, index) => (
      listValue(raw.timingFunctions, index)
    ));
    return {
      key: raw.key,
      direction: raw.direction,
      delay: raw.delay,
      revealed: raw.revealed,
      opacity: strictOpacity(raw.opacity),
      filter: raw.filter,
      translate: strictTranslate(raw.translate) ?? { x: Number.NaN, y: Number.NaN },
      durationMs: durations[0],
      delayMs: delays[0],
      transitionProperties: raw.transitionProperties.slice(0, expectedRevealProperties.length),
      timingFunctions,
      allDurationsMs: durations,
      allDelaysMs: delays,
    };
  });
}

function publicPreRevealStates(states) {
  return states.map(({ allDurationsMs, allDelaysMs, ...state }) => state);
}

function validatePreRevealStates(states) {
  return states.length === expectedContract.length && states.every((state, index) => {
    const expected = expectedContract[index];
    const expectedDelay = Number(expected.delay);
    const expectedX = expected.direction === "left" ? -64 : 64;
    return state.key === expected.key
      && state.direction === expected.direction
      && state.delay === expected.delay
      && state.revealed === "false"
      && state.opacity === 0.08
      && state.filter === "blur(2px)"
      && state.translate.x === expectedX
      && state.translate.y === 0
      && JSON.stringify(state.transitionProperties) === JSON.stringify(expectedRevealProperties)
      && state.allDurationsMs.every((duration) => duration === 500)
      && state.allDelaysMs.every((delay) => delay === expectedDelay)
      && state.timingFunctions.every((timing) => timing === expectedTimingFunction);
  });
}

async function readFinalStates(page) {
  return page.locator("[data-reveal]").evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      key: element.getAttribute("data-reveal-key"),
      revealed: element.getAttribute("data-revealed"),
      opacity: Number(style.opacity),
      filter: style.filter,
      translate: style.translate,
    };
  }));
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const failures = {
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  externalRequests: [],
};

context.on("request", (request) => {
  const isMainDocument = request.isNavigationRequest()
    && request.resourceType() === "document"
    && request.frame() === request.frame().page().mainFrame();
  if (!isMainDocument && !isRuntimeEmbedded(request.url())) {
    failures.externalRequests.push(`${request.method()} ${request.url()}`);
  }
});
context.on("requestfailed", (request) => {
  failures.requestFailures.push(
    `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown failure"}`,
  );
});

try {
  const preRevealPage = await context.newPage();
  watchPage(preRevealPage, "pre-reveal", failures);
  await preRevealPage.emulateMedia({ reducedMotion: "no-preference" });
  await preRevealPage.addInitScript(() => {
    class FrozenIntersectionObserver {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: FrozenIntersectionObserver,
    });
  });
  await preRevealPage.goto(documentUrl, { waitUntil: "load" });

  const preTargets = preRevealPage.locator("[data-reveal]");
  if (await preTargets.count() !== expectedContract.length) throw new Error("Expected 18 reveal targets");
  const contract = await readContract(preRevealPage);
  if (JSON.stringify(contract) !== JSON.stringify(expectedContract)) {
    throw new Error(`Reveal contract mismatch: ${JSON.stringify(contract)}`);
  }

  const rootTokens = await readRootTokens(preRevealPage);
  if (JSON.stringify(rootTokens) !== JSON.stringify(expectedRootTokens)) {
    throw new Error(`Root motion token mismatch: ${JSON.stringify(rootTokens)}`);
  }

  const resources = await inspectRenderedResources(preRevealPage);
  if (resources.externalResources.length > 0) {
    throw new Error(
      `Standalone HTML contains external rendered resources:\n${resources.externalResources.join("\n")}`,
    );
  }
  if (!resources.embeddedPortrait) {
    throw new Error("Standalone HTML does not contain the embedded portrait");
  }

  await preRevealPage.waitForTimeout(preRevealSettleMs);
  const preRevealOverflow = await preRevealPage.evaluate(() => {
    const root = document.documentElement;
    return {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      overflow: root.scrollWidth !== root.clientWidth,
    };
  });
  if (preRevealOverflow.overflow) {
    throw new Error(`Standalone overflows during pre-reveal: ${JSON.stringify(preRevealOverflow)}`);
  }

  const rawPreRevealStates = await readPreRevealStates(preRevealPage);
  const preRevealStates = publicPreRevealStates(rawPreRevealStates);
  const motionEnabled = await preRevealPage.locator("html").evaluate((root) => (
    root.classList.contains("motion-enabled")
  ));
  if (!motionEnabled || !validatePreRevealStates(rawPreRevealStates)) {
    throw new Error(`Unrevealed motion state mismatch: ${JSON.stringify({ motionEnabled, states: preRevealStates })}`);
  }
  assertNoRuntimeFailures(failures);
  await preRevealPage.close();

  const normalPage = await context.newPage();
  watchPage(normalPage, "normal", failures);
  await normalPage.emulateMedia({ reducedMotion: "no-preference" });
  await normalPage.addInitScript(() => {
    const sampler = { running: true, frameId: 0, samples: [] };
    const sample = () => {
      const root = document.documentElement;
      if (root && root.clientWidth > 0) {
        sampler.samples.push({
          timestamp: performance.now(),
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
        });
      }
      if (sampler.running) sampler.frameId = requestAnimationFrame(sample);
    };
    sampler.frameId = requestAnimationFrame(sample);
    window.__standaloneOverflowSampler = sampler;
  });
  await normalPage.goto(documentUrl, { waitUntil: "load" });
  const targets = normalPage.locator("[data-reveal]");
  if (await targets.count() !== expectedContract.length) throw new Error("Expected 18 reveal targets");

  for (let index = 0; index < expectedContract.length; index += 1) {
    const key = expectedContract[index].key;
    await targets.nth(index).evaluate((element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
    });
    await normalPage.waitForFunction(
      (revealKey) => document.querySelector(`[data-reveal-key="${revealKey}"]`)?.getAttribute("data-revealed") === "true",
      key,
    );
  }

  const maxDurationDelayMs = Math.max(
    ...preRevealStates.map((state) => state.durationMs + state.delayMs),
  );
  const waitedMs = maxDurationDelayMs + transitionFrameMarginMs;
  await normalPage.waitForTimeout(waitedMs);
  const overflowSamples = await normalPage.evaluate(() => {
    const sampler = window.__standaloneOverflowSampler;
    sampler.running = false;
    cancelAnimationFrame(sampler.frameId);
    const root = document.documentElement;
    sampler.samples.push({
      timestamp: performance.now(),
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    });
    return sampler.samples;
  });
  const overflowedFrames = overflowSamples.filter((sample) => (
    sample.scrollWidth !== sample.clientWidth
  ));
  const overflow = {
    sampleCount: overflowSamples.length,
    overflowedFrames,
    maxDurationDelayMs,
    waitedMs,
    maxScrollWidth: Math.max(...overflowSamples.map((sample) => sample.scrollWidth)),
    minClientWidth: Math.min(...overflowSamples.map((sample) => sample.clientWidth)),
  };
  if (overflowedFrames.length > 0) {
    throw new Error(`Standalone overflows during reveal transitions: ${JSON.stringify(overflow)}`);
  }

  const finalStates = await readFinalStates(normalPage);
  const finalStatesValid = finalStates.length === expectedContract.length
    && finalStates.every((state, index) => (
      state.key === expectedContract[index].key
      && state.revealed === "true"
      && state.opacity === 1
      && state.filter === "none"
      && state.translate === "none"
    ));
  if (!finalStatesValid) {
    throw new Error(`Final reveal state mismatch: ${JSON.stringify(finalStates)}`);
  }

  const result = await normalPage.evaluate(() => ({
    headingVisible: Boolean(document.querySelector("h1")?.getBoundingClientRect().height),
    revealed: document.querySelectorAll('[data-revealed="true"]').length,
  }));
  if (!result.headingVisible || result.revealed !== expectedContract.length) {
    throw new Error(`Invalid standalone state: ${JSON.stringify(result)}`);
  }
  assertNoRuntimeFailures(failures);

  console.log(JSON.stringify({
    filePath,
    ...result,
    contract,
    rootTokens,
    preReveal: {
      motionEnabled,
      states: preRevealStates,
      overflow: preRevealOverflow,
    },
    final: { states: finalStates },
    overflow,
    failures,
  }));
} finally {
  await browser.close();
}
