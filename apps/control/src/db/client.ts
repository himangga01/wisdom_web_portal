import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { drizzleSchema, SCHEMA_VERSION } from "./schema.js";

export interface ControlDatabase {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof drizzleSchema>;
}

const INITIAL_MIGRATION = `
CREATE TABLE consultations (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','acknowledged','in_progress','closed','spam')),
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  category TEXT NOT NULL CHECK (category IN ('procurement','credibility','safety-esg','business-certification','licensing-entity','immigration-visa','other')),
  preferred_contact TEXT NOT NULL CHECK (preferred_contact IN ('phone','email')),
  pii_envelope TEXT,
  pii_key_id TEXT,
  phone_blind_index BLOB,
  email_blind_index BLOB,
  blind_index_key_id TEXT,
  marketing_accepted INTEGER NOT NULL CHECK (marketing_accepted IN (0,1)),
  received_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  retention_expires_at_ms INTEGER NOT NULL,
  purged_at_ms INTEGER,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  CHECK (
    (purged_at_ms IS NULL AND pii_envelope IS NOT NULL AND pii_key_id IS NOT NULL AND phone_blind_index IS NOT NULL AND blind_index_key_id IS NOT NULL)
    OR
    (purged_at_ms IS NOT NULL AND pii_envelope IS NULL AND pii_key_id IS NULL AND phone_blind_index IS NULL AND email_blind_index IS NULL AND blind_index_key_id IS NULL)
  )
);
CREATE UNIQUE INDEX consultations_receipt_uidx ON consultations(receipt_id);
CREATE INDEX consultations_status_received_idx ON consultations(status, received_at_ms);
CREATE INDEX consultations_retention_due_idx ON consultations(retention_expires_at_ms) WHERE purged_at_ms IS NULL;
CREATE INDEX consultations_phone_blind_idx ON consultations(blind_index_key_id, phone_blind_index);
CREATE INDEX consultations_email_blind_idx ON consultations(blind_index_key_id, email_blind_index);

CREATE TABLE consent_documents (
  id TEXT PRIMARY KEY,
  bundle_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('privacy','marketing')),
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  version TEXT NOT NULL,
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
  retention_months INTEGER NOT NULL CHECK (retention_months IN (12,24)),
  state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retired')),
  effective_at_ms INTEGER,
  retired_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  created_by_admin_id TEXT
);
CREATE UNIQUE INDEX consent_documents_identity_uidx ON consent_documents(kind, locale, version);
CREATE UNIQUE INDEX consent_documents_one_active_uidx ON consent_documents(kind, locale) WHERE state = 'active';
CREATE INDEX consent_documents_bundle_idx ON consent_documents(bundle_id, state);
CREATE INDEX consent_documents_state_kind_locale_idx ON consent_documents(state, kind, locale);

CREATE TABLE consent_events (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL REFERENCES consent_documents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('privacy','marketing')),
  decision TEXT NOT NULL CHECK (decision IN ('accepted','declined','withdrawn')),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  document_version TEXT NOT NULL,
  document_sha256 BLOB NOT NULL CHECK (length(document_sha256) = 32),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('visitor','admin','token','system')),
  request_id TEXT NOT NULL,
  metadata_json TEXT,
  occurred_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX consent_events_sequence_uidx ON consent_events(consultation_id, kind, sequence);
CREATE INDEX consent_events_consultation_time_idx ON consent_events(consultation_id, occurred_at_ms);
CREATE INDEX consent_events_document_time_idx ON consent_events(document_id, occurred_at_ms);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key_hash BLOB NOT NULL CHECK (length(key_hash) = 32),
  request_fingerprint BLOB NOT NULL CHECK (length(request_fingerprint) = 32),
  consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  response_status INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash)
) WITHOUT ROWID;
CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at_ms);
CREATE INDEX idempotency_consultation_idx ON idempotency_keys(consultation_id);

CREATE TABLE abuse_buckets (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('ip','phone','email')),
  subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
  window_kind TEXT NOT NULL CHECK (window_kind IN ('ten_minute','day')),
  window_start_ms INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_hash, window_kind, window_start_ms)
) WITHOUT ROWID;
CREATE INDEX abuse_buckets_expiry_idx ON abuse_buckets(expires_at_ms);

CREATE TABLE notification_outbox (
  id TEXT PRIMARY KEY,
  consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email','hermes-telegram')),
  event_type TEXT NOT NULL,
  payload_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','sent','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  locked_at_ms INTEGER,
  locked_by TEXT,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER
);
CREATE UNIQUE INDEX notification_outbox_event_uidx ON notification_outbox(consultation_id, channel, event_type);
CREATE INDEX notification_outbox_queue_idx ON notification_outbox(state, available_at_ms);

CREATE TABLE notification_settings (
  channel TEXT PRIMARY KEY CHECK (channel IN ('email','hermes-telegram')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  provider TEXT,
  payload_mode TEXT CHECK (payload_mode IS NULL OR payload_mode IN ('receipt-only','full-inquiry')),
  secret_ref TEXT,
  config_json TEXT,
  updated_at_ms INTEGER NOT NULL,
  updated_by_admin_id TEXT
);

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret_envelope TEXT,
  totp_key_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_login_at_ms INTEGER
);

CREATE TABLE admin_sessions (
  token_hash BLOB PRIMARY KEY CHECK (length(token_hash) = 32),
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_hash BLOB NOT NULL CHECK (length(csrf_hash) = 32),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  idle_expires_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER
);
CREATE INDEX admin_sessions_admin_expiry_idx ON admin_sessions(admin_id, expires_at_ms);

CREATE TABLE articles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('draft','in_review','approved','published','rejected')),
  source_locale TEXT NOT NULL CHECK (source_locale IN ('ko','en','zh-Hans','zh-Hant')),
  current_revision_id TEXT,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('admin','hermes','system')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  published_at_ms INTEGER
);

CREATE TABLE article_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  body_markdown TEXT NOT NULL,
  content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
  sources_json TEXT NOT NULL,
  translation_metadata_json TEXT,
  review_state TEXT NOT NULL CHECK (review_state IN ('draft','in_review','approved','rejected')),
  created_at_ms INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (article_id, locale, revision_no)
);
CREATE INDEX article_revisions_article_locale_idx ON article_revisions(article_id, locale, revision_no DESC);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  payload_json TEXT NOT NULL,
  dedupe_key TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  locked_at_ms INTEGER,
  finished_at_ms INTEGER,
  locked_by TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE UNIQUE INDEX jobs_dedupe_uidx ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_queue_idx ON jobs(state, available_at_ms);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256) = 32),
  state TEXT NOT NULL CHECK (state IN ('building','active','retired','failed')),
  created_at_ms INTEGER NOT NULL,
  activated_at_ms INTEGER,
  rolled_back_at_ms INTEGER,
  created_by TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('visitor','admin','token','system')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  request_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at_ms INTEGER NOT NULL
);
CREATE INDEX audit_events_created_idx ON audit_events(created_at_ms);
CREATE INDEX audit_events_target_idx ON audit_events(target_type, target_id, created_at_ms);
`;

function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("secure_delete = ON");
}

export function openDatabase(path: string): ControlDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  applyPragmas(sqlite);
  return { sqlite, orm: drizzle(sqlite, { schema: drizzleSchema }) };
}

export function runMigrations(db: ControlDatabase, nowMs = Date.now()): void {
  const { sqlite } = db;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);
  const applied = sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(SCHEMA_VERSION);
  if (applied) return;

  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(INITIAL_MIGRATION);
    sqlite.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
    ).run(SCHEMA_VERSION, "initial-control-schema", nowMs);
    sqlite.exec("COMMIT");
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

export function closeDatabase(db: ControlDatabase): void {
  if (db.sqlite.open) db.sqlite.close();
}

export function isDatabaseReady(db: ControlDatabase): boolean {
  try {
    const row = db.sqlite.prepare("SELECT max(version) version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version === SCHEMA_VERSION;
  } catch {
    return false;
  }
}
