import { randomBytes as defaultRandomBytes } from "node:crypto";
import path from "node:path";

const MIGRATION_SENSITIVE_SECRETS = new Set([
  "CONTROL_HMAC_SECRET",
  "HERMES_HMAC_SECRET",
  "PII_ENCRYPTION_KEY",
  "WITHDRAWAL_TOKEN_SECRET",
]);
const AGE_IDENTITY_SERVICE = "com.jihye.portal.age-identity";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validateAccount(account) {
  if (typeof account !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(account)) {
    fail("INVALID_KEYCHAIN_ACCOUNT", "Keychain account must use a restricted non-empty name");
  }
}

function validateMapping(mapping) {
  if (
    !mapping ||
    !/^[A-Z][A-Z0-9_]{1,127}$/u.test(mapping.environment ?? "") ||
    !/^[A-Za-z0-9._-]{1,200}$/u.test(mapping.service ?? "")
  ) {
    fail("INVALID_SECRET_MAPPING", "Secret mappings must be ENVIRONMENT=keychain.service");
  }
}

function validateDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length === 0) {
    fail("INVALID_SECRET_DEFINITIONS", "At least one secret definition is required");
  }
  const environments = new Set();
  const services = new Set();
  for (const definition of definitions) {
    validateMapping(definition);
    if (!Number.isInteger(definition.bytes) || definition.bytes < 32 || definition.bytes > 128) {
      fail("INVALID_SECRET_DEFINITIONS", "Generated secrets must contain 32 to 128 random bytes");
    }
    if (environments.has(definition.environment) || services.has(definition.service)) {
      fail("INVALID_SECRET_DEFINITIONS", "Secret environments and services must be unique");
    }
    environments.add(definition.environment);
    services.add(definition.service);
  }
}

export async function installKeychainSecrets({
  account,
  definitions,
  dryRun = true,
  mode = "bootstrap",
  adapter,
  randomBytes = defaultRandomBytes,
}) {
  validateAccount(account);
  validateDefinitions(definitions);
  if (mode !== "bootstrap" && mode !== "rotate") {
    fail("INVALID_KEYCHAIN_MODE", "Keychain mode must be bootstrap or rotate");
  }
  if (mode === "rotate" && definitions.length !== 1) {
    fail("KEYCHAIN_BULK_ROTATION_FORBIDDEN", "Rotate exactly one Keychain item at a time");
  }
  if (mode === "rotate" && MIGRATION_SENSITIVE_SECRETS.has(definitions[0].environment)) {
    fail("KEYCHAIN_ROTATION_REQUIRES_MIGRATION", "This key requires its dedicated migration runbook");
  }
  if (!adapter?.exists || !adapter?.add) {
    fail("INVALID_KEYCHAIN_ADAPTER", "Keychain adapter is incomplete");
  }

  const states = [];
  for (const definition of definitions) {
    const exists = await adapter.exists({ account, service: definition.service });
    if (exists && mode !== "rotate") {
      fail("KEYCHAIN_ITEM_EXISTS", `Keychain item ${definition.service} already exists; use explicit rotation`);
    }
    states.push({ definition, exists });
  }

  const actions = states.map(({ definition, exists }) => ({
    action: mode === "rotate" && exists ? "rotate" : "create",
    environment: definition.environment,
    service: definition.service,
  }));

  if (!dryRun) {
    for (const { definition, exists } of states) {
      const value = randomBytes(definition.bytes).toString("base64");
      await adapter.add({
        account,
        service: definition.service,
        value,
        replace: mode === "rotate" && exists,
      });
    }
  }

  return { dryRun, actions };
}

export async function importAgeIdentity({ account, value, dryRun = true, adapter }) {
  validateAccount(account);
  if (dryRun) {
    return { dryRun: true, action: "import-age-identity", service: AGE_IDENTITY_SERVICE };
  }
  if (!adapter?.add) fail("INVALID_KEYCHAIN_ADAPTER", "Keychain add adapter is missing");
  const normalizedValue = typeof value === "string" ? value.replace(/\r?\n$/u, "") : "";
  if (
    /[\r\n\0]/u.test(normalizedValue) ||
    !/^AGE-SECRET-KEY-1[023456789ACDEFGHJKLMNPQRSTUVWXYZ]{40,100}$/u.test(normalizedValue)
  ) {
    fail("AGE_IDENTITY_INVALID", "Expected one age X25519 secret identity line");
  }
  await adapter.add({
    account,
    service: AGE_IDENTITY_SERVICE,
    value: normalizedValue,
    replace: false,
  });
  return { dryRun: false, action: "import-age-identity", service: AGE_IDENTITY_SERVICE };
}

export async function importCodexApiCredential({ account, service, value, dryRun = true, adapter }) {
  validateAccount(account);
  validateMapping({ environment: "CODEX_API_KEY", service });
  if (dryRun) return { dryRun: true, action: "import-codex-api", service };
  if (!adapter?.add) fail("INVALID_KEYCHAIN_ADAPTER", "Keychain add adapter is missing");
  const normalizedValue = typeof value === "string" ? value.replace(/\r?\n$/u, "") : "";
  if (normalizedValue.length < 20 || normalizedValue.length > 4_096 || !/^[!-~]+$/u.test(normalizedValue)) {
    fail("CODEX_API_CREDENTIAL_INVALID", "Expected one printable Codex API credential line");
  }
  await adapter.add({ account, service, value: normalizedValue, replace: false });
  return { dryRun: false, action: "import-codex-api", service };
}

