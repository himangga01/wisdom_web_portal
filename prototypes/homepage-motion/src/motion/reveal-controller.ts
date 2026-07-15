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
  const createObserver = hasFactoryOverride
    ? (overrides.createObserver ?? null)
    : typeof windowRef.IntersectionObserver === "function"
      ? (callback: IntersectionObserverCallback, options: IntersectionObserverInit) =>
          new windowRef.IntersectionObserver(callback, options)
      : null;
  let observer: ObserverLike | null = null;
  let started = false;

  const reveal = (target: HTMLElement): boolean => {
    if (target.dataset.revealed === "true") return false;
    target.dataset.revealed = "true";
    observer?.unobserve(target);
    return true;
  };

  const revealAll = (): void => {
    root.classList.remove("motion-enabled");
    targets.forEach(reveal);
    observer?.disconnect();
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
      targets.forEach((target) => observer?.observe(target));
      root.classList.add("motion-enabled");
    } catch {
      revealAll();
    }
  };

  const destroy = (): void => {
    revealAll();
    started = false;
  };

  return { start, reveal, revealAll, destroy };
}
