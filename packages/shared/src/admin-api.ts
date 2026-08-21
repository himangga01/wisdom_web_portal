import { z } from "zod";

import {
  articleStateSchema,
  consultationStatusSchema,
  localeSchema,
  notificationChannelSchema,
} from "./contracts.js";

const boundedString = z.string().min(1).max(16_384);
const boundedArticleMarkdown = z.string().min(1).max(240 * 1_024);
const identifier = z.string().min(1).max(512);
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const boundedItems = <T extends z.ZodType>(schema: T, maximum = 100) =>
  z.array(schema).max(maximum);

export const adminApiErrorCodeSchema = z.enum([
  "AUTH_REQUIRED",
  "AUTH_INVALID",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "ROW_VERSION_CONFLICT",
  "CONFIRMATION_REQUIRED",
  "NOTIFICATION_CHANNEL_DISABLED",
  "OPERATION_UNAVAILABLE",
  "ADMIN_API_RESPONSE_INVALID",
  "INTERNAL_ERROR",
]);
export type AdminApiErrorCode = z.infer<typeof adminApiErrorCodeSchema>;

export const adminApiErrorBodySchema = z.object({
  error: z.object({
    code: adminApiErrorCodeSchema,
    message: boundedString,
    fieldErrors: z.record(z.string(), boundedString).optional(),
  }).strict(),
}).strict();
export type AdminApiErrorBody = z.infer<typeof adminApiErrorBodySchema>;

export interface AdminApiSuccess<T> {
  data: T;
}

export const adminVoidSchema = z.void();

export const adminPageSchema = z.object({
  page: positiveInteger,
  pageSize: positiveInteger.max(100),
  total: nonnegativeInteger,
  pageCount: nonnegativeInteger,
}).strict();
export type AdminPage = z.infer<typeof adminPageSchema>;

export const adminSessionSchema = z.object({
  stage: z.literal("authenticated"),
  adminId: identifier,
  csrfToken: identifier,
  expiresAtMs: nonnegativeInteger,
  idleExpiresAtMs: nonnegativeInteger,
}).strict();
export type AdminSessionDto = z.infer<typeof adminSessionSchema>;

export const adminPreAuthSchema = z.object({
  stage: z.literal("mfa"),
  csrfToken: identifier,
}).strict();
export type AdminPreAuthDto = z.infer<typeof adminPreAuthSchema>;

export const adminDashboardSchema = z.object({
  counts: boundedItems(z.object({
    status: identifier,
    count: nonnegativeInteger,
  }).strict(), 20),
}).strict();
export type AdminDashboardDto = z.infer<typeof adminDashboardSchema>;

export const adminConsultationListItemSchema = z.object({
  id: identifier,
  receiptId: identifier,
  status: consultationStatusSchema,
  locale: identifier,
  category: identifier,
  receivedAtMs: nonnegativeInteger,
}).strict();
export type AdminConsultationListItem = z.infer<typeof adminConsultationListItemSchema>;

export const adminConsultationListSchema = z.object({
  items: boundedItems(adminConsultationListItemSchema, 20),
  page: adminPageSchema,
}).strict();
export type AdminConsultationListDto = z.infer<typeof adminConsultationListSchema>;

export const adminConsultationDetailSchema = adminConsultationListItemSchema.extend({
  preferredContact: identifier,
  rowVersion: positiveInteger,
  piiAvailability: z.enum(["available", "expired", "purged"]),
  pii: z.object({
    name: boundedString,
    phone: boundedString,
    email: z.string().max(320).optional(),
    company: z.string().max(512).optional(),
    message: boundedString,
  }).strict().nullable(),
  nextStatuses: boundedItems(consultationStatusSchema, 5),
}).strict();
export type AdminConsultationDetailDto = z.infer<typeof adminConsultationDetailSchema>;

export const adminArticleListItemSchema = z.object({
  id: identifier,
  sourceLocale: localeSchema,
  locale: localeSchema,
  slug: identifier,
  state: articleStateSchema,
  rowVersion: positiveInteger,
  title: boundedString,
  updatedAtMs: nonnegativeInteger,
}).strict();
export type AdminArticleListItem = z.infer<typeof adminArticleListItemSchema>;

