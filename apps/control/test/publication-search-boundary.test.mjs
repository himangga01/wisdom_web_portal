import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { createSearchBuildState } from "../../site/src/search/build.js";
import { runPublicationBuild } from "../src/articles/publication-build.js";

const PUBLIC_ORIGIN = "https://www.jihye-office.kr";
const NAVER_META_TOKEN = "unit_test_naver_meta_token_1234567890";
const NAVER_FILE = "naverunit_test_file_token_1234567890.html";
const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
let root;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "wisdom-publication-boundary-"));
  mkdirSync(path.join(root, "home"));
});

afterEach(() => rmSync(root, { force: true, recursive: true }));

it("feeds the isolated child environment to Site's real production search-build parser", async () => {
  let observed;
  await runPublicationBuild({
    siteSourceRoot: workspaceRoot,
    snapshotDirectory: path.join(workspaceRoot, "apps/site/published-content"),
    outputDirectory: path.join(root, "dist"),
    buildHome: path.join(root, "home"),
    npmBinary: path.join(root, "bin", "npm"),
    nodeBinary: path.join(root, "bin", "node"),
    timeoutMs: 120_000,
    publicOrigin: PUBLIC_ORIGIN,
    naverSiteVerificationMeta: NAVER_META_TOKEN,
  }, {
    runProcess(request) {
      observed = request;
      return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    },
  });

  const search = createSearchBuildState(observed.env);
  expect(search.index.origin).toBe(PUBLIC_ORIGIN);
  expect(search.verification).toEqual({ naverMetaToken: NAVER_META_TOKEN });
});

it("feeds Naver file verification through the isolated child environment to Site", async () => {
  let observed;
  await runPublicationBuild({
    siteSourceRoot: workspaceRoot,
    snapshotDirectory: path.join(workspaceRoot, "apps/site/published-content"),
    outputDirectory: path.join(root, "dist"),
    buildHome: path.join(root, "home"),
    npmBinary: path.join(root, "bin", "npm"),
    nodeBinary: path.join(root, "bin", "node"),
    timeoutMs: 120_000,
    publicOrigin: PUBLIC_ORIGIN,
    naverSiteVerificationFile: NAVER_FILE,
  }, {
    runProcess(request) {
      observed = request;
      return Promise.resolve({ exitCode: 0, stdout: "ok", stderr: "" });
    },
  });

  expect(observed.env).not.toHaveProperty("NAVER_SITE_VERIFICATION_META");
  expect(observed.env.NAVER_SITE_VERIFICATION_FILE).toBe(NAVER_FILE);
  const search = createSearchBuildState(observed.env);
  expect(search.index.origin).toBe(PUBLIC_ORIGIN);
  expect(search.verification).toEqual({
    naverFile: {
      filename: NAVER_FILE,
      content: `naver-site-verification: ${NAVER_FILE}`,
    },
  });
});
