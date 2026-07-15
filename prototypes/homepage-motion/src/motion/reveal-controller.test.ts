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

  it("shows every target without constructing an observer for reduced motion", () => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const createObserver = vi.fn();
    const controller = createRevealController({ mediaQuery: createMediaQuery(true), createObserver });

    controller.start();

    expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
    expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
    expect(createObserver).not.toHaveBeenCalled();
  });

  it("shows every target when IntersectionObserver is unsupported", () => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const controller = createRevealController({ mediaQuery: createMediaQuery(false), createObserver: null });

    controller.start();

    expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
    expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
  });

  it("recovers atomically when observer construction throws", () => {
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => { throw new Error("forced initialization failure"); },
    });

    controller.start();

    expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
    expect(targets.every((target) => target.dataset.revealed === "true")).toBe(true);
  });

  it("reveals an interactive ancestor when focus enters", () => {
    document.body.innerHTML = `<section data-reveal data-revealed="false"><a href="#consultation">상담</a></section>`;
    const target = document.querySelector<HTMLElement>("[data-reveal]")!;
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
    });
    controller.start();

    target.querySelector("a")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    expect(target.dataset.revealed).toBe("true");
  });

  it("disconnects and reveals all when reduced motion turns on", () => {
    let changeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const disconnect = vi.fn();
    const mediaQuery = {
      ...createMediaQuery(false),
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
        changeListener = listener as (event: MediaQueryListEvent) => void;
      },
    } as unknown as MediaQueryList;
    const controller = createRevealController({
      mediaQuery,
      createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect }),
    });
    controller.start();

    changeListener?.({ matches: true } as MediaQueryListEvent);

    expect(document.documentElement.classList.contains("motion-enabled")).toBe(false);
    expect(disconnect).toHaveBeenCalled();
  });

  it("reveals a direct hash destination", () => {
    document.body.innerHTML = `<section id="principles"><div data-reveal data-revealed="false"></div></section>`;
    window.history.replaceState({}, "", "#principles");
    const target = document.querySelector<HTMLElement>("[data-reveal]")!;
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
    });
    controller.start();

    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(target.dataset.revealed).toBe("true");
    window.history.replaceState({}, "", "/");
  });

  it("reveals targets that a fast scroll has already passed", () => {
    const target = document.querySelector<HTMLElement>("[data-reveal]")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: -200,
      top: -200,
      right: 300,
      bottom: -20,
      left: 0,
      width: 300,
      height: 180,
      toJSON: () => ({}),
    });
    const controller = createRevealController({
      mediaQuery: createMediaQuery(false),
      createObserver: () => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }),
    });
    controller.start();

    window.dispatchEvent(new Event("pageshow"));

    expect(target.dataset.revealed).toBe("true");
  });
});
