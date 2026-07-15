const FORM_SELECTOR = "[data-consultation-form]";

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
    const contactMethods = Array.from(form.querySelectorAll<HTMLInputElement>('[name="preferredContact"]'));

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
    form.addEventListener("change", updateEmailConstraint);
    updateEmailConstraint();
  });
}
