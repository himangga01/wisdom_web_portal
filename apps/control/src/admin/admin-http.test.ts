import { createHash } from "node:crypto";

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
import { blindIndex, createStaticKeyProvider, encryptPii } from "../crypto/index.js";

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

    const list = await current.app.request(`${ADMIN_ORIGIN}/admin/articles`, {
      headers: { cookie: session.cookie },
    });
    expect(list.status).toBe(200);
    sensitiveHeaders(list);
    expect(await list.text()).toContain("Procurement registration guide");
    expect((await current.app.request(`${PUBLIC_ORIGIN}/admin/articles`, {
      headers: { cookie: session.cookie },
    })).status).toBe(404);

    const slug = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/locales/ko/slug`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          slug: "public-procurement-registration", rowVersion: "1", csrf: session.csrf,
        }),
      },
    );
    expect(slug.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT slug, row_version FROM article_locale_heads
      WHERE article_id = ? AND locale = 'ko'
    `).get(articleId)).toEqual({ slug: "public-procurement-registration", row_version: 2 });

    const missingCsrf = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/locales/ko/review`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ rowVersion: "2" }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    const review = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/locales/ko/review`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ rowVersion: "2", csrf: session.csrf }),
      },
    );
    expect(review.status).toBe(303);
    const stale = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/locales/ko/approve`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ rowVersion: "2", csrf: session.csrf }),
      },
    );
    expect(stale.status).toBe(409);
    const approve = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/locales/ko/approve`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ rowVersion: "3", csrf: session.csrf }),
      },
    );
    expect(approve.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT state, row_version, approved_by_admin_id
      FROM article_locale_heads WHERE article_id = ? AND locale = 'ko'
    `).get(articleId)).toEqual({
      state: "approved", row_version: 4, approved_by_admin_id: "admin-1",
    });

    const wrongOrigin = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/translations`,
      {
        method: "POST",
        headers: {
          origin: "https://evil.test",
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ targetLocale: "en", rowVersion: "4", csrf: session.csrf }),
      },
    );
    expect(wrongOrigin.status).toBe(403);
    const translate = await current.app.request(
      `${ADMIN_ORIGIN}/admin/articles/${articleId}/translations`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ targetLocale: "en", rowVersion: "4", csrf: session.csrf }),
      },
    );
    expect(translate.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT article_id, source_revision_id, target_locale, state
      FROM article_translation_jobs
    `).get()).toEqual({
      article_id: articleId,
      source_revision_id: revisionId,
      target_locale: "en",
      state: "queued",
    });
    const detail = await current.app.request(`${ADMIN_ORIGIN}/admin/articles/${articleId}`, {
      headers: { cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("번역 요청");
    expect(html).not.toContain("pii_envelope");
    const preview = await current.app.request(`${ADMIN_ORIGIN}/admin/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Procurement registration guide");
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
    const stalePreview = await current.app.request(`${ADMIN_ORIGIN}/admin/publish/preview`, {
      headers: { cookie: session.cookie },
    });
    const stalePreviewHtml = await stalePreview.text();
    expect(stalePreviewHtml.split("<h2>제외 대상</h2>")[0]).not.toContain(
      "Stale English translation",
    );
    expect(stalePreviewHtml).toContain("Stale English translation / 승인");
    expect(stalePreviewHtml).toContain("정책만 발행");
    expect(stalePreviewHtml).not.toContain('<button type="submit" disabled');
    const releases = await current.app.request(`${ADMIN_ORIGIN}/admin/releases`, {
      headers: { cookie: session.cookie },
    });
    expect(releases.status).toBe(200);
    expect(await releases.text()).toContain("승인 글 미리보기");
    const unavailablePublish = await current.app.request(`${ADMIN_ORIGIN}/admin/publish`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        confirmation: "publish-approved", csrf: session.csrf,
      }),
    });
    expect(unavailablePublish.status).toBe(503);
  });
});

