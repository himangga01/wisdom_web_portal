import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { openAnalyticsDatabase, type AnalyticsDatabase } from "./analytics/store.js";
import { parseControlConfig, type ControlConfig } from "./config.js";
import { openDatabase, runMigrations, type ControlDatabase } from "./db/client.js";

export interface ControlRuntime {
  config: ControlConfig;
  db: ControlDatabase;
  analyticsDb: AnalyticsDatabase;
}

export function loadLocalEnvironment(path = ".env"): void {
  if (existsSync(path)) loadEnvFile(path);
}

export function createControlRuntime(
  source: Record<string, string | undefined> = process.env,
): ControlRuntime {
  const config = parseControlConfig(source);
  const db = openDatabase(config.databasePath);
  runMigrations(db);
  const analyticsDb = openAnalyticsDatabase(config.analyticsDatabasePath);
  return { config, db, analyticsDb };
}
