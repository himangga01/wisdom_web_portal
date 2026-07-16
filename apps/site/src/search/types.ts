import type { Locale, PublishedArticleDocument } from "@wisdom/shared";

import type { ServicePublication } from "./quality-gate.js";
import type { SurfacePolicy } from "./surface-registry.js";

export interface SearchAlternate {
  locale: Locale;
  url: string;
}

export type SearchDocumentKind = "base" | "service" | "article";

export interface JsonLdDocument {
  "@context": "https://schema.org";
  "@graph": Array<Record<string, unknown>>;
}

export interface SearchDocument {
  kind: SearchDocumentKind;
  policy: Exclude<SurfacePolicy, "private">;
  locale: Locale;
  route: string;
  canonicalUrl: string;
  title: string;
  description: string;
  h1: string;
  lastModified?: string;
  alternates: readonly SearchAlternate[];
  xDefaultUrl?: string;
  jsonLd: JsonLdDocument;
  service?: ServicePublication;
  article?: PublishedArticleDocument;
}

export interface SearchIndex {
  origin: string;
  documents: readonly SearchDocument[];
  indexable: readonly SearchDocument[];
  byRoute: ReadonlyMap<string, SearchDocument>;
  byCanonical: ReadonlyMap<string, SearchDocument>;
  indexNowUrls: readonly string[];
  releaseSetSha256: string;
}
