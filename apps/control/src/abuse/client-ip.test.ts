import { describe, expect, it } from "vitest";

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
