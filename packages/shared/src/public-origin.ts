/// <reference lib="dom" />

export interface PublicOriginOptions {
  production: boolean;
}

const PLACEHOLDER_HOSTS = new Set([
  "example.com",
  "www.example.com",
  "localhost",
  "127.0.0.1",
  "::1",
]);

function isNonProductionHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return PLACEHOLDER_HOSTS.has(normalized)
    || normalized.endsWith(".test")
    || normalized.endsWith(".example")
    || normalized.endsWith(".invalid")
    || /(?:^|\.)(?:staging|stage|preview|dev|development)(?:\.|$)/.test(normalized);
}

function isAddressLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/gu, "");
  return normalized.includes(":") || /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(normalized);
}

function isPublicDnsHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return !isAddressLiteral(normalized)
    && normalized.includes(".")
    && !normalized.endsWith(".local");
}

export function parsePublicOrigin(
  value: string | undefined,
  options: PublicOriginOptions,
): string {
  if (!value || value.trim() !== value || value.endsWith("/")) {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
      || url.port
      || url.origin !== value
      || (
        options.production &&
        (
          isNonProductionHostname(url.hostname) ||
          !isPublicDnsHostname(url.hostname)
        )
      )
    ) {
      throw new Error("PUBLIC_ORIGIN_INVALID");
    }
    return url.origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }
}
