import { z } from "zod";

export const LOCALES = ["ko", "en", "zh-Hans", "zh-Hant"] as const;
export const localeSchema = z.enum(LOCALES);
export type Locale = z.infer<typeof localeSchema>;

export const CONSULTATION_CATEGORIES = [
  "procurement",
  "credibility",
  "safety-esg",
  "business-certification",
  "licensing-entity",
  "immigration-visa",
  "other",
] as const;
export const consultationCategorySchema = z.enum(CONSULTATION_CATEGORIES);
export type ConsultationCategory = z.infer<typeof consultationCategorySchema>;

export const CONSULTATION_STATUSES = [
  "received",
  "acknowledged",
  "in_progress",
  "closed",
  "spam",
] as const;
export const consultationStatusSchema = z.enum(CONSULTATION_STATUSES);
export type ConsultationStatus = z.infer<typeof consultationStatusSchema>;

export const PREFERRED_CONTACT_METHODS = ["phone", "email"] as const;
export const preferredContactSchema = z.enum(PREFERRED_CONTACT_METHODS);
export type PreferredContact = z.infer<typeof preferredContactSchema>;

export const NOTIFICATION_CHANNELS = ["email", "hermes-telegram"] as const;
export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const EMAIL_PAYLOAD_MODES = ["receipt-only", "full-inquiry"] as const;
export const emailPayloadModeSchema = z.enum(EMAIL_PAYLOAD_MODES);
export type EmailPayloadMode = z.infer<typeof emailPayloadModeSchema>;

export const ARTICLE_STATES = [
  "draft",
  "in_review",
  "approved",
  "published",
  "rejected",
] as const;
export const articleStateSchema = z.enum(ARTICLE_STATES);
export type ArticleState = z.infer<typeof articleStateSchema>;

export const consultationReceiptSchema = z
  .object({
    receiptId: z.string().min(1),
    receivedAt: z.iso.datetime({ offset: true }),
    status: z.literal("received"),
  })
  .strict();
export type ConsultationReceipt = z.infer<typeof consultationReceiptSchema>;

export const apiErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    fieldErrors: z.record(z.string(), z.array(z.string().min(1))).optional(),
    requestId: z.string().min(1),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;
