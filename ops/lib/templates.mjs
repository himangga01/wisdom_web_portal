import { readFile } from "node:fs/promises";

const TOKEN = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function renderTemplate(source, values) {
  const missing = new Set();
  const rendered = source.replace(TOKEN, (_match, name) => {
    const value = values[name];
    if (value === undefined || value === null || String(value).length === 0) {
      missing.add(name);
      return "";
    }
    if (/[\0\r\n]/u.test(String(value))) {
      throw new Error(`Template value ${name} contains a forbidden control character`);
    }
    return String(value);
  });
  if (missing.size > 0) {
    throw new Error(`Missing template values: ${[...missing].sort().join(", ")}`);
  }
  const unresolved = [...rendered.matchAll(TOKEN)].map((match) => match[1]);
  if (unresolved.length > 0) {
    throw new Error(`Unresolved template values: ${[...new Set(unresolved)].sort().join(", ")}`);
  }
  return rendered;
}

export async function renderTemplateFile(filePath, values) {
  return renderTemplate(await readFile(filePath, "utf8"), values);
}
