export function option(argv, name, { required = true } = {}) {
  const matches = argv.flatMap((value, index) => value === name ? [index] : []);
  if (matches.length > 1) throw Object.assign(new Error(`Duplicate ${name}`), { code: "CLI_USAGE" });
  if (matches.length === 0) {
    if (required) throw Object.assign(new Error(`Missing ${name}`), { code: "CLI_USAGE" });
    return undefined;
  }
  const value = argv[matches[0] + 1];
  if (!value || value.startsWith("--")) throw Object.assign(new Error(`Missing value for ${name}`), { code: "CLI_USAGE" });
  return value;
}

export function integerOption(argv, name) {
  const value = Number(option(argv, name));
  if (!Number.isSafeInteger(value)) throw Object.assign(new Error(`${name} must be an integer`), { code: "CLI_USAGE" });
  return value;
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
