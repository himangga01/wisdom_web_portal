import { sql } from "drizzle-orm";
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  name: text("name").notNull(),
  appliedAtMs: integer("applied_at_ms").notNull(),
});

export const consultations = sqliteTable("consultations", {
  id: text("id").primaryKey(),
  receiptId: text("receipt_id").notNull().unique(),
  status: text("status").notNull().default("received"),
  locale: text("locale").notNull(),
  category: text("category").notNull(),
  preferredContact: text("preferred_contact").notNull(),
  piiEnvelope: text("pii_envelope"),
  piiKeyId: text("pii_key_id"),
  phoneBlindIndex: blob("phone_blind_index", { mode: "buffer" }),
  emailBlindIndex: blob("email_blind_index", { mode: "buffer" }),
  blindIndexKeyId: text("blind_index_key_id"),
  marketingAccepted: integer("marketing_accepted", { mode: "boolean" }).notNull(),
  receivedAtMs: integer("received_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  retentionExpiresAtMs: integer("retention_expires_at_ms").notNull(),
  purgedAtMs: integer("purged_at_ms"),
  marketingWithdrawnAtMs: integer("marketing_withdrawn_at_ms"),
  rowVersion: integer("row_version").notNull().default(1),
}, (table) => [
  index("consultations_status_received_idx").on(table.status, table.receivedAtMs),
  index("consultations_phone_blind_idx").on(table.blindIndexKeyId, table.phoneBlindIndex),
  index("consultations_email_blind_idx").on(table.blindIndexKeyId, table.emailBlindIndex),
  check("consultations_marketing_bool", sql`${table.marketingAccepted} IN (0, 1)`),
]);

export const consentDocuments = sqliteTable("consent_documents", {
  id: text("id").primaryKey(),
  bundleId: text("bundle_id").notNull(),
  kind: text("kind").notNull(),
  locale: text("locale").notNull(),
  version: text("version").notNull(),
  title: text("title").notNull(),
  bodyMarkdown: text("body_markdown").notNull(),
  contentSha256: blob("content_sha256", { mode: "buffer" }).notNull(),
  retentionMonths: integer("retention_months").notNull(),
  state: text("state").notNull().default("draft"),
  effectiveAtMs: integer("effective_at_ms"),
  retiredAtMs: integer("retired_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  createdByAdminId: text("created_by_admin_id"),
}, (table) => [
  uniqueIndex("consent_documents_identity_uidx").on(table.kind, table.locale, table.version),
  uniqueIndex("consent_documents_bundle_identity_uidx").on(table.bundleId, table.kind, table.locale),
  index("consent_documents_bundle_idx").on(table.bundleId, table.state),
  index("consent_documents_state_kind_locale_idx").on(table.state, table.kind, table.locale),
]);

export const consentEvents = sqliteTable("consent_events", {
  id: text("id").primaryKey(),
  consultationId: text("consultation_id").notNull().references(() => consultations.id),
  documentId: text("document_id").notNull().references(() => consentDocuments.id),
  kind: text("kind").notNull(),
  decision: text("decision").notNull(),
  sequence: integer("sequence").notNull(),
  documentVersion: text("document_version").notNull(),
  documentSha256: blob("document_sha256", { mode: "buffer" }).notNull(),
  actorType: text("actor_type").notNull(),
  requestId: text("request_id").notNull(),
  metadataJson: text("metadata_json"),
  occurredAtMs: integer("occurred_at_ms").notNull(),
}, (table) => [
  uniqueIndex("consent_events_sequence_uidx").on(table.consultationId, table.kind, table.sequence),
  index("consent_events_consultation_time_idx").on(table.consultationId, table.occurredAtMs),
  index("consent_events_document_time_idx").on(table.documentId, table.occurredAtMs),
]);

export const idempotencyKeys = sqliteTable("idempotency_keys", {
  scope: text("scope").notNull(),
  keyHash: blob("key_hash", { mode: "buffer" }).notNull(),
  requestFingerprint: blob("request_fingerprint", { mode: "buffer" }).notNull(),
  consultationId: text("consultation_id").notNull().references(() => consultations.id),
  responseStatus: integer("response_status").notNull(),
  responseJson: text("response_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [
  primaryKey({ columns: [table.scope, table.keyHash] }),
  index("idempotency_expiry_idx").on(table.expiresAtMs),
  index("idempotency_consultation_idx").on(table.consultationId),
]);

export const abuseBuckets = sqliteTable("abuse_buckets", {
  subjectKind: text("subject_kind").notNull(),
  subjectHash: blob("subject_hash", { mode: "buffer" }).notNull(),
  windowKind: text("window_kind").notNull(),
  windowStartMs: integer("window_start_ms").notNull(),
  count: integer("count").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [
  primaryKey({ columns: [table.subjectKind, table.subjectHash, table.windowKind, table.windowStartMs] }),
  index("abuse_buckets_expiry_idx").on(table.expiresAtMs),
]);

export const notificationOutbox = sqliteTable("notification_outbox", {
  id: text("id").primaryKey(),
  consultationId: text("consultation_id").notNull().references(() => consultations.id),
  channel: text("channel").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json"),
  state: text("state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAtMs: integer("available_at_ms").notNull(),
  lockedAtMs: integer("locked_at_ms"),
  leaseExpiresAtMs: integer("lease_expires_at_ms"),
  lockedBy: text("locked_by"),
  purpose: text("purpose").notNull().default("transactional"),
  deliveryCycle: integer("delivery_cycle").notNull().default(1),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  sentAtMs: integer("sent_at_ms"),
}, (table) => [
  uniqueIndex("notification_outbox_event_uidx").on(table.consultationId, table.channel, table.eventType),
  index("notification_outbox_queue_idx").on(table.state, table.availableAtMs),
  index("notification_outbox_lease_idx").on(table.state, table.availableAtMs, table.leaseExpiresAtMs),
]);

export const admins = sqliteTable("admins", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  totpSecretEnvelope: text("totp_secret_envelope"),
  totpKeyId: text("totp_key_id"),
  totpLastCounter: integer("totp_last_counter"),
  status: text("status").notNull(),
  failedCount: integer("failed_count").notNull().default(0),
  lockedUntilMs: integer("locked_until_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  lastLoginAtMs: integer("last_login_at_ms"),
});

export const adminSessions = sqliteTable("admin_sessions", {
  tokenHash: blob("token_hash", { mode: "buffer" }).primaryKey(),
  adminId: text("admin_id").notNull().references(() => admins.id),
  csrfHash: blob("csrf_hash", { mode: "buffer" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  idleExpiresAtMs: integer("idle_expires_at_ms").notNull(),
  lastSeenAtMs: integer("last_seen_at_ms").notNull(),
  revokedAtMs: integer("revoked_at_ms"),
}, (table) => [
  index("admin_sessions_admin_expiry_idx").on(table.adminId, table.expiresAtMs),
]);

export const adminRecoveryCodes = sqliteTable("admin_recovery_codes", {
  id: text("id").primaryKey(),
  adminId: text("admin_id").notNull().references(() => admins.id),
  codeHash: blob("code_hash", { mode: "buffer" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  usedAtMs: integer("used_at_ms"),
}, (table) => [
  uniqueIndex("admin_recovery_codes_admin_hash_uidx").on(table.adminId, table.codeHash),
  index("admin_recovery_codes_unused_idx").on(table.adminId, table.usedAtMs),
]);

export const adminPreAuthChallenges = sqliteTable("admin_pre_auth_challenges", {
  challengeHash: blob("challenge_hash", { mode: "buffer" }).primaryKey(),
  adminId: text("admin_id").notNull().references(() => admins.id),
  csrfHash: blob("csrf_hash", { mode: "buffer" }).notNull(),
  pendingPasswordHash: text("pending_password_hash"),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  usedAtMs: integer("used_at_ms"),
}, (table) => [
  index("admin_pre_auth_expiry_idx").on(table.expiresAtMs, table.usedAtMs),
]);

export const adminLoginBuckets = sqliteTable("admin_login_buckets", {
  subjectKind: text("subject_kind").notNull(),
  subjectHash: blob("subject_hash", { mode: "buffer" }).notNull(),
  windowStartMs: integer("window_start_ms").notNull(),
  failureCount: integer("failure_count").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [
  primaryKey({ columns: [table.subjectKind, table.subjectHash, table.windowStartMs] }),
  index("admin_login_buckets_expiry_idx").on(table.expiresAtMs),
]);

export const adminLoginAdmissions = sqliteTable("admin_login_admissions", {
  id: text("id").primaryKey(),
  usernameHash: blob("username_hash", { mode: "buffer" }).notNull(),
  sourceHash: blob("source_hash", { mode: "buffer" }).notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [
  index("admin_login_admissions_username_idx").on(table.usernameHash, table.expiresAtMs),
  index("admin_login_admissions_source_idx").on(table.sourceHash, table.expiresAtMs),
]);

export const notificationDeliveryAttempts = sqliteTable("notification_delivery_attempts", {
  id: text("id").primaryKey(),
  outboxId: text("outbox_id").notNull().references(() => notificationOutbox.id),
  deliveryCycle: integer("delivery_cycle").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  workerId: text("worker_id").notNull(),
  outcomeCode: text("outcome_code"),
  providerMessageId: text("provider_message_id"),
  startedAtMs: integer("started_at_ms").notNull(),
  finishedAtMs: integer("finished_at_ms"),
}, (table) => [
  uniqueIndex("notification_delivery_attempt_identity_uidx").on(
    table.outboxId,
    table.deliveryCycle,
    table.attemptNo,
  ),
  index("notification_delivery_attempts_outbox_idx").on(table.outboxId, table.startedAtMs),
]);

export const marketingWithdrawalCapabilities = sqliteTable("marketing_withdrawal_capabilities", {
  tokenHash: blob("token_hash", { mode: "buffer" }).primaryKey(),
  consultationId: text("consultation_id").notNull().references(() => consultations.id),
  consentEventId: text("consent_event_id").notNull().references(() => consentEvents.id),
  locale: text("locale").notNull(),
  landingHash: blob("landing_hash", { mode: "buffer" }),
  landingExpiresAtMs: integer("landing_expires_at_ms"),
  createdAtMs: integer("created_at_ms").notNull(),
  expiresAtMs: integer("expires_at_ms").notNull(),
  usedAtMs: integer("used_at_ms"),
}, (table) => [
  index("marketing_withdrawal_consultation_idx").on(
    table.consultationId,
    table.usedAtMs,
    table.expiresAtMs,
  ),
]);

export const REQUIRED_TABLES = [
  "schema_migrations",
  "consultations",
  "consent_documents",
  "consent_events",
  "idempotency_keys",
  "abuse_buckets",
  "notification_outbox",
  "notification_settings",
  "admins",
  "admin_sessions",
  "admin_recovery_codes",
  "admin_pre_auth_challenges",
  "admin_login_buckets",
  "admin_login_admissions",
  "notification_delivery_attempts",
  "marketing_withdrawal_capabilities",
  "articles",
  "article_revisions",
  "article_locale_heads",
  "article_review_runs",
  "article_translation_jobs",
  "jobs",
  "releases",
  "release_entries",
  "release_activations",
  "publication_outbox",
  "hermes_article_idempotency",
  "hermes_article_nonces",
  "audit_events",
] as const;

export const REQUIRED_INDEXES = [
  "consultations_receipt_uidx",
  "consultations_status_received_idx",
  "consultations_retention_due_idx",
  "consultations_phone_blind_idx",
  "consultations_email_blind_idx",
  "consent_documents_identity_uidx",
  "consent_documents_bundle_identity_uidx",
  "consent_documents_one_active_uidx",
  "consent_documents_bundle_idx",
  "consent_documents_state_kind_locale_idx",
  "consent_events_sequence_uidx",
  "consent_events_consultation_time_idx",
  "consent_events_document_time_idx",
  "idempotency_expiry_idx",
  "idempotency_consultation_idx",
  "abuse_buckets_expiry_idx",
  "notification_outbox_event_uidx",
  "notification_outbox_queue_idx",
  "admin_sessions_admin_expiry_idx",
  "admin_recovery_codes_unused_idx",
  "admin_pre_auth_expiry_idx",
  "admin_login_buckets_expiry_idx",
  "admin_login_admissions_username_idx",
  "admin_login_admissions_source_idx",
  "notification_delivery_attempts_outbox_idx",
  "notification_outbox_lease_idx",
  "marketing_withdrawal_consultation_idx",
  "article_revisions_article_locale_idx",
  "article_revisions_source_idx",
  "article_locale_heads_state_idx",
  "article_locale_heads_published_idx",
  "article_review_runs_revision_idx",
  "article_translation_jobs_one_running_uidx",
  "article_translation_jobs_queue_idx",
  "article_translation_jobs_article_idx",
  "hermes_article_nonces_expiry_idx",
  "hermes_article_idempotency_article_idx",
  "jobs_queue_idx",
  "releases_identity_manifest_uidx",
  "releases_one_active_uidx",
  "releases_state_created_idx",
  "release_entries_revision_idx",
  "release_activations_one_incomplete_uidx",
  "release_activations_release_idx",
  "publication_outbox_queue_idx",
  "audit_events_created_idx",
  "audit_events_target_idx",
] as const;

export const REQUIRED_TRIGGERS = [
  "consent_documents_immutable_content_update",
  "consent_documents_immutable_delete",
  "consent_documents_lifecycle_insert",
  "consent_documents_effective_time_immutable",
  "consent_documents_retired_time_immutable",
  "consent_documents_state_transition_update",
  "consent_events_document_snapshot_insert",
  "consent_events_immutable_update",
  "consent_events_immutable_delete",
  "article_revisions_immutable_update",
  "article_revisions_immutable_delete",
  "article_review_runs_immutable_update",
  "article_review_runs_immutable_delete",
  "article_review_runs_running_job_insert",
  "release_entries_content_hash_insert",
  "release_entries_immutable_update",
  "release_entries_immutable_delete",
  "releases_active_invariant_insert",
  "releases_active_invariant_update",
  "releases_delete_retired_only",
] as const;

export const SCHEMA_VERSION = 5;

export const drizzleSchema = {
  schemaMigrations,
  consultations,
  consentDocuments,
  consentEvents,
  idempotencyKeys,
  abuseBuckets,
  notificationOutbox,
  admins,
  adminSessions,
  adminRecoveryCodes,
  adminPreAuthChallenges,
  adminLoginBuckets,
  adminLoginAdmissions,
  notificationDeliveryAttempts,
  marketingWithdrawalCapabilities,
};
