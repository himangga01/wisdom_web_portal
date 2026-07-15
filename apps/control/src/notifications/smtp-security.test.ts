import { describe, expect, it } from "vitest";

import {
  assertPublicSmtpResolution,
  isAllowedSmtpHostname,
  isPublicRoutableAddress,
} from "./smtp-security.js";

describe("SMTP endpoint security", () => {
  it("accepts only DNS FQDNs and rejects local, reserved, and literal targets", () => {
    expect(isAllowedSmtpHostname("smtp.example.com")).toBe(true);
    for (const hostname of [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "smtp.localhost",
      "mail.local",
      "mail.internal",
      "mail.lan",
      "mail.home",
      "mail.localdomain",
      "smtp.example.test",
      "smtp.example.invalid",
      "smtp.example.example",
      "single-label",
      "smtp.example.com.",
    ]) {
      expect(isAllowedSmtpHostname(hostname), hostname).toBe(false);
    }
  });

  it("rejects loopback, private, link-local, documentation, multicast, ULA, and mapped addresses", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.1.1",
      "172.16.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:8.8.8.8",
      "64:ff9b::7f00:1",
      "100::1",
      "2001:db8::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
    ]) {
      expect(isPublicRoutableAddress(address), address).toBe(false);
    }
    expect(isPublicRoutableAddress("8.8.8.8")).toBe(true);
    expect(isPublicRoutableAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("requires a non-empty all-public DNS answer and selects a pinned address", () => {
    expect(assertPublicSmtpResolution([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ])).toBe("93.184.216.34");
    expect(() => assertPublicSmtpResolution([])).toThrow(/resolution/i);
    expect(() => assertPublicSmtpResolution([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ])).toThrow(/public/i);
  });
});