export async function importIndexNowKey({ account, service, value, dryRun = true, adapter }) {
  validateAccount(account);
  validateMapping({ environment: "INDEXNOW_KEY", service });
  if (dryRun) return { dryRun: true, action: "import-indexnow-key", service };
  if (!adapter?.add) fail("INVALID_KEYCHAIN_ADAPTER", "Keychain add adapter is missing");
  const normalizedValue = typeof value === "string" ? value.replace(/\r?\n$/u, "") : "";
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(normalizedValue)) {
    fail("INDEXNOW_KEY_INVALID", "Expected one 8 to 128 character IndexNow ownership key");
  }
  await adapter.add({ account, service, value: normalizedValue, replace: false });
  return { dryRun: false, action: "import-indexnow-key", service };
}

export async function importSmtpCredential({ account, service, value, dryRun = true, adapter }) {
  validateAccount(account);
  validateMapping({ environment: "SMTP_CREDENTIAL_JSON", service });
  if (dryRun) return { dryRun: true, action: "import-smtp-json", service };
  if (!adapter?.add) fail("INVALID_KEYCHAIN_ADAPTER", "Keychain add adapter is missing");
  const normalizedValue = typeof value === "string" ? value.replace(/\r?\n$/u, "") : "";
  let parsed;
  try {
    parsed = JSON.parse(normalizedValue);
  } catch {
    fail("SMTP_CREDENTIAL_INVALID", "Expected one SMTP credential JSON line");
  }
  if (
    !exactObjectKeys(parsed, ["user", "password"]) ||
    typeof parsed.user !== "string" || parsed.user.length < 1 || parsed.user.length > 512 || !/^[!-~]+$/u.test(parsed.user) ||
    typeof parsed.password !== "string" || parsed.password.length < 1 || parsed.password.length > 4_096 || !/^[!-~]+$/u.test(parsed.password)
  ) fail("SMTP_CREDENTIAL_INVALID", "SMTP credential JSON must contain only printable user and password fields");
  await adapter.add({
    account,
    service,
    value: JSON.stringify({ user: parsed.user, password: parsed.password }),
    replace: false,
  });
  return { dryRun: false, action: "import-smtp-json", service };
}

function exactObjectKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
}

export function parseKeychainExecArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) {
    fail("KEYCHAIN_EXEC_USAGE", "An absolute command is required after --");
  }
  const options = argv.slice(0, separator);
  const commandParts = argv.slice(separator + 1);
  let account;
  let configPath;
  const mappings = [];
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index];
    const value = options[index + 1];
    if (!value) fail("KEYCHAIN_EXEC_USAGE", `Missing value for ${flag ?? "option"}`);
    if (flag === "--account") {
      if (account !== undefined) fail("KEYCHAIN_EXEC_USAGE", "Keychain account may appear only once");
      account = value;
    } else if (flag === "--config") {
      if (configPath !== undefined || !path.isAbsolute(value)) {
        fail("KEYCHAIN_EXEC_USAGE", "Runtime config path must be absolute and appear once");
      }
      configPath = value;
    } else if (flag === "--secret") {
      const equals = value.indexOf("=");
      const mapping = {
        environment: equals > 0 ? value.slice(0, equals) : "",
        service: equals > 0 ? value.slice(equals + 1) : "",
      };
      validateMapping(mapping);
      mappings.push(mapping);
    } else {
      fail("KEYCHAIN_EXEC_USAGE", `Unknown option ${flag}`);
    }
  }
  validateAccount(account);
  if (!path.isAbsolute(commandParts[0])) {
    fail("COMMAND_NOT_ABSOLUTE", "The child executable must be an absolute path");
  }
  if (mappings.length === 0) fail("KEYCHAIN_EXEC_USAGE", "At least one --secret mapping is required");
  if (new Set(mappings.map(({ environment }) => environment)).size !== mappings.length) {
    fail("INVALID_SECRET_MAPPING", "Secret environment names must be unique");
  }
  return {
    account,
    mappings,
    command: commandParts[0],
    args: commandParts.slice(1),
    ...(configPath === undefined ? {} : { configPath }),
  };
}

export async function loadKeychainEnvironment({ account, mappings, adapter, baseEnvironment = {} }) {
  validateAccount(account);
  if (!adapter?.read) fail("INVALID_KEYCHAIN_ADAPTER", "Keychain read adapter is missing");
  const environment = { ...baseEnvironment };
  const seen = new Set();
  for (const mapping of mappings) {
    validateMapping(mapping);
    if (seen.has(mapping.environment)) fail("INVALID_SECRET_MAPPING", "Secret environment names must be unique");
    seen.add(mapping.environment);
    const value = await adapter.read({ account, service: mapping.service });
    if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) {
      fail("KEYCHAIN_VALUE_INVALID", `Keychain item ${mapping.service} is missing or invalid`);
    }
    environment[mapping.environment] = value;
  }
  return environment;
}
