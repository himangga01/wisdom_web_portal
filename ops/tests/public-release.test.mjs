import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPublicCurrent, verifyPublicReleaseDirectory, writePublicReleaseManifest } from "../lib/public-release.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function consentBundle() {
  const documents = ["ko", "en", "zh-Hans", "zh-Hant"].flatMap((locale) => (
    ["privacy", "marketing"].map((kind) => {
      const document = {
        kind,
        locale,
        version: `${kind}-2026-07-16`,
        title: `${kind} ${locale}`,
        bodyMarkdown: `Approved ${kind} terms for ${locale}.`,
        retentionMonths: kind === "privacy" ? 12 : 24,
      };
      return {
        ...document,
        contentSha256: hash(JSON.stringify(document)),
        effectiveAt: "2026-07-16T00:00:00.000Z",
        required: kind === "privacy",
      };
    })
  ));
  return { schemaVersion: 1, bundleId: "bundle-2026-07-16", documents };
}

async function writeWisdomRelease(release, files) {
  const consent = `${JSON.stringify(consentBundle(), null, 2)}\n`;
  const sealedFiles = { ...files, "consent-bundle.json": consent };
  for (const [relative, value] of Object.entries(sealedFiles)) {
    const absolute = path.join(release, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, value);
  }
  const manifest = {
    schemaVersion: 1,
    snapshotManifestSha256: "a".repeat(64),
    consentBundle: {
      bundleId: "bundle-2026-07-16",
      contentFileSha256: hash(consent),
    },
    files: Object.entries(sealedFiles)
      .map(([relative, value]) => ({ path: relative, sha256: hash(value), size: Buffer.byteLength(value) }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  await writeFile(path.join(release, ".wisdom-release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("explicit ops bootstrap manifest binds the whole initial static tree", async () => {
  const release = await mkdtemp(path.join(os.tmpdir(), "wisdom-public-release-"));
  await mkdir(path.join(release, "_astro"));
  await writeFile(path.join(release, "index.html"), "<!doctype html><title>Wisdom</title>");
  await writeFile(path.join(release, "_astro", "app.abcdef.js"), "export default true;");
  await writePublicReleaseManifest(release, "20260716T010203Z-abcdef1", new Date("2026-07-16T01:02:03.000Z"));

  assert.deepEqual(await verifyPublicReleaseDirectory(release, { allowBootstrap: true }), {
    manifestVerified: true,
    indexVerified: true,
    format: "ops-bootstrap",
    releaseId: "20260716T010203Z-abcdef1",
  });
  await assert.rejects(verifyPublicReleaseDirectory(release), { code: "PUBLIC_CURRENT_NOT_READY" });
  await writeFile(path.join(release, "index.html"), "tampered");
  await assert.rejects(verifyPublicReleaseDirectory(release, { allowBootstrap: true }), { code: "PUBLIC_CURRENT_NOT_READY" });
});

test("authoritative Wisdom manifest requires canonical exact inventory, size, and every hash", async () => {
  const release = await mkdtemp(path.join(os.tmpdir(), "wisdom-authoritative-release-"));
  await writeWisdomRelease(release, {
    "_astro/app.abcdef.js": "export default true;",
    "index.html": "<!doctype html><title>Wisdom</title>",
    "rss.xml": "<rss/>",
    "sitemap.xml": "<urlset/>",
  });

  const verified = await verifyPublicReleaseDirectory(release);
  assert.equal(verified.format, "wisdom");
  assert.equal(verified.manifestVerified, true);
  assert.equal(verified.consentBundleVerified, true);
  assert.equal(verified.consentBundleId, "bundle-2026-07-16");
  assert.match(verified.manifestSha256, /^[a-f0-9]{64}$/u);
  await writeFile(path.join(release, "rss.xml"), "<rss>tampered</rss>");
  await assert.rejects(verifyPublicReleaseDirectory(release), { code: "PUBLIC_CURRENT_NOT_READY" });
});

test("authoritative Wisdom manifest rejects an incomplete approved policy snapshot", async () => {
  const release = await mkdtemp(path.join(os.tmpdir(), "wisdom-policy-release-"));
  await writeWisdomRelease(release, { "index.html": "published" });
  const invalid = consentBundle();
  invalid.documents.pop();
  const invalidBytes = `${JSON.stringify(invalid, null, 2)}\n`;
  await writeFile(path.join(release, "consent-bundle.json"), invalidBytes);
  const manifestPath = path.join(release, ".wisdom-release-manifest.json");
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(manifestPath, "utf8"));
  manifest.consentBundle.contentFileSha256 = hash(invalidBytes);
  const entry = manifest.files.find(({ path: relative }) => relative === "consent-bundle.json");
  entry.sha256 = hash(invalidBytes);
  entry.size = Buffer.byteLength(invalidBytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await assert.rejects(verifyPublicReleaseDirectory(release), { code: "PUBLIC_CURRENT_NOT_READY" });
});

test("bootstrap current is refused after any normal Wisdom publication exists", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-public-current-"));
  const publicReleaseRoot = path.join(root, "public-releases");
  const bootstrap = path.join(publicReleaseRoot, "20260716T010203Z-abcdef1");
  const published = path.join(publicReleaseRoot, "20260716T020304Z-bbbbbbb");
  const current = path.join(root, "public-current");
  await mkdir(bootstrap, { recursive: true });
  await writeFile(path.join(bootstrap, "index.html"), "bootstrap");
  await writePublicReleaseManifest(bootstrap, "20260716T010203Z-abcdef1");
  try {
    await symlink(bootstrap, current, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  assert.equal((await verifyPublicCurrent({ publicReleaseRoot, publicCurrentLink: current })).format, "ops-bootstrap");
  await mkdir(published);
  await writeWisdomRelease(published, { "index.html": "published" });
  await assert.rejects(verifyPublicCurrent({ publicReleaseRoot, publicCurrentLink: current }), {
    code: "PUBLIC_CURRENT_NOT_READY",
  });
});

test("public release refuses symlinked content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wisdom-public-symlink-"));
  const release = path.join(root, "release");
  const external = path.join(root, "external.js");
  await mkdir(release);
  await writeFile(path.join(release, "index.html"), "site");
  await writeFile(external, "external");
  try {
    await symlink(external, path.join(release, "external.js"), "file");
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") {
      t.diagnostic("symlink creation is unavailable on this Windows host");
      return;
    }
    throw error;
  }
  await assert.rejects(
    writePublicReleaseManifest(release, "20260716T010203Z-abcdef1"),
    { code: "PUBLIC_RELEASE_INVALID" },
  );
});