describe("administrator publication failure recovery", () => {
  it("returns sanitized HTML and preserves the public pointer when publish or rollback fails", async () => {
    const publication = {
      publish: vi.fn(async () => { throw new Error("secret /Users/wisdom/private-release"); }),
      rollback: vi.fn(async () => { throw new Error("secret rollback storage path"); }),
    };
    const current = await fixture("127.0.0.1", { articlePublication: publication });
    const session = await login(current);
    const headers = {
      origin: ADMIN_ORIGIN,
      cookie: session.cookie,
      "content-type": "application/x-www-form-urlencoded",
    };

    const publish = await current.app.request(`${ADMIN_ORIGIN}/admin/publish`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ confirmation: "publish-approved", csrf: session.csrf }),
    });
    expect(publish.status).toBe(503);
    expect(publish.headers.get("content-type")).toContain("text/html");
    const publishHtml = await publish.text();
    expect(publishHtml).toContain("공개본은 변경되지 않았습니다");
    expect(publishHtml).toContain('href="/admin/publish/preview"');
    expect(publishHtml).not.toContain("private-release");

    const rollback = await current.app.request(`${ADMIN_ORIGIN}/admin/releases/release-1/rollback`, {
      method: "POST",
      headers,
      body: new URLSearchParams({
        confirmation: "rollback-retained-release",
        csrf: session.csrf,
      }),
    });
    expect(rollback.status).toBe(503);
    expect(rollback.headers.get("content-type")).toContain("text/html");
    const rollbackHtml = await rollback.text();
    expect(rollbackHtml).toContain("공개본은 변경되지 않았습니다");
    expect(rollbackHtml).toContain('href="/admin/releases"');
    expect(rollbackHtml).not.toContain("storage path");
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
  } } = {},
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
  expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(response.headers.get("strict-transport-security")).toBeNull();
}

function cookiePair(response: Response): string {
  const header = response.headers.get("set-cookie");
  expect(header).toBeTruthy();
  return header!.split(";", 1)[0]!;
}

