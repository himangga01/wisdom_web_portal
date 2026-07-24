const MENU_SELECTOR = "[data-mobile-menu]";

/**
 * Progressive enhancement for the native <details> mobile menu: close it on
 * Escape or an outside click/tap, and keep the toggle's accessible name in sync
 * with its open/closed state. Without JS the menu still opens and closes via the
 * native <summary> toggle.
 */
export function initializeMobileMenu(documentRef: Document = document): void {
  documentRef.querySelectorAll<HTMLDetailsElement>(MENU_SELECTOR).forEach((menu) => {
    if (menu.dataset.mobileMenuReady === "true") return;
    menu.dataset.mobileMenuReady = "true";
    const summary = menu.querySelector<HTMLElement>("summary");

    const syncLabel = (): void => {
      if (!summary) return;
      const label = menu.open
        ? summary.dataset.closeLabel
        : summary.dataset.openLabel;
      if (label) summary.setAttribute("aria-label", label);
    };

    menu.addEventListener("toggle", syncLabel);

    documentRef.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        summary?.focus();
      }
    });

    documentRef.addEventListener("click", (event) => {
      if (!menu.open) return;
      const target = event.target;
      if (target instanceof Node && !menu.contains(target)) {
        // If focus was inside the menu we are closing, return it to the toggle
        // (mirrors the Escape path) so keyboard focus is not lost to <body>.
        const focusWasInside = documentRef.activeElement instanceof Node
          && menu.contains(documentRef.activeElement);
        menu.open = false;
        if (focusWasInside) summary?.focus();
      }
    });

    syncLabel();
  });
}
