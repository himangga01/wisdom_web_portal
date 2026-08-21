import { afterEach, describe, expect, it, vi } from "vitest";
import { computePublishedArticleContentSha256 } from "@wisdom/shared";

import { consentBundle, createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import { createControlApp, type RedactedLogEvent } from "../app.js";
import {
  encryptAdminTotpSecret,
  hashAdminPassword,
  mintMarketingWithdrawalCapability,
  totpCode,
} from "../index.js";
import { activateConsentBundle, seedConsentDocuments } from "../consent/service.js";
import type { ConsentAuthorityResolver } from "../consent/service.js";
import { createStaticKeyProvider, encryptPii } from "../crypto/index.js";
import { PublicationActivationSettlementError } from "../articles/publication-release.js";
import { WITHDRAWAL_STYLES, WITHDRAWAL_STYLES_PATH } from "../withdrawal/styles.js";

const PUBLIC_ORIGIN = "https://www.example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const authSecret = Buffer.alloc(32, 91);
const withdrawalSecret = Buffer.alloc(32, 92);
const keyProvider = createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 93) });
const totpSecret = Buffer.alloc(32, 94);
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ADMIN_API = `${ADMIN_ORIGIN}/admin/api/v1`;

function apiHeaders(
  session: { cookie: string; csrf: string },
  origin = ADMIN_ORIGIN,
): Record<string, string> {
  return {
    origin,
    cookie: session.cookie,
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
  };
}

async function responseData<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}

describe("administrator article review and explicit translation routes", () => {
  it("lists immutable content and requires host, session, Origin, CSRF, and row version for every mutation", async () => {
    const current = await fixture();
    const articleId = "11111111-1111-4111-8111-111111111111";
    const revisionId = "22222222-2222-4222-8222-222222222222";
    const bodyMarkdown = "## Complete procurement answer\n\nOfficial guidance.\n";
    const sources = [{
      id: "official-source",
      url: "https://example.com/official",
      sourceTimestamp: "2026-07-16T00:00:00.000Z",
    }];
    const contentSha256 = Buffer.from(computePublishedArticleContentSha256({
      title: "Procurement registration guide",
      summary: "Reviewed source guidance.",
      bodyMarkdown,
      sources,
      locale: "ko",
    }), "hex");
    current.database.db.sqlite.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, current_revision_id,
        created_by_type, created_at_ms, updated_at_ms
      ) VALUES (?, 'procurement-registration', 'draft', 'ko', ?, 'hermes', 1, 1)
    `).run(articleId, revisionId);
    current.database.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'ko', 1, 'Procurement registration guide',
        'Reviewed source guidance.', ?, ?, ?, ?, 'draft', 1, 'hermes', 'hermes-draft')
    `).run(
      revisionId, articleId, bodyMarkdown, contentSha256,
      JSON.stringify(sources), Buffer.alloc(32, 61),
    );
    current.database.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, 'ko', 'procurement-registration', 'draft', ?, 1, 1)
    `).run(articleId, revisionId);
    const session = await login(current);

    const list = await current.app.request(`${ADMIN_API}/articles`, {
      headers: { cookie: session.cookie },
    });
    expect(list.status).toBe(200);
    sensitiveHeaders(list);
    expect((await responseData<{ items: Array<{ title: string }> }>(list)).items).toContainEqual(
      expect.objectContaining({ title: "Procurement registration guide" }),
    );
    expect((await current.app.request(`${PUBLIC_ORIGIN}/admin/api/v1/articles`, {
      headers: { cookie: session.cookie },
    })).status).toBe(404);

    const slug = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/locales/ko/slug`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ slug: "public-procurement-registration", rowVersion: 1 }),
      },
    );
    expect(slug.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT slug, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = 'ko'
    `).get(articleId)).toEqual({ slug: "public-procurement-registration", row_version: 2 });

    const missingCsrf = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/locales/ko/review`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ rowVersion: 2 }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    const review = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/locales/ko/review`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ rowVersion: 2 }),
      },
    );
    expect(review.status).toBe(200);
    const stale = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/locales/ko/approve`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ rowVersion: 2 }),
      },
    );
    expect(stale.status).toBe(409);
    const approve = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/locales/ko/approve`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ rowVersion: 3 }),
      },
    );
    expect(approve.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT state, row_version, approved_by_admin_id
      FROM article_locale_heads WHERE article_id = ? AND locale = 'ko'
    `).get(articleId)).toEqual({
      state: "approved", row_version: 4, approved_by_admin_id: "admin-1",
    });

    const wrongOrigin = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/translations`,
      {
        method: "POST",
        headers: apiHeaders(session, "https://evil.test"),
        body: JSON.stringify({ targetLocale: "en", rowVersion: 4 }),
      },
    );
    expect(wrongOrigin.status).toBe(403);
    const translate = await current.app.request(
      `${ADMIN_API}/articles/${articleId}/translations`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ targetLocale: "en", rowVersion: 4 }),
      },
    );
    expect(translate.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT article_id, source_revision_id, target_locale, state
      FROM article_translation_jobs
    `).get()).toEqual({
      article_id: articleId,
      source_revision_id: revisionId,
      target_locale: "en",
      state: "queued",
    });
    const detail = await current.app.request(`${ADMIN_API}/articles/${articleId}`, {
      headers: { cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    const detailBody = await responseData<{ heads: Array<{ title: string; bodyMarkdown: string }> }>(detail);
    expect(detailBody.heads).toContainEqual(expect.objectContaining({
      title: "Procurement registration guide",
      bodyMarkdown,
    }));
    expect(JSON.stringify(detailBody)).not.toContain("pii_envelope");
    const preview = await current.app.request(`${ADMIN_API}/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    expect(preview.status).toBe(200);
    expect((await responseData<{ eligible: Array<{ title: string }> }>(preview)).eligible).toContainEqual(
      expect.objectContaining({ title: "Procurement registration guide" }),
    );
    const staleRevisionId = "33333333-3333-4333-8333-333333333333";
    current.database.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, sources_json, source_sha256,
        prompt_sha256, schema_sha256, model_id, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'en', 1, 'Stale English translation', 'Stale summary',
        '## Stale English\n', ?, ?, ?, ?, ?, ?, 'fixed-model', 'in_review',
        2, 'codex', 'job-stale')
    `).run(
      staleRevisionId, articleId, Buffer.alloc(32, 41), revisionId,
      JSON.stringify(sources), Buffer.alloc(32, 42), Buffer.alloc(32, 43),
      Buffer.alloc(32, 44),
    );
    current.database.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, approved_revision_id,
        reviewed_by_admin_id, reviewed_at_ms, approved_by_admin_id, approved_at_ms,
        row_version, updated_at_ms
      ) VALUES (?, 'en', 'procurement-registration', 'approved', ?, ?,
        'admin-1', ?, 'admin-1', ?, 2, ?)
    `).run(articleId, staleRevisionId, staleRevisionId, current.now, current.now, current.now);
    current.database.db.sqlite.prepare(`
      UPDATE article_locale_heads SET state = 'in_review', approved_revision_id = NULL,
        approved_by_admin_id = NULL, approved_at_ms = NULL, row_version = row_version + 1
      WHERE article_id = ? AND locale = 'ko'
    `).run(articleId);
    const stalePreview = await current.app.request(`${ADMIN_API}/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    const stalePreviewBody = await responseData<{
      eligible: Array<{ title: string }>;
      blocked: Array<{ title: string; state: string }>;
      fingerprint: string;
    }>(stalePreview);
    expect(stalePreviewBody.eligible).not.toContainEqual(
      expect.objectContaining({ title: "Stale English translation" }),
    );
    expect(stalePreviewBody.blocked).toContainEqual(expect.objectContaining({
      title: "Stale English translation",
      state: "approved",
    }));
    const releases = await current.app.request(`${ADMIN_API}/releases`, {
      headers: { cookie: session.cookie },
    });
    expect(releases.status).toBe(200);
    const publishConfirmation = await current.app.request(`${ADMIN_API}/publish/confirm`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({ mode: "next-batch", fingerprint: stalePreviewBody.fingerprint }),
    });
    expect(publishConfirmation.status).toBe(200);
    const publishToken = (await responseData<{ confirmationToken: string }>(publishConfirmation)).confirmationToken;
    const unavailablePublish = await current.app.request(`${ADMIN_API}/publish`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({
        confirmationToken: publishToken,
        mode: "next-batch",
        fingerprint: stalePreviewBody.fingerprint,
      }),
    });
    expect(unavailablePublish.status).toBe(503);
  });
});

