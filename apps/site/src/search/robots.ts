import { absolutePublicUrl } from "./origin.js";
import { PRIVATE_SURFACE_REGISTRY } from "./surface-registry.js";

export const ROBOTS_PUBLIC_AGENTS = [
  "Googlebot",
  "Yeti",
  "OAI-SearchBot",
  "Google-Extended",
  "ChatGPT-User",
  "*",
] as const;

export const ROBOTS_SENSITIVE_PATHS = Object.freeze(
  PRIVATE_SURFACE_REGISTRY.flatMap(({ robotsPaths }) => robotsPaths),
);

export function renderRobots(origin: string): string {
  const publicGroups = ROBOTS_PUBLIC_AGENTS.map((agent) => [
    `User-agent: ${agent}`,
    "Allow: /",
    ...ROBOTS_SENSITIVE_PATHS.map((path) => `Disallow: ${path}`),
  ].join("\n"));
  return [
    `Sitemap: ${absolutePublicUrl(origin, "/sitemap.xml")}`,
    ...publicGroups,
    ["User-agent: GPTBot", "Disallow: /"].join("\n"),
    "",
  ].join("\n\n");
}
