import {
  apiErrorSchema,
  consultationReceiptSchema,
  consultationRequestSchema,
  type ApiError,
  type ConsultationReceipt,
  type ConsultationRequest,
  type Locale,
} from "@wisdom/shared";

const CONSENT_ENDPOINT = "/api/v1/consent-documents";
const CONSULTATION_ENDPOINT = "/api/v1/consultations";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ConsentConfiguration {
  privacyVersion: string;
  marketingVersion: string;
  formToken: string;
  documents: {
    privacy: ConsentDocument;
    marketing: ConsentDocument;
  };
}

export interface ConsentDocument {
  version: string;
  title: string;
  bodyMarkdown: string;
  contentSha256: string;
  effectiveAt: string;
  retentionMonths: number;
  required: boolean;
}

export interface ConsultationSubmission {
  consultation: ConsultationRequest;
  antiAbuse: {
    formToken: string;
    website: string;
  };
}

export type ConsultationPostResult =
  | { ok: true; receipt: ConsultationReceipt }
  | { ok: false; status: number; error?: ApiError };

export function createConsultationIdempotencyKeyCache(
  createKey: () => string = () => globalThis.crypto.randomUUID(),
): (submission: ConsultationSubmission) => string {
  let previousBody: string | undefined;
  let previousKey: string | undefined;

  return (submission) => {
    const body = JSON.stringify(submission);
    if (body !== previousBody || previousKey === undefined) {
      previousBody = body;
      previousKey = createKey();
    }
    return previousKey;
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid consent response: ${path}`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid consent response: ${path}`);
  }
  return value;
}

function parseConsentDocument(
  value: unknown,
  path: string,
  expectedRequired: boolean,
): ConsentDocument {
  const document = record(value, path);
  const contentSha256 = nonEmptyString(document.contentSha256, `${path}.contentSha256`);
  if (!/^[0-9a-f]{64}$/.test(contentSha256)) {
    throw new Error(`Invalid consent response: ${path}.contentSha256`);
  }
  const effectiveAt = nonEmptyString(document.effectiveAt, `${path}.effectiveAt`);
  const date = new Date(effectiveAt);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== effectiveAt) {
    throw new Error(`Invalid consent response: ${path}.effectiveAt`);
  }
  if (
    !Number.isSafeInteger(document.retentionMonths)
    || (document.retentionMonths as number) < 1
    || (document.retentionMonths as number) > 1_200
  ) {
    throw new Error(`Invalid consent response: ${path}.retentionMonths`);
  }
  if (document.required !== expectedRequired) {
    throw new Error(`Invalid consent response: ${path}.required`);
  }
  return {
    version: nonEmptyString(document.version, `${path}.version`),
    title: nonEmptyString(document.title, `${path}.title`),
    bodyMarkdown: nonEmptyString(document.bodyMarkdown, `${path}.bodyMarkdown`),
    contentSha256,
    effectiveAt,
    retentionMonths: document.retentionMonths as number,
    required: expectedRequired,
  };
}

function formValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export function parseConsentConfiguration(value: unknown, locale: Locale): ConsentConfiguration {
  const response = record(value, "response");
  if (response.locale !== locale) throw new Error("Invalid consent response: locale");
  const documents = record(response.documents, "documents");
  const privacy = parseConsentDocument(documents.privacy, "documents.privacy", true);
  const marketing = parseConsentDocument(documents.marketing, "documents.marketing", false);

  return {
    privacyVersion: privacy.version,
    marketingVersion: marketing.version,
    formToken: nonEmptyString(response.formToken, "formToken"),
    documents: { privacy, marketing },
  };
}

export async function loadConsentConfiguration(
  locale: Locale,
  options: { fetchRef?: FetchLike } = {},
): Promise<ConsentConfiguration> {
  const fetchRef = options.fetchRef ?? fetch;
  const response = await fetchRef(`${CONSENT_ENDPOINT}?locale=${encodeURIComponent(locale)}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Consent configuration unavailable: ${response.status}`);
  return parseConsentConfiguration(await response.json(), locale);
}

export function buildConsultationSubmission(
  data: FormData,
  consent: ConsentConfiguration,
): ConsultationSubmission {
  const consultation = consultationRequestSchema.parse({
    locale: formValue(data, "locale"),
    category: formValue(data, "category"),
    name: formValue(data, "name"),
    phone: formValue(data, "phone"),
    email: formValue(data, "email"),
    company: formValue(data, "company"),
    preferredContact: formValue(data, "preferredContact"),
    message: formValue(data, "message"),
    privacyConsent: {
      version: consent.privacyVersion,
      accepted: formValue(data, "privacyConsent") === "accepted",
    },
    marketingConsent: {
      version: consent.marketingVersion,
      accepted: formValue(data, "marketingConsent") === "accepted",
    },
  });

  return {
    consultation,
    antiAbuse: {
      formToken: consent.formToken,
      website: formValue(data, "website"),
    },
  };
}

export async function postConsultation(
  submission: ConsultationSubmission,
  options: {
    endpoint?: string;
    fetchRef?: FetchLike;
    idempotencyKey?: string;
  } = {},
): Promise<ConsultationPostResult> {
  const fetchRef = options.fetchRef ?? fetch;
  const idempotencyKey = options.idempotencyKey ?? globalThis.crypto.randomUUID();
  const response = await fetchRef(options.endpoint ?? CONSULTATION_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    credentials: "same-origin",
    body: JSON.stringify(submission),
  });
  const body: unknown = await response.json().catch(() => undefined);

  if (response.status === 201) {
    return { ok: true, receipt: consultationReceiptSchema.parse(body) };
  }

  const error = apiErrorSchema.safeParse(body);
  return error.success
    ? { ok: false, status: response.status, error: error.data }
    : { ok: false, status: response.status };
}
