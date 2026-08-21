import {
  blindIndexCandidates,
  decryptPii,
  type ConsultationPii,
  type KeyProvider,
} from "../crypto/index.js";
import type { ControlDatabase } from "../db/client.js";
import type { SealedPublicationRelease } from "./publication-build.js";

const MAX_CONTACT_CANDIDATES = 64;
const MIN_MESSAGE_FRAGMENT_CHARACTERS = 16;
const EMAIL_PATTERN = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]{0,251}[A-Z0-9])?\.[A-Z]{2,63}/giu;
const MOBILE_PATTERN = /(?<!\d)(?:\+82[ .()-]*)?0?1[016789](?:[ .()-]*\d){7,8}(?!\d)/gu;

export type ArticlePiiCheckResult =
  | { safe: true }
  | {
    safe: false;
    kind: "phone" | "email" | "name" | "company" | "message" |
      "candidate-limit" | "decrypt-failed";
  };

interface RetainedConsultationRow {
  id: string;
  pii_envelope: string | null;
}

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

function compactSensitiveText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function containsExactSensitiveValue(article: readonly string[], value: string): boolean {
  const compactValue = compactSensitiveText(value);
  return compactValue.length > 0 && article.some((segment) => segment.includes(compactValue));
}

function messageFragments(segments: readonly string[]): Set<string> {
  const fragments = new Set<string>();
  for (const segment of segments) {
    const characters = [...segment];
    for (let index = 0; index <= characters.length - MIN_MESSAGE_FRAGMENT_CHARACTERS; index += 1) {
      fragments.add(characters.slice(index, index + MIN_MESSAGE_FRAGMENT_CHARACTERS).join(""));
    }
  }
  return fragments;
}

function containsMeaningfulMessageFragment(articleFragments: ReadonlySet<string>, message: string): boolean {
  const messageCharacters = [...compactSensitiveText(message)];
  if (messageCharacters.length < MIN_MESSAGE_FRAGMENT_CHARACTERS) return false;
  for (let index = 0; index <= messageCharacters.length - MIN_MESSAGE_FRAGMENT_CHARACTERS; index += 1) {
    const fragment = messageCharacters
      .slice(index, index + MIN_MESSAGE_FRAGMENT_CHARACTERS)
      .join("");
    if (articleFragments.has(fragment)) return true;
  }
  return false;
}

function matchesEncryptedRetainedConsultation(
  db: ControlDatabase,
  provider: KeyProvider,
  segments: readonly string[],
): ArticlePiiCheckResult {
  const compactArticle = segments.map(compactSensitiveText);
  const articleMessageFragments = messageFragments(compactArticle);
  const retained = db.sqlite.prepare(`
    SELECT id, pii_envelope
    FROM consultations
    WHERE purged_at_ms IS NULL
    ORDER BY id
  `).iterate() as Iterable<RetainedConsultationRow>;
  for (const row of retained) {
    if (typeof row.pii_envelope !== "string") {
      return { safe: false, kind: "decrypt-failed" };
    }
    let pii: ConsultationPii;
    try {
      pii = decryptPii(provider, row.id, row.pii_envelope);
    } catch {
      return { safe: false, kind: "decrypt-failed" };
    }
    if (containsExactSensitiveValue(compactArticle, pii.phone)) {
      return { safe: false, kind: "phone" };
    }
    if (pii.email && containsExactSensitiveValue(compactArticle, pii.email)) {
      return { safe: false, kind: "email" };
    }
    if (containsExactSensitiveValue(compactArticle, pii.name)) {
      return { safe: false, kind: "name" };
    }
    if (pii.company && containsExactSensitiveValue(compactArticle, pii.company)) {
      return { safe: false, kind: "company" };
    }
    if (containsMeaningfulMessageFragment(articleMessageFragments, pii.message)) {
      return { safe: false, kind: "message" };
    }
  }
  return { safe: true };
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
  return matchesEncryptedRetainedConsultation(db, provider, segments);
}

export function collectReleasePiiSegments(
  release: SealedPublicationRelease,
): string[] {
  return [
    ...release.publicTextSegments,
    ...release.consentBundle.documents.flatMap(
      (document) => [document.title, document.bodyMarkdown],
    ),
    ...release.documents.flatMap((document) => [
      document.title,
      document.summary,
      document.bodyMarkdown,
      document.slug,
      document.route,
      ...document.sources.flatMap((source) => [source.id, source.url]),
    ]),
  ];
}
