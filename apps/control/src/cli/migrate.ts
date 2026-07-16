import { parseControlConfig } from "../config.js";
import {
  assertRollbackCompatibleMigration,
  closeDatabase,
  openDatabase,
  runMigrations,
} from "../db/client.js";
import { loadLocalEnvironment } from "../runtime.js";
import { parseMigrateArguments } from "./arguments.js";

loadLocalEnvironment();
const options = parseMigrateArguments(process.argv.slice(2));
const config = parseControlConfig(process.env);
const db = openDatabase(config.databasePath);
try {
  if (options.requireRollbackCompatible) assertRollbackCompatibleMigration(db);
  runMigrations(db);
  console.log(JSON.stringify({ event: "database.migrated", status: "ok" }));
} finally {
  closeDatabase(db);
}
