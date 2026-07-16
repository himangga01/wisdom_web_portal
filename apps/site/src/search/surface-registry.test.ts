import { describe, expect, it } from "vitest";

import { CONTENT_ROUTES } from "../lib/routes.js";
import {
  BASE_SURFACE_REGISTRY,
  PRIVATE_SURFACE_REGISTRY,
  getBaseSurface,
} from "./surface-registry.js";

describe("typed public surface registry", () => {
  it("classifies every base route exactly once without pathname inference", () => {
    expect(BASE_SURFACE_REGISTRY.map(({ route }) => route)).toEqual([
      ...CONTENT_ROUTES,
      "/404",
    ]);
    expect(new Set(BASE_SURFACE_REGISTRY.map(({ route }) => route)).size)
      .toBe(BASE_SURFACE_REGISTRY.length);

    expect(getBaseSurface("/services/procurement").policy).toBe("indexable");
    expect(getBaseSurface("/consultation").policy).toBe("noindex");
    expect(getBaseSurface("/privacy").policy).toBe("noindex");
    expect(getBaseSurface("/marketing/withdraw").policy).toBe("noindex");
    expect(getBaseSurface("/404").policy).toBe("noindex");
  });

  it("records private dynamic surfaces independently from static public routes", () => {
    expect(PRIVATE_SURFACE_REGISTRY.map(({ id }) => id)).toEqual([
      "admin",
      "api",
      "internal",
      "health",
      "withdrawal-token",
      "verification-token",
    ]);
    expect(PRIVATE_SURFACE_REGISTRY.flatMap(({ robotsPaths }) => robotsPaths)).toEqual([
      "/admin",
      "/admin/",
      "/api",
      "/api/",
      "/internal",
      "/internal/",
      "/health",
      "/health/ready",
      "/marketing/withdraw/",
      "/en/marketing/withdraw/",
      "/zh-hans/marketing/withdraw/",
      "/zh-hant/marketing/withdraw/",
      "/verification",
      "/verification/",
    ]);
    expect(BASE_SURFACE_REGISTRY.map(({ policy }) => policy)).not.toContain("private");
  });

  it("assigns stable revision time to every indexable static surface", () => {
    for (const surface of BASE_SURFACE_REGISTRY.filter(({ policy }) => policy === "indexable")) {
      expect("lastModified" in surface ? surface.lastModified : undefined)
        .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});
