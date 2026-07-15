import { z } from "zod";

import {
  consultationCategorySchema,
  localeSchema,
  preferredContactSchema,
} from "./contracts.js";

const consentVersionSchema = z.string().trim().min(1);

export const privacyConsentSchema = z
  .object({
    version: consentVersionSchema,
    accepted: z.literal(true),
  })
  .strict();
export type PrivacyConsent = z.infer<typeof privacyConsentSchema>;

export const marketingConsentSchema = z
  .object({
    version: consentVersionSchema,
    accepted: z.boolean(),
  })
  .strict();
export type MarketingConsent = z.infer<typeof marketingConsentSchema>;

const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([z.literal("").transform(() => undefined), z.email()]).optional(),
);

const optionalCompanySchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.union([z.literal("").transform(() => undefined), z.string().max(100)]).optional(),
);

const normalizedPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 .()-]+$/, "Phone contains unsupported characters")
  .transform((value) => {
    const prefix = value.startsWith("+") ? "+" : "";
    return `${prefix}${value.replace(/\D/g, "")}`;
  })
  .refine(
    (value) => {
      const digitCount = value.startsWith("+") ? value.length - 1 : value.length;
      return digitCount >= 8 && digitCount <= 20;
    },
    { message: "Phone must contain between 8 and 20 digits" },
  );

export const consultationRequestSchema = z
  .object({
    locale: localeSchema,
    category: consultationCategorySchema,
    name: z.string().trim().min(2).max(50),
    phone: normalizedPhoneSchema,
    email: optionalEmailSchema,
    company: optionalCompanySchema,
    preferredContact: preferredContactSchema,
    message: z.string().trim().min(20).max(2000),
    privacyConsent: privacyConsentSchema,
    marketingConsent: marketingConsentSchema,
  })
  .strict()
  .superRefine((request, context) => {
    const emailRequired =
      request.preferredContact === "email" || request.marketingConsent.accepted;

    if (emailRequired && !request.email) {
      context.addIssue({
        code: "custom",
        message: "Email is required for the selected contact or marketing preference",
        path: ["email"],
      });
    }
  });

export type ConsultationRequestInput = z.input<typeof consultationRequestSchema>;
export type ConsultationRequest = z.output<typeof consultationRequestSchema>;
