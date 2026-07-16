import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test/helpers.js";
import {
  blindIndex,
  createStaticKeyProvider,
} from "../crypto/index.js";
import { closeDatabase, openDatabase } from "../db/client.js";
import {
  acceptHermesArticleDraft,
  canonicalHermesArticleDraftRequest,
  computeHermesArticleDraftSignature,
  isLoopbackAddress,
  type HermesArticleDraftRequest,
} from "./hermes-intake.js";

const NOW = Date.parse("2026-07-16T00:00:00.000Z");
const SECRET = Buffer.alloc(32, 91);
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

let testDatabase: TestDatabase | undefined;
afterEach(() => testDatabase?.close());

function draft(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: "hermes-draft-20260716-0001",
    hermesDraftId: "hermes_01JZZZZZZZZZZZZZZZZZZZZZZZ",
    sourceLocale: "ko",
    title: "Public procurement guide",
    summary: "A reviewed administrative overview.",
    bodyMarkdown: "## Start\r\n\r\nSafe guidance.\r\n",
    sources: [{
      id: "source-1",
      url: "https://example.com/source",
      sourceTimestamp: "2026-07-16T00:00:00.000Z",
    }],
    ...overrides,
  };
}

function request(
  rawBody: Uint8Array,
  overrides: Partial<HermesArticleDraftRequest> = {},
): HermesArticleDraftRequest {
  const base = {
    method: "POST" as const,
    route: "/internal/v1/article-drafts" as const,
    peerAddress: "127.0.0.1",
    timestamp: String(NOW),
    nonce: "nonce-20260716-0001",
    idempotencyKey: "hermes-draft-20260716-0001",
    rawBody,
  };
  const unsigned = { ...base, ...overrides };
  return {
    ...unsigned,
    signature: computeHermesArticleDraftSignature(SECRET, unsigned),
    ...overrides,
  };
}

function dependencies() {
  let index = 0;
  return {
    db: testDatabase!.db,
    keyProvider: createStaticKeyProvider({ id: "pii-v1", secret: Buffer.alloc(32, 7) }),
    hermesSecret: SECRET,
    nowMs: NOW,
    requestId: "request-hermes-1",
    randomUUID: () => IDS[index++]!,
  };
}

