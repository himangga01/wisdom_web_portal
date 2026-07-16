import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import {
  validateCanonicalConsentBundleRows,
  type ConsentBundleRow,
} from "../consent/bundle-validation.js";
import {
  drizzleSchema,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
  REQUIRED_TRIGGERS,
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

const THIRD_MIGRATION = `
DROP INDEX article_revisions_article_locale_idx;
ALTER TABLE article_revisions RENAME TO article_revisions_v1;

CREATE TABLE article_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  revision_no INTEGER NOT NULL CHECK (revision_no > 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  body_markdown TEXT NOT NULL,
  content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
  source_revision_id TEXT,
  parent_revision_id TEXT,
  sources_json TEXT NOT NULL,
  prompt_sha256 BLOB CHECK (prompt_sha256 IS NULL OR length(prompt_sha256) = 32),
  schema_sha256 BLOB CHECK (schema_sha256 IS NULL OR length(schema_sha256) = 32),
  source_sha256 BLOB NOT NULL CHECK (length(source_sha256) = 32),
  model_id TEXT,
  translation_metadata_json TEXT,
  initial_review_state TEXT NOT NULL CHECK (initial_review_state IN ('draft','in_review','approved','rejected')),
  created_at_ms INTEGER NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('admin','hermes','codex','system')),
  created_by_id TEXT NOT NULL,
  UNIQUE (article_id, locale, revision_no),
  UNIQUE (id, article_id),
  UNIQUE (id, article_id, locale),
  FOREIGN KEY (source_revision_id, article_id)
    REFERENCES article_revisions(id, article_id) ON DELETE RESTRICT,
  FOREIGN KEY (parent_revision_id, article_id, locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT,
  CHECK (source_revision_id IS NULL OR source_revision_id <> id),
  CHECK (parent_revision_id IS NULL OR parent_revision_id <> id),
  CHECK (
    created_by_type <> 'codex'
    OR (
      source_revision_id IS NOT NULL
      AND prompt_sha256 IS NOT NULL
      AND schema_sha256 IS NOT NULL
      AND model_id IS NOT NULL
      AND length(trim(model_id)) > 0
    )
  )
);
CREATE INDEX article_revisions_article_locale_idx
  ON article_revisions(article_id, locale, revision_no DESC);
CREATE INDEX article_revisions_source_idx ON article_revisions(source_revision_id);

INSERT INTO article_revisions (
  id, article_id, locale, revision_no, title, summary, body_markdown,
  content_sha256, source_revision_id, parent_revision_id, sources_json,
  prompt_sha256, schema_sha256, source_sha256, model_id,
  translation_metadata_json, initial_review_state,
  created_at_ms, created_by_type, created_by_id
)
SELECT
  r.id, r.article_id, r.locale, r.revision_no,
  CASE
    WHEN length(a.slug) BETWEEN 1 AND 200 AND a.slug NOT GLOB '*[^ -~]*'
      THEN a.slug
    ELSE 'Legacy article ' || lower(substr(hex(r.article_id), 1, 120))
      || '-' || printf('%016x', a.rowid)
  END,
  '', r.body_markdown,
  r.content_sha256, NULL, NULL, r.sources_json,
  NULL, NULL, r.content_sha256, NULL,
  r.translation_metadata_json, r.review_state,
  r.created_at_ms,
  'system',
  r.created_by
FROM article_revisions_v1 r
JOIN articles a ON a.id = r.article_id;

DROP TABLE article_revisions_v1;

CREATE TRIGGER article_revisions_immutable_update
BEFORE UPDATE ON article_revisions BEGIN
  SELECT RAISE(ABORT, 'article revisions are immutable');
END;
CREATE TRIGGER article_revisions_immutable_delete
BEFORE DELETE ON article_revisions BEGIN
  SELECT RAISE(ABORT, 'article revisions are immutable');
END;

CREATE TABLE article_locale_heads (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  slug TEXT NOT NULL CHECK (
    length(slug) BETWEEN 1 AND 96
    AND slug = lower(slug)
    AND slug NOT GLOB '*[^a-z0-9-]*'
    AND slug NOT LIKE '-%'
    AND slug NOT LIKE '%-'
    AND slug NOT LIKE '%--%'
  ),
  state TEXT NOT NULL CHECK (state IN ('draft','in_review','approved','published','rejected')),
  head_revision_id TEXT NOT NULL,
  approved_revision_id TEXT,
  published_revision_id TEXT,
  reviewed_by_admin_id TEXT REFERENCES admins(id) ON DELETE RESTRICT,
  reviewed_at_ms INTEGER,
  approved_by_admin_id TEXT REFERENCES admins(id) ON DELETE RESTRICT,
  approved_at_ms INTEGER,
  published_at_ms INTEGER,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version > 0),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (article_id, locale),
  UNIQUE (locale, slug),
  FOREIGN KEY (head_revision_id, article_id, locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT,
  FOREIGN KEY (approved_revision_id, article_id, locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT,
  FOREIGN KEY (published_revision_id, article_id, locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT,
  CHECK (reviewed_at_ms IS NULL OR reviewed_by_admin_id IS NOT NULL),
  CHECK (
    (state IN ('draft','in_review','rejected')
      AND approved_revision_id IS NULL AND published_revision_id IS NULL
      AND approved_by_admin_id IS NULL
      AND approved_at_ms IS NULL AND published_at_ms IS NULL)
    OR
    (state = 'approved' AND approved_revision_id = head_revision_id
      AND published_revision_id IS NULL AND approved_by_admin_id IS NOT NULL
      AND approved_at_ms IS NOT NULL AND published_at_ms IS NULL)
    OR
    (state = 'published' AND approved_revision_id = head_revision_id
      AND published_revision_id = head_revision_id
      AND approved_by_admin_id IS NOT NULL
      AND approved_at_ms IS NOT NULL AND published_at_ms IS NOT NULL)
  )
);
CREATE INDEX article_locale_heads_state_idx ON article_locale_heads(state, updated_at_ms);
CREATE INDEX article_locale_heads_published_idx
  ON article_locale_heads(locale, published_at_ms) WHERE state = 'published';

INSERT INTO article_locale_heads (
  article_id, locale, slug, state, head_revision_id,
  approved_revision_id, published_revision_id,
  approved_at_ms, published_at_ms, row_version, updated_at_ms
)
SELECT
  r.article_id, r.locale,
  'legacy-v3-' || printf('%016x', a.rowid),
  CASE
    WHEN r.initial_review_state = 'approved' THEN 'in_review'
    ELSE r.initial_review_state
  END,
  r.id,
  NULL,
  NULL,
  NULL,
  NULL,
  1, a.updated_at_ms
FROM article_revisions r
JOIN articles a ON a.id = r.article_id
WHERE r.revision_no = (
  SELECT MAX(latest.revision_no) FROM article_revisions latest
  WHERE latest.article_id = r.article_id AND latest.locale = r.locale
);

CREATE TABLE article_translation_jobs (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  source_revision_id TEXT NOT NULL,
  target_locale TEXT NOT NULL CHECK (target_locale IN ('ko','en','zh-Hans','zh-Hant')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled')),
  input_sha256 BLOB NOT NULL CHECK (length(input_sha256) = 32),
  dedupe_key TEXT NOT NULL UNIQUE,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  locked_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  heartbeat_at_ms INTEGER,
  locked_by TEXT,
  fencing_token BLOB CHECK (fencing_token IS NULL OR length(fencing_token) = 32),
  result_revision_id TEXT,
  last_error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  UNIQUE (id, article_id, source_revision_id, target_locale),
  FOREIGN KEY (source_revision_id, article_id)
    REFERENCES article_revisions(id, article_id) ON DELETE RESTRICT,
  FOREIGN KEY (result_revision_id, article_id, target_locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT,
  CHECK (
    (state = 'running' AND locked_at_ms IS NOT NULL AND lease_expires_at_ms IS NOT NULL
      AND heartbeat_at_ms IS NOT NULL AND locked_by IS NOT NULL AND fencing_token IS NOT NULL)
    OR
    (state <> 'running' AND locked_at_ms IS NULL AND lease_expires_at_ms IS NULL
      AND heartbeat_at_ms IS NULL AND locked_by IS NULL AND fencing_token IS NULL)
  ),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms > locked_at_ms),
  CHECK (
    (state IN ('queued','running') AND result_revision_id IS NULL AND finished_at_ms IS NULL)
    OR (state = 'succeeded' AND result_revision_id IS NOT NULL AND finished_at_ms IS NOT NULL)
    OR (state IN ('failed','cancelled') AND result_revision_id IS NULL AND finished_at_ms IS NOT NULL)
  ),
  CHECK (finished_at_ms IS NULL OR finished_at_ms >= created_at_ms)
);
CREATE UNIQUE INDEX article_translation_jobs_one_running_uidx
  ON article_translation_jobs((1)) WHERE state = 'running';
CREATE INDEX article_translation_jobs_queue_idx
  ON article_translation_jobs(state, available_at_ms, lease_expires_at_ms);
CREATE INDEX article_translation_jobs_article_idx
  ON article_translation_jobs(article_id, target_locale, created_at_ms);

CREATE TABLE article_review_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  source_revision_id TEXT NOT NULL,
  pass_kind TEXT NOT NULL CHECK (pass_kind IN ('translation','review-1','review-2')),
  state TEXT NOT NULL CHECK (state IN ('succeeded','failed')),
  prompt_sha256 BLOB NOT NULL CHECK (length(prompt_sha256) = 32),
  schema_sha256 BLOB NOT NULL CHECK (length(schema_sha256) = 32),
  source_sha256 BLOB NOT NULL CHECK (length(source_sha256) = 32),
  output_sha256 BLOB CHECK (output_sha256 IS NULL OR length(output_sha256) = 32),
  model_id TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  exit_code INTEGER,
  created_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER NOT NULL,
  UNIQUE (job_id, pass_kind),
  FOREIGN KEY (job_id, article_id, source_revision_id, locale)
    REFERENCES article_translation_jobs(id, article_id, source_revision_id, target_locale)
    ON DELETE CASCADE,
  FOREIGN KEY (source_revision_id, article_id)
    REFERENCES article_revisions(id, article_id) ON DELETE RESTRICT,
  CHECK (finished_at_ms >= created_at_ms),
  CHECK (state <> 'succeeded' OR (exit_code = 0 AND output_sha256 IS NOT NULL))
);
CREATE INDEX article_review_runs_revision_idx
  ON article_review_runs(source_revision_id, created_at_ms);
CREATE TRIGGER article_review_runs_running_job_insert
BEFORE INSERT ON article_review_runs
WHEN NOT EXISTS (
  SELECT 1 FROM article_translation_jobs job
  WHERE job.id = NEW.job_id
    AND job.article_id = NEW.article_id
    AND job.source_revision_id = NEW.source_revision_id
    AND job.target_locale = NEW.locale
    AND job.state = 'running'
)
BEGIN
  SELECT RAISE(ABORT, 'article review runs require the exact running translation job');
END;
CREATE TRIGGER article_review_runs_immutable_update
BEFORE UPDATE ON article_review_runs BEGIN
  SELECT RAISE(ABORT, 'article review runs are immutable');
END;
CREATE TRIGGER article_review_runs_immutable_delete
BEFORE DELETE ON article_review_runs BEGIN
  SELECT RAISE(ABORT, 'article review runs are immutable');
END;

CREATE TABLE hermes_article_nonces (
  nonce_hash BLOB PRIMARY KEY CHECK (length(nonce_hash) = 32),
  signed_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > signed_at_ms)
) WITHOUT ROWID;
CREATE INDEX hermes_article_nonces_expiry_idx ON hermes_article_nonces(expires_at_ms);

CREATE TABLE hermes_article_idempotency (
  key_hash BLOB PRIMARY KEY CHECK (length(key_hash) = 32),
  payload_fingerprint BLOB NOT NULL CHECK (length(payload_fingerprint) = 32),
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (revision_id, article_id)
    REFERENCES article_revisions(id, article_id) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX hermes_article_idempotency_article_idx
  ON hermes_article_idempotency(article_id, created_at_ms);

ALTER TABLE releases ADD COLUMN verified_at_ms INTEGER;
ALTER TABLE releases ADD COLUMN verification_sha256 BLOB
  CHECK (verification_sha256 IS NULL OR length(verification_sha256) = 32);
ALTER TABLE releases ADD COLUMN activation_generation INTEGER NOT NULL DEFAULT 0
  CHECK (activation_generation >= 0);
UPDATE releases SET state = 'retired' WHERE state = 'active';
CREATE UNIQUE INDEX releases_identity_manifest_uidx ON releases(id, manifest_sha256);
CREATE UNIQUE INDEX releases_one_active_uidx ON releases((1)) WHERE state = 'active';
CREATE INDEX releases_state_created_idx ON releases(state, created_at_ms DESC);
CREATE TRIGGER releases_active_invariant_insert
BEFORE INSERT ON releases
WHEN NEW.state = 'active' AND (
  NEW.verified_at_ms IS NULL OR NEW.verification_sha256 IS NULL OR NEW.activated_at_ms IS NULL
  OR NEW.verification_sha256 <> NEW.manifest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'active release must be verified and activated');
END;
CREATE TRIGGER releases_active_invariant_update
BEFORE UPDATE ON releases
WHEN NEW.state = 'active' AND (
  NEW.verified_at_ms IS NULL OR NEW.verification_sha256 IS NULL OR NEW.activated_at_ms IS NULL
  OR NEW.verification_sha256 <> NEW.manifest_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'active release must be verified and activated');
END;
CREATE TRIGGER releases_delete_retired_only
BEFORE DELETE ON releases
WHEN OLD.state <> 'retired'
BEGIN
  SELECT RAISE(ABORT, 'only retired releases may be deleted');
END;

CREATE TABLE release_entries (
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE RESTRICT,
  locale TEXT NOT NULL CHECK (locale IN ('ko','en','zh-Hans','zh-Hant')),
  slug TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_sha256 BLOB NOT NULL CHECK (length(content_sha256) = 32),
  route TEXT NOT NULL CHECK (route LIKE '/%'),
  PRIMARY KEY (release_id, article_id, locale),
  UNIQUE (release_id, route),
  FOREIGN KEY (revision_id, article_id, locale)
    REFERENCES article_revisions(id, article_id, locale) ON DELETE RESTRICT
) WITHOUT ROWID;
CREATE INDEX release_entries_revision_idx ON release_entries(revision_id);
CREATE TRIGGER release_entries_content_hash_insert
BEFORE INSERT ON release_entries
WHEN NOT EXISTS (
  SELECT 1 FROM article_revisions revision
  WHERE revision.id = NEW.revision_id
    AND revision.article_id = NEW.article_id
    AND revision.locale = NEW.locale
    AND revision.content_sha256 = NEW.content_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'release entry content hash must match its revision');
END;
CREATE TRIGGER release_entries_immutable_update
BEFORE UPDATE ON release_entries BEGIN
  SELECT RAISE(ABORT, 'release entries are immutable');
END;
CREATE TRIGGER release_entries_immutable_delete
BEFORE DELETE ON release_entries
WHEN EXISTS (SELECT 1 FROM releases WHERE id = OLD.release_id)
BEGIN
  SELECT RAISE(ABORT, 'release entries are immutable');
END;

CREATE TABLE release_activations (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  previous_release_id TEXT REFERENCES releases(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('publish','rollback','reconcile')),
  state TEXT NOT NULL CHECK (state IN ('prepared','switched','committed','failed')),
  manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256) = 32),
  target_path TEXT NOT NULL,
  previous_path TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  switched_at_ms INTEGER,
  committed_at_ms INTEGER,
  CHECK (state <> 'switched' OR switched_at_ms IS NOT NULL),
  CHECK (state <> 'committed' OR (switched_at_ms IS NOT NULL AND committed_at_ms IS NOT NULL)),
  FOREIGN KEY (release_id, manifest_sha256)
    REFERENCES releases(id, manifest_sha256) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX release_activations_one_incomplete_uidx
  ON release_activations((1)) WHERE state IN ('prepared','switched');
CREATE INDEX release_activations_release_idx ON release_activations(release_id, created_at_ms);

CREATE TABLE publication_outbox (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type = 'indexnow'),
  manifest_sha256 BLOB NOT NULL CHECK (length(manifest_sha256) = 32),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','processing','sent','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at_ms INTEGER NOT NULL,
  locked_at_ms INTEGER,
  lease_expires_at_ms INTEGER,
  locked_by TEXT,
  fencing_token BLOB CHECK (fencing_token IS NULL OR length(fencing_token) = 32),
  last_error_code TEXT,
  provider_message_id TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  UNIQUE (release_id, event_type, manifest_sha256),
  FOREIGN KEY (release_id, manifest_sha256)
    REFERENCES releases(id, manifest_sha256) ON DELETE RESTRICT,
  CHECK (
    (state = 'processing' AND locked_at_ms IS NOT NULL AND lease_expires_at_ms IS NOT NULL
      AND locked_by IS NOT NULL AND fencing_token IS NOT NULL)
    OR
    (state <> 'processing' AND locked_at_ms IS NULL AND lease_expires_at_ms IS NULL
      AND locked_by IS NULL AND fencing_token IS NULL)
  ),
  CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms > locked_at_ms)
);
CREATE INDEX publication_outbox_queue_idx
  ON publication_outbox(state, available_at_ms, lease_expires_at_ms);
`;

const FOURTH_MIGRATION = `
CREATE UNIQUE INDEX consent_documents_bundle_identity_uidx
  ON consent_documents(bundle_id, kind, locale);

CREATE TRIGGER consent_documents_immutable_content_update
BEFORE UPDATE ON consent_documents
WHEN NEW.id IS NOT OLD.id
  OR NEW.bundle_id IS NOT OLD.bundle_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.locale IS NOT OLD.locale
  OR NEW.version IS NOT OLD.version
  OR NEW.title IS NOT OLD.title
  OR NEW.body_markdown IS NOT OLD.body_markdown
  OR NEW.content_sha256 IS NOT OLD.content_sha256
  OR NEW.retention_months IS NOT OLD.retention_months
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
BEGIN
  SELECT RAISE(ABORT, 'consent document content is immutable');
END;

CREATE TRIGGER consent_documents_immutable_delete
BEFORE DELETE ON consent_documents
BEGIN
  SELECT RAISE(ABORT, 'consent documents are immutable');
END;

CREATE TRIGGER consent_documents_lifecycle_insert
BEFORE INSERT ON consent_documents
WHEN (NEW.state = 'draft' AND (NEW.effective_at_ms IS NOT NULL OR NEW.retired_at_ms IS NOT NULL))
  OR (NEW.state = 'active' AND (NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NOT NULL))
  OR (NEW.state = 'retired' AND (
    NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NULL
    OR NEW.retired_at_ms < NEW.effective_at_ms
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid consent document lifecycle');
END;

CREATE TRIGGER consent_documents_effective_time_immutable
BEFORE UPDATE ON consent_documents
WHEN OLD.effective_at_ms IS NOT NULL
  AND NEW.effective_at_ms IS NOT OLD.effective_at_ms
BEGIN
  SELECT RAISE(ABORT, 'consent document effective time is immutable');
END;

CREATE TRIGGER consent_documents_retired_time_immutable
BEFORE UPDATE ON consent_documents
WHEN OLD.retired_at_ms IS NOT NULL
  AND NEW.retired_at_ms IS NOT OLD.retired_at_ms
BEGIN
  SELECT RAISE(ABORT, 'consent document retired time is immutable');
END;

CREATE TRIGGER consent_documents_state_transition_update
BEFORE UPDATE ON consent_documents
WHEN (OLD.state = 'draft' AND NEW.state NOT IN ('draft','active'))
  OR (OLD.state = 'active' AND NEW.state NOT IN ('active','retired'))
  OR (OLD.state = 'retired' AND NEW.state <> 'retired')
  OR (NEW.state = 'draft' AND (NEW.effective_at_ms IS NOT NULL OR NEW.retired_at_ms IS NOT NULL))
  OR (NEW.state = 'active' AND (NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NOT NULL))
  OR (NEW.state = 'retired' AND (
    NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NULL
    OR NEW.retired_at_ms < NEW.effective_at_ms
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid consent document state transition');
END;
`;

const FIFTH_MIGRATION = `
CREATE TRIGGER consent_events_document_snapshot_insert
BEFORE INSERT ON consent_events
WHEN NOT EXISTS (
  SELECT 1 FROM consent_documents document
  WHERE document.id = NEW.document_id
    AND document.kind = NEW.kind
    AND document.version = NEW.document_version
    AND document.content_sha256 = NEW.document_sha256
)
BEGIN
  SELECT RAISE(ABORT, 'consent event snapshot must match referenced document');
END;

CREATE TRIGGER consent_events_immutable_update
BEFORE UPDATE ON consent_events
BEGIN
  SELECT RAISE(ABORT, 'consent events are immutable');
END;

CREATE TRIGGER consent_events_immutable_delete
BEFORE DELETE ON consent_events
BEGIN
  SELECT RAISE(ABORT, 'consent events are immutable');
END;
`;

const SIXTH_MIGRATION = `
CREATE TRIGGER consent_events_replace_guard_insert
BEFORE INSERT ON consent_events
WHEN EXISTS (
  SELECT 1 FROM consent_events existing
  WHERE existing.id = NEW.id
    OR (
      existing.consultation_id = NEW.consultation_id
      AND existing.kind = NEW.kind
      AND existing.sequence = NEW.sequence
    )
)
BEGIN
  SELECT RAISE(ABORT, 'consent event replacement is forbidden');
END;
`;

const MIGRATIONS = [
  { version: 1, name: "initial-control-schema", sql: INITIAL_MIGRATION },
  { version: 2, name: "admin-notification-withdrawal", sql: SECOND_MIGRATION },
  { version: 3, name: "article-publication-pipeline", sql: THIRD_MIGRATION },
  { version: 4, name: "immutable-consent-bundles", sql: FOURTH_MIGRATION },
  { version: 5, name: "append-only-consent-events", sql: FIFTH_MIGRATION },
  { version: 6, name: "consent-event-replace-guard", sql: SIXTH_MIGRATION },
] as const;

export const MIGRATION_FINGERPRINTS = MIGRATIONS.map((migration) => ({
  version: migration.version,
  sha256: createHash("sha256").update(migration.sql).digest("hex"),
}));

function normalizeSchemaSql(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ").toLowerCase();
}

const REQUIRED_SCHEMA_DEFINITIONS = [
  {
    type: "index",
    name: "consent_documents_bundle_identity_uidx",
    sql: "CREATE UNIQUE INDEX consent_documents_bundle_identity_uidx ON consent_documents(bundle_id, kind, locale)",
  },
  {
    type: "trigger",
    name: "consent_documents_immutable_content_update",
    sql: `CREATE TRIGGER consent_documents_immutable_content_update
      BEFORE UPDATE ON consent_documents
      WHEN NEW.id IS NOT OLD.id
        OR NEW.bundle_id IS NOT OLD.bundle_id
        OR NEW.kind IS NOT OLD.kind
        OR NEW.locale IS NOT OLD.locale
        OR NEW.version IS NOT OLD.version
        OR NEW.title IS NOT OLD.title
        OR NEW.body_markdown IS NOT OLD.body_markdown
        OR NEW.content_sha256 IS NOT OLD.content_sha256
        OR NEW.retention_months IS NOT OLD.retention_months
        OR NEW.created_at_ms IS NOT OLD.created_at_ms
        OR NEW.created_by_admin_id IS NOT OLD.created_by_admin_id
      BEGIN
        SELECT RAISE(ABORT, 'consent document content is immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_documents_immutable_delete",
    sql: `CREATE TRIGGER consent_documents_immutable_delete
      BEFORE DELETE ON consent_documents
      BEGIN
        SELECT RAISE(ABORT, 'consent documents are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_documents_lifecycle_insert",
    sql: `CREATE TRIGGER consent_documents_lifecycle_insert
      BEFORE INSERT ON consent_documents
      WHEN (NEW.state = 'draft' AND (NEW.effective_at_ms IS NOT NULL OR NEW.retired_at_ms IS NOT NULL))
        OR (NEW.state = 'active' AND (NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NOT NULL))
        OR (NEW.state = 'retired' AND (
          NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NULL
          OR NEW.retired_at_ms < NEW.effective_at_ms
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid consent document lifecycle');
      END`,
  },
  {
    type: "trigger",
    name: "consent_documents_effective_time_immutable",
    sql: `CREATE TRIGGER consent_documents_effective_time_immutable
      BEFORE UPDATE ON consent_documents
      WHEN OLD.effective_at_ms IS NOT NULL
        AND NEW.effective_at_ms IS NOT OLD.effective_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'consent document effective time is immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_documents_retired_time_immutable",
    sql: `CREATE TRIGGER consent_documents_retired_time_immutable
      BEFORE UPDATE ON consent_documents
      WHEN OLD.retired_at_ms IS NOT NULL
        AND NEW.retired_at_ms IS NOT OLD.retired_at_ms
      BEGIN
        SELECT RAISE(ABORT, 'consent document retired time is immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_documents_state_transition_update",
    sql: `CREATE TRIGGER consent_documents_state_transition_update
      BEFORE UPDATE ON consent_documents
      WHEN (OLD.state = 'draft' AND NEW.state NOT IN ('draft','active'))
        OR (OLD.state = 'active' AND NEW.state NOT IN ('active','retired'))
        OR (OLD.state = 'retired' AND NEW.state <> 'retired')
        OR (NEW.state = 'draft' AND (NEW.effective_at_ms IS NOT NULL OR NEW.retired_at_ms IS NOT NULL))
        OR (NEW.state = 'active' AND (NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NOT NULL))
        OR (NEW.state = 'retired' AND (
          NEW.effective_at_ms IS NULL OR NEW.retired_at_ms IS NULL
          OR NEW.retired_at_ms < NEW.effective_at_ms
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid consent document state transition');
      END`,
  },
  {
    type: "trigger",
    name: "consent_events_document_snapshot_insert",
    sql: `CREATE TRIGGER consent_events_document_snapshot_insert
      BEFORE INSERT ON consent_events
      WHEN NOT EXISTS (
        SELECT 1 FROM consent_documents document
        WHERE document.id = NEW.document_id
          AND document.kind = NEW.kind
          AND document.version = NEW.document_version
          AND document.content_sha256 = NEW.document_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'consent event snapshot must match referenced document');
      END`,
  },
  {
    type: "trigger",
    name: "consent_events_immutable_update",
    sql: `CREATE TRIGGER consent_events_immutable_update
      BEFORE UPDATE ON consent_events
      BEGIN
        SELECT RAISE(ABORT, 'consent events are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_events_immutable_delete",
    sql: `CREATE TRIGGER consent_events_immutable_delete
      BEFORE DELETE ON consent_events
      BEGIN
        SELECT RAISE(ABORT, 'consent events are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "consent_events_replace_guard_insert",
    sql: `CREATE TRIGGER consent_events_replace_guard_insert
      BEFORE INSERT ON consent_events
      WHEN EXISTS (
        SELECT 1 FROM consent_events existing
        WHERE existing.id = NEW.id
          OR (
            existing.consultation_id = NEW.consultation_id
            AND existing.kind = NEW.kind
            AND existing.sequence = NEW.sequence
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'consent event replacement is forbidden');
      END`,
  },
  {
    type: "index",
    name: "article_translation_jobs_one_running_uidx",
    sql: "CREATE UNIQUE INDEX article_translation_jobs_one_running_uidx ON article_translation_jobs((1)) WHERE state = 'running'",
  },
  {
    type: "index",
    name: "releases_identity_manifest_uidx",
    sql: "CREATE UNIQUE INDEX releases_identity_manifest_uidx ON releases(id, manifest_sha256)",
  },
  {
    type: "index",
    name: "releases_one_active_uidx",
    sql: "CREATE UNIQUE INDEX releases_one_active_uidx ON releases((1)) WHERE state = 'active'",
  },
  {
    type: "index",
    name: "release_activations_one_incomplete_uidx",
    sql: "CREATE UNIQUE INDEX release_activations_one_incomplete_uidx ON release_activations((1)) WHERE state IN ('prepared','switched')",
  },
  {
    type: "trigger",
    name: "article_revisions_immutable_update",
    sql: `CREATE TRIGGER article_revisions_immutable_update
      BEFORE UPDATE ON article_revisions BEGIN
        SELECT RAISE(ABORT, 'article revisions are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "article_revisions_immutable_delete",
    sql: `CREATE TRIGGER article_revisions_immutable_delete
      BEFORE DELETE ON article_revisions BEGIN
        SELECT RAISE(ABORT, 'article revisions are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "article_review_runs_running_job_insert",
    sql: `CREATE TRIGGER article_review_runs_running_job_insert
      BEFORE INSERT ON article_review_runs
      WHEN NOT EXISTS (
        SELECT 1 FROM article_translation_jobs job
        WHERE job.id = NEW.job_id
          AND job.article_id = NEW.article_id
          AND job.source_revision_id = NEW.source_revision_id
          AND job.target_locale = NEW.locale
          AND job.state = 'running'
      )
      BEGIN
        SELECT RAISE(ABORT, 'article review runs require the exact running translation job');
      END`,
  },
  {
    type: "trigger",
    name: "article_review_runs_immutable_update",
    sql: `CREATE TRIGGER article_review_runs_immutable_update
      BEFORE UPDATE ON article_review_runs BEGIN
        SELECT RAISE(ABORT, 'article review runs are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "article_review_runs_immutable_delete",
    sql: `CREATE TRIGGER article_review_runs_immutable_delete
      BEFORE DELETE ON article_review_runs BEGIN
        SELECT RAISE(ABORT, 'article review runs are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "release_entries_content_hash_insert",
    sql: `CREATE TRIGGER release_entries_content_hash_insert
      BEFORE INSERT ON release_entries
      WHEN NOT EXISTS (
        SELECT 1 FROM article_revisions revision
        WHERE revision.id = NEW.revision_id
          AND revision.article_id = NEW.article_id
          AND revision.locale = NEW.locale
          AND revision.content_sha256 = NEW.content_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'release entry content hash must match its revision');
      END`,
  },
  {
    type: "trigger",
    name: "release_entries_immutable_update",
    sql: `CREATE TRIGGER release_entries_immutable_update
      BEFORE UPDATE ON release_entries BEGIN
        SELECT RAISE(ABORT, 'release entries are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "release_entries_immutable_delete",
    sql: `CREATE TRIGGER release_entries_immutable_delete
      BEFORE DELETE ON release_entries
      WHEN EXISTS (SELECT 1 FROM releases WHERE id = OLD.release_id)
      BEGIN
        SELECT RAISE(ABORT, 'release entries are immutable');
      END`,
  },
  {
    type: "trigger",
    name: "releases_active_invariant_insert",
    sql: `CREATE TRIGGER releases_active_invariant_insert
      BEFORE INSERT ON releases
      WHEN NEW.state = 'active' AND (
        NEW.verified_at_ms IS NULL OR NEW.verification_sha256 IS NULL OR NEW.activated_at_ms IS NULL
        OR NEW.verification_sha256 <> NEW.manifest_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'active release must be verified and activated');
      END`,
  },
  {
    type: "trigger",
    name: "releases_active_invariant_update",
    sql: `CREATE TRIGGER releases_active_invariant_update
      BEFORE UPDATE ON releases
      WHEN NEW.state = 'active' AND (
        NEW.verified_at_ms IS NULL OR NEW.verification_sha256 IS NULL OR NEW.activated_at_ms IS NULL
        OR NEW.verification_sha256 <> NEW.manifest_sha256
      )
      BEGIN
        SELECT RAISE(ABORT, 'active release must be verified and activated');
      END`,
  },
  {
    type: "trigger",
    name: "releases_delete_retired_only",
    sql: `CREATE TRIGGER releases_delete_retired_only
      BEFORE DELETE ON releases
      WHEN OLD.state <> 'retired'
      BEGIN
        SELECT RAISE(ABORT, 'only retired releases may be deleted');
      END`,
  },
] as const;

const REQUIRED_SCHEMA_FINGERPRINTS = REQUIRED_SCHEMA_DEFINITIONS.map((definition) => ({
  type: definition.type,
  name: definition.name,
  sha256: createHash("sha256").update(normalizeSchemaSql(definition.sql)).digest("hex"),
}));

function applyPragmas(sqlite: Database.Database): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("recursive_triggers = ON");
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

type MigrationHistoryRow = { version: number; name: string };

function validateMigrationHistory(appliedRows: readonly MigrationHistoryRow[]): void {
  if (
    appliedRows.length > MIGRATIONS.length ||
    appliedRows.some((row, index) => {
      const expected = MIGRATIONS[index];
      return expected === undefined || row.version !== expected.version || row.name !== expected.name;
    })
  ) {
    throw new Error("Database migration history is not an exact contiguous known prefix");
  }
}

function readMigrationHistory(sqlite: Database.Database): MigrationHistoryRow[] {
  const table = sqlite.prepare(`
    SELECT 1 present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (table === undefined) return [];
  const appliedRows = sqlite.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as MigrationHistoryRow[];
  validateMigrationHistory(appliedRows);
  return appliedRows;
}

function migrationHistoryVersion(appliedRows: readonly MigrationHistoryRow[]): number {
  return appliedRows.at(-1)?.version ?? 0;
}

function assertUserVersionMatchesHistory(
  sqlite: Database.Database,
  historyVersion: number,
): void {
  const userVersion = Number(sqlite.pragma("user_version", { simple: true }));
  if (userVersion === historyVersion) return;
  throw new Error(
    `SQLite user_version ${userVersion} does not match migration history ${historyVersion}`,
  );
}

function inImmediateTransaction<T>(sqlite: Database.Database, operation: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

function synchronizeMigrationMetadata(sqlite: Database.Database): MigrationHistoryRow[] {
  return inImmediateTransaction(sqlite, () => {
    const history = readMigrationHistory(sqlite);
    const historyVersion = migrationHistoryVersion(history);
    const userVersion = Number(sqlite.pragma("user_version", { simple: true }));
    if (userVersion === 0 && historyVersion > 0) {
      sqlite.pragma(`user_version = ${historyVersion}`);
    } else {
      assertUserVersionMatchesHistory(sqlite, historyVersion);
    }
    return history;
  });
}

function assertCanonicalConsentBundlesBeforeV4(sqlite: Database.Database): void {
  const rows = sqlite.prepare(`
    SELECT id, bundle_id, kind, locale, version, title, body_markdown,
      content_sha256, retention_months, state, effective_at_ms, retired_at_ms
    FROM consent_documents ORDER BY bundle_id, kind, locale, version
  `).all() as ConsentBundleRow[];
  const bundles = new Map<string, ConsentBundleRow[]>();
  for (const row of rows) {
    const bundle = bundles.get(row.bundle_id) ?? [];
    bundle.push(row);
    bundles.set(row.bundle_id, bundle);
  }
  if ([...bundles.values()].some((bundle) => (
    validateCanonicalConsentBundleRows(bundle) === undefined
  ))) {
    throw new Error("DATABASE_CONSENT_BUNDLE_INVALID");
  }
}

function assertConsentEventSnapshotsBeforeV5(sqlite: Database.Database): void {
  const invalid = sqlite.prepare(`
    SELECT 1 invalid
    FROM consent_events event
    LEFT JOIN consent_documents document ON document.id = event.document_id
    WHERE document.id IS NULL
      OR document.kind <> event.kind
      OR document.version <> event.document_version
      OR document.content_sha256 <> event.document_sha256
    LIMIT 1
  `).get();
  if (invalid !== undefined) {
    throw new Error("Database contains a consent event snapshot that does not match its document");
  }
}

export function assertRollbackCompatibleMigration(
  db: ControlDatabase,
  targetVersion = SCHEMA_VERSION,
): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 1 || targetVersion > SCHEMA_VERSION) {
    throw new Error("Unsupported schema migration target");
  }
  const history = synchronizeMigrationMetadata(db.sqlite);
  const currentVersion = migrationHistoryVersion(history);
  if (currentVersion === 0 || currentVersion === targetVersion) return;
  if (currentVersion > targetVersion) {
    throw new Error("Database schema is newer than the requested migration target");
  }
  const nextMigration = MIGRATIONS.find((migration) => migration.version > currentVersion);
  throw Object.assign(new Error(
    `Migration ${nextMigration?.version ?? targetVersion} (${nextMigration?.name ?? "unknown"}) requires a maintenance deployment because retained releases require the exact previous schema`,
  ), { code: "DATABASE_MIGRATION_ROLLBACK_INCOMPATIBLE" });
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
  synchronizeMigrationMetadata(sqlite);
  inImmediateTransaction(sqlite, () => {
    const appliedRows = readMigrationHistory(sqlite);
    assertUserVersionMatchesHistory(sqlite, migrationHistoryVersion(appliedRows));
    const applied = new Set(appliedRows.map((row) => row.version));
    for (const migration of MIGRATIONS) {
      if (migration.version > targetVersion || applied.has(migration.version)) continue;
      if (migration.version === 4) assertCanonicalConsentBundlesBeforeV4(sqlite);
      if (migration.version === 5) assertConsentEventSnapshotsBeforeV5(sqlite);
      sqlite.exec(migration.sql);
      sqlite.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at_ms) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, nowMs);
      sqlite.pragma(`user_version = ${migration.version}`);
    }
  });
}

export function closeDatabase(db: ControlDatabase): void {
  if (db.sqlite.open) db.sqlite.close();
}

export function isDatabaseReady(db: ControlDatabase): boolean {
  try {
    if (Number(db.sqlite.pragma("recursive_triggers", { simple: true })) !== 1) return false;
    if (Number(db.sqlite.pragma("user_version", { simple: true })) !== SCHEMA_VERSION) return false;
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
      SELECT type, name, sql FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger')
    `).all() as Array<{
      type: "table" | "index" | "trigger";
      name: string;
      sql: string | null;
    }>;
    const tables = new Set(schemaObjects.filter((item) => item.type === "table").map((item) => item.name));
    const indexes = new Set(schemaObjects.filter((item) => item.type === "index").map((item) => item.name));
    const triggers = new Set(schemaObjects.filter((item) => item.type === "trigger").map((item) => item.name));
    if (!REQUIRED_TABLES.every((name) => tables.has(name))) return false;
    if (!REQUIRED_INDEXES.every((name) => indexes.has(name))) return false;
    if (!REQUIRED_TRIGGERS.every((name) => triggers.has(name))) return false;
    const schemaByName = new Map(schemaObjects.map((item) => [item.name, item]));
    if (!REQUIRED_SCHEMA_FINGERPRINTS.every((expected) => {
      const actual = schemaByName.get(expected.name);
      if (actual?.type !== expected.type || actual.sql === null) return false;
      const actualSha256 = createHash("sha256")
        .update(normalizeSchemaSql(actual.sql))
        .digest("hex");
      return actualSha256 === expected.sha256;
    })) return false;

    const requiredColumns = {
      consultations: ["marketing_withdrawn_at_ms"],
      admins: ["totp_last_counter"],
      notification_outbox: ["lease_expires_at_ms", "purpose", "delivery_cycle"],
      article_revisions: [
        "title", "summary", "source_revision_id", "parent_revision_id", "source_sha256",
        "translation_metadata_json", "initial_review_state", "created_by_type", "created_by_id",
      ],
      releases: ["verified_at_ms", "verification_sha256", "activation_generation"],
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
