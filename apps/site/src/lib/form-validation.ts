import { LOCALES, type Locale } from "@wisdom/shared";

import {
  buildConsultationSubmission,
  createConsultationIdempotencyKeyCache,
  loadConsentConfiguration,
  postConsultation,
  type ConsentConfiguration,
  type ConsentDocument,
} from "./consultation-adapter.js";

const FORM_SELECTOR = "[data-consultation-form]";
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

function supportedLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  const locale = value as Locale;
  return LOCALES.includes(locale) ? locale : undefined;
}

function isFormControl(control: Element): control is FormControl {
  return control instanceof HTMLInputElement
    || control instanceof HTMLSelectElement
    || control instanceof HTMLTextAreaElement;
}

function controlsForField(form: HTMLFormElement, name: string): FormControl[] {
  return Array.from(form.elements).filter(
    (control): control is FormControl => isFormControl(control) && control.name === name,
  );
}

function validationMessage(control: FormControl): string {
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
    const privacy = form.elements.namedItem("privacyConsent");
    const localeControl = form.elements.namedItem("locale");
    const contactMethods = Array.from(form.querySelectorAll<HTMLInputElement>('[name="preferredContact"]'));
    const consentFieldset = form.querySelector<HTMLFieldSetElement>("[data-consent-fieldset]");
    const consentRetry = form.querySelector<HTMLButtonElement>("[data-consent-retry]");
    const status = form.querySelector<HTMLElement>("[data-form-status]");
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const idempotencyKeyFor = createConsultationIdempotencyKeyCache();

    const selectedLocale = (): Locale | undefined => {
      if (!(localeControl instanceof HTMLSelectElement)) return undefined;
      return supportedLocale(localeControl.value);
    };

    let consentLocale: Locale | undefined;
    let activeConsent: ConsentConfiguration | undefined;
    let consentLoadGeneration = 0;
    let submitting = false;

    const showStatus = (state: "submitting" | "success" | "error", message: string): void => {
      if (!status) return;
      status.hidden = false;
      status.dataset.state = state;
      status.setAttribute("role", state === "error" ? "alert" : "status");
      status.textContent = message;
    };

    const hideStatus = (): void => {
      if (!status) return;
      status.hidden = true;
      status.dataset.state = "";
      status.setAttribute("role", "status");
      status.textContent = "";
    };

    const applyServerFieldErrors = (errors: Record<string, string[]> | undefined): boolean => {
      if (!errors) return false;
      let first: FormControl | undefined;
      const localizedMessage = form.dataset.errorServer ?? form.dataset.statusInvalid ?? "";
      for (const name of Object.keys(errors)) {
        const controls = controlsForField(form, name);
        if (controls.length === 0) continue;
        controls[0]?.setCustomValidity(localizedMessage);
        for (const control of controls) {
          control.setAttribute("aria-invalid", "true");
          control.dataset.serverError = "true";
        }
        first ??= controls[0];
      }
      first?.focus();
      first?.reportValidity();
      return first !== undefined;
    };

    const setConsentRetryAvailable = (available: boolean): void => {
      if (!consentRetry) return;
      consentRetry.hidden = !available;
      consentRetry.disabled = !available;
    };

    const syncSubmitAvailability = (): void => {
      if (submit) submit.disabled = submitting || activeConsent === undefined;
    };

    const resetConsentDisplay = (): void => {
      activeConsent = undefined;
      setConsentRetryAvailable(false);
      for (const control of [privacy, marketing]) {
        if (control instanceof HTMLInputElement) {
          control.checked = false;
          control.disabled = true;
        }
      }
      consentFieldset?.setAttribute("aria-busy", "true");
      form.querySelectorAll<HTMLElement>("[data-consent-document]").forEach((document) => {
        document.hidden = true;
      });
      syncSubmitAvailability();
    };

    const renderConsentDocument = (kind: "privacy" | "marketing", document: ConsentDocument): void => {
      const container = form.querySelector<HTMLElement>(`[data-consent-document="${kind}"]`);
      if (!container) throw new Error(`Missing ${kind} consent container`);
      const title = container.querySelector<HTMLElement>("[data-consent-title]");
      const version = container.querySelector<HTMLElement>("[data-consent-version]");
      const effective = container.querySelector<HTMLTimeElement>("[data-consent-effective]");
      const retention = container.querySelector<HTMLElement>("[data-consent-retention]");
      const body = container.querySelector<HTMLElement>("[data-consent-body]");
      if (!title || !version || !effective || !retention || !body) {
        throw new Error(`Incomplete ${kind} consent container`);
      }
      title.textContent = document.title;
      version.textContent = document.version;
      effective.dateTime = document.effectiveAt;
      effective.textContent = document.effectiveAt.slice(0, 10);
      retention.textContent = String(document.retentionMonths);
      body.textContent = document.bodyMarkdown;
      container.hidden = false;
    };

    const refreshConsent = async (
      locale: Locale | undefined = selectedLocale(),
      restoreFocus = false,
    ): Promise<ConsentConfiguration | undefined> => {
      const generation = ++consentLoadGeneration;
      consentLocale = locale;
      hideStatus();
      resetConsentDisplay();
      if (!locale) return undefined;
      const loaded = await loadConsentConfiguration(locale).catch(() => undefined);
      if (generation !== consentLoadGeneration || selectedLocale() !== locale) return loaded;
      if (!loaded) {
        consentFieldset?.setAttribute("aria-busy", "false");
        setConsentRetryAvailable(true);
        showStatus("error", form.dataset.statusConfigurationFailure ?? "");
        return undefined;
      }
      try {
        renderConsentDocument("privacy", loaded.documents.privacy);
        renderConsentDocument("marketing", loaded.documents.marketing);
      } catch {
        consentFieldset?.setAttribute("aria-busy", "false");
        setConsentRetryAvailable(true);
        showStatus("error", form.dataset.statusConfigurationFailure ?? "");
        return undefined;
      }
      activeConsent = loaded;
      for (const control of [privacy, marketing]) {
        if (control instanceof HTMLInputElement) control.disabled = false;
      }
      consentFieldset?.setAttribute("aria-busy", "false");
      syncSubmitAvailability();
      if (restoreFocus && privacy instanceof HTMLInputElement) {
        showStatus("success", form.dataset.statusConsentReady ?? "");
        privacy.focus();
      }
      return loaded;
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
        if (control.dataset.serverError === "true") return;
        control.setCustomValidity("");
        control.setCustomValidity(validationMessage(control));
      }
    }, true);

    form.addEventListener("input", (event) => {
      const control = event.target;
      if (control instanceof Element && isFormControl(control)) {
        const relatedControls = control.name === ""
          ? [control]
          : controlsForField(form, control.name);
        for (const relatedControl of relatedControls) {
          relatedControl.setCustomValidity("");
          relatedControl.removeAttribute("aria-invalid");
          delete relatedControl.dataset.serverError;
        }
      }
      updateEmailConstraint();
    });
    form.addEventListener("change", (event) => {
      updateEmailConstraint();
      if (event.target === localeControl) void refreshConsent();
    });
    consentRetry?.addEventListener("click", () => {
      void refreshConsent(selectedLocale(), true);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      const submissionData = new FormData(form);
      const submissionLocale = supportedLocale(submissionData.get("locale"));
      const consentAtSubmit = activeConsent;
      if (!submissionLocale || submissionLocale !== consentLocale || !consentAtSubmit) {
        showStatus("error", form.dataset.statusConfigurationFailure ?? "");
        return;
      }

      void (async () => {
        const originalSubmitLabel = submit?.textContent ?? "";
        let terminalStatus: { state: "success" | "error"; message: string } | undefined;
        submitting = true;
        form.setAttribute("aria-busy", "true");
        if (submit) {
          submit.textContent = form.dataset.statusSubmitting ?? originalSubmitLabel;
        }
        syncSubmitAvailability();
        showStatus("submitting", form.dataset.statusSubmitting ?? "");

        try {
          let submission;
          try {
            submission = buildConsultationSubmission(submissionData, consentAtSubmit);
          } catch {
            terminalStatus = { state: "error", message: form.dataset.statusInvalid ?? "" };
            return;
          }

          try {
            const result = await postConsultation(submission, {
              endpoint: form.getAttribute("action") ?? "/api/v1/consultations",
              idempotencyKey: idempotencyKeyFor(submission),
            });
            if (!result.ok) {
              if (result.status === 409 && result.error?.code === "CONSENT_VERSION_STALE") {
                if (selectedLocale() === submissionLocale) {
                  await refreshConsent(submissionLocale);
                }
                terminalStatus = {
                  state: "error",
                  message: form.dataset.statusConsentUpdated ?? "",
                };
                return;
              }
              if (result.status === 422 && applyServerFieldErrors(result.error?.fieldErrors)) {
                terminalStatus = { state: "error", message: form.dataset.statusInvalid ?? "" };
                return;
              }
              if (result.status === 429) {
                terminalStatus = {
                  state: "error",
                  message: result.retryAfterSeconds === undefined
                    ? form.dataset.statusRateLimitedGeneric ?? form.dataset.statusFailure ?? ""
                    : (form.dataset.statusRateLimited ?? form.dataset.statusFailure ?? "")
                      .replace("{seconds}", String(result.retryAfterSeconds)),
                };
                return;
              }
              terminalStatus = { state: "error", message: form.dataset.statusFailure ?? "" };
              return;
            }
            const message = (form.dataset.statusSuccess ?? "").replace(
              "{receiptId}",
              result.receipt.receiptId,
            );
            terminalStatus = { state: "success", message };
          } catch {
            terminalStatus = { state: "error", message: form.dataset.statusFailure ?? "" };
          }
        } finally {
          submitting = false;
          form.removeAttribute("aria-busy");
          if (submit) {
            submit.textContent = originalSubmitLabel;
          }
          syncSubmitAvailability();
          if (terminalStatus) {
            showStatus(terminalStatus.state, terminalStatus.message);
          }
        }
      })();
    });
    updateEmailConstraint();
    resetConsentDisplay();
    void refreshConsent();
  });
}