describe("Hermes article draft intake", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.255.255.254", true],
    ["::1", true],
    ["0:0:0:0:0:0:0:1", true],
    ["::ffff:127.0.0.1", true],
    ["localhost", false],
    ["127.01.0.1", false],
    ["::ffff:203.0.113.10", false],
    ["203.0.113.10", false],
  ] as const)("classifies literal peer %s as loopback=%s", (peer, expected) => {
    expect(isLoopbackAddress(peer)).toBe(expected);
  });

  it("signs an unambiguous canonical prefix followed by the exact raw body bytes", () => {
    const rawBody = Buffer.from('{"x":"raw\\r\\nbytes"}', "utf8");
    const unsigned = {
      method: "POST" as const,
      route: "/internal/v1/article-drafts" as const,
      peerAddress: "127.0.0.1",
      timestamp: "1784160000000",
      nonce: "nonce-20260716-0001",
      idempotencyKey: "hermes-draft-20260716-0001",
      rawBody,
    };
    const expected = Buffer.concat([
      Buffer.from(
        "wisdom-hermes-article-draft-v1\nPOST\n/internal/v1/article-drafts\n" +
        "1784160000000\nnonce-20260716-0001\nhermes-draft-20260716-0001\n20\n",
        "utf8",
      ),
      rawBody,
    ]);
    expect(canonicalHermesArticleDraftRequest(unsigned)).toEqual(expected);
    expect(computeHermesArticleDraftSignature(SECRET, unsigned)).toBe(
      createHmac("sha256", SECRET).update(expected).digest("hex"),
    );
  });

  it("atomically stores one immutable draft and replays the identical response", () => {
    testDatabase = createTestDatabase();
    const rawBody = Buffer.from(JSON.stringify(draft()), "utf8");
    const first = acceptHermesArticleDraft(dependencies(), request(rawBody));
    if (first.kind !== "created") throw new Error(`expected created, received ${first.kind}`);
    expect(first).toEqual({
      kind: "created",
      status: 201,
      responseJson: JSON.stringify({
        articleId: IDS[0], revisionId: IDS[1], state: "draft",
      }),
    });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT id, slug, state, source_locale, current_revision_id, created_by_type
      FROM articles
    `).get()).toEqual({
      id: IDS[0],
      slug: `draft-${IDS[0].replaceAll("-", "")}`,
      state: "draft",
      source_locale: "ko",
      current_revision_id: IDS[1],
      created_by_type: "hermes",
    });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT article_id, locale, revision_no, title, summary, body_markdown,
        initial_review_state, created_by_type, created_by_id
      FROM article_revisions
    `).get()).toEqual({
      article_id: IDS[0],
      locale: "ko",
      revision_no: 1,
      title: "Public procurement guide",
      summary: "A reviewed administrative overview.",
      body_markdown: "## Start\n\nSafe guidance.\n",
      initial_review_state: "draft",
      created_by_type: "hermes",
      created_by_id: "hermes_01JZZZZZZZZZZZZZZZZZZZZZZZ",
    });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM article_locale_heads",
    ).get()).toEqual({ count: 1 });
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM audit_events WHERE action = 'article.draft_created'",
    ).get()).toEqual({ count: 1 });
    expect(testDatabase.db.sqlite.prepare(`
      SELECT length(key_hash) key_length, length(payload_fingerprint) fingerprint_length,
        response_json FROM hermes_article_idempotency
    `).get()).toEqual({
      key_length: 32,
      fingerprint_length: 32,
      response_json: first.responseJson,
    });

    const replayRequest = request(rawBody, { nonce: "nonce-20260716-0002" });
    expect(acceptHermesArticleDraft(dependencies(), replayRequest)).toEqual({
      kind: "replay", status: 201, responseJson: first.responseJson,
    });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 1 });
  });

  it("serializes idempotency across two file-backed database connections", () => {
    testDatabase = createTestDatabase();
    const second = openDatabase(testDatabase.path);
    try {
      const rawBody = Buffer.from(JSON.stringify(draft()), "utf8");
      const first = acceptHermesArticleDraft(dependencies(), request(rawBody));
      if (first.kind !== "created") throw new Error(`expected created, received ${first.kind}`);
      const secondDependencies = { ...dependencies(), db: second };
      expect(acceptHermesArticleDraft(
        secondDependencies,
        request(rawBody, { nonce: "nonce-second-connection-0001" }),
      )).toEqual({
        kind: "replay", status: 201, responseJson: first.responseJson,
      });
      const changedBody = Buffer.from(JSON.stringify(draft({ title: "Changed title" })), "utf8");
      expect(acceptHermesArticleDraft(
        secondDependencies,
        request(changedBody, { nonce: "nonce-second-connection-0002" }),
      )).toEqual({ kind: "conflict" });
      expect(second.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 1 });
      expect(second.sqlite.prepare("SELECT count(*) count FROM article_revisions").get()).toEqual({ count: 1 });
    } finally {
      closeDatabase(second);
    }
  });

  it("rejects nonce replay and same-key payload conflicts", () => {
    testDatabase = createTestDatabase();
    const rawBody = Buffer.from(JSON.stringify(draft()), "utf8");
    const original = request(rawBody);
    expect(acceptHermesArticleDraft(dependencies(), original).kind).toBe("created");
    expect(acceptHermesArticleDraft(dependencies(), original)).toEqual({ kind: "nonce-replay" });

    const changedBody = Buffer.from(JSON.stringify(draft({ title: "Changed title" })), "utf8");
    expect(acceptHermesArticleDraft(
      dependencies(),
      request(changedBody, { nonce: "nonce-20260716-0003" }),
    )).toEqual({ kind: "conflict" });
  });

  it("rejects non-loopback, stale, malformed, mismatched, and invalid signatures without persisting a nonce", () => {
    testDatabase = createTestDatabase();
    const rawBody = Buffer.from(JSON.stringify(draft()), "utf8");
    const cases: Array<[Partial<HermesArticleDraftRequest>, string]> = [
      [{ peerAddress: "203.0.113.10" }, "forbidden"],
      [{ peerAddress: "localhost" }, "forbidden"],
      [{ timestamp: String(NOW - 300_001) }, "stale"],
      [{ idempotencyKey: "different-key-0000001" }, "validation-failed"],
      [{ signature: "0".repeat(64) }, "invalid-signature"],
    ];
    for (const [overrides, expectedKind] of cases) {
      const candidate = request(rawBody, {
        nonce: `nonce-${expectedKind}-0000000001`.slice(0, 64),
        ...overrides,
      });
      expect(acceptHermesArticleDraft(dependencies(), candidate).kind).toBe(expectedKind);
    }
    expect(testDatabase.db.sqlite.prepare(
      "SELECT count(*) count FROM hermes_article_nonces",
    ).get()).toEqual({ count: 0 });
  });

  it("enforces the raw 256 KiB boundary before JSON parsing", () => {
    testDatabase = createTestDatabase();
    const atLimit = Buffer.alloc(256 * 1_024, 0x20);
    const overLimit = Buffer.alloc(256 * 1_024 + 1, 0x20);
    expect(acceptHermesArticleDraft(dependencies(), request(atLimit))).toEqual({ kind: "invalid-json" });
    expect(acceptHermesArticleDraft(
      dependencies(),
      request(overLimit, { nonce: "nonce-over-limit-0001" }),
    )).toEqual({ kind: "payload-too-large" });
  });

  it("rejects unsafe Markdown and retained consultation PII before article persistence", () => {
    testDatabase = createTestDatabase();
    const deps = dependencies();
    testDatabase.db.sqlite.prepare(`
      INSERT INTO consultations (
        id, receipt_id, status, locale, category, preferred_contact,
        pii_envelope, pii_key_id, phone_blind_index, email_blind_index,
        blind_index_key_id, marketing_accepted, received_at_ms, updated_at_ms,
        retention_expires_at_ms, row_version
      ) VALUES ('private-row', 'private-receipt', 'received', 'ko', 'procurement', 'email',
        'opaque', ?, ?, ?, ?, 0, 0, 0, 999999, 1)
    `).run(
      deps.keyProvider.active().id,
      blindIndex(deps.keyProvider, "phone", "+821012345678"),
      blindIndex(deps.keyProvider, "email", "private@example.com"),
      deps.keyProvider.active().id,
    );
    const unsafe = Buffer.from(JSON.stringify(draft({
      bodyMarkdown: "<script>secret</script>",
    })), "utf8");
    expect(acceptHermesArticleDraft(deps, request(unsafe))).toEqual({ kind: "validation-failed" });
    const pii = Buffer.from(JSON.stringify(draft({
      bodyMarkdown: "Private contact: private@example.com",
    })), "utf8");
    expect(acceptHermesArticleDraft(
      deps,
      request(pii, { nonce: "nonce-private-pii-0001" }),
    )).toEqual({ kind: "pii-rejected" });
    expect(testDatabase.db.sqlite.prepare("SELECT count(*) count FROM articles").get()).toEqual({ count: 0 });
  });

  it("rolls back article, revision, head, audit, and idempotency together on a fault", () => {
    testDatabase = createTestDatabase();
    const rawBody = Buffer.from(JSON.stringify(draft()), "utf8");
    expect(() => acceptHermesArticleDraft(
      { ...dependencies(), faultInjector: (point) => {
        if (point === "after-revision") throw new Error("simulated fault");
      } },
      request(rawBody),
    )).toThrow("simulated fault");
    for (const table of [
      "articles", "article_revisions", "article_locale_heads", "audit_events",
      "hermes_article_idempotency",
    ]) expect(testDatabase.db.sqlite.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
  });
});
