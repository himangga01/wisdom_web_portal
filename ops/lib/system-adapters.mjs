import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function defaultRun(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      ...options,
      shell: false,
      stdio: options.stdio ?? ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(Object.assign(new Error("External command failed"), {
        code: "EXTERNAL_COMMAND_FAILED",
        exitCode: code,
        signal,
      }));
    });
  });
}

function validatePath(candidate) {
  return typeof candidate === "string" && path.isAbsolute(candidate) && !/[\0\r\n]/u.test(candidate);
}

export function createAgeAdapter({ executable, run = defaultRun }) {
  if (!validatePath(executable)) fail("AGE_ADAPTER_INPUT_INVALID", "age executable must be absolute");
  return {
    encrypt: async ({ input, output, recipient }) => {
      if (!validatePath(input) || !validatePath(output) || typeof recipient !== "string" || !recipient.startsWith("age1")) {
        fail("AGE_ADAPTER_INPUT_INVALID", "age encryption input is invalid");
      }
      await run(executable, ["--recipient", recipient, "--output", output, input], {
        shell: false,
        stdio: ["ignore", "ignore", "ignore"],
      });
    },
    decrypt: async ({ input, output, identity }) => {
      if (!validatePath(input) || !validatePath(output) || typeof identity !== "string" || identity.length < 16 || /[\0\r\n]/u.test(identity)) {
        fail("AGE_ADAPTER_INPUT_INVALID", "age decryption input is invalid");
      }
      const identityPath = `${output}.identity-${randomUUID()}`;
      try {
        await writeFile(identityPath, `${identity}\n`, { mode: 0o600, flag: "wx" });
        await chmod(identityPath, 0o600);
        await run(executable, ["--decrypt", "--identity", identityPath, "--output", output, input], {
          shell: false,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } finally {
        await rm(identityPath, { force: true });
      }
    },
  };
}

export function createSqliteAdapter({
  loadDatabase = async () => (await import("better-sqlite3")).default,
  expectedSchemaVersion = 3,
} = {}) {
  return {
    checkpoint: async (source) => {
      const Database = await loadDatabase();
      const database = new Database(source);
      try {
        database.pragma("wal_checkpoint(PASSIVE)");
      } finally {
        database.close();
      }
    },
    onlineBackup: async (source, destination) => {
      const Database = await loadDatabase();
      const database = new Database(source);
      try {
        await database.backup(destination);
      } finally {
        database.close();
      }
    },
    inspect: async (databasePath) => {
      const Database = await loadDatabase();
      const database = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const integrityRows = database.pragma("integrity_check");
        const integrity = integrityRows.every((row) => Object.values(row).every((value) => value === "ok")) ? "ok" : "corrupt";
        const schemaVersion = Number(database.pragma("user_version", { simple: true }));
        const sqliteVersion = database.prepare("SELECT sqlite_version() AS version").get().version;
        return { integrity, schemaVersion, sqliteVersion };
      } finally {
        database.close();
      }
    },
    schemaCompatible: async ({ schemaVersion }) => schemaVersion === expectedSchemaVersion,
  };
}
