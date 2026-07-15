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
  lockedBy: text("locked_by"),
  providerMessageId: text("provider_message_id"),
  lastErrorCode: text("last_error_code"),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
  sentAtMs: integer("sent_at_ms"),
}, (table) => [
  uniqueIndex("notification_outbox_event_uidx").on(table.consultationId, table.channel, table.eventType),
  index("notification_outbox_queue_idx").on(table.state, table.availableAtMs),
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
  "articles",
  "article_revisions",
  "jobs",
  "releases",
  "audit_events",
] as const;

export const REQUIRED_INDEXES = [
  "consultations_receipt_uidx",
  "consultations_status_received_idx",
  "consultations_retention_due_idx",
  "consultations_phone_blind_idx",
  "consultations_email_blind_idx",
  "consent_documents_identity_uidx",
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
  "article_revisions_article_locale_idx",
  "jobs_queue_idx",
  "audit_events_created_idx",
  "audit_events_target_idx",
] as const;

export const SCHEMA_VERSION = 1;

export const drizzleSchema = {
  schemaMigrations,
  consultations,
  consentDocuments,
  consentEvents,
  idempotencyKeys,
  abuseBuckets,
  notificationOutbox,
};
