import {
  createHash,
  createHmac,
  randomUUID as nodeRandomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  canonicalPublishedArticleContentBytes,
  computePublishedArticleContentSha256,
  hermesArticleDraftSchema,
  normalizeValidateAndRenderArticleMarkdown,
  type HermesArticleDraft,
} from "@wisdom/shared";

import type { KeyProvider } from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import { checkArticleForRetainedConsultationPii } from "./no-pii.js";

const ROUTE = "/internal/v1/article-drafts";
const MAX_RAW_BODY_BYTES = 256 * 1_024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const TIMESTAMP_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export interface HermesArticleDraftUnsignedRequest {
  method: string;
  route: string;
  peerAddress: string;
  timestamp: string;
  nonce: string;
  idempotencyKey: string;
  rawBody: Uint8Array;
}

export interface HermesArticleDraftRequest extends HermesArticleDraftUnsignedRequest {
  signature: string;
}

export type HermesIntakeFaultPoint =
  | "after-article"
  | "after-revision"
  | "after-head"
  | "after-audit"
  | "after-idempotency";

export interface HermesArticleDraftDependencies {
  db: ControlDatabase;
  keyProvider: KeyProvider;
  hermesSecret: Uint8Array;
  nowMs: number;
  requestId: string;
  randomUUID?: () => string;
  faultInjector?: (point: HermesIntakeFaultPoint) => void;
}

export type HermesArticleDraftResult =
  | { kind: "created"; status: 201; responseJson: string }
  | { kind: "replay"; status: 201; responseJson: string }
  | { kind: "conflict" }
  | { kind: "forbidden" }
  | { kind: "stale" }
  | { kind: "nonce-replay" }
  | { kind: "invalid-signature" }
  | { kind: "payload-too-large" }
  | { kind: "invalid-json" }
  | { kind: "validation-failed" }
  | { kind: "pii-rejected" };

interface IdempotencyRow {
  payload_fingerprint: Buffer;
  response_json: string;
}

function assertHermesSecret(secret: Uint8Array): Buffer {
  if (secret.byteLength < 32) throw new Error("Hermes HMAC secret must contain at least 32 bytes");
  return Buffer.from(secret);
}

export function isLoopbackAddress(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice("::ffff:".length));
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(octet)) return false;
    return Number(octet) <= 255;
  });
}

export function canonicalHermesArticleDraftRequest(
  request: HermesArticleDraftUnsignedRequest,
): Buffer {
  const prefix = [
    "wisdom-hermes-article-draft-v1",
    request.method,
    request.route,
    request.timestamp,
    request.nonce,
    request.idempotencyKey,
    String(request.rawBody.byteLength),
    "",
  ].join("\n");
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from(request.rawBody)]);
}

export function computeHermesArticleDraftSignature(
  secret: Uint8Array,
  request: HermesArticleDraftUnsignedRequest,
): string {
  return createHmac("sha256", assertHermesSecret(secret))
    .update(canonicalHermesArticleDraftRequest(request))
    .digest("hex");
}

