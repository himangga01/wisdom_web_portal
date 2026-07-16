import type { PublicRoute } from "../lib/routes.js";

export type SurfacePolicy = "indexable" | "noindex" | "private";
export type BaseSurfaceKind = "home" | "general" | "service" | "listing" | "utility" | "error";

export interface BaseSurface {
  route: PublicRoute;
  policy: Exclude<SurfacePolicy, "private">;
  kind: BaseSurfaceKind;
  lastModified?: string;
}

export interface PrivateSurface {
  id: "admin" | "api" | "internal" | "health" | "withdrawal-token" | "verification-token";
  robotsPaths: readonly string[];
}

const BASE_REVISION_TIME = "2026-07-16T00:00:00.000Z";

export const BASE_SURFACE_REGISTRY = [
  { route: "/", policy: "indexable", kind: "home", lastModified: BASE_REVISION_TIME },
  { route: "/about", policy: "indexable", kind: "general", lastModified: BASE_REVISION_TIME },
  { route: "/services", policy: "indexable", kind: "listing", lastModified: BASE_REVISION_TIME },
  { route: "/services/procurement", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/services/credibility", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/services/safety-esg", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/services/business-certification", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/services/licensing-entity", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/services/immigration-visa", policy: "indexable", kind: "service", lastModified: BASE_REVISION_TIME },
  { route: "/process", policy: "indexable", kind: "general", lastModified: BASE_REVISION_TIME },
  { route: "/insights", policy: "indexable", kind: "listing", lastModified: BASE_REVISION_TIME },
  { route: "/consultation", policy: "noindex", kind: "utility" },
  { route: "/location", policy: "indexable", kind: "general", lastModified: BASE_REVISION_TIME },
  { route: "/privacy", policy: "noindex", kind: "utility" },
  { route: "/marketing/withdraw", policy: "noindex", kind: "utility" },
  { route: "/404", policy: "noindex", kind: "error" },
] as const satisfies readonly BaseSurface[];

export const PRIVATE_SURFACE_REGISTRY = [
  { id: "admin", robotsPaths: ["/admin", "/admin/"] },
  { id: "api", robotsPaths: ["/api", "/api/"] },
  { id: "internal", robotsPaths: ["/internal", "/internal/"] },
  { id: "health", robotsPaths: ["/health", "/health/ready"] },
  {
    id: "withdrawal-token",
    robotsPaths: [
      "/marketing/withdraw",
      "/marketing/withdraw/",
      "/en/marketing/withdraw",
      "/en/marketing/withdraw/",
      "/zh-hans/marketing/withdraw",
      "/zh-hans/marketing/withdraw/",
      "/zh-hant/marketing/withdraw",
      "/zh-hant/marketing/withdraw/",
    ],
  },
  { id: "verification-token", robotsPaths: ["/verification", "/verification/"] },
] as const satisfies readonly PrivateSurface[];

const baseByRoute = new Map<PublicRoute, BaseSurface>(
  BASE_SURFACE_REGISTRY.map((surface) => [surface.route, surface]),
);

export function getBaseSurface(route: PublicRoute): BaseSurface {
  const surface = baseByRoute.get(route);
  if (!surface) throw new Error("PUBLIC_SURFACE_UNREGISTERED");
  return surface;
}
