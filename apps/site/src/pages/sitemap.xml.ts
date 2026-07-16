import type { APIRoute } from "astro";

import { createSearchBuildState } from "../search/build.js";
import { renderSitemap } from "../search/feeds.js";

export const prerender = true;

export const GET: APIRoute = () => new Response(
  renderSitemap(createSearchBuildState().index),
  { headers: { "content-type": "application/xml; charset=utf-8" } },
);
