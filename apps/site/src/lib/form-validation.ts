import { LOCALES, type Locale } from "@wisdom/shared";

import {
  buildConsultationSubmission,
  createConsultationIdempotencyKeyCache,
  loadConsentConfiguration,
  postConsultation,
  type ConsentConfiguration,
} from "./consultation-adapter.js";

const FORM_SELECTOR = "[data-consultation-form]";

function supportedLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const locale = value as Locale;
  return LOCALES.includes(locale) ? locale : undefined;
}

function validationMessage(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  if (control.validity.valueMissing) return control.dataset.errorRequired ?? "";
  if (control.validity.patternMismatch) return control.dataset.errorPattern ?? "";
  if (control.validity.typeMismatch) return control.dataset.errorType ?? "";
  if (control.validity.tooShort || control.validity.tooLong) return control.dataset.errorTooShort ?? "";
  return "";
}

export function initializeConsultationForms(documentRef: Document = document): void {
  documentRef.querySelectorAll<HTMLFormElement>(FORM_SELECTOR).forEach((form) => {
    if (form.dataset.validationReady === "true") return;
    form.dataset.validationReady = "true";

    const email = form.elements.namedItem("email");
    const marketing = form.elements.namedItem("marketingConsent");
    const localeControl = form.elements.namedItem("locale");
    const contactMethods = Array.from(form.querySelectorAll<HTMLInputElement>('[name="preferredContact"]'));
    const status = form.querySelector<HTMLElement>("[data-form-status]");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const idempotencyKeyFor = createConsultationIdempotencyKeyCache();

    const selectedLocale = (): Locale | undefined => {
      if (!(localeControl instanceof HTMLSelectElement)) return undefined;
      return supportedLocale(localeControl.value);
    };

    let consentLocale = selectedLocale();
    let consentRequest: Promise<ConsentConfiguration | undefined> = consentLocale
      ? loadConsentConfiguration(consentLocale).catch(() => undefined)
      : Promise.resolve(undefined);

    const refreshConsent = (locale: Locale | undefined = selectedLocale()): void => {
      consentLocale = locale;
      consentRequest = consentLocale
        ? loadConsentConfiguration(consentLocale).catch(() => undefined)
        : Promise.resolve(undefined);
    };

    const showStatus = (state: "submitting" | "success" | "error", message: string): void => {
      if (!status) return;
      status.hidden = false;
      status.dataset.state = state;
      status.setAttribute("role", state === "error" ? "alert" : "status");
      status.textContent = message;
    };

    const updateEmailConstraint = (): void => {
      if (!(email instanceof HTMLInputElement) || !(marketing instanceof HTMLInputElement)) return;
      const selectedContact = contactMethods.find((control) => control.checked)?.value;
      email.required = selectedContact === "email" || marketing.checked;
      email.setAttribute("aria-required", String(email.required));
    };

    form.addEventListener("invalid", (event) => {
      const control = event.target;
      if (
        control instanceof HTMLInputElement
        || control instanceof HTMLSelectElement
        || control instanceof HTMLTextAreaElement
      ) {
        control.setCustomValidity("");
        control.setCustomValidity(validationMessage(control));
      }
    }, true);

    form.addEventListener("input", (event) => {
      const control = event.target;
      if (
        control instanceof HTMLInputElement
        || control instanceof HTMLSelectElement
        || control instanceof HTMLTextAreaElement
      ) {
        control.setCustomValidity("");
      }
      updateEmailConstraint();
    });
    form.addEventListener("change", (event) => {
      updateEmailConstraint();
      if (event.target === localeControl) refreshConsent();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      void (async () => {
        const submissionData = new FormData(form);
        const submissionLocale = supportedLocale(submissionData.get("locale"));
        const originalSubmitLabel = submit?.textContent ?? "";
        form.setAttribute("aria-busy", "true");
        if (submit) {
          submit.disabled = true;
          submit.textContent = form.dataset.statusSubmitting ?? originalSubmitLabel;
        }
        showStatus("submitting", form.dataset.statusSubmitting ?? "");

        try {
          if (!submissionLocale) {
            showStatus("error", form.dataset.statusInvalid ?? "");
            return;
          }
          if (submissionLocale !== consentLocale) refreshConsent(submissionLocale);
          let consent = await consentRequest;
          if (!consent) {
            refreshConsent(submissionLocale);
            consent = await consentRequest;
          }
          if (!consent) {
            showStatus("error", form.dataset.statusConfigurationFailure ?? "");
            return;
          }

          let submission;
          try {
            submission = buildConsultationSubmission(submissionData, consent);
          } catch {
            showStatus("error", form.dataset.statusInvalid ?? "");
            return;
          }

          try {
            const result = await postConsultation(submission, {
              endpoint: form.getAttribute("action") ?? "/api/v1/consultations",
              idempotencyKey: idempotencyKeyFor(submission),
            });
            if (!result.ok) {
              showStatus("error", form.dataset.statusFailure ?? "");
              return;
            }
            const message = (form.dataset.statusSuccess ?? "").replace(
              "{receiptId}",
              result.receipt.receiptId,
            );
            showStatus("success", message);
          } catch {
            showStatus("error", form.dataset.statusFailure ?? "");
          }
        } finally {
          form.removeAttribute("aria-busy");
          if (submit) {
            submit.disabled = false;
            submit.textContent = originalSubmitLabel;
          }
        }
      })();
    });
    updateEmailConstraint();
  });
}
