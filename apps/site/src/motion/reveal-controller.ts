const TARGET_SELECTOR = "[data-reveal]";

export function initializeRevealMotion(
  documentRef: Document = document,
  windowRef: Window = window,
): void {
  const root = documentRef.documentElement;
  const targets = Array.from(documentRef.querySelectorAll<HTMLElement>(TARGET_SELECTOR));
  if (targets.length === 0 || root.dataset.revealController === "ready") return;
  root.dataset.revealController = "ready";

  const mediaQuery = windowRef.matchMedia("(prefers-reduced-motion: reduce)");
  let observer: IntersectionObserver | undefined;
  let eventsAttached = false;

  const reveal = (target: HTMLElement): void => {
    if (target.dataset.revealed === "true") return;
    target.dataset.revealed = "true";
    observer?.unobserve(target);
  };

  const revealAll = (): void => {
    root.classList.remove("motion-enabled");
    targets.forEach(reveal);
    observer?.disconnect();
  };

  const revealPassedTargets = (): void => {
    for (const target of targets) {
      if (target.getBoundingClientRect().bottom < 0) reveal(target);
    }
  };

  const revealHashTarget = (): void => {
    let id = "";
    try {
      id = decodeURIComponent(windowRef.location.hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;
    const anchor = documentRef.getElementById(id);
    if (!anchor) return;
    const directTarget = anchor.closest<HTMLElement>(TARGET_SELECTOR);
    if (directTarget) reveal(directTarget);
    anchor.querySelectorAll<HTMLElement>(TARGET_SELECTOR).forEach(reveal);
  };

  const onFocus = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>(TARGET_SELECTOR);
    if (target) reveal(target);
  };

  const onPageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      revealAll();
      detachEvents();
      return;
    }
    revealPassedTargets();
    revealHashTarget();
  };

  const onReducedMotion = (event: MediaQueryListEvent): void => {
    if (!event.matches) return;
    revealAll();
    detachEvents();
  };

  const attachEvents = (): void => {
    if (eventsAttached) return;
    documentRef.addEventListener("focusin", onFocus, true);
    windowRef.addEventListener("hashchange", revealHashTarget);
    windowRef.addEventListener("pageshow", onPageShow);
    windowRef.addEventListener("resize", revealPassedTargets, { passive: true });
    mediaQuery.addEventListener("change", onReducedMotion);
    eventsAttached = true;
  };

  function detachEvents(): void {
    if (!eventsAttached) return;
    documentRef.removeEventListener("focusin", onFocus, true);
    windowRef.removeEventListener("hashchange", revealHashTarget);
    windowRef.removeEventListener("pageshow", onPageShow);
    windowRef.removeEventListener("resize", revealPassedTargets);
    mediaQuery.removeEventListener("change", onReducedMotion);
    eventsAttached = false;
  }

  const Observer = (windowRef as Window & {
    IntersectionObserver?: typeof IntersectionObserver;
  }).IntersectionObserver;

  if (mediaQuery.matches || typeof Observer !== "function") {
    revealAll();
    return;
  }

  try {
    const createdObserver = new Observer(
      (entries: IntersectionObserverEntry[]) => {
        for (const entry of entries) {
          if (entry.isIntersecting) reveal(entry.target as HTMLElement);
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.01 },
    );
    observer = createdObserver;

    for (const target of targets) {
      target.dataset.revealed = "false";
      if (target.getBoundingClientRect().bottom < 0) reveal(target);
      else createdObserver.observe(target);
    }
    revealHashTarget();
    attachEvents();
    root.classList.add("motion-enabled", "motion-preparing");
    root.getBoundingClientRect();
    root.classList.remove("motion-preparing");
  } catch {
    detachEvents();
    revealAll();
  }
}
