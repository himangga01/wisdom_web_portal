import type { Locale } from "@wisdom/shared";
import { createInstance, type InitOptions, type TFunction } from "i18next";

import { siteContent } from "../content/site-content.js";

export const i18nOptions = {
  fallbackLng: false,
  interpolation: { escapeValue: false },
  resources: Object.fromEntries(
    Object.entries(siteContent).map(([locale, translation]) => [locale, { translation }]),
  ),
} satisfies InitOptions;

export async function createTranslator(locale: Locale): Promise<TFunction> {
  const instance = createInstance();
  await instance.init({ ...i18nOptions, lng: locale });
  return instance.t.bind(instance);
}
