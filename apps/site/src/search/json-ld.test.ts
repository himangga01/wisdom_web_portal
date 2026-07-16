import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadPublishedContent } from "../content/published-articles.js";
import { safeJsonLdStringify } from "./json-ld.js";
import { buildSearchIndex } from "./search-index.js";

const origin = "https://www.jihye-office.kr";
const fixtureDirectory = fileURLToPath(
  new URL("../content/__fixtures__/published-content", import.meta.url),
);
const allowedTypes = new Set([
  "ProfessionalService",
  "Person",
  "Service",
  "Article",
  "BreadcrumbList",
  "ListItem",
]);

function schemaTypes(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaTypes);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record["@type"] === "string" ? [record["@type"]] : []),
    ...Object.values(record).flatMap(schemaTypes),
  ];
}

describe("visible-content-derived JSON-LD", () => {
  it("uses only approved schema types and matches visible service claims", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));
    const service = index.byRoute.get("/en/services/procurement")!;
    const graph = service.jsonLd["@graph"];

    expect(schemaTypes(graph).every((type) => allowedTypes.has(type))).toBe(true);
    expect(schemaTypes(graph)).toContain("ProfessionalService");
    expect(schemaTypes(graph)).toContain("Person");
    expect(schemaTypes(graph)).toContain("Service");
    expect(schemaTypes(graph)).toContain("BreadcrumbList");
    expect(JSON.stringify(graph)).not.toMatch(/"@type":"(?:Attorney|Review|AggregateRating)"/);

    const serviceNode = graph.find((node) => node["@type"] === "Service");
    expect(serviceNode).toMatchObject({
      name: service.h1,
      description: service.description,
      url: service.canonicalUrl,
      inLanguage: "en",
    });
    const office = graph.find((node) => node["@type"] === "ProfessionalService");
    const person = graph.find((node) => node["@type"] === "Person");
    const breadcrumb = graph.find((node) => node["@type"] === "BreadcrumbList");
    expect(office).toMatchObject({
      "@id": `${origin}/#professional-service`,
      url: `${origin}/en`,
    });
    expect(person).toMatchObject({
      "@id": `${origin}/#representative`,
      jobTitle: "Representative Administrative Attorney",
    });
    expect(person).not.toHaveProperty("roleName");
    expect(breadcrumb?.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/en` },
      { "@type": "ListItem", position: 2, name: "Services", item: `${origin}/en/services` },
      { "@type": "ListItem", position: 3, name: service.h1, item: service.canonicalUrl },
    ]);
    expect(serviceNode).not.toHaveProperty("reviewedBy");
    expect(serviceNode).not.toHaveProperty("dateModified");
    expect(serviceNode).not.toHaveProperty("citation");
  });

  it("uses approved article identity, dates, reviewer, and sources", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));
    const document = index.byRoute.get("/en/insights/procurement-entry-guide")!;
    const articleNode = document.jsonLd["@graph"].find((node) => node["@type"] === "Article");

    expect(articleNode).toMatchObject({
      headline: document.h1,
      description: document.description,
      url: document.canonicalUrl,
      mainEntityOfPage: document.canonicalUrl,
      inLanguage: "en",
      datePublished: "2026-07-03T00:00:00.000Z",
      dateModified: "2026-07-03T00:00:00.000Z",
      reviewedBy: {
        "@id": `${origin}/#representative`,
        name: "Jihye Kang",
        jobTitle: "Administrative Attorney",
      },
      citation: ["https://example.test/procurement"],
    });
    expect(articleNode).not.toHaveProperty("author");
    const breadcrumb = document.jsonLd["@graph"]
      .find((node) => node["@type"] === "BreadcrumbList");
    expect(breadcrumb?.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: `${origin}/en` },
      { "@type": "ListItem", position: 2, name: "Insights", item: `${origin}/en/insights` },
      { "@type": "ListItem", position: 3, name: document.h1, item: document.canonicalUrl },
    ]);
  });

  it("keeps global IDs and locale-home URLs valid on the home page", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));
    for (const route of ["/", "/en", "/zh-hans", "/zh-hant"] as const) {
      const document = index.byRoute.get(route)!;
      const graph = document.jsonLd["@graph"];
      const office = graph.find((node) => node["@type"] === "ProfessionalService")!;
      expect(office["@id"]).toBe(`${origin}/#professional-service`);
      expect(office.url).toBe(document.canonicalUrl);
      expect(() => new URL(String(office["@id"]))).not.toThrow();
      expect(() => new URL(String(office.url))).not.toThrow();
    }
  });

  it("types every breadcrumb entry as an ordered ListItem", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));

    for (const document of index.indexable) {
      const breadcrumb = document.jsonLd["@graph"]
        .find((node) => node["@type"] === "BreadcrumbList");
      const items = breadcrumb?.itemListElement as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      expect(items.map((item) => item["@type"])).toEqual(items.map(() => "ListItem"));
      expect(items.map((item) => item.position)).toEqual(
        items.map((_, index) => index + 1),
      );
    }
  });

  it("emits only parseable absolute schema URLs and IDs", () => {
    const index = buildSearchIndex(origin, loadPublishedContent(fixtureDirectory));
    const urlKeys = new Set(["@id", "url", "item", "mainEntityOfPage"]);
    const visit = (value: unknown, key?: string): void => {
      if (Array.isArray(value)) {
        for (const child of value) visit(child, key);
        return;
      }
      if (value && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
        return;
      }
      if (typeof value === "string" && (urlKeys.has(key ?? "") || key === "citation")) {
        expect(() => new URL(value), `${key}: ${value}`).not.toThrow();
        expect(new URL(value).protocol).toBe("https:");
      }
    };
    for (const document of index.indexable) visit(document.jsonLd);
  });

  it("escapes JSON script terminators without changing parsed data", () => {
    const payload = { "@context": "https://schema.org", value: "</script><script>alert(1)</script>" };
    const serialized = safeJsonLdStringify(payload);

    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(serialized)).toEqual(payload);
  });
});