export const adminArticleListSchema = z.object({
  items: boundedItems(adminArticleListItemSchema, 50),
  page: adminPageSchema,
}).strict();
export type AdminArticleListDto = z.infer<typeof adminArticleListSchema>;

export const adminArticleHeadSchema = z.object({
  locale: localeSchema,
  slug: identifier,
  state: articleStateSchema,
  rowVersion: positiveInteger,
  headRevisionId: identifier,
  title: boundedString,
  summary: boundedString,
  bodyMarkdown: boundedArticleMarkdown,
  sourcesJson: z.string().max(65_536),
  createdAtMs: nonnegativeInteger,
  createdByType: identifier,
}).strict();
export type AdminArticleHeadDto = z.infer<typeof adminArticleHeadSchema>;

export const adminArticleRevisionSchema = z.object({
  id: identifier,
  locale: localeSchema,
  revisionNo: positiveInteger,
  title: boundedString,
  createdAtMs: nonnegativeInteger,
  createdByType: identifier,
  previousRevisionId: identifier.nullable(),
  previousRevisionNo: positiveInteger.nullable(),
}).strict();
export type AdminArticleRevisionDto = z.infer<typeof adminArticleRevisionSchema>;

export const adminArticleDetailSchema = z.object({
  id: identifier,
  sourceLocale: localeSchema,
  createdAtMs: nonnegativeInteger,
  updatedAtMs: nonnegativeInteger,
  heads: boundedItems(adminArticleHeadSchema, 4),
  revisions: boundedItems(adminArticleRevisionSchema, 50),
  revisionPage: adminPageSchema,
}).strict();
export type AdminArticleDetailDto = z.infer<typeof adminArticleDetailSchema>;

const adminRevisionContentSchema = z.object({
  id: identifier,
  title: boundedString,
  summary: boundedString,
  bodyMarkdown: boundedArticleMarkdown,
}).strict();

export const adminRevisionDiffSchema = z.object({
  locale: localeSchema,
  previous: adminRevisionContentSchema,
  current: adminRevisionContentSchema,
}).strict();
export type AdminRevisionDiffDto = z.infer<typeof adminRevisionDiffSchema>;

export const adminPublishPreviewItemSchema = z.object({
  articleId: identifier,
  locale: localeSchema,
  slug: identifier,
  state: articleStateSchema,
  headRevisionId: identifier,
  title: boundedString,
  summary: boundedString,
  sourceBindingValid: z.boolean(),
}).strict();

export const adminPublishPreviewSchema = z.object({
  eligible: boundedItems(adminPublishPreviewItemSchema, 100),
  blocked: boundedItems(adminPublishPreviewItemSchema, 100),
  eligibleTotal: nonnegativeInteger,
  blockedTotal: nonnegativeInteger,
  batchCount: nonnegativeInteger.max(64),
  remainingAfterBatch: nonnegativeInteger,
  mode: z.enum(["next-batch", "policy-only"]),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  page: adminPageSchema,
}).strict();
export type AdminPublishPreviewDto = z.infer<typeof adminPublishPreviewSchema>;

export const adminReleaseSchema = z.object({
  id: identifier,
  version: identifier,
  state: identifier,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  verifiedAtMs: nonnegativeInteger.nullable(),
  activatedAtMs: nonnegativeInteger.nullable(),
  rolledBackAtMs: nonnegativeInteger.nullable(),
  createdAtMs: nonnegativeInteger,
}).strict();
export type AdminReleaseDto = z.infer<typeof adminReleaseSchema>;

export const adminReleaseListSchema = z.object({
  items: boundedItems(adminReleaseSchema, 25),
  page: adminPageSchema,
}).strict();
export type AdminReleaseListDto = z.infer<typeof adminReleaseListSchema>;

export const adminNotificationSettingSchema = z.object({
  channel: notificationChannelSchema,
  enabled: z.boolean(),
  provider: identifier,
  payloadMode: z.enum(["receipt-only", "full-inquiry"]).nullable(),
  updatedAtMs: nonnegativeInteger,
  smtpConfigured: z.boolean(),
  smtp: z.object({
    host: identifier,
    port: z.literal(465),
    from: z.email(),
    to: z.email(),
    secretRef: z.string().regex(/^keychain:[A-Za-z0-9._-]+$/u),
  }).strict().optional(),
}).strict();

