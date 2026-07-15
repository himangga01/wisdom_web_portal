import { consultationRequestSchema } from "@wisdom/shared";
import { describe, expect, it, vi } from "vitest";

function formData(overrides: Record<string, string> = {}): FormData {
  const values = {
    locale: "en",
    category: "procurement",
    name: "  Hong Gildong  ",
    phone: "+82 (10) 1234-5678",
    email: "",
    company: "  Wisdom Co.  ",
    preferredContact: "phone",
    message: "  Please review our public procurement registration plan.  ",
    privacyConsent: "accepted",
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

const consentConfiguration = {
  privacyVersion: "privacy-2026-07-16",
  marketingVersion: "marketing-2026-07-16",
  formToken: "signed-form-token",
};

describe("consultation form adapter", () => {
  it("builds a schema-valid normalized request with explicit unchecked marketing consent", async () => {
    const { buildConsultationSubmission } = await import("./consultation-adapter.js");

    const submission = buildConsultationSubmission(formData(), consentConfiguration);
    expect(consultationRequestSchema.parse(submission.consultation)).toEqual(submission.consultation);
    expect(submission).toMatchObject({
      consultation: {
        name: "Hong Gildong",
        phone: "+821012345678",
        company: "Wisdom Co.",
        privacyConsent: { version: consentConfiguration.privacyVersion, accepted: true },
        marketingConsent: { version: consentConfiguration.marketingVersion, accepted: false },
      },
      antiAbuse: { formToken: consentConfiguration.formToken, website: "" },
    });
  });

  it("includes checked marketing consent and its conditionally required email", async () => {
    const { buildConsultationSubmission } = await import("./consultation-adapter.js");
    const data = formData({ email: "client@example.com", marketingConsent: "accepted" });

    expect(buildConsultationSubmission(data, consentConfiguration)).toMatchObject({
      consultation: {
        email: "client@example.com",
        marketingConsent: { version: consentConfiguration.marketingVersion, accepted: true },
      },
    });
  });

  it("normalizes formatted phones and enforces the shared eight-to-twenty digit boundaries", async () => {
    const { buildConsultationSubmission } = await import("./consultation-adapter.js");

    expect(buildConsultationSubmission(
      formData({ phone: "02-123-456" }),
      consentConfiguration,
    ).consultation.phone).toBe("02123456");
    expect(buildConsultationSubmission(
      formData({ phone: "+12 (345) 6789-0123-4567-890" }),
      consentConfiguration,
    ).consultation.phone).toBe("+12345678901234567890");

    for (const phone of ["--------", "1234567", "123456789012345678901"]) {
      expect(() => buildConsultationSubmission(
        formData({ phone }),
        consentConfiguration,
      ), phone).toThrow();
    }
  });

  it("loads and validates active consent versions with the signed form token", async () => {
    const { loadConsentConfiguration } = await import("./consultation-adapter.js");
    const fetchRef = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      locale: "en",
      documents: {
        privacy: { version: consentConfiguration.privacyVersion },
        marketing: { version: consentConfiguration.marketingVersion },
      },
      formToken: consentConfiguration.formToken,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await expect(loadConsentConfiguration("en", { fetchRef })).resolves.toEqual(consentConfiguration);
    expect(fetchRef).toHaveBeenCalledWith(
      "/api/v1/consent-documents?locale=en",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("posts JSON with an idempotency UUID and validates the 201 receipt", async () => {
    const { buildConsultationSubmission, postConsultation } = await import("./consultation-adapter.js");
    const submission = buildConsultationSubmission(formData(), consentConfiguration);
    const idempotencyKey = "00000000-0000-4000-8000-000000000001";
    const fetchRef = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(JSON.stringify({
      receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
      receivedAt: "2026-07-16T02:00:00.000Z",
      status: "received",
    }), { status: 201, headers: { "content-type": "application/json" } }));

    const result = await postConsultation(submission, { fetchRef, idempotencyKey });

    expect(result).toEqual({
      ok: true,
      receipt: {
        receiptId: "receipt_01JZZZZZZZZZZZZZZZZZZZZZZZ",
        receivedAt: "2026-07-16T02:00:00.000Z",
        status: "received",
      },
    });
    expect(fetchRef).toHaveBeenCalledOnce();
    const [url, init] = fetchRef.mock.calls[0]!;
    expect(url).toBe("/api/v1/consultations");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(submission),
    });
  });

  it("reuses the idempotency key for the same serialized envelope and rotates on token changes", async () => {
    const {
      buildConsultationSubmission,
      createConsultationIdempotencyKeyCache,
    } = await import("./consultation-adapter.js");
    const firstKey = "00000000-0000-4000-8000-000000000001";
    const secondKey = "00000000-0000-4000-8000-000000000002";
    const createKey = vi.fn()
      .mockReturnValueOnce(firstKey)
      .mockReturnValueOnce(secondKey);
    const keyFor = createConsultationIdempotencyKeyCache(createKey);

    const firstSubmission = buildConsultationSubmission(formData(), consentConfiguration);
    const equivalentSubmission = buildConsultationSubmission(formData(), consentConfiguration);
    const refreshedTokenSubmission = buildConsultationSubmission(formData(), {
      ...consentConfiguration,
      formToken: "refreshed-signed-form-token",
    });

    expect(keyFor(firstSubmission)).toBe(firstKey);
    expect(keyFor(equivalentSubmission)).toBe(firstKey);
    expect(keyFor(refreshedTokenSubmission)).toBe(secondKey);
    expect(createKey).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed success receipt instead of presenting fake success", async () => {
    const { buildConsultationSubmission, postConsultation } = await import("./consultation-adapter.js");
    const fetchRef = vi.fn(async () => new Response(JSON.stringify({ status: "received" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));

    await expect(postConsultation(buildConsultationSubmission(formData(), consentConfiguration), {
      fetchRef,
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
    })).rejects.toThrow();
  });
});
