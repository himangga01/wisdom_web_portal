import { describe, expect, it } from "vitest";

import { ROBOTS_PUBLIC_AGENTS, ROBOTS_SENSITIVE_PATHS, renderRobots } from "./robots.js";
import { PRIVATE_SURFACE_REGISTRY } from "./surface-registry.js";

function groups(document: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of document.split("\n")) {
    if (line.startsWith("User-agent: ")) {
      current = line.slice("User-agent: ".length);
      result.set(current, []);
    } else if (current && line) {
      result.get(current)?.push(line);
    }
  }
  return result;
}

describe("robots policy", () => {
  it("repeats private disallows for every explicitly allowed public crawler", () => {
    const document = renderRobots("https://www.jihye-office.kr");
    const parsed = groups(document);

    for (const agent of ROBOTS_PUBLIC_AGENTS) {
      expect(parsed.get(agent), agent).toContain("Allow: /");
      for (const path of ROBOTS_SENSITIVE_PATHS) {
        expect(parsed.get(agent), `${agent} ${path}`).toContain(`Disallow: ${path}`);
      }
    }
    expect(parsed.get("GPTBot")).toEqual(["Disallow: /"]);
    expect(document).toContain("Sitemap: https://www.jihye-office.kr/sitemap.xml");
    expect(document.toLowerCase()).not.toContain("nosourceinfo");
  });

  it("derives exact and localized sensitive boundaries from the typed private registry", () => {
    expect(ROBOTS_SENSITIVE_PATHS).toEqual(
      PRIVATE_SURFACE_REGISTRY.flatMap(({ robotsPaths }) => robotsPaths),
    );
    expect(ROBOTS_SENSITIVE_PATHS).toEqual(expect.arrayContaining([
      "/admin",
      "/admin/",
      "/health/ready",
      "/marketing/withdraw",
      "/en/marketing/withdraw",
      "/zh-hans/marketing/withdraw",
      "/zh-hant/marketing/withdraw",
    ]));
  });

  it("treats OAI-SearchBot, GPTBot, and ChatGPT-User as separate controls", () => {
    const parsed = groups(renderRobots("https://www.jihye-office.kr"));

    expect(parsed.has("OAI-SearchBot")).toBe(true);
    expect(parsed.has("GPTBot")).toBe(true);
    expect(parsed.has("ChatGPT-User")).toBe(true);
    expect(parsed.get("OAI-SearchBot")).not.toEqual(parsed.get("GPTBot"));
  });
});
