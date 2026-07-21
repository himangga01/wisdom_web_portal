import { describe, expect, it } from "vitest";

import { bucketAddress } from "./client-ip.js";
import { resolveClientIp } from "./rate-limit.js";

describe("trusted proxy client IP resolution", () => {
  it("trusts X-Forwarded-For only from loopback Caddy peers", () => {
    for (const peer of ["127.0.0.1", "127.42.10.3", "::1", "::ffff:127.0.0.1"]) {
      expect(resolveClientIp(peer, "198.51.100.20, 127.0.0.1"), peer).toBe("198.51.100.20");
    }
    expect(resolveClientIp("203.0.113.9", "198.51.100.20")).toBe("203.0.113.9");
    expect(resolveClientIp("127.0.0.1", "not-an-ip")).toBe("127.0.0.1");
  });

  it("ignores attacker-controlled leftmost values in a trusted proxy chain", () => {
    expect(resolveClientIp(
      "127.0.0.1",
      "192.0.2.66, 198.51.100.20, 127.0.0.2",
    )).toBe("198.51.100.20");
  });
});

describe("rate-limit bucket address aggregation", () => {
  it("keeps IPv4 addresses as-is", () => {
    expect(bucketAddress("203.0.113.9")).toBe("203.0.113.9");
    expect(bucketAddress("127.0.0.1")).toBe("127.0.0.1");
  });

  it("collapses IPv6 addresses in the same /64 into one bucket", () => {
    const first = bucketAddress("2001:db8:aaaa:bbbb:1:2:3:4");
    expect(first).toBe("2001:db8:aaaa:bbbb::/64");
    expect(bucketAddress("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff")).toBe(first);
    expect(bucketAddress("2001:db8:aaaa:bbbb::")).toBe(first);
    expect(bucketAddress("2001:0db8:AAAA:BBBB::1")).toBe(first);
  });

  it("separates different /64 prefixes", () => {
    expect(bucketAddress("2001:db8:aaaa:bbbc::1")).not.toBe(bucketAddress("2001:db8:aaaa:bbbb::1"));
  });

  it("maps IPv4-mapped IPv6 forms onto the embedded IPv4 bucket", () => {
    expect(bucketAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(bucketAddress("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  it("returns unparseable inputs unchanged", () => {
    expect(bucketAddress("unknown")).toBe("unknown");
    expect(bucketAddress("fe80::1%en0")).toBe("fe80::1%en0");
  });
});
