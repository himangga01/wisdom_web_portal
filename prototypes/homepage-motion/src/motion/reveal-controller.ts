export interface ObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}

export type ObserverFactory = (
  callback: IntersectionObserverCallback,
  options: IntersectionObserverInit,
) => ObserverLike;

export interface RevealEnvironment {
  documentRef: Document;
  windowRef: Window;
  root: HTMLElement;
  targets: HTMLElement[];
  mediaQuery: MediaQueryList;
  createObserver: ObserverFactory | null;
}

export interface RevealController {
  start(): void;
  reveal(target: HTMLElement): boolean;
  revealAll(): void;
  destroy(): void;
}

export function createRevealController(
  overrides: Partial<RevealEnvironment> = {},
): RevealController {
  const documentRef = overrides.documentRef ?? document;
  const windowRef = overrides.windowRef ?? window;
  const root = overrides.root ?? documentRef.documentElement;
  const targets = overrides.targets ?? Array.from(documentRef.querySelectorAll<HTMLElement>("[data-reveal]"));
  const mediaQuery = overrides.mediaQuery ?? windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  const hasFactoryOverride = Object.prototype.hasOwnProperty.call(overrides, "createObserver");
  const Observer = (windowRef as Window & {
    IntersectionObserver?: typeof IntersectionObserver;
  }).IntersectionObserver;
  const createObserver = hasFactoryOverride
    ? (overrides.createObserver ?? null)
    : typeof Observer === "function"
      ? (callback: IntersectionObserverCallback, options: IntersectionObserverInit) =>
          new Observer(callback, options)
      : null;
  let observer: ObserverLike | null = null;
  let started = false;
  let eventsAttached = false;

  const reveal = (target: HTMLElement): boolean => {
    if (target.dataset.revealed === "true") return false;
    target.dataset.revealed = "true";
    observer?.unobserve(target);
    return true;
  };

  const revealPassedTargets = (): void => {
    targets.forEach((target) => {
      if (target.dataset.revealed !== "true" && target.getBoundingClientRect().bottom < 0) {
        reveal(target);
      }
    });
  };

  const revealHashTarget = (): void => {
    const id = decodeURIComponent(windowRef.location.hash.slice(1));
    if (!id) return;
    const anchor = documentRef.getElementById(id);
    if (!anchor) return;
    const direct = anchor.closest<HTMLElement>("[data-reveal]");
    const descendants = Array.from(anchor.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (direct) reveal(direct);
    descendants.forEach(reveal);
  };

  const onFocusIn = (event: Event): void => {
    const element = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-reveal]")
      : null;
    if (element) reveal(element);
  };

  const onViewportState = (): void => {
    revealPassedTargets();
    revealHashTarget();
  };

  const detachEvents = (): void => {
    if (!eventsAttached) return;
    documentRef.removeEventListener("focusin", onFocusIn, true);
    windowRef.removeEventListener("hashchange", revealHashTarget);
    windowRef.removeEventListener("pageshow", onViewportState);
    windowRef.removeEventListener("resize", onViewportState);
    mediaQuery.removeEventListener("change", onMotionPreference);
    eventsAttached = false;
  };

  const revealAll = (): void => {
    root.classList.remove("motion-enabled");
    targets.forEach(reveal);
    observer?.disconnect();
  };

  const onMotionPreference = (event: MediaQueryListEvent): void => {
    if (!event.matches) return;
    detachEvents();
    revealAll();
  };

  const attachEvents = (): void => {
    if (eventsAttached) return;
    documentRef.addEventListener("focusin", onFocusIn, true);
    windowRef.addEventListener("hashchange", revealHashTarget);
    windowRef.addEventListener("pageshow", onViewportState);
    windowRef.addEventListener("resize", onViewportState, { passive: true });
    mediaQuery.addEventListener("change", onMotionPreference);
    eventsAttached = true;
  };

  const prepareMediaTarget = (target: HTMLElement): void => {
    if (!target.classList.contains("reveal-media")) return;
    target.style.willChange = "opacity, transform";
    let cleared = false;
    const clear = (): void => {
      if (cleared) return;
      cleared = true;
      target.style.removeProperty("will-change");
    };
    target.addEventListener("transitionend", clear, { once: true });
    windowRef.setTimeout(clear, 1000);
  };

  const start = (): void => {
    if (started) return;
    started = true;
    if (mediaQuery.matches || createObserver === null) {
      revealAll();
      return;
    }
    try {
      observer = createObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) reveal(entry.target as HTMLElement);
        });
      }, { rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
      targets.forEach((target) => {
        prepareMediaTarget(target);
        if (target.getBoundingClientRect().bottom < 0) reveal(target);
        else observer?.observe(target);
      });
      revealHashTarget();
      attachEvents();
      root.classList.add("motion-enabled");
    } catch {
      detachEvents();
      revealAll();
    }
  };

  const destroy = (): void => {
    detachEvents();
    revealAll();
    started = false;
  };

  return { start, reveal, revealAll, destroy };
}