async function login(current: Fixture): Promise<{ cookie: string; csrf: string }> {
  const password = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
    method: "POST",
    headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "owner", password: "owner password" }),
  });
  expect(password.status).toBe(303);
  sensitiveHeaders(password);
  const preauth = cookiePair(password);
  const [, preauthValue = ""] = preauth.split("=");
  const [, preauthCsrf = ""] = preauthValue.split(".");
  const mfa = await current.app.request(`${ADMIN_ORIGIN}/admin/mfa`, {
    method: "POST",
    headers: {
      origin: ADMIN_ORIGIN,
      cookie: preauth,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      username: "owner",
      method: "totp",
      code: totpCode(totpSecret, current.now),
      csrf: preauthCsrf,
    }),
  });
  expect(mfa.status).toBe(303);
  const sessionCookie = cookiePair(mfa);
  const [, value = ""] = sessionCookie.split("=");
  const [, csrf = ""] = value.split(".");
  return { cookie: sessionCookie, csrf };
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
    const unknown = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "missing", password: "wrong" }),
    });
    const wrong = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "wrong" }),
    });
    expect([unknown.status, wrong.status]).toEqual([401, 401]);
    const genericFailureBody = await unknown.text();
    expect(genericFailureBody).toBe(await wrong.text());
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 0 });
    expect((await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner password" }),
    })).status).toBe(403);

    const passwordOnly = await current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "owner", password: "owner password" }),
    });
    expect(passwordOnly.status).toBe(303);
    const preauth = cookiePair(passwordOnly);
    const [, preauthValue = ""] = preauth.split("=");
    const [, preauthCsrf = ""] = preauthValue.split(".");
    const badMfa = await current.app.request(`${ADMIN_ORIGIN}/admin/mfa`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: preauth,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: "owner", method: "recovery", code: "invalid-recovery-code", csrf: preauthCsrf,
      }),
    });
    expect(badMfa.status).toBe(401);
    expect(await badMfa.text()).toBe(genericFailureBody);

    const authenticated = await login(current);
    expect(authenticated.cookie).toMatch(/^__Host-wisdom-admin=/);
    expect(current.database.db.sqlite.prepare("SELECT count(*) count FROM admin_sessions").get()).toEqual({ count: 1 });
  });

  it("rejects unsupported, oversized, duplicate, and overlong login forms before password KDF", async () => {
    const current = await fixture();
    const request = (body: BodyInit, contentType = "application/x-www-form-urlencoded") =>
      current.app.request(`${ADMIN_ORIGIN}/admin/login`, {
        method: "POST",
        headers: { origin: ADMIN_ORIGIN, "content-type": contentType },
        body,
      });
    const unsupported = await request(JSON.stringify({ username: "owner", password: "owner password" }), "application/json");
    const oversized = await request(`username=owner&password=${"a".repeat(17_000)}`);
    const duplicate = await request("username=owner&username=other&password=owner+password");
    const overlong = await request(new URLSearchParams({ username: "owner", password: "a".repeat(1_025) }));
    expect([
      unsupported.status, oversized.status, duplicate.status, overlong.status,
    ]).toEqual([415, 413, 400, 400]);
    for (const response of [unsupported, oversized, duplicate, overlong]) sensitiveHeaders(response);
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_login_buckets
    `).get()).toEqual({ count: 0 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM admin_pre_auth_challenges
    `).get()).toEqual({ count: 0 });
  });

  it("renders all required protected SSR pages, escapes stored PII, and enforces CSRF/CAS/logout", async () => {
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
    }
    const detail = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/consultation-1`, {
      headers: { cookie: session.cookie },
    });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain("&lt;script&gt;stored-name&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=stored-company&gt;");
    expect(html).not.toContain("<script>stored-name</script>");
    expect(html).toMatch(/<title>상담 상세<\/title>/);
    expect(html).toContain('<label for="consultation-status">다음 상태</label>');
    expect(html).toContain('<option value="" selected="" disabled="">변경할 상태를 선택하세요</option>');
    expect(html).not.toContain('<option value="received">');
    expect(html).toContain('<option value="acknowledged">확인</option>');
    const detailCsrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(detailCsrf).toBe(session.csrf);

    const missingCsrf = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status: "acknowledged", rowVersion: "1" }),
      },
    );
    expect(missingCsrf.status).toBe(403);
    const changed = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          status: "acknowledged", rowVersion: "1", csrf: detailCsrf!,
        }),
      },
    );
    expect(changed.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT status, row_version FROM consultations WHERE id = 'consultation-1'
    `).get()).toEqual({ status: "acknowledged", row_version: 2 });
    const acknowledgedDetail = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`,
      { headers: { cookie: session.cookie } },
    );
    const acknowledgedHtml = await acknowledgedDetail.text();
    expect(acknowledgedHtml).not.toContain('<option value="received">');
    expect(acknowledgedHtml).not.toContain('<option value="acknowledged">');
    expect(acknowledgedHtml).toContain('<option value="in_progress">진행 중</option>');
    const stale = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status: "closed", rowVersion: "1", confirmTerminal: "yes", csrf: detailCsrf! }),
      },
    );
    expect(stale.status).toBe(409);

    const unconfirmedTerminal = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1/status`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ status: "spam", rowVersion: "2", csrf: detailCsrf! }),
      },
    );
    expect(unconfirmedTerminal.status).toBe(422);
    expect(current.database.db.sqlite.prepare(
      "SELECT status FROM consultations WHERE id = 'consultation-1'",
    ).get()).toEqual({ status: "acknowledged" });

    current.database.db.sqlite.prepare(`
      UPDATE consultations SET status = 'closed', row_version = row_version + 1
      WHERE id = 'consultation-1'
    `).run();
    const closedDetail = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`,
      { headers: { cookie: session.cookie } },
    );
    const closedHtml = await closedDetail.text();
    expect(closedHtml).toContain("이 상담은 더 이상 상태를 변경할 수 없는 최종 단계입니다.");
    expect(closedHtml).not.toContain('/consultations/consultation-1/status');

    expect((await current.app.request(`${ADMIN_ORIGIN}/admin/logout`, {
      method: "GET", headers: { cookie: session.cookie },
    })).status).toBe(404);
    current.now += 29 * 60 * 1_000;
    const refreshedDashboard = await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    });
    expect(refreshedDashboard.status).toBe(200);
    const dashboardHtml = await refreshedDashboard.text();
    const logoutCsrf = /action="\/admin\/logout"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(dashboardHtml)?.[1];
    expect(logoutCsrf).toBe(session.csrf);
    expect(current.database.db.sqlite.prepare(`
      SELECT idle_expires_at_ms FROM admin_sessions WHERE revoked_at_ms IS NULL
    `).get()).toEqual({ idle_expires_at_ms: current.now + 30 * 60 * 1_000 });
    const logout = await current.app.request(`${ADMIN_ORIGIN}/admin/logout`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: logoutCsrf! }),
    });
    expect(logout.status).toBe(303);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    })).status).toBe(303);
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
    const dashboard = await current.app.request(`${ADMIN_ORIGIN}/admin`, {
      headers: { cookie: session.cookie },
    });
    expect(await dashboard.text()).toContain("접수: 22");
    const firstPage = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations?page=1`, {
      headers: { cookie: session.cookie },
    });
    const firstPageHtml = await firstPage.text();
    expect(firstPageHtml).toContain("receipt-22");
    expect(firstPageHtml).toContain('href="/admin/consultations?page=2"');
    expect(firstPageHtml).not.toContain("« 이전");
    const secondPage = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations?page=2`, {
      headers: { cookie: session.cookie },
    });
    const secondPageHtml = await secondPage.text();
    expect(secondPageHtml).toContain("receipt-1");
    expect(secondPageHtml).toContain('href="/admin/consultations?page=1"');
    expect(secondPageHtml).not.toContain("다음 »");
    const savedBannerPage = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations?saved=1`, {
      headers: { cookie: session.cookie },
    });
    expect(await savedBannerPage.text()).toContain("저장되었습니다.");
    const consents = await current.app.request(`${ADMIN_ORIGIN}/admin/consents`, {
      headers: { cookie: session.cookie },
    });
    expect(await consents.text()).toContain("bundle-2026-07-16");

    const notificationPage = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications`, {
      headers: { cookie: session.cookie },
    });
    const notificationHtml = await notificationPage.text();
    for (const field of ["smtpHost", "smtpPort", "smtpFrom", "smtpTo", "smtpTlsMode", "smtpSecretRef"]) {
      expect(notificationHtml).toContain(`name="${field}"`);
    }
    expect(notificationHtml).not.toMatch(/name="(?:smtp)?password"/i);
    const notificationCsrf = /action="\/admin\/notifications"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(notificationHtml)?.[1];
    expect(notificationCsrf).toBe(session.csrf);
    const postSettings = (values: Record<string, string>) => current.app.request(
      `${ADMIN_ORIGIN}/admin/notifications`,
      {
        method: "POST",
        headers: {
          origin: ADMIN_ORIGIN,
          cookie: session.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: notificationCsrf!, channel: "email", ...values }),
      },
    );
    expect((await postSettings({ enabled: "1", payloadMode: "not-a-mode" })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "full-inquiry", fullInquiryApproved: "yes",
    })).status).toBe(422);
    const smtpValues = {
      smtpHost: "smtp.example.com",
      smtpPort: "465",
      smtpFrom: "office@example.test",
      smtpTo: "owner@example.test",
      smtpTlsMode: "implicit-tls",
      smtpSecretRef: "keychain:smtp",
    };
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpTlsMode: "plaintext",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpSecretRef: "raw-password",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpPassword: "must-never-be-accepted",
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
        enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpHost,
      })).status, smtpHost).toBe(422);
    }
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues, smtpPort: "587",
    })).status).toBe(422);
    expect((await postSettings({
      enabled: "1", payloadMode: "full-inquiry", ...smtpValues,
    })).status).toBe(422);
    expect(current.database.db.sqlite.prepare(
      "SELECT count(*) count FROM notification_settings",
    ).get()).toEqual({ count: 0 });
    expect((await postSettings({
      enabled: "1", payloadMode: "receipt-only", ...smtpValues,
    })).status).toBe(303);
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
      enabled: "1", payloadMode: "full-inquiry", fullInquiryApproved: "yes", ...smtpValues,
    })).status).toBe(303);
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
    const savedNotificationHtml = await (await current.app.request(
      `${ADMIN_ORIGIN}/admin/notifications`,
      { headers: { cookie: session.cookie } },
    )).text();
    expect(savedNotificationHtml).toContain('name="enabled" value="1" checked');
    expect(savedNotificationHtml).toContain('value="full-inquiry" selected');
    const testEnqueue = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications/test`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: notificationCsrf!, channel: "email" }),
    });
    expect(testEnqueue.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT channel, purpose, state, payload_json FROM notification_outbox WHERE purpose = 'test'
    `).get()).toEqual({
      channel: "email", purpose: "test", state: "pending", payload_json: '{"test":true}',
    });
    const emailBeforeHermes = current.database.db.sqlite.prepare(`
      SELECT enabled, provider, payload_mode, config_json, secret_ref
      FROM notification_settings WHERE channel = 'email'
    `).get();
    const hermesSettings = await current.app.request(`${ADMIN_ORIGIN}/admin/notifications`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf: notificationCsrf!,
        channel: "hermes-telegram",
        enabled: "1",
        payloadMode: "receipt-only",
        smtpHost: "",
        smtpPort: "",
        smtpFrom: "",
        smtpTo: "",
        smtpTlsMode: "implicit-tls",
        smtpSecretRef: "",
      }),
    });
    expect(hermesSettings.status).toBe(303);
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
    const failures = await current.app.request(`${ADMIN_ORIGIN}/admin/failures`, {
      headers: { cookie: session.cookie },
    });
    const failuresHtml = await failures.text();
    expect(failuresHtml).toContain("failed-delivery");
    const failureCsrf = /failed-delivery\/requeue"[^>]*>[\s\S]*?name="csrf" value="([^"]+)"/.exec(failuresHtml)?.[1];
    expect(failureCsrf).toBe(session.csrf);
    const requeued = await current.app.request(`${ADMIN_ORIGIN}/admin/failures/failed-delivery/requeue`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: session.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf: failureCsrf! }),
    });
    expect(requeued.status).toBe(303);
    expect(current.database.db.sqlite.prepare(`
      SELECT state, attempt_count, delivery_cycle FROM notification_outbox WHERE id = 'failed-delivery'
    `).get()).toEqual({ state: "pending", attempt_count: 0, delivery_cycle: 2 });
    expect(current.database.db.sqlite.prepare(`
      SELECT count(*) count FROM notification_delivery_attempts WHERE outbox_id = 'failed-delivery'
    `).get()).toEqual({ count: 1 });

    current.database.db.sqlite.exec("DROP INDEX notification_outbox_lease_idx");
    const degraded = await current.app.request(`${ADMIN_ORIGIN}/admin/health`, {
      headers: { cookie: session.cookie },
    });
    expect(degraded.status).toBe(503);
    expect(await degraded.text()).toContain("not ready");
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
    expect(await withdrawn.text()).not.toContain(minted.token);
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
  });
});

describe("administrator content security policy self-consistency", () => {
  it("permits the served inline style block via a matching style-src hash", async () => {
    const current = await fixture();
    const response = await current.app.request(`${ADMIN_ORIGIN}/admin/login`);
    const html = await response.text();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    expect(style).toBeTruthy();
    const hash = `'sha256-${createHash("sha256").update(style!).digest("base64")}'`;
    const csp = response.headers.get("content-security-policy") ?? "";
    // The app-layer CSP must itself allow its inline styles, without relying on
    // an upstream (Caddy) header replacing it.
    expect(csp).toContain(`style-src 'self' ${hash}`);
    expect(csp).not.toContain("'unsafe-inline'");
  });
});

const INSERT_CONSULTATION = `
  INSERT INTO consultations (
    id, receipt_id, status, locale, category, preferred_contact,
    pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
    blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
    retention_expires_at_ms, row_version
  ) VALUES (?, ?, ?, 'ko', 'procurement', 'email', ?, 'pii-v1', ?, ?, 'pii-v1', ?, ?, ?, 10000000, 1)
`;

describe("administrator consultation list, search, and detail", () => {
  it("filters the consultation list by status", async () => {
    const current = await fixture();
    const session = await login(current);
    const env = encryptPii(keyProvider, "consultation-closed", {
      name: "n", phone: "010-0000-0000", message: "a stored consultation message long enough",
    });
    current.database.db.sqlite.prepare(INSERT_CONSULTATION).run(
      "consultation-closed", "receipt-closed", "closed", env, Buffer.alloc(32, 7), null, 0, 200, 200,
    );

    const received = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations?status=received`, { headers: { cookie: session.cookie } });
    const receivedHtml = await received.text();
    expect(received.status).toBe(200);
    expect(receivedHtml).toContain("receipt-1");
    expect(receivedHtml).not.toContain("receipt-closed");

    const closed = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations?status=closed`, { headers: { cookie: session.cookie } });
    const closedHtml = await closed.text();
    expect(closedHtml).toContain("receipt-closed");
    expect(closedHtml).not.toContain("receipt-1");
  });

  it("returns a format hint, not a 503, when a contact search value cannot be normalized", async () => {
    const current = await fixture();
    const session = await login(current);
    // A partial number or a name is a very common operator input; normalizePhone
    // rejects both. The response must stay a friendly 200, not a storage 503.
    const response = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/search`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ searchKind: "phone", q: "홍길동", csrf: session.csrf }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("검색어 형식을 확인하세요");
    expect(html).not.toContain("STORAGE_UNAVAILABLE");
    expect(html).toContain("« 전체 목록 보기");
  });

  it("finds a consultation by exact email via the blind index and reports no match otherwise", async () => {
    const current = await fixture();
    const session = await login(current);
    const env = encryptPii(keyProvider, "consultation-match", {
      name: "n", phone: "010-9999-8888", email: "match@example.test",
      message: "a stored consultation message long enough",
    });
    current.database.db.sqlite.prepare(INSERT_CONSULTATION).run(
      "consultation-match", "receipt-match", "received", env,
      blindIndex(keyProvider, "phone", "010-9999-8888"),
      blindIndex(keyProvider, "email", "match@example.test"), 0, 300, 300,
    );

    const hit = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/search`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ searchKind: "email", q: "MATCH@Example.test", csrf: session.csrf }),
    });
    expect(hit.status).toBe(200);
    const hitHtml = await hit.text();
    expect(hitHtml).toContain("receipt-match");
    expect(hitHtml).not.toContain("receipt-1");

    const miss = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/search`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ searchKind: "email", q: "nobody@example.test", csrf: session.csrf }),
    });
    expect(await miss.text()).toContain("일치하는 상담이 없습니다");
  });

  it("surfaces setup-caused cancellations on the failures screen and hides lifecycle cancellations", async () => {
    const current = await fixture();
    const session = await login(current);
    const insert = current.database.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, payload_json, state,
        attempt_count, last_error_code, available_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, 'consultation-1', ?, ?, '{}', ?, 1, ?, 100, 100, ?)
    `);
    insert.run("outbox-disabled", "email", "consultation.received", "cancelled", "CHANNEL_DISABLED", 500);
    insert.run("outbox-purged", "hermes-telegram", "consultation.received", "cancelled", "RETENTION_PURGED", 400);
    insert.run("outbox-failed", "email", "marketing.confirmation", "failed", "PROVIDER_ERROR", 600);

    const response = await current.app.request(`${ADMIN_ORIGIN}/admin/failures`, { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("채널 꺼짐");            // CHANNEL_DISABLED, localized and exposed
    expect(html).toContain("채널 설정 확인");        // non-requeueable note links to settings
    expect(html).toContain("발송 제공자 오류");       // a genuinely failed delivery
    // The screen renders the localized label, never the raw code, so the real
    // proof that the lifecycle cancellation is filtered out is its label's absence.
    expect(html).not.toContain("보유기간 만료 파기");
  });

  it("derives the marketing consent state shown on the detail", async () => {
    const current = await fixture();
    const session = await login(current);
    const accepted = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(await accepted.text()).toContain("<dt>마케팅 동의</dt><dd>동의</dd>");

    current.database.db.sqlite.prepare(
      "UPDATE consultations SET marketing_withdrawn_at_ms = 500 WHERE id = 'consultation-1'").run();
    const withdrawn = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(await withdrawn.text()).toContain("<dt>마케팅 동의</dt><dd>철회됨 (");
  });

  it("renders populated notification and status-change history on the detail", async () => {
    const current = await fixture();
    const session = await login(current);
    current.database.db.sqlite.prepare(`
      INSERT INTO notification_outbox (
        id, consultation_id, channel, event_type, payload_json, state,
        attempt_count, sent_at_ms, available_at_ms, created_at_ms, updated_at_ms
      ) VALUES ('outbox-sent', 'consultation-1', 'email', 'consultation.received', '{}', 'sent', 1, 450, 100, 100, 450)
    `).run();
    current.database.db.sqlite.prepare(`
      INSERT INTO audit_events (id, actor_type, action, target_type, target_id, request_id, metadata_json, created_at_ms)
      VALUES ('audit-status-1', 'admin', 'consultation.status.changed', 'consultation', 'consultation-1', 'req-1', ?, 500)
    `).run(JSON.stringify({ fromStatus: "received", toStatus: "acknowledged", rowVersion: 2 }));

    const response = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    const html = await response.text();
    expect(html).toContain("<td>이메일</td>");     // channel label in the history row
    expect(html).toContain("<td>발송됨</td>");      // notification-state label
    expect(html).toContain("접수 → 확인");           // localized from → to transition
  });

  it("warns on the detail only when a delivery channel is disabled", async () => {
    const current = await fixture();
    const session = await login(current);
    const setChannel = current.database.db.sqlite.prepare(`
      INSERT INTO notification_settings (channel, enabled, updated_at_ms) VALUES (?, ?, 0)
      ON CONFLICT(channel) DO UPDATE SET enabled = excluded.enabled
    `);
    setChannel.run("email", 1);
    setChannel.run("hermes-telegram", 1);
    const enabled = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(await enabled.text()).not.toContain("현재 채널이 꺼져 있어");

    setChannel.run("email", 0);
    const disabled = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(await disabled.text()).toContain("현재 채널이 꺼져 있어 발송되지 않습니다");
  });

  it("hides preference and retention fields once a consultation is purged", async () => {
    const current = await fixture();
    const session = await login(current);
    current.database.db.sqlite.prepare(`
      UPDATE consultations SET pii_envelope = NULL, pii_key_id = NULL,
        phone_blind_index = NULL, email_blind_index = NULL, blind_index_key_id = NULL,
        purged_at_ms = 900 WHERE id = 'consultation-1'
    `).run();
    const response = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("개인정보는 보유기간이 지나 파기되었습니다");
    expect(html).not.toContain("희망 연락 방법");
    expect(html).not.toContain("마케팅 동의");
    expect(html).not.toContain("파기 예정일");
    // The status form and processing-history tables are hidden on a purged record.
    expect(html).toContain("파기된 상담은 상태 변경과 처리 이력을 표시하지 않습니다");
    expect(html).not.toContain("<h2>알림 이력</h2>");
    expect(html).not.toContain("<h2>상태 변경 이력</h2>");
    expect(html).not.toContain('name="status"');
  });

  it("still surfaces a genuine storage failure as a 503 during search, not a friendly hint", async () => {
    const current = await fixture();
    const session = await login(current);
    // Break only the search path: auth reads admin_sessions (intact), so a storage
    // error inside findConsultationIdsByContact must reach onError (503) rather than
    // being masked as an invalid-input hint. A valid phone is used so normalization
    // succeeds and the failure is genuinely at the storage layer.
    current.database.db.sqlite.exec("ALTER TABLE consultations RENAME TO consultations_removed");
    const response = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/search`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ searchKind: "phone", q: "010-1234-5678", csrf: session.csrf }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("STORAGE_UNAVAILABLE");
  });

  it("caps contact-search results at 50 and says so", async () => {
    const current = await fixture();
    const session = await login(current);
    const sharedPhoneIndex = blindIndex(keyProvider, "phone", "010-5555-1234");
    const insert = current.database.db.sqlite.prepare(INSERT_CONSULTATION);
    for (let i = 0; i < 51; i++) {
      const env = encryptPii(keyProvider, `bulk-${i}`, {
        name: "n", phone: "010-5555-1234", message: "a stored consultation message long enough",
      });
      insert.run(`bulk-${i}`, `receipt-bulk-${i}`, "received", env, sharedPhoneIndex, null, 0, 1000 + i, 1000 + i);
    }
    const response = await current.app.request(`${ADMIN_ORIGIN}/admin/consultations/search`, {
      method: "POST",
      headers: { origin: ADMIN_ORIGIN, cookie: session.cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ searchKind: "phone", q: "010-5555-1234", csrf: session.csrf }),
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("일치 항목이 많아 최근 50건만 표시합니다");
    expect((html.match(/receipt-bulk-/g) ?? []).length).toBe(50);
  });

  it("keeps the status filter on the pagination links", async () => {
    const current = await fixture();
    const session = await login(current);
    const insert = current.database.db.sqlite.prepare(INSERT_CONSULTATION);
    for (let i = 0; i < 21; i++) {
      const env = encryptPii(keyProvider, `closed-${i}`, {
        name: "n", phone: "010-0000-0000", message: "a stored consultation message long enough",
      });
      insert.run(`closed-${i}`, `receipt-c-${i}`, "closed", env, Buffer.alloc(32, 20 + i), null, 0, 2000 + i, 2000 + i);
    }
    const response = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations?status=closed`, { headers: { cookie: session.cookie } });
    const html = await response.text();
    expect(html).toContain('href="/admin/consultations?status=closed&amp;page=2"');
  });

  it("shows 미동의 for a consultation that declined marketing", async () => {
    const current = await fixture();
    const session = await login(current);
    current.database.db.sqlite.prepare(
      "UPDATE consultations SET marketing_accepted = 0 WHERE id = 'consultation-1'").run();
    const response = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(await response.text()).toContain("<dt>마케팅 동의</dt><dd>미동의</dd>");
  });

  it("tolerates a corrupt status-history audit row without a 500", async () => {
    const current = await fixture();
    const session = await login(current);
    current.database.db.sqlite.prepare(`
      INSERT INTO audit_events (id, actor_type, action, target_type, target_id, request_id, metadata_json, created_at_ms)
      VALUES ('audit-broken', 'admin', 'consultation.status.changed', 'consultation', 'consultation-1', 'req-x', '{', 700)
    `).run();
    const response = await current.app.request(
      `${ADMIN_ORIGIN}/admin/consultations/consultation-1`, { headers: { cookie: session.cookie } });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("기록된 상태 변경이 없습니다");
  });
});
