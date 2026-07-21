import { isIP } from "node:net";

const RESERVED_DNS_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "test",
  "invalid",
  "example",
] as const;

export interface SmtpLookupAddress {
  address: string;
  family: 4 | 6;
}

/** Accept only canonical, externally delegated-looking ASCII DNS FQDNs. */
export function isAllowedSmtpHostname(value: string): boolean {
  if (
    value.length < 4 || value.length > 253 ||
    value !== value.trim() || value.endsWith(".") ||
    /[\r\n]/.test(value) || isIP(value.replace(/^\[|\]$/g, "")) !== 0
  ) return false;
  const labels = value.toLowerCase().split(".");
  if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1)!)) return false;
  if (RESERVED_DNS_SUFFIXES.some((suffix) =>
    value.toLowerCase() === suffix || value.toLowerCase().endsWith(`.${suffix}`))) return false;
  return labels.every((label) =>
    /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

function ipv4Octets(address: string): number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  return address.split(".").map(Number);
}

function ipv6Words(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let canonical = address.toLowerCase();
  const ipv4Tail = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(canonical)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Octets(ipv4Tail);
    if (!octets) return undefined;
    canonical = canonical.slice(0, -ipv4Tail.length) +
      `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = canonical.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function isPublicIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  const [a, b] = words;
  // Reject IPv4-compatible/mapped forms and translation prefixes instead of
  // letting alternate textual forms bypass the IPv4 policy.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) return false;
  if (a === 0x0064 && b === 0xff9b) return false;
  // Only global unicast 2000::/3 is eligible. This excludes unspecified,
  // loopback, ULA, link-local, multicast, discard-only, and other special space.
  if ((a! & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x2001 && b === 0x0002) return false; // benchmarking
  if (a === 0x2001 && b! >= 0x0010 && b! <= 0x001f) return false; // ORCHID
  if (a === 0x2001 && b! >= 0x0020 && b! <= 0x002f) return false; // ORCHIDv2
  if (a === 0x2001 && b === 0) return false; // Teredo 2001::/32
  return true;
}

export function isPublicRoutableAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isPublicIpv4(address) : version === 6 ? isPublicIpv6(address) : false;
}

export function assertPublicSmtpResolution(addresses: readonly SmtpLookupAddress[]): string {
  if (addresses.length === 0) throw new Error("SMTP DNS resolution returned no addresses");
  for (const result of addresses) {
    if (isIP(result.address) !== result.family || !isPublicRoutableAddress(result.address)) {
      throw new Error("SMTP DNS resolution must contain only public-routable addresses");
    }
  }
  return addresses[0]!.address;
}
