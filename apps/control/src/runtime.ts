import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { parseControlConfig, type ControlConfig } from "./config.js";
import {
  assertDatabaseSchemaCurrent,
  closeDatabase,
  openDatabase,
  type ControlDatabase,
} from "./db/client.js";

export interface ControlRuntime {
  config: ControlConfig;
  db: ControlDatabase;
}

export function loadLocalEnvironment(path = ".env"): void {
  if (existsSync(path)) loadEnvFile(path);
}

export function createControlRuntime(
  source: Record<string, string | undefined> = process.env,
): ControlRuntime {
  const config = parseControlConfig(source);
  const db = openDatabase(config.databasePath);
  try {
    assertDatabaseSchemaCurrent(db);
    return { config, db };
  } catch (error) {
    closeDatabase(db);
    throw error;
  }
}
