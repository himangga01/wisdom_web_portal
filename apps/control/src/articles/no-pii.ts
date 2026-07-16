import {
  blindIndexCandidates,
  type KeyProvider,
} from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";

const MAX_CONTACT_CANDIDATES = 64;
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]{0,251}[A-Z0-9])?\.[A-Z]{2,63}/giu;
const MOBILE_PATTERN = /(?<!\d)(?:\+82[ .()-]*)?0?1[016789](?:[ .()-]*\d){7,8}(?!\d)/gu;

export type ArticlePiiCheckResult =
  | { safe: true }
  | { safe: false; kind: "phone" | "email" | "candidate-limit" };

function uniqueMatches(segments: readonly string[], pattern: RegExp): string[] {
  const matches = new Set<string>();
  for (const segment of segments) {
    pattern.lastIndex = 0;
    for (const match of segment.matchAll(pattern)) {
      const candidate = match[0];
      if (candidate) matches.add(candidate);
    }
  }
  return [...matches];
}

function matchesRetainedConsultation(
  db: ControlDatabase,
  provider: KeyProvider,
  kind: "phone" | "email",
  value: string,
): boolean {
  const column = kind === "phone" ? "phone_blind_index" : "email_blind_index";
  const find = db.sqlite.prepare(`
    SELECT 1 present FROM consultations
    WHERE purged_at_ms IS NULL
      AND blind_index_key_id = ?
      AND ${column} = ?
    LIMIT 1
  `);
  return blindIndexCandidates(provider, kind, value).some((candidate) =>
    find.get(candidate.keyId, candidate.index) !== undefined
  );
}

export function checkArticleForRetainedConsultationPii(
  db: ControlDatabase,
  provider: KeyProvider,
  segments: readonly string[],
): ArticlePiiCheckResult {
  const phones = uniqueMatches(segments, MOBILE_PATTERN);
  const emails = uniqueMatches(segments, EMAIL_PATTERN);
  if (phones.length + emails.length > MAX_CONTACT_CANDIDATES) {
    return { safe: false, kind: "candidate-limit" };
  }
  for (const phone of phones) {
    if (matchesRetainedConsultation(db, provider, "phone", phone)) {
      return { safe: false, kind: "phone" };
    }
  }
  for (const email of emails) {
    if (matchesRetainedConsultation(db, provider, "email", email)) {
      return { safe: false, kind: "email" };
    }
  }
  return { safe: true };
}