export const adminNotificationsSchema = z.object({
  settings: boundedItems(adminNotificationSettingSchema, 2),
}).strict();
export type AdminNotificationSettingDto = z.infer<typeof adminNotificationSettingSchema>;
export type AdminNotificationsDto = z.infer<typeof adminNotificationsSchema>;

export const adminConsentBundleSchema = z.object({
  bundleId: identifier,
  documents: boundedItems(z.object({
    kind: z.enum(["privacy", "marketing"]),
    locale: localeSchema,
    version: identifier,
  }).strict(), 8),
}).strict();
export type AdminConsentBundleDto = z.infer<typeof adminConsentBundleSchema>;

export const adminConsentAuthoritySchema = z.object({
  databaseCandidate: adminConsentBundleSchema.nullable(),
  publicAuthority: z.object({
    releaseId: identifier,
    bundleId: identifier,
  }).strict().nullable(),
  inSync: z.boolean(),
}).strict();
export type AdminConsentAuthorityDto = z.infer<typeof adminConsentAuthoritySchema>;

export const adminFailureSchema = z.object({
  id: identifier,
  channel: notificationChannelSchema,
  eventType: identifier,
  attemptCount: nonnegativeInteger,
  lastErrorCode: identifier.nullable(),
}).strict();

export const adminFailureListSchema = z.object({
  items: boundedItems(adminFailureSchema, 50),
  page: adminPageSchema,
}).strict();
export type AdminFailureDto = z.infer<typeof adminFailureSchema>;
export type AdminFailureListDto = z.infer<typeof adminFailureListSchema>;

export const adminHealthSchema = z.object({
  ready: z.boolean(),
  queues: boundedItems(z.object({
    state: identifier,
    count: nonnegativeInteger,
  }).strict(), 20),
}).strict();
export type AdminHealthDto = z.infer<typeof adminHealthSchema>;

export const adminSavedSchema = z.object({ saved: z.literal(true) }).strict();
export const adminDeliveryQueuedSchema = z.object({ deliveryId: identifier }).strict();
export const adminRequeuedSchema = z.object({ requeued: z.literal(true) }).strict();
export const adminConfirmationSchema = z.object({
  confirmationToken: identifier,
  expiresInMs: positiveInteger,
  version: identifier.optional(),
}).strict();
export const adminPublicationResultSchema = z.object({
  releaseId: identifier,
  version: identifier,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();

const adminConsultationMutationSchema = z.object({
  kind: z.enum(["updated", "unchanged"]),
  httpStatus: z.literal(200),
  consultationStatus: consultationStatusSchema,
  rowVersion: positiveInteger,
}).strict();
const adminArticleStateMutationSchema = z.object({
  kind: z.enum(["updated", "unchanged"]),
  httpStatus: z.literal(200),
  state: articleStateSchema,
  rowVersion: positiveInteger,
  headRevisionId: identifier,
}).strict();
const adminArticleSlugMutationSchema = z.object({
  kind: z.enum(["updated", "unchanged"]),
  httpStatus: z.literal(200),
  slug: identifier,
  state: articleStateSchema,
  rowVersion: positiveInteger,
}).strict();
const adminTranslationMutationSchema = z.union([
  z.object({
    kind: z.enum(["queued", "requeued"]),
    httpStatus: z.literal(202),
    jobId: identifier,
    sourceRevisionId: identifier,
    targetLocale: localeSchema,
  }).strict(),
  z.object({
    kind: z.literal("existing"),
    httpStatus: z.literal(200),
    jobId: identifier,
    jobState: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
    sourceRevisionId: identifier,
    targetLocale: localeSchema,
  }).strict(),
]);
export const adminConsultationMutationResultSchema = adminConsultationMutationSchema;
export const adminArticleMutationResultSchema = z.union([
  adminArticleStateMutationSchema,
  adminArticleSlugMutationSchema,
  adminTranslationMutationSchema,
]);
