import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRevealController, type ObserverLike } from "./reveal-controller";

function createMediaQuery(matches = false): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

describe("RevealController core", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    document.body.innerHTML = `
      <section data-reveal data-revealed="false"></section>
      <section data-reveal data-revealed="false"></section>
    `;
  });

  it("uses the approved observer boundary and enables motion last", () => {
    const observed: Element[] = [];
    let receivedOptions: IntersectionObserverInit | undefined;
    const observer: ObserverLike = {
      observe: (target) => observed.push(target),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    };
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: (_callback, options) => {
        receivedOptions = options;
        expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
        return observer;
      },
    });

    controller.start();

    expect(receivedOptions).toEqual({ rootMargin: "0px 0px -12% 0px", threshold: 0.01 });
    expect(observed).toHaveLength(2);
    expect(document.documentElement.classList.contains("motion-enabled")).toBe(true);
  });

  it("changes a target to revealed only once", () => {
    const target = document.querySelector<HTMLElement>("[data-reveal]")!;
    const unobserve = vi.fn();
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => ({ observe: vi.fn(), unobserve, disconnect: vi.fn() }),
    });
    controller.start();

    expect(controller.reveal(target)).toBe(true);
    expect(controller.reveal(target)).toBe(false);
    expect(target.dataset.revealed).toBe("true");
    expect(unobserve).toHaveBeenCalledTimes(1);
  });
});
