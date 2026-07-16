import type { APIRoute } from "astro";

import { createSearchBuildState } from "../search/build.js";
import { renderRobots } from "../search/robots.js";

export const prerender = true;

export const GET: APIRoute = () => {
  const { index } = createSearchBuildState();
  return new Response(renderRobots(index.origin), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