function sameSignature(expectedHex: string, actualHex: string): boolean {
  if (!SIGNATURE_PATTERN.test(actualHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashToken(secret: Uint8Array, domain: "nonce" | "idempotency", value: string): Buffer {
  return createHmac("sha256", assertHermesSecret(secret))
    .update(`wisdom:hermes-article:${domain}:v1\0${value}`, "utf8")
    .digest();
}

function canonicalDraft(draft: HermesArticleDraft, bodyMarkdown: string) {
  const sources = [...draft.sources].sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));
  return {
    hermesDraftId: draft.hermesDraftId,
    sourceLocale: draft.sourceLocale,
    title: draft.title.normalize("NFC"),
    summary: draft.summary.normalize("NFC"),
    bodyMarkdown,
    sources,
  };
}

function payloadFingerprint(draft: HermesArticleDraft, bodyMarkdown: string): Buffer {
  const canonical = canonicalDraft(draft, bodyMarkdown);
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest();
}

function persistNonce(
  db: ControlDatabase,
  secret: Uint8Array,
  request: HermesArticleDraftRequest,
  signedAtMs: number,
  nowMs: number,
): boolean {
  const nonceHash = hashToken(secret, "nonce", request.nonce);
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    db.sqlite.prepare("DELETE FROM hermes_article_nonces WHERE expires_at_ms <= ?").run(nowMs);
    const existing = db.sqlite.prepare(
      "SELECT 1 present FROM hermes_article_nonces WHERE nonce_hash = ?",
    ).get(nonceHash);
    if (existing) {
      db.sqlite.exec("COMMIT");
      return false;
    }
    db.sqlite.prepare(`
      INSERT INTO hermes_article_nonces (nonce_hash, signed_at_ms, expires_at_ms)
      VALUES (?, ?, ?)
    `).run(nonceHash, signedAtMs, Math.max(signedAtMs, nowMs) + MAX_CLOCK_SKEW_MS);
    db.sqlite.exec("COMMIT");
    return true;
  } catch (error) {
    if (db.sqlite.inTransaction) db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function canonicalUuid(createId: () => string): string {
  const id = createId();
  if (!UUID_PATTERN.test(id) || id !== id.toLowerCase()) {
    throw new Error("Article identifiers must be canonical UUIDs");
  }
  return id;
}

export function acceptHermesArticleDraft(
  dependencies: HermesArticleDraftDependencies,
  request: HermesArticleDraftRequest,
): HermesArticleDraftResult {
  if (!isLoopbackAddress(request.peerAddress)) return { kind: "forbidden" };
  if (request.rawBody.byteLength > MAX_RAW_BODY_BYTES) return { kind: "payload-too-large" };
  if (
    request.method !== "POST" ||
    request.route !== ROUTE ||
    !TIMESTAMP_PATTERN.test(request.timestamp) ||
    !TOKEN_PATTERN.test(request.nonce) ||
    !TOKEN_PATTERN.test(request.idempotencyKey)
  ) return { kind: "validation-failed" };
  const signedAtMs = Number(request.timestamp);
  if (!Number.isSafeInteger(signedAtMs) || Math.abs(dependencies.nowMs - signedAtMs) > MAX_CLOCK_SKEW_MS) {
    return { kind: "stale" };
  }
  const expectedSignature = computeHermesArticleDraftSignature(dependencies.hermesSecret, request);
  if (!sameSignature(expectedSignature, request.signature)) return { kind: "invalid-signature" };

  let untrusted: unknown;
  try {
    const serialized = new TextDecoder("utf-8", { fatal: true }).decode(request.rawBody);
    untrusted = JSON.parse(serialized);
  } catch {
    return { kind: "invalid-json" };
  }
  const parsed = hermesArticleDraftSchema.safeParse(untrusted);
  if (!parsed.success || parsed.data.idempotencyKey !== request.idempotencyKey) {
    return { kind: "validation-failed" };
  }
  let bodyMarkdown: string;
  try {
    bodyMarkdown = normalizeValidateAndRenderArticleMarkdown(parsed.data.bodyMarkdown).bodyMarkdown;
  } catch {
    return { kind: "validation-failed" };
  }
  if (!persistNonce(
    dependencies.db,
    dependencies.hermesSecret,
    request,
    signedAtMs,
    dependencies.nowMs,
  )) return { kind: "nonce-replay" };

  const keyHash = hashToken(dependencies.hermesSecret, "idempotency", request.idempotencyKey);
  const fingerprint = payloadFingerprint(parsed.data, bodyMarkdown);
  const canonical = canonicalDraft(parsed.data, bodyMarkdown);
  const db = dependencies.db.sqlite;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare(`
      SELECT payload_fingerprint, response_json
      FROM hermes_article_idempotency WHERE key_hash = ?
    `).get(keyHash) as IdempotencyRow | undefined;
    if (existing) {
      const same = existing.payload_fingerprint.length === fingerprint.length &&
        timingSafeEqual(existing.payload_fingerprint, fingerprint);
      db.exec("COMMIT");
      return same
        ? { kind: "replay", status: 201, responseJson: existing.response_json }
        : { kind: "conflict" };
    }

    const pii = checkArticleForRetainedConsultationPii(
      dependencies.db,
      dependencies.keyProvider,
      [
        canonical.title,
        canonical.summary,
        canonical.bodyMarkdown,
        ...canonical.sources.flatMap((source) => [source.id, source.url]),
      ],
    );
    if (!pii.safe) {
      db.exec("ROLLBACK");
      return { kind: "pii-rejected" };
    }

    const createId = dependencies.randomUUID ?? nodeRandomUUID;
    const articleId = canonicalUuid(createId);
    const revisionId = canonicalUuid(createId);
    const auditId = canonicalUuid(createId);
    const slug = `draft-${articleId.replaceAll("-", "")}`;
    const contentSha256 = Buffer.from(computePublishedArticleContentSha256({
      title: canonical.title,
      summary: canonical.summary,
      bodyMarkdown: canonical.bodyMarkdown,
      sources: canonical.sources,
      locale: canonical.sourceLocale,
    }), "hex");
    const canonicalSourceBytes = canonicalPublishedArticleContentBytes({
      title: canonical.title,
      summary: canonical.summary,
      bodyMarkdown: canonical.bodyMarkdown,
      sources: canonical.sources,
      locale: canonical.sourceLocale,
    });
    const sourceSha256 = createHash("sha256")
      .update("wisdom:hermes-source:v1\0", "utf8")
      .update(canonical.hermesDraftId, "utf8")
      .update(canonicalSourceBytes)
      .digest();
    const sourcesJson = JSON.stringify(canonical.sources);
    const responseJson = JSON.stringify({ articleId, revisionId, state: "draft" });

    db.prepare(`
      INSERT INTO articles (
        id, slug, state, source_locale, current_revision_id,
        created_by_type, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'draft', ?, ?, 'hermes', ?, ?)
    `).run(
      articleId, slug, canonical.sourceLocale, revisionId,
      dependencies.nowMs, dependencies.nowMs,
    );
    dependencies.faultInjector?.("after-article");
    db.prepare(`
      INSERT INTO article_revisions (
        id, article_id, locale, revision_no, title, summary, body_markdown,
        content_sha256, source_revision_id, parent_revision_id, sources_json,
        prompt_sha256, schema_sha256, source_sha256, model_id,
        translation_metadata_json, initial_review_state,
        created_at_ms, created_by_type, created_by_id
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL,
        NULL, 'draft', ?, 'hermes', ?)
    `).run(
      revisionId,
      articleId,
      canonical.sourceLocale,
      canonical.title,
      canonical.summary,
      canonical.bodyMarkdown,
      contentSha256,
      sourcesJson,
      sourceSha256,
      dependencies.nowMs,
      canonical.hermesDraftId,
    );
    dependencies.faultInjector?.("after-revision");
    db.prepare(`
      INSERT INTO article_locale_heads (
        article_id, locale, slug, state, head_revision_id, row_version, updated_at_ms
      ) VALUES (?, ?, ?, 'draft', ?, 1, ?)
    `).run(articleId, canonical.sourceLocale, slug, revisionId, dependencies.nowMs);
    dependencies.faultInjector?.("after-head");
    db.prepare(`
      INSERT INTO audit_events (
        id, actor_type, actor_id, action, target_type, target_id,
        request_id, metadata_json, created_at_ms
      ) VALUES (?, 'token', 'hermes', 'article.draft_created', 'article', ?, ?, ?, ?)
    `).run(
      auditId,
      articleId,
      dependencies.requestId,
      JSON.stringify({ locale: canonical.sourceLocale, revisionId }),
      dependencies.nowMs,
    );
    dependencies.faultInjector?.("after-audit");
    db.prepare(`
      INSERT INTO hermes_article_idempotency (
        key_hash, payload_fingerprint, article_id, revision_id,
        response_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      keyHash,
      fingerprint,
      articleId,
      revisionId,
      responseJson,
      dependencies.nowMs,
    );
    dependencies.faultInjector?.("after-idempotency");
    db.exec("COMMIT");
    return { kind: "created", status: 201, responseJson };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
