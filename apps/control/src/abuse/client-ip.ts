import { isIP } from "node:net";

function ipv6Words(address: string): number[] | undefined {
  let value = address.toLowerCase();
  const mapped = /^((?:[0-9a-f]{0,4}:)+)(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(value);
  if (mapped?.[1] && mapped[2]) {
    const octets = mapped[2].split(".").map(Number);
    if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
    const head = octets[0] ?? 0;
    const second = octets[1] ?? 0;
    const third = octets[2] ?? 0;
    const fourth = octets[3] ?? 0;
    value = `${mapped[1]}${((head << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (left.length + right.length > 8) return undefined;
  const middle = halves.length === 2 ? new Array<string>(8 - left.length - right.length).fill("0") : [];
  const words: number[] = [];
  for (const part of [...left, ...middle, ...right]) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words.length === 8 ? words : undefined;
}

/**
 * Collapses an address into its rate-limit bucket identity. IPv6 subscribers
 * typically control an entire /64, so distinct addresses inside one /64 must
 * share a bucket; IPv4-mapped IPv6 forms must share the embedded IPv4 bucket.
 */
export function bucketAddress(address: string): string {
  const family = isIP(address);
  if (family !== 6) return address;
  const words = ipv6Words(address);
  if (!words) return address;
  const isMapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (isMapped) {
    const high = words[6] ?? 0;
    const low = words[7] ?? 0;
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  const prefix = words.slice(0, 4).map((word) => word.toString(16)).join(":");
  return `${prefix}::/64`;
}
