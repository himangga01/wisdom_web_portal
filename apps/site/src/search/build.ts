import { loadBuildPublishedContent, type PublishedContent } from "../content/published-articles.js";
import { parsePublicOrigin } from "./origin.js";
import { buildSearchIndex } from "./search-index.js";
import type { SearchIndex } from "./types.js";
import {
  parseSearchVerificationConfig,
  type SearchVerificationConfig,
  type SearchVerificationEnvironment,
} from "./verification.js";

export type SearchBuildEnvironment = SearchVerificationEnvironment & Record<string, string | undefined>;

export interface SearchBuildState {
  content: PublishedContent;
  index: SearchIndex;
  verification: SearchVerificationConfig;
}

export function createSearchBuildState(
  environment: SearchBuildEnvironment = process.env,
): SearchBuildState {
  const origin = parsePublicOrigin(environment.PUBLIC_ORIGIN, { production: true });
  const content = loadBuildPublishedContent(environment);
  return {
    content,
    index: buildSearchIndex(origin, content),
    verification: parseSearchVerificationConfig(environment),
  };
}
