import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCALES, type Locale } from "@wisdom/shared";

import type { ConsentDocumentSeed } from "../src/consent/service.js";
import { closeDatabase, openDatabase, runMigrations, type ControlDatabase } from "../src/db/client.js";

export interface TestDatabase {
  db: ControlDatabase;
  directory: string;
  path: string;
  close(): void;
}

export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), "wisdom-control-"));
  const path = join(directory, "control.sqlite");
  const db = openDatabase(path);
  runMigrations(db);
  return {
    db,
    directory,
    path,
    close() {
      closeDatabase(db);
      rmSync(directory, { force: true, recursive: true });
    },
  };
}

export function consentBundle(
  bundleId = "bundle-2026-07-16",
  suffix = "2026-07-16",
): ConsentDocumentSeed[] {
  return LOCALES.flatMap((locale: Locale) => [
    {
      bundleId,
      kind: "privacy" as const,
      locale,
      version: `privacy-${suffix}`,
      title: `Privacy ${locale}`,
      bodyMarkdown: `Privacy collection and processing terms for ${locale}.`,
      retentionMonths: 12 as const,
    },
    {
      bundleId,
      kind: "marketing" as const,
      locale,
      version: `marketing-${suffix}`,
      title: `Marketing ${locale}`,
      bodyMarkdown: `Optional marketing communications terms for ${locale}.`,
      retentionMonths: 24 as const,
    },
  ]);
}
