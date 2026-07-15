import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  drizzleSchema,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  SCHEMA_VERSION,
} from "./schema.js";

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

const SECOND_MIGRATION = `
ALTER TABLE consultations ADD COLUMN marketing_withdrawn_at_ms INTEGER
  CHECK (marketing_withdrawn_at_ms IS NULL OR marketing_accepted = 1);
ALTER TABLE admins ADD COLUMN totp_last_counter INTEGER
  CHECK (totp_last_counter IS NULL OR totp_last_counter >= 0);
ALTER TABLE notification_outbox ADD COLUMN lease_expires_at_ms INTEGER
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0);
ALTER TABLE notification_outbox ADD COLUMN purpose TEXT NOT NULL DEFAULT 'transactional'
  CHECK (purpose IN ('transactional','marketing','test'));
ALTER TABLE notification_outbox ADD COLUMN delivery_cycle INTEGER NOT NULL DEFAULT 1
  CHECK (delivery_cycle > 0);

UPDATE notification_outbox
SET state = 'pending', locked_at_ms = NULL, lease_expires_at_ms = NULL, locked_by = NULL
WHERE state = 'processing';

CREATE TABLE admin_recovery_codes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash BLOB NOT NULL CHECK (length(code_hash) = 32),
  created_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  UNIQUE (admin_id, code_hash)
);
CREATE INDEX admin_recovery_codes_unused_idx
  ON admin_recovery_codes(admin_id, used_at_ms);

CREATE TABLE admin_pre_auth_challenges (
  challenge_hash BLOB PRIMARY KEY NOT NULL CHECK (length(challenge_hash) = 32),
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_hash BLOB NOT NULL CHECK (length(csrf_hash) = 32),
  pending_password_hash TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX admin_pre_auth_expiry_idx
  ON admin_pre_auth_challenges(expires_at_ms, used_at_ms);

CREATE TABLE admin_login_buckets (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('username','source')),
  subject_hash BLOB NOT NULL CHECK (length(subject_hash) = 32),
  window_start_ms INTEGER NOT NULL,
  failure_count INTEGER NOT NULL CHECK (failure_count > 0),
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_hash, window_start_ms),
  CHECK (expires_at_ms > window_start_ms)
) WITHOUT ROWID;
CREATE INDEX admin_login_buckets_expiry_idx ON admin_login_buckets(expires_at_ms);

CREATE TABLE admin_login_admissions (
  id TEXT PRIMARY KEY,
  username_hash BLOB NOT NULL CHECK (length(username_hash) = 32),
  source_hash BLOB NOT NULL CHECK (length(source_hash) = 32),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX admin_login_admissions_username_idx
  ON admin_login_admissions(username_hash, expires_at_ms);
CREATE INDEX admin_login_admissions_source_idx
  ON admin_login_admissions(source_hash, expires_at_ms);

CREATE TABLE notification_delivery_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES notification_outbox(id) ON DELETE CASCADE,
  delivery_cycle INTEGER NOT NULL CHECK (delivery_cycle > 0),
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  worker_id TEXT NOT NULL,
  outcome_code TEXT,
  provider_message_id TEXT,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  UNIQUE (outbox_id, delivery_cycle, attempt_no)
);
CREATE INDEX notification_delivery_attempts_outbox_idx
  ON notification_delivery_attempts(outbox_id, started_at_ms);
CREATE INDEX notification_outbox_lease_idx
  ON notification_outbox(state, available_at_ms, lease_expires_at_ms);

CREATE TABLE marketing_withdrawal_capabilities (
  token_hash BLOB PRIMARY KEY NOT NULL CHECK (length(token_hash) = 32),
  consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
  consent_event_id TEXT NOT NULL REFERENCES consent_events(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  landing_hash BLOB CHECK (landing_hash IS NULL OR length(landing_hash) = 32),
  landing_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  used_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX marketing_withdrawal_consultation_idx
  ON marketing_withdrawal_capabilities(consultation_id, used_at_ms, expires_at_ms);
CREATE TRIGGER marketing_withdrawal_capability_consent_insert
BEFORE INSERT ON marketing_withdrawal_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM consent_events e
  JOIN consultations c ON c.id = NEW.consultation_id
  WHERE e.id = NEW.consent_event_id
    AND e.consultation_id = NEW.consultation_id
    AND e.kind = 'marketing'
    AND e.decision = 'accepted'
    AND c.marketing_accepted = 1
)
BEGIN
  SELECT RAISE(ABORT, 'withdrawal capability requires the matching accepted marketing consent');
END;
CREATE TRIGGER marketing_withdrawal_capability_consent_update
BEFORE UPDATE OF consultation_id, consent_event_id ON marketing_withdrawal_capabilities
WHEN NOT EXISTS (
  SELECT 1 FROM consent_events e
  JOIN consultations c ON c.id = NEW.consultation_id
  WHERE e.id = NEW.consent_event_id
    AND e.consultation_id = NEW.consultation_id
    AND e.kind = 'marketing'
    AND e.decision = 'accepted'
    AND c.marketing_accepted = 1
)
BEGIN
  SELECT RAISE(ABORT, 'withdrawal capability requires the matching accepted marketing consent');
END;
`;

