import { afterEach, describe, expect, it } from "vitest";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  consentAuthorityIdentity,
  createReleaseBoundConsentAuthorityResolver,
} from "./release-authority.js";
import {
  activateConsentBundle,
  createDatabaseConsentAuthorityResolver,
  seedConsentDocuments,
} from "./service.js";

let database: TestDatabase | undefined;
afterEach(() => database?.close());

describe("release-bound consent authority fallback", () => {
  it("gives the legacy database authority an exact virtual release identity", () => {
    database = createTestDatabase();
    seedConsentDocuments(database.db, consentBundle(), 1_000);
    activateConsentBundle(database.db, "bundle-2026-07-16", 2_000);
    const resolver = createReleaseBoundConsentAuthorityResolver(
      database.db,
      createDatabaseConsentAuthorityResolver(database.db),
    );
    const authority = resolver({ nowMs: 3_000 });
    expect(authority).toBeDefined();
    expect(consentAuthorityIdentity(database.db, authority!)).toEqual({
      releaseId: "database:bundle-2026-07-16",
      bundleId: "bundle-2026-07-16",
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(resolver({
      releaseId: "database:bundle-2026-07-16",
      nowMs: 3_000,
    })?.bundle.bundleId).toBe("bundle-2026-07-16");
    expect(resolver({ releaseId: "unknown-release", nowMs: 3_000 })).toBeUndefined();
  });
});