describe("administrator publication failure recovery", () => {
  it("returns sanitized HTML and preserves the public pointer when publish or rollback fails", async () => {
    const publication = {
      publish: vi.fn(async () => {
        throw new PublicationActivationSettlementError({
          kind: "reverted",
          activationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          previousReleaseId: "previous-release",
        });
      }),
      rollback: vi.fn(async () => {
        throw new PublicationActivationSettlementError({
          kind: "manual-recovery-required",
          activationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          errorCode: "PUBLICATION_RECOVERY_FAILED",
        });
      }),
    };
    const current = await fixture("127.0.0.1", { articlePublication: publication });
    current.database.db.sqlite.prepare(`
      INSERT INTO releases (
        id, version, path, manifest_sha256, state, created_at_ms, created_by
      ) VALUES ('release-1', 'release-v1', '/safe/release-v1', ?, 'retired', 1, 'admin')
    `).run(Buffer.alloc(32, 7));
    const session = await login(current);
    const headers = apiHeaders(session);

    const legacyPublish = await current.app.request(`${ADMIN_API}/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({ confirmation: "publish-approved" }),
    });
    expect(legacyPublish.status).toBe(422);
    expect(publication.publish).not.toHaveBeenCalled();
    const preview = await current.app.request(`${ADMIN_API}/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    const fingerprint = (await responseData<{ fingerprint: string }>(preview)).fingerprint;
    const publishConfirmation = await current.app.request(`${ADMIN_API}/publish/confirm`, {
      method: "POST", headers, body: JSON.stringify({ mode: "next-batch", fingerprint }),
    });
    const publishToken = (await responseData<{ confirmationToken: string }>(publishConfirmation)).confirmationToken;
    const publish = await current.app.request(`${ADMIN_API}/publish`, {
      method: "POST", headers,
      body: JSON.stringify({
        confirmationToken: publishToken,
        mode: "next-batch",
        fingerprint,
      }),
    });
    expect(publish.status).toBe(503);
    expect(publish.headers.get("content-type")).toContain("application/json");
    const publishBody = await publish.text();
    expect(publishBody).toContain("이전 공개 릴리스로 복구되었습니다");
    expect(publishBody).not.toContain("previous-release");

    const rollbackConfirmation = await current.app.request(`${ADMIN_API}/releases/release-1/rollback/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    const rollbackToken = (await responseData<{ confirmationToken: string }>(rollbackConfirmation)).confirmationToken;
    const rollback = await current.app.request(`${ADMIN_API}/releases/release-1/rollback`, {
      method: "POST", headers,
      body: JSON.stringify({ confirmationToken: rollbackToken }),
    });
    expect(rollback.status).toBe(503);
    expect(rollback.headers.get("content-type")).toContain("application/json");
    const rollbackBody = await rollback.text();
    expect(rollbackBody).toContain("운영 복구가 필요합니다");
    expect(rollbackBody).toContain("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(rollbackBody).not.toContain("PUBLICATION_RECOVERY_FAILED");
    expect((await current.app.request(`${ADMIN_API}/releases/release-1/rollback`, {
      method: "POST", headers,
      body: JSON.stringify({ confirmationToken: rollbackToken }),
    })).status).toBe(422);
  });
});

interface Fixture {
  app: ReturnType<typeof createControlApp>;
  database: TestDatabase;
  logs: RedactedLogEvent[];
  now: number;
  dummyPasswordHash: string;
}

async function fixture(
  peer = "127.0.0.1",
  overrides: { articlePublication?: {
    publish: (input: unknown) => Promise<{ releaseId: string; version: string; manifestSha256: string }>;
    rollback: (input: unknown) => Promise<{ releaseId: string; version: string; manifestSha256: string }>;
  }; consentAuthorityResolver?: ConsentAuthorityResolver } = {},
): Promise<Fixture> {
  const database = createTestDatabase();
  cleanups.push(() => database.close());
  seedConsentDocuments(database.db, consentBundle(), 1);
  activateConsentBundle(database.db, "bundle-2026-07-16", 2);
  const passwordHash = await hashAdminPassword("owner password");
  const dummyPasswordHash = await hashAdminPassword("dummy password");
  database.db.sqlite.prepare(`
    INSERT INTO admins (
      id, username, display_name, password_hash, totp_secret_envelope,
      totp_key_id, status, created_at_ms, updated_at_ms
    ) VALUES ('admin-1', 'owner', 'Owner', ?, ?, 'pii-v1', 'active', 0, 0)
  `).run(passwordHash, encryptAdminTotpSecret(keyProvider, "admin-1", totpSecret));
  const piiEnvelope = encryptPii(keyProvider, "consultation-1", {
    name: "<script>stored-name</script>",
    phone: "010-1234-5678",
    email: "stored@example.test",
    company: "<img src=x onerror=stored-company>",
    message: "<svg onload=stored-message>Long consultation message content.</svg>",
  });
  database.db.sqlite.prepare(`
    INSERT INTO consultations (
      id, receipt_id, status, locale, category, preferred_contact,
      pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
      blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
      retention_expires_at_ms, row_version
    ) VALUES ('consultation-1', 'receipt-1', 'received', 'ko', 'procurement', 'email',
      ?, 'pii-v1', ?, ?, 'pii-v1', 1, 100, 100, 10000000, 1)
  `).run(piiEnvelope, Buffer.alloc(32, 1), Buffer.alloc(32, 2));
  const marketingDocument = database.db.sqlite.prepare(`
    SELECT id, version, content_sha256 FROM consent_documents
    WHERE kind = 'marketing' AND locale = 'ko' AND state = 'active'
  `).get() as { id: string; version: string; content_sha256: Buffer };
  const privacyDocument = database.db.sqlite.prepare(`
    SELECT id, version, content_sha256 FROM consent_documents
    WHERE kind = 'privacy' AND locale = 'ko' AND state = 'active'
  `).get() as { id: string; version: string; content_sha256: Buffer };
  database.db.sqlite.prepare(`
    INSERT INTO consent_events (
      id, consultation_id, document_id, kind, decision, sequence,
      document_version, document_sha256, actor_type, request_id, occurred_at_ms
    ) VALUES ('privacy-accepted', 'consultation-1', ?, 'privacy', 'accepted', 1,
      ?, ?, 'visitor', 'request-intake', 100)
  `).run(privacyDocument.id, privacyDocument.version, privacyDocument.content_sha256);
  database.db.sqlite.prepare(`
    INSERT INTO consent_events (
      id, consultation_id, document_id, kind, decision, sequence,
      document_version, document_sha256, actor_type, request_id, occurred_at_ms
    ) VALUES ('marketing-accepted', 'consultation-1', ?, 'marketing', 'accepted', 1,
      ?, ?, 'visitor', 'request-intake', 100)
  `).run(marketingDocument.id, marketingDocument.version, marketingDocument.content_sha256);
  const logs: RedactedLogEvent[] = [];
  const state = { now: 30_000 };
  const dependencies = {
    db: database.db,
    keyProvider,
    allowedOrigins: [PUBLIC_ORIGIN],
    enforceOrigin: true,
    publicOrigin: PUBLIC_ORIGIN,
    adminOrigin: ADMIN_ORIGIN,
    authSecret,
    withdrawalSecret,
    dummyPasswordHash,
    now: () => state.now,
    peerAddress: () => peer,
    logger: { write: (event: RedactedLogEvent) => logs.push(event) },
    ...overrides,
  };
  return {
    app: createControlApp(dependencies),
    database,
    logs,
    get now() { return state.now; },
    set now(value: number) { state.now = value; },
    dummyPasswordHash,
  };
}

function sensitiveHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBeTruthy();
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
  expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("strict-transport-security")).toBeNull();
}

function confirmationToken(html: string): string {
  const token = /name="confirmationToken" value="([^"]+)"/u.exec(html)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

async function login(current: Fixture): Promise<{ cookie: string; csrf: string }> {
  const password = await current.app.request(`${ADMIN_ORIGIN}/admin/api/v1/auth/login`, {
    method: "POST",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: "owner password" }),
  });
  expect(password.status).toBe(202);
  sensitiveHeaders(password);
  const preauth = cookiePair(password);
  const passwordBody = await password.json() as { data: { csrfToken: string } };
  const preauthCsrf = passwordBody.data.csrfToken;
  const mfa = await current.app.request(`${ADMIN_ORIGIN}/admin/api/v1/auth/mfa`, {
    method: "POST",
    headers: {
      origin: ADMIN_ORIGIN,
      cookie: preauth,
      "content-type": "application/json",
      "x-csrf-token": preauthCsrf,
    },
    body: JSON.stringify({
      username: "owner",
      method: "totp",
      code: totpCode(totpSecret, current.now),
    }),
  });
  expect(mfa.status).toBe(200);
  const mfaBody = await mfa.json() as { data: { csrfToken: string } };
  const sessionCookie = cookiePair(mfa);
  return { cookie: sessionCookie, csrf: mfaBody.data.csrfToken };
}

describe("separate host and administrator browser boundary", () => {
  it("rejects unknown/public admin hosts and trusts forwarded routing only from loopback", async () => {
    const external = await fixture("203.0.113.10");
    const publicAdmin = await external.app.request(`${PUBLIC_ORIGIN}/admin/login`);
    expect(publicAdmin.status).toBe(404);
    sensitiveHeaders(publicAdmin);
    expect((await external.app.request("https://unknown.example.test/admin/login")).status).toBe(421);
    expect((await external.app.request(`${PUBLIC_ORIGIN}/admin/login`, {
      headers: {
        "x-forwarded-host": "admin.example.test",
        "x-forwarded-proto": "https",
      },
    })).status).toBe(404);

    const loopback = await fixture("127.0.0.1");
    const forwarded = await loopback.app.request("http://127.0.0.1:8787/admin/login", {
      headers: {
        "x-forwarded-host": "admin.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(forwarded.status).toBe(200);
    sensitiveHeaders(forwarded);
    expect((await loopback.app.request("http://127.0.0.1:8787/admin/login", {
      headers: {
        "x-forwarded-host": "evil.example.test",
        "x-forwarded-proto": "https",
      },
    })).status).toBe(421);
  });

  it("uses generic password failures, strict login Origin, and no session before MFA", async () => {
    const current = await fixture();
    const page = await current.app.request(`${ADMIN_ORIGIN}/admin/login`);
    expect(page.status).toBe(200);
    sensitiveHeaders(page);
    const unknown = await current.app.request(`${ADMIN_API}/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "missing", password: "wrong" }),
    });
    const wrong = await current.app.request(`${ADMIN_API}/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "wrong" }),
    });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    const genericFailureBody = await unknown.text();
    expect(genericFailureBody).toBe(await wrong.text());
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect((await current.app.request(`${ADMIN_API}/auth/login`, {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "owner password" }),
    })).status).toBe(403);

    const passwordOnly = await current.app.request(`${ADMIN_API}/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "owner password" }),
    });
    expect(passwordOnly.status).toBe(202);
    const preauth = cookiePair(passwordOnly);
    const preauthCsrf = (await responseData<{ csrfToken: string }>(passwordOnly)).csrfToken;
    const badMfa = await current.app.request(`${ADMIN_API}/auth/mfa`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: preauth,
        "content-type": "application/json",
        "x-csrf-token": preauthCsrf,
      },
      body: JSON.stringify({
        username: "owner", method: "recovery", code: "invalid-recovery-code",
      }),
    });
    expect(badMfa.status).toBe(401);
    expect(await badMfa.json()).toEqual({
      error: { code: "AUTH_INVALID", message: "인증 정보를 확인할 수 없습니다." },
    });

    const authenticated = await login(current);
    expect(authenticated.cookie).toMatch(/^__Host-wisdom-admin=/);
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 1 });
  });

  it("expires persisted pre-auth challenges and lets the browser leave MFA cleanly", async () => {
    const current = await fixture();
    const password = await current.app.request(`${ADMIN_API}/auth/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "owner password" }),
    });
    const preauth = cookiePair(password);
    const csrf = (await responseData<{ csrfToken: string }>(password)).csrfToken;
    current.now += 10 * 60 * 1_000;

    const expired = await current.app.request(`${ADMIN_API}/auth/preauth`, {
      headers: { cookie: preauth },
    });
    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await expired.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "다시 로그인하세요." },
    });

    const expiredMfa = await current.app.request(`${ADMIN_API}/auth/mfa`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: preauth,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({
        username: "owner",
        method: "totp",
        code: totpCode(totpSecret, current.now),
      }),
    });
    expect(expiredMfa.status).toBe(401);
    expect(expiredMfa.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await expiredMfa.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "다시 로그인하세요." },
    });

    const restart = await current.app.request(`${ADMIN_API}/auth/preauth/reset`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: preauth,
        "content-type": "application/json",
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({}),
    });
    expect(restart.status).toBe(204);
    expect(restart.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rechecks the session after a streamed mutation body is read", async () => {
    const current = await fixture();
    const session = await login(current);
    let signalRead!: () => void;
    let releaseBody!: () => void;
    const readStarted = new Promise<void>((resolve) => { signalRead = resolve; });
    const bodyReleased = new Promise<void>((resolve) => { releaseBody = resolve; });
    const encoded = new TextEncoder().encode(JSON.stringify({
      status: "acknowledged",
      rowVersion: 1,
      email: false,
      hermes: false,
    }));
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        signalRead();
        await bodyReleased;
        if (sent) return;
        sent = true;
        controller.enqueue(encoded);
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request(`${ADMIN_API}/consultations/consultation-1/status`, {
      method: "POST",
      headers: apiHeaders(session),
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const responsePromise = current.app.request(request);
    await readStarted;
    current.database.db.sqlite.prepare(`
      UPDATE admin_sessions SET revoked_at_ms = ? WHERE revoked_at_ms IS NULL
    `).run(current.now);
    releaseBody();

    const response = await responsePromise;
    expect(response.status).toBe(401);
    expect(current.database.db.sqlite.prepare(`
      SELECT status, row_version FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ status: "received", row_version: 1 });
  });

  it("rejects unsupported, oversized, malformed, and overlong login JSON before password KDF", async () => {
    const current = await fixture();
    const request = (body: BodyInit, contentType = "application/json") =>
      current.app.request(`${ADMIN_API}/auth/login`, {
        method: "POST",
        headers: { origin: ADMIN_ORIGIN, "content-type": contentType },
        body,
      });
    const unsupported = await request("username=owner", "application/x-www-form-urlencoded");
    const oversized = await request(JSON.stringify({ username: "owner", password: "a".repeat(17_000) }));
    const malformed = await request("[]");
    const overlong = await request(JSON.stringify({ username: "owner", password: "a".repeat(1_025) }));
    expect([
      unsupported.status, oversized.status, malformed.status, overlong.status,
    ]).toEqual([415, 413, 400, 400]);
    for (const response of [unsupported, oversized, malformed, overlong]) sensitiveHeaders(response);
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_login_buckets
    `).get()).toEqual({ count: 0 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_pre_auth_challenges
    `).get()).toEqual({ count: 0 });
  });

  it("serves the React shell and protects JSON detail, CSRF, CAS, renewal, and logout", async () => {
    const current = await fixture();
    const session = await login(current);
    for (const path of [
      "/admin",
      "/admin/consultations",
      "/admin/notifications",
      "/admin/consents",
      "/admin/failures",
      "/admin/health",
    ]) {
      const response = await current.app.request(`${ADMIN_ORIGIN}${path}`, {
        headers: { cookie: session.cookie },
      });
      expect(response.status, path).toBe(200);
      sensitiveHeaders(response);
      expect(await response.text()).toMatch(/\/admin\/assets\/admin-[A-Za-z0-9_-]+\.js/u);
    }
    const detail = await current.app.request(`${ADMIN_API}/consultations/consultation-1`, {
      headers: { cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    expect(detail.headers.get("content-type")).toContain("application/json");
    const detailBody = await responseData<{
      pii: { name: string; company: string };
      piiAvailability: string;
      nextStatuses: string[];
      rowVersion: number;
    }>(detail);
    expect(detailBody.pii).toEqual(expect.objectContaining({
      name: "<script>stored-name</script>",
      company: "<img src=x onerror=stored-company>",
    }));
    expect(detailBody.piiAvailability).toBe("available");
    expect(detailBody.nextStatuses).not.toContain("received");
    expect(detailBody.nextStatuses).toContain("acknowledged");
    expect(detailBody.rowVersion).toBe(1);

    const missingCsrf = await current.app.request(
      `${ADMIN_API}/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "acknowledged", rowVersion: 1 }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    const changed = await current.app.request(
      `${ADMIN_API}/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ status: "acknowledged", rowVersion: 1 }),
      },
    );
    expect(changed.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT status, row_version FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ status: "acknowledged", row_version: 2 });
    const acknowledgedDetail = await current.app.request(
      `${ADMIN_API}/consultations/consultation-1`,
      { headers: { cookie: session.cookie } },
    );
    const acknowledgedBody = await responseData<{ nextStatuses: string[] }>(acknowledgedDetail);
    expect(acknowledgedBody.nextStatuses).not.toContain("received");
    expect(acknowledgedBody.nextStatuses).not.toContain("acknowledged");
    expect(acknowledgedBody.nextStatuses).toContain("in_progress");
    const stale = await current.app.request(
      `${ADMIN_API}/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ status: "closed", rowVersion: 1 }),
      },
    );
    expect(stale.status).toBe(409);

    current.database.db.sqlite.prepare(`
      UPDATE consultations SET status = 'closed', row_version = row_version + 1
      WHERE id = 'consultation-1'
    `).run();
    const closedDetail = await current.app.request(
      `${ADMIN_API}/consultations/consultation-1`,
      { headers: { cookie: session.cookie } },
    );
    expect((await responseData<{ nextStatuses: string[] }>(closedDetail)).nextStatuses).toEqual([]);

    expect((await current.app.request(`${ADMIN_API}/auth/logout`, {
      method: "GET", headers: { cookie: session.cookie },
    })).status).toBe(404);
    current.now += 29 * 60 * 1_000;
    const refreshedDashboard = await current.app.request(`${ADMIN_API}/dashboard`, {
      headers: { cookie: session.cookie },
    });
    expect(refreshedDashboard.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT idle_expires_at_ms FROM admin_sessions WHERE revoked_at_ms IS NULL
    `).get()).toEqual({ idle_expires_at_ms: current.now + 30 * 60 * 1_000 });
    const logout = await current.app.request(`${ADMIN_API}/auth/logout`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({}),
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await current.app.request(`${ADMIN_API}/session`, {
      headers: { cookie: session.cookie },
    })).status).toBe(401);
  });

  it("does not decrypt consultation PII after retention expiry or purge", async () => {
    const current = await fixture();
    const session = await login(current);
    const readDetail = async () => {
      const response = await current.app.request(
        `${ADMIN_API}/consultations/consultation-1`,
        { headers: { cookie: session.cookie } },
      );
      expect(response.status).toBe(200);
      return responseData<{ pii: null; piiAvailability: "expired" | "purged" }>(response);
    };

    current.database.db.sqlite.prepare(`
      UPDATE consultations
      SET pii_envelope = 'invalid-envelope',
          retention_expires_at_ms = ?
      WHERE id = 'consultation-1'
    `).run(current.now);
    expect(await readDetail()).toEqual(expect.objectContaining({
      pii: null,
      piiAvailability: "expired",
    }));

    current.database.db.sqlite.prepare(`
      UPDATE consultations
      SET purged_at_ms = ?,
          pii_envelope = NULL,
          pii_key_id = NULL,
          phone_blind_index = NULL,
          email_blind_index = NULL,
          blind_index_key_id = NULL
      WHERE id = 'consultation-1'
    `).run(current.now + 1);
    expect(await readDetail()).toEqual(expect.objectContaining({
      pii: null,
      piiAvailability: "purged",
    }));
  });

  it("persists gated notification settings/tests, paginates consultations, requeues failed history, and reports degraded health", async () => {
    const current = await fixture();
    const session = await login(current);
    const insert = current.database.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, blind_index_key_id,
        marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES (?, ?, 'received', 'ko', 'procurement', 'phone',
        'opaque', 'pii-v1', ?, 'pii-v1', 0, ?, ?, 10000000, 1)
    `);
    for (let index = 2; index <= 22; index += 1) {
      insert.run(`consultation-${index}`, `receipt-${index}`, Buffer.alloc(32, index), index * 100, index * 100);
    }
    const dashboard = await current.app.request(`${ADMIN_API}/dashboard`, {
      headers: { cookie: session.cookie },
    });
    expect((await responseData<{ counts: Array<{ status: string; count: number }> }>(dashboard)).counts)
      .toContainEqual({ status: "received", count: 22 });
    const firstPage = await current.app.request(`${ADMIN_API}/consultations?page=1`, {
      headers: { cookie: session.cookie },
    });
    const firstPageBody = await responseData<{
      items: Array<{ receiptId: string }>;
      page: { page: number; total: number; pageCount: number };
    }>(firstPage);
    expect(firstPageBody.items).toContainEqual(expect.objectContaining({ receiptId: "receipt-22" }));
    expect(firstPageBody.page).toEqual(expect.objectContaining({ page: 1, total: 22, pageCount: 2 }));
    const secondPage = await current.app.request(`${ADMIN_API}/consultations?page=2`, {
      headers: { cookie: session.cookie },
    });
    expect((await responseData<{ items: Array<{ receiptId: string }> }>(secondPage)).items)
      .toContainEqual(expect.objectContaining({ receiptId: "receipt-1" }));
    const consents = await current.app.request(`${ADMIN_API}/consents`, {
      headers: { cookie: session.cookie },
    });
    expect(await responseData(consents)).toEqual({
      databaseCandidate: {
        bundleId: "bundle-2026-07-16",
        documents: expect.arrayContaining([
          expect.objectContaining({ kind: "privacy", locale: "ko" }),
          expect.objectContaining({ kind: "marketing", locale: "ko" }),
        ]),
      },
      publicAuthority: null,
      inSync: false,
    });

    const notificationPage = await current.app.request(`${ADMIN_API}/notifications`, {
      headers: { cookie: session.cookie },
    });
    expect(await responseData(notificationPage)).toEqual({ settings: [] });
    const postSettings = (values: Record<string, unknown>) => current.app.request(
      `${ADMIN_API}/notifications`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ channel: "email", ...values }),
      },
    );
    expect((await postSettings({ enabled: true, payloadMode: "not-a-mode" })).status).toBe(422);
    expect((await postSettings({
      enabled: true, payloadMode: "full-inquiry", fullInquiryApproved: true,
    })).status).toBe(422);
    const smtpValues = {
      smtp: {
        host: "smtp.example.com",
        port: 465,
        from: "office@example.test",
        to: "owner@example.test",
        secretRef: "keychain:smtp",
      },
    };
    expect((await postSettings({
      enabled: true,
      payloadMode: "receipt-only",
      smtp: { ...smtpValues.smtp, secretRef: "raw-password" },
    })).status).toBe(422);
    expect((await postSettings({
      enabled: true,
      payloadMode: "receipt-only",
      smtp: { ...smtpValues.smtp, password: "must-not-be-accepted" },
    })).status).toBe(422);
    expect((await postSettings({
      enabled: true,
      payloadMode: "receipt-only",
      ...smtpValues,
      smtpPassword: "must-not-be-accepted",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: true,
      payloadMode: "receipt-only",
      ...smtpValues,
      password: "must-not-be-accepted",
    })).status).toBe(422);
    for (const smtpHost of [
      "127.0.0.1",
      "10.0.0.1",
      "localhost",
      "mail.local",
      "mail.internal",
      "smtp.example.test",
    ]) {
      expect((await postSettings({
        enabled: true,
        payloadMode: "receipt-only",
        smtp: { ...smtpValues.smtp, host: smtpHost },
      })).status, smtpHost).toBe(422);
    }
    expect((await postSettings({
      enabled: true,
      payloadMode: "receipt-only",
      smtp: { ...smtpValues.smtp, port: 587 },
    })).status).toBe(422);
    expect((await postSettings({
      enabled: true, payloadMode: "full-inquiry", ...smtpValues,
    })).status).toBe(422);
    expect(current.database.db.sqlite.prepare(
      "SELECT count(*) count FROM notification_settings",
    ).get()).toEqual({ count: 0 });
    expect((await postSettings({
      enabled: true, payloadMode: "receipt-only", ...smtpValues,
    })).status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual({
      enabled: 1,
      provider: "smtp",
      payload_mode: "receipt-only",
      config_json: JSON.stringify({
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      }),
      secret_ref: "keychain:smtp",
    });
    expect(current.database.db.sqlite.prepare(`
      SELECT action, metadata_json FROM audit_events
      WHERE action = 'notification.settings.updated' ORDER BY created_at_ms DESC LIMIT 1
    `).get()).toEqual({
      action: "notification.settings.updated",
      metadata_json: JSON.stringify({
        enabled: true, payloadMode: "receipt-only", smtpConfigured: true,
      }),
    });
    expect(JSON.stringify(current.logs)).not.toMatch(/smtp\.example|office@example|owner@example|keychain:smtp/);
    expect((await postSettings({
      enabled: true, payloadMode: "full-inquiry", fullInquiryApproved: true, ...smtpValues,
    })).status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT payload_mode, config_json, secret_ref FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual({
      payload_mode: "full-inquiry",
      config_json: JSON.stringify({
        host: "smtp.example.com", port: 465, secure: true,
        from: "office@example.test", to: "owner@example.test",
      }),
      secret_ref: "keychain:smtp",
    });
    const savedNotification = await responseData<{
      settings: Array<{ channel: string; enabled: boolean; payloadMode: string; smtpConfigured: boolean }>;
    }>(await current.app.request(
      `${ADMIN_API}/notifications`,
      { headers: { cookie: session.cookie } },
    ));
    expect(savedNotification.settings).toContainEqual(expect.objectContaining({
      channel: "email", enabled: true, payloadMode: "full-inquiry", smtpConfigured: true,
    }));
    const testEnqueue = await current.app.request(`${ADMIN_API}/notifications/test`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({ channel: "email" }),
    });
    expect(testEnqueue.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT channel, purpose, state, payload_json FROM notification_outbox WHERE purpose = 'test'
    `).get()).toEqual({
      channel: "email", purpose: "test", state: "pending", payload_json: '{"test":true}',
    });
    const emailBeforeHermes = current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get();
    const hermesSettings = await current.app.request(`${ADMIN_API}/notifications`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({ channel: "hermes-telegram", enabled: true }),
    });
    expect(hermesSettings.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'hermes-telegram'
    `).get()).toEqual({
      enabled: 1, provider: "hermes", payload_mode: null, config_json: "{}", secret_ref: null,
    });
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual(emailBeforeHermes);

    current.database.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, state, attempt_count,
        available_at_ms, purpose, delivery_cycle, last_error_code,
        created_at_ms, updated_at_ms
      ) VALUES ('failed-delivery', 'consultation-1', 'email', 'notification.failed-test',
        'failed', 5, 0, 'test', 1, 'PROVIDER_ERROR', 0, 0)
    `).run();
    current.database.db.sqlite.prepare(`
      INSERT INTO notification_delivery_attempts (
        id, outbox_id, delivery_cycle, attempt_no, worker_id,
        outcome_code, started_at_ms, finished_at_ms
      ) VALUES ('failed-attempt', 'failed-delivery', 1, 5, 'worker',
        'PROVIDER_ERROR', 0, 1)
    `).run();
    const failures = await current.app.request(`${ADMIN_API}/failures`, {
      headers: { cookie: session.cookie },
    });
    expect((await responseData<{ items: Array<{ id: string }> }>(failures)).items)
      .toContainEqual(expect.objectContaining({ id: "failed-delivery" }));
    const requeued = await current.app.request(`${ADMIN_API}/failures/failed-delivery/requeue`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({}),
    });
    expect(requeued.status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT state, attempt_count, delivery_cycle FROM notification_outbox WHERE id = 'failed-delivery'
    `).get()).toEqual({ state: "pending", attempt_count: 0, delivery_cycle: 2 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_delivery_attempts WHERE outbox_id = 'failed-delivery'
    `).get()).toEqual({ count: 1 });

    current.database.db.sqlite.exec("DROP INDEX notification_outbox_lease_idx");
    const degraded = await current.app.request(`${ADMIN_API}/health`, {
      headers: { cookie: session.cookie },
    });
    expect(degraded.status).toBe(200);
    expect((await responseData<{ ready: boolean }>(degraded)).ready).toBe(false);
  });

  it("paginates the complete publish preview scope without hiding aggregate totals", async () => {
    const current = await fixture();
    const session = await login(current);
    const insertArticle = current.database.db.sqlite.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, current_revision_id,
        created_by_type, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'draft', 'ko', ?, 'hermes', ?, ?)
    `);
    const insertRevision = current.database.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, 'ko', 1, ?, 'summary', 'body', ?, '[]', ?, 'draft', ?, 'hermes', 'fixture')
    `);
    const insertHead = current.database.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, 'ko', ?, 'draft', ?, 1, ?)
    `);
    current.database.db.sqlite.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 1; index <= 201; index += 1) {
        const suffix = String(index).padStart(3, "0");
        const articleId = `preview-article-${suffix}`;
        const revisionId = `preview-revision-${suffix}`;
        const slug = `preview-${suffix}`;
        insertArticle.run(articleId, slug, revisionId, index, index);
        insertRevision.run(
          revisionId,
          articleId,
          `Preview ${suffix}`,
          Buffer.alloc(32, index % 255),
          Buffer.alloc(32, (index + 1) % 255),
          index,
        );
        insertHead.run(articleId, slug, revisionId, index);
      }
      current.database.db.sqlite.exec("COMMIT");
    } catch (error) {
      current.database.db.sqlite.exec("ROLLBACK");
      throw error;
    }
    const preview = await current.app.request(`${ADMIN_API}/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    expect(preview.status).toBe(200);
    const data = await responseData<{
      eligible: unknown[];
      blocked: unknown[];
      eligibleTotal: number;
      blockedTotal: number;
      fingerprint: string;
      page: { page: number; pageSize: number; total: number; pageCount: number };
    }>(preview);
    expect(data.eligible).toHaveLength(0);
    expect(data.blocked).toHaveLength(100);
    expect(data.eligibleTotal).toBe(0);
    expect(data.blockedTotal).toBe(201);
    expect(data.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(data.page).toEqual({ page: 1, pageSize: 100, total: 201, pageCount: 3 });

    const lastPage = await current.app.request(`${ADMIN_API}/publish/preview?page=3`, {
      headers: { cookie: session.cookie },
    });
    const lastPageData = await responseData<{
      blocked: Array<{ title: string }>;
      blockedTotal: number;
      fingerprint: string;
      page: { page: number };
    }>(lastPage);
    expect(lastPageData.blocked).toHaveLength(1);
    expect(lastPageData.blocked[0]).toEqual(expect.objectContaining({ title: "Preview 201" }));
    expect(lastPageData.blockedTotal).toBe(201);
    expect(lastPageData.fingerprint).toBe(data.fingerprint);
    expect(lastPageData.page.page).toBe(3);
  });

  it("rejects a confirmed publish when the reviewed publication scope changes", async () => {
    const publication = {
      publish: vi.fn(async () => ({
        releaseId: "release-new",
        version: "release-v2",
        manifestSha256: "ab".repeat(32),
      })),
      rollback: vi.fn(async () => ({
        releaseId: "release-old",
        version: "release-v1",
        manifestSha256: "cd".repeat(32),
      })),
    };
    const current = await fixture("127.0.0.1", { articlePublication: publication });
    const session = await login(current);
    const headers = apiHeaders(session);
    const preview = await current.app.request(`${ADMIN_API}/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    const fingerprint = (await responseData<{ fingerprint: string }>(preview)).fingerprint;
    const confirmation = await current.app.request(`${ADMIN_API}/publish/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "next-batch", fingerprint }),
    });
    const token = (await responseData<{ confirmationToken: string }>(confirmation)).confirmationToken;

    current.database.db.sqlite.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, current_revision_id,
        created_by_type, created_at_ms, updated_at_ms
      ) VALUES ('scope-change-article', 'scope-change', 'approved', 'ko',
        'scope-change-revision', 'hermes', 1, 1)
    `).run();
    current.database.db.sqlite.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, sources_json, source_sha256, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES ('scope-change-revision', 'scope-change-article', 'ko', 1,
        'New scope', 'summary', 'body', ?, '[]', ?, 'approved',
        1, 'hermes', 'fixture')
    `).run(Buffer.alloc(32, 8), Buffer.alloc(32, 9));
    current.database.db.sqlite.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, approved_revision_id,
        approved_by_admin_id, approved_at_ms, row_version, updated_at_ms
      ) VALUES ('scope-change-article', 'ko', 'scope-change', 'approved',
        'scope-change-revision', 'scope-change-revision', 'admin-1', 1, 1, 1)
    `).run();

    const publish = await current.app.request(`${ADMIN_API}/publish`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        confirmationToken: token,
        mode: "next-batch",
        fingerprint,
      }),
    });
    expect(publish.status).toBe(409);
    expect(publication.publish).not.toHaveBeenCalled();
  });

  it("uses the administrator error envelope and redacts API resource identifiers in logs", async () => {
    const current = await fixture();
    const session = await login(current);
    current.database.db.sqlite.prepare(
      "UPDATE consultations SET pii_envelope = 'corrupt-envelope' WHERE id = 'consultation-1'",
    ).run();
    const response = await current.app.request(`${ADMIN_API}/consultations/consultation-1`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "관리자 요청을 처리하지 못했습니다.",
      },
    });
    expect(current.logs.at(-1)).toEqual(expect.objectContaining({
      route: "/admin/api/v1/consultations/:id",
      code: "STORAGE_UNAVAILABLE",
    }));
    expect(JSON.stringify(current.logs)).not.toContain("consultation-1");
  });

  it("clamps unsafe pages and bounds the failed notification list", async () => {
    const current = await fixture();
    const session = await login(current);
    for (let index = 0; index < 51; index += 1) {
      current.database.db.sqlite.prepare(`
        INSERT INTO notification_outbox (
          id, consultation_id, channel, event_type, state, attempt_count,
          available_at_ms, purpose, delivery_cycle, last_error_code,
          created_at_ms, updated_at_ms
        ) VALUES (?, 'consultation-1', 'email', ?,
          'failed', 5, 0, 'test', 1, 'PROVIDER_ERROR', ?, ?)
      `).run(`failure-${index}`, `notification.failed-${index}`, index, index);
    }

    const unsafePage = await current.app.request(
      `${ADMIN_API}/consultations?page=999999999999999999999999`,
      { headers: { cookie: session.cookie } },
    );
    expect(unsafePage.status).toBe(200);
    expect((await responseData<{ page: { page: number } }>(unsafePage)).page.page).toBe(1);

    const beyondLastPage = await current.app.request(
      `${ADMIN_API}/consultations?page=999999999`,
      { headers: { cookie: session.cookie } },
    );
    expect((await responseData<{ page: { page: number } }>(beyondLastPage)).page.page).toBe(1);

    const failures = await current.app.request(`${ADMIN_API}/failures`, {
      headers: { cookie: session.cookie },
    });
    const failuresBody = await responseData<{
      items: Array<{ id: string }>;
      page: { page: number; total: number; pageCount: number };
    }>(failures);
    expect(failuresBody.page).toEqual(expect.objectContaining({ page: 1, total: 51, pageCount: 2 }));
    expect(failuresBody.items).toContainEqual(expect.objectContaining({ id: "failure-50" }));
    expect(failuresBody.items).not.toContainEqual(expect.objectContaining({ id: "failure-0" }));
  });

  it("allows disabling full inquiry email without repeating approval", async () => {
    const current = await fixture();
    const session = await login(current);
    const smtpValues = {
      smtp: {
        host: "smtp.example.com",
        port: 465,
        from: "office@example.test",
        to: "owner@example.test",
        secretRef: "keychain:smtp",
      },
    };
    const postSettings = (values: Record<string, unknown>) => current.app.request(
      `${ADMIN_API}/notifications`,
      {
        method: "POST",
        headers: apiHeaders(session),
        body: JSON.stringify({ channel: "email", ...values }),
      },
    );

    expect((await postSettings({
      enabled: false,
      payloadMode: "receipt-only",
    })).status).toBe(200);
    const disabledTest = await current.app.request(`${ADMIN_API}/notifications/test`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({ channel: "email" }),
    });
    expect(disabledTest.status).toBe(409);
    expect(await disabledTest.json()).toEqual({
      error: {
        code: "NOTIFICATION_CHANNEL_DISABLED",
        message: "비활성 알림 채널은 테스트할 수 없습니다.",
      },
    });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_outbox WHERE purpose = 'test'
    `).get()).toEqual({ count: 0 });

    expect((await postSettings({
      enabled: true,
      payloadMode: "full-inquiry",
      fullInquiryApproved: true,
      ...smtpValues,
    })).status).toBe(200);
    expect((await postSettings({
      enabled: false,
      payloadMode: "full-inquiry",
      ...smtpValues,
    })).status).toBe(200);
    expect(current.database.db.sqlite.prepare(`
      SELECT enabled, payload_mode FROM notification_settings WHERE channel = 'email'
    `).get()).toEqual({ enabled: 0, payload_mode: "full-inquiry" });
    expect((await current.app.request(`${ADMIN_API}/notifications/test`, {
      method: "POST",
      headers: apiHeaders(session),
      body: JSON.stringify({ channel: "email" }),
    })).status).toBe(409);
  });
});

