import type { APIRoute, GetStaticPaths } from "astro";

import { parseSearchVerificationConfig } from "../search/verification.js";

interface Props {
  content: string;
}

export const prerender = true;

export const getStaticPaths: GetStaticPaths = () => {
  const verification = parseSearchVerificationConfig(process.env);
  if (!verification.naverFile) return [];
  return [{
    params: { verification: verification.naverFile.filename },
    props: { content: verification.naverFile.content } satisfies Props,
  }];
};

export const GET: APIRoute<Props> = ({ props }) => new Response(`${props.content}\n`, {
  headers: {
    "content-type": "text/html; charset=utf-8",
    "x-robots-tag": "noindex",
  },
});
