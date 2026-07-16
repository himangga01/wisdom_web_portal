import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import {
  publishedArticleDocumentSchema,
  publishedConsentBundleSchema,
  publishedManifestSchema,
} from "@wisdom/shared";
import { createSearchBuildState } from "../../site/src/search/build.js";
import {
  runPublicationBuild,
  verifyAndSealPublicationBuild,
} from "../src/articles/publication-build.js";
import {
  publicationSnapshotManifest,
  writePublicationSnapshot,
} from "../src/articles/publication-snapshot.js";

const PUBLIC_ORIGIN = "https://www.jihye-office.kr";
const NAVER_META_TOKEN = "unit_test_naver_meta_token_1234567890";
const NAVER_FILE = "naverunit_test_file_token_1234567890.html";
const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureContentRoot = path.join(
  workspaceRoot,
  "apps/site/src/content/__fixtures__/published-content",
);
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
    snapshotDirectory: path.join(workspaceRoot, "apps/site/src/content/__fixtures__/published-content"),
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
    snapshotDirectory: path.join(workspaceRoot, "apps/site/src/content/__fixtures__/published-content"),
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

it("builds and seals Site from a snapshot written by Control's publication boundary", async () => {
  const manifest = publishedManifestSchema.parse(JSON.parse(readFileSync(
    path.join(fixtureContentRoot, "manifest.json"),
    "utf8",
  )));
  const consentBundle = publishedConsentBundleSchema.parse(JSON.parse(readFileSync(
    path.join(fixtureContentRoot, manifest.consentBundle.contentFile),
    "utf8",
  )));
  const documents = manifest.entries.map((entry) => publishedArticleDocumentSchema.parse(
    JSON.parse(readFileSync(path.join(fixtureContentRoot, entry.contentFile), "utf8")),
  ));
  const snapshot = {
    entries: manifest.entries,
    documents,
    capturedAtMs: Date.parse("2026-07-16T00:00:00.000Z"),
    promotions: [],
    baseReleaseId: null,
    baseReleaseGeneration: 0,
    consentBundle,
  };
  const snapshotDirectory = path.join(root, "snapshot");
  mkdirSync(snapshotDirectory);
  writePublicationSnapshot(snapshot, snapshotDirectory);

  await runPublicationBuild({
    siteSourceRoot: workspaceRoot,
    snapshotDirectory,
    outputDirectory: path.join(root, "dist"),
    buildHome: path.join(root, "home"),
    npmBinary: path.join(root, "bin", process.platform === "win32" ? "npm.cmd" : "npm"),
    nodeBinary: process.execPath,
    timeoutMs: 120_000,
    publicOrigin: PUBLIC_ORIGIN,
  }, {
    runProcess(request) {
      const npmCli = process.env.npm_execpath;
      if (!npmCli || !path.isAbsolute(npmCli)) {
        throw new Error("TEST_NPM_CLI_UNAVAILABLE");
      }
      const child = spawnSync(process.execPath, [npmCli, ...request.args], {
        cwd: request.cwd,
        env: {
          ...request.env,
          ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.windir ? { windir: process.env.windir } : {}),
          ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
        },
        encoding: "utf8",
        timeout: request.timeoutMs,
        windowsHide: true,
      });
      if (child.error) throw child.error;
      return Promise.resolve({
        exitCode: child.status ?? -1,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      });
    },
  });

  const sealed = verifyAndSealPublicationBuild({
    outputDirectory: path.join(root, "dist"),
    snapshot,
    requiredCoreRoutes: ["/", "/insights"],
    forbiddenCanaries: ["DRAFT_PRIVATE_CANARY"],
    publicOrigin: PUBLIC_ORIGIN,
  });
  expect(existsSync(path.join(root, "dist", "index.html"))).toBe(true);
  expect(sealed.consentBundle.bundleId).toBe(consentBundle.bundleId);
  expect(sealed.manifest.consentBundle.contentFileSha256)
    .toBe(publicationSnapshotManifest(snapshot).consentBundle.contentFileSha256);
}, 120_000);