describe("marketing withdrawal HTTP ceremony", () => {
  it("never renders or logs the raw capability and mutates only on strict-Origin POST", async () => {
    const current = await fixture();
    const minted = mintMarketingWithdrawalCapability(
      current.database.db,
      withdrawalSecret,
      {
        consultationId: "consultation-1",
        publicOrigin: PUBLIC_ORIGIN,
        nowMs: current.now,
        expiresAtMs: current.now + 1_000_000,
        randomBytes: () => Buffer.alloc(32, 101),
      },
    );
    const landing = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${minted.token}`);
    expect(landing.status).toBe(303);
    sensitiveHeaders(landing);
    expect(landing.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`);
    expect(landing.headers.get("location")).not.toContain(minted.token);
    const landingCookie = cookiePair(landing);
    expect(landingCookie).not.toContain(minted.token);
    const beforeConfirmation = current.database.db.sqlite.serialize();
    const confirmation = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`, {
      headers: { cookie: landingCookie },
    });
    expect(confirmation.status).toBe(200);
    sensitiveHeaders(confirmation);
    const html = await confirmation.text();
    expect(html).not.toContain(minted.token);
    expect(html).toContain('action="/marketing/withdraw/confirm"');
    expect(html).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    expect(html).not.toContain("/admin/");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<nav");
    const stylesheet = await current.app.request(`${PUBLIC_ORIGIN}${WITHDRAWAL_STYLES_PATH}`);
    expect(stylesheet.status).toBe(200);
    sensitiveHeaders(stylesheet);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await stylesheet.text()).toBe(WITHDRAWAL_STYLES);
    expect((await current.app.request(`${ADMIN_ORIGIN}${WITHDRAWAL_STYLES_PATH}`)).status).toBe(404);
    expect(current.database.db.sqlite.serialize()).toEqual(beforeConfirmation);
    const confirmationValue = /name="confirmation" value="([^"]+)"/.exec(html)?.[1];
    expect(confirmationValue).toBeTruthy();
    const duplicate = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: `confirmation=${encodeURIComponent(confirmationValue!)}&confirmation=${encodeURIComponent(confirmationValue!)}`,
    });
    expect(duplicate.status).toBe(400);
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM consent_events WHERE kind = 'marketing' AND decision = 'withdrawn'
    `).get()).toEqual({ count: 0 });
    expect((await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`, {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    })).status).toBe(403);
    const withdrawn = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    });
    expect(withdrawn.status).toBe(200);
    const successHtml = await withdrawn.text();
    expect(successHtml).not.toContain(minted.token);
    expect(successHtml).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    expect(successHtml).not.toContain("/admin/");
    expect(JSON.stringify(current.logs)).not.toContain(minted.token);
    expect((await current.app.request(`${ADMIN_ORIGIN}/marketing/withdraw/${minted.token}`)).status).toBe(404);
  });

  it("redacts raw-token route labels even when storage throws", async () => {
    const current = await fixture();
    const token = Buffer.alloc(32, 111).toString("base64url");
    current.database.db.sqlite.close();
    const response = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${token}`);
    expect(response.status).toBe(503);
    sensitiveHeaders(response);
    expect(JSON.stringify(current.logs)).not.toContain(token);
    expect(current.logs.at(-1)?.route).toBe("/marketing/withdraw/:token");
  });

  it("uses the public stylesheet for invalid confirmation and capability pages", async () => {
    const current = await fixture();
    const confirmation = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/confirm`);
    expect(confirmation.status).toBe(410);
    const confirmationHtml = await confirmation.text();
    expect(confirmationHtml).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    expect(confirmationHtml).toContain("withdrawal-card--error");
    expect(confirmationHtml).not.toContain("/admin/");

    const capability = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/not-a-capability`);
    expect(capability.status).toBe(404);
    const capabilityHtml = await capability.text();
    expect(capabilityHtml).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    expect(capabilityHtml).toContain("withdrawal-card--error");
    expect(capabilityHtml).not.toContain("/admin/");
  });

  it.each([
    ["ko", "/marketing/withdraw/confirm", "마케팅 수신 동의 철회", "동의 철회가 완료되었습니다"],
    ["en", "/en/marketing/withdraw/confirm", "Withdraw marketing consent", "Marketing consent withdrawn"],
    ["zh-Hans", "/zh-hans/marketing/withdraw/confirm", "撤回营销信息接收同意", "营销信息接收同意已撤回"],
    ["zh-Hant", "/zh-hant/marketing/withdraw/confirm", "撤回行銷資訊接收同意", "行銷資訊接收同意已撤回"],
  ] as const)("renders localized withdrawal confirmation and success for %s", async (
    locale, route, confirmationCopy, successCopy,
  ) => {
    const current = await fixture();
    current.database.db.sqlite.prepare(`
      UPDATE consultations SET locale = ? WHERE id = 'consultation-1'
    `).run(locale);
    const minted = mintMarketingWithdrawalCapability(
      current.database.db,
      withdrawalSecret,
      {
        consultationId: "consultation-1",
        publicOrigin: PUBLIC_ORIGIN,
        nowMs: current.now,
        expiresAtMs: current.now + 1_000_000,
      },
    );
    const landing = await current.app.request(`${PUBLIC_ORIGIN}/marketing/withdraw/${minted.token}`);
    expect(landing.headers.get("location")).toBe(`${PUBLIC_ORIGIN}${route}`);
    const landingCookie = cookiePair(landing);
    const confirmation = await current.app.request(`${PUBLIC_ORIGIN}${route}`, {
      headers: { cookie: landingCookie },
    });
    const confirmationHtml = await confirmation.text();
    expect(confirmationHtml).toContain(`lang="${locale}"`);
    expect(confirmationHtml).toContain(confirmationCopy);
    expect(confirmationHtml).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    const confirmationValue = /name="confirmation" value="([^"]+)"/.exec(confirmationHtml)?.[1];
    const success = await current.app.request(`${PUBLIC_ORIGIN}${route}`, {
      method: "POST",
      headers: {
        origin: PUBLIC_ORIGIN,
        cookie: landingCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ confirmation: confirmationValue! }),
    });
    const successHtml = await success.text();
    expect(successHtml).toContain(`lang="${locale}"`);
    expect(successHtml).toContain(successCopy);
    expect(successHtml).toContain(`href="${WITHDRAWAL_STYLES_PATH}"`);
    expect(successHtml).toContain("withdrawal-card--success");
  });
});
