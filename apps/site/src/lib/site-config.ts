import { CONSULTATION_CATEGORIES } from "@wisdom/shared";

export function getKakaoChatUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate === "#") return undefined;

  try {
    const url = new URL(candidate);
    const isKakaoHost = url.hostname === "kakao.com" || url.hostname.endsWith(".kakao.com");

    if (url.protocol !== "https:" || !isKakaoHost || url.username || url.password) {
      return undefined;
    }

    return candidate;
  } catch {
    return undefined;
  }
}

export const CONSULTATION_FORM = {
  action: "/api/v1/consultations",
  method: "post",
  fields: [
    "locale",
    "category",
    "name",
    "phone",
    "email",
    "company",
    "preferredContact",
    "message",
    "privacyConsent",
    "marketingConsent",
  ],
  categories: CONSULTATION_CATEGORIES,
} as const;
