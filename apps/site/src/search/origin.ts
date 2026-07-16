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
      || (options.production && isNonProductionHostname(url.hostname))
    ) {
      throw new Error("PUBLIC_ORIGIN_INVALID");
    }
    return url.origin;
  } catch {
    throw new Error("PUBLIC_ORIGIN_INVALID");
  }
}

export function absolutePublicUrl(origin: string, pathname: string): string {
  if (
    !pathname.startsWith("/")
    || pathname.startsWith("//")
    || pathname.includes("?")
    || pathname.includes("#")
    || pathname.includes("\\")
  ) {
    throw new Error("PUBLIC_PATH_INVALID");
  }
  const url = new URL(pathname, `${origin}/`);
  if (url.origin !== origin || `${url.pathname}` !== pathname) {
    throw new Error("PUBLIC_PATH_INVALID");
  }
  return url.href;
}