const MIGRATIONS = [
  { version: 1, name: "initial-control-schema", sql: INITIAL_MIGRATION },
  { version: 2, name: "admin-notification-withdrawal", sql: SECOND_MIGRATION },
] as const;

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

export function runMigrations(
  db: ControlDatabase,
  nowMs = Date.now(),
  targetVersion = SCHEMA_VERSION,
): void {
  const { sqlite } = db;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > SCHEMA_VERSION) {
    throw new Error("Unsupported schema migration target");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `);
  const appliedRows = sqlite.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
  }>;
  if (
    appliedRows.length > MIGRATIONS.length ||
    appliedRows.some((row, index) => {
      const expected = MIGRATIONS[index];
      return expected === undefined || row.version !== expected.version || row.name !== expected.name;
    })
  ) {
    throw new Error("Database migration history is not an exact contiguous known prefix");
  }
  const applied = new Set(appliedRows.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (migration.version > targetVersion || applied.has(migration.version)) continue;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      sqlite.exec(migration.sql);
      sqlite.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, nowMs);
      sqlite.exec("COMMIT");
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

export function closeDatabase(db: ControlDatabase): void {
  if (db.sqlite.open) db.sqlite.close();
}

export function isDatabaseReady(db: ControlDatabase): boolean {
  try {
    const history = db.sqlite.prepare(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    ).all() as Array<{ version: number; name: string }>;
    if (
      history.length !== MIGRATIONS.length ||
      history.some((row, index) => {
        const expected = MIGRATIONS[index];
        return expected === undefined || row.version !== expected.version || row.name !== expected.name;
      })
    ) return false;

    const schemaObjects = db.sqlite.prepare(`
      SELECT type, name FROM sqlite_master
      WHERE type IN ('table', 'index')
    `).all() as Array<{ type: "table" | "index"; name: string }>;
    const tables = new Set(schemaObjects.filter((item) => item.type === "table").map((item) => item.name));
    const indexes = new Set(schemaObjects.filter((item) => item.type === "index").map((item) => item.name));
    if (!REQUIRED_TABLES.every((name) => tables.has(name))) return false;
    if (!REQUIRED_INDEXES.every((name) => indexes.has(name))) return false;

    const requiredColumns = {
      consultations: ["marketing_withdrawn_at_ms"],
      admins: ["totp_last_counter"],
      notification_outbox: ["lease_expires_at_ms", "purpose", "delivery_cycle"],
    } as const;
    return Object.entries(requiredColumns).every(([table, names]) => {
      const columns = db.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
      const present = new Set(columns.map((column) => column.name));
      return names.every((name) => present.has(name));
    });
  } catch {
    return false;
  }
}
