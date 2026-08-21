import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStaticKeyProvider } from "../crypto/index.js";
import {
  activateConsentBundle,
  seedCompleteConsentBundles,
} from "../consent/service.js";
import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import type { PublicationReleaseConfig } from "../articles/publication-release.js";
import {
  createFirstPublicationPlan,
  executeFirstPublication,
} from "./publication-first.js";

const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOOTSTRAP_ID = "20260716T010203Z-abcdef1";
const NOW = Date.parse("2026-07-16T05:00:00.000Z");
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 81) });

let fixture: TestDatabase;
let root: string;
let config: PublicationReleaseConfig;

function writeBootstrapRelease(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const index = "<!doctype html><title>Bootstrap</title>";
  writeFileSync(join(directory, "index.html"), index);
  const manifest = {
    formatVersion: 1,
    kind: "bootstrap",
    releaseId: BOOTSTRAP_ID,
    createdAt: "2026-07-16T01:02:03.000Z",
    files: {
      "index.html": createHash("sha256").update(index).digest("hex"),
    },
  };
  writeFileSync(
    join(directory, ".ops-public-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

beforeEach(() => {
  fixture = createTestDatabase();
  seedCompleteConsentBundles(fixture.db, consentBundle(), NOW - 10_000);
  activateConsentBundle(fixture.db, "bundle-2026-07-16", NOW - 9_000);
  fixture.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, status,
      failed_count, created_at_ms, updated_at_ms
    ) VALUES (?, 'operator', 'Publication Operator', 'hash', 'active', 0, 0, 0)
  `).run(ADMIN_ID);
  root = realpathSync(mkdtempSync(join(tmpdir(), "wisdom-first-publication-")));
  const releaseRoot = join(root, "public-releases");
  const bootstrap = join(releaseRoot, BOOTSTRAP_ID);
  const currentLink = join(root, "public-current");
  writeBootstrapRelease(bootstrap);
  symlinkSync(bootstrap, currentLink, process.platform === "win32" ? "junction" : "dir");
  mkdirSync(join(root, "site"));
  config = {
    releaseRoot,
    currentLink,
    siteSourceRoot: resolve(root, "site"),
    npmBinary: resolve(root, "bin", "npm"),
    nodeBinary: resolve(root, "bin", "node"),
    buildTimeoutMs: 120_000,
    requiredCoreRoutes: ["/"],
    forbiddenCanaries: [],
    publicOrigin: "https://www.example.com",
  };
});

afterEach(() => {
  fixture.close();
  rmSync(root, { recursive: true, force: true });
});

describe("first publication CLI service", () => {
  it("creates a stable bounded plan from bootstrap, consent, and approved heads", () => {
    const plan = createFirstPublicationPlan(fixture.db, config, {
      bootstrapReleaseId: BOOTSTRAP_ID,
      actorAdminId: ADMIN_ID,
    });
    expect(plan).toMatchObject({
      action: "first-publication",
      bootstrapReleaseId: BOOTSTRAP_ID,
      consentBundleId: "bundle-2026-07-16",
      eligiblePromotionCount: 0,
    });
    expect(plan.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(createFirstPublicationPlan(fixture.db, config, {
      bootstrapReleaseId: BOOTSTRAP_ID,
      actorAdminId: ADMIN_ID,
    })).toEqual(plan);
  });

  it("does not publish without the exact current fingerprint", async () => {
    const publish = vi.fn();
    await expect(executeFirstPublication(
      fixture.db,
      keyProvider,
      config,
      {
        bootstrapReleaseId: BOOTSTRAP_ID,
        actorAdminId: ADMIN_ID,
        nowMs: NOW,
        apply: true,
        confirmFingerprint: "f".repeat(64),
      },
      { publish },
    )).rejects.toThrow("FIRST_PUBLICATION_CONFIRMATION_MISMATCH");
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes once and rejects every subsequent first-publication plan", async () => {
    const plan = createFirstPublicationPlan(fixture.db, config, {
      bootstrapReleaseId: BOOTSTRAP_ID,
      actorAdminId: ADMIN_ID,
    });
    const releaseId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const manifest = Buffer.alloc(32, 7);
    const publicationPath = join(config.releaseRoot, "release-first");
    const result = await executeFirstPublication(
      fixture.db,
      keyProvider,
      config,
      {
        bootstrapReleaseId: BOOTSTRAP_ID,
        actorAdminId: ADMIN_ID,
        nowMs: NOW,
        apply: true,
        confirmFingerprint: plan.fingerprint,
      },
      {
        publish: async (db) => {
          db.sqlite.prepare(`
            INSERT INTO releases (
              id, version, path, manifest_sha256, state, created_at_ms,
              activated_at_ms, created_by, verified_at_ms, verification_sha256
            ) VALUES (?, 'release-first', ?, ?, 'active', ?, ?, ?, ?, ?)
          `).run(
            releaseId,
            publicationPath,
            manifest,
            NOW,
            NOW,
            ADMIN_ID,
            NOW,
            manifest,
          );
          return {
            releaseId,
            version: "release-first",
            manifestSha256: manifest.toString("hex"),
          };
        },
      },
    );
    expect(result).toMatchObject({
      action: "first-publication",
      fingerprint: plan.fingerprint,
      releaseId,
    });
    expect(() => createFirstPublicationPlan(fixture.db, config, {
      bootstrapReleaseId: BOOTSTRAP_ID,
      actorAdminId: ADMIN_ID,
    })).toThrow("FIRST_PUBLICATION_ALREADY_COMPLETED");
  });
});
