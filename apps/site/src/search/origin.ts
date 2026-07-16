export { parsePublicOrigin, type PublicOriginOptions } from "@wisdom/shared";

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
