import type { APIRoute } from "astro";

import { createSearchBuildState } from "../search/build.js";
import { renderRss } from "../search/feeds.js";

export const prerender = true;

export const GET: APIRoute = () => new Response(
  renderRss(createSearchBuildState().index),
  { headers: { "content-type": "application/rss+xml; charset=utf-8" } },
);
