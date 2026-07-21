import { isIP } from "node:net";

import type { ControlDatabase } from "../db/client.js";
import { keyedDigest, type KeyProvider } from "../crypto/index.js";
import { bucketAddress } from "./client-ip.js";

const TEN_MINUTES_MS = 10 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const EXPIRY_GRACE_MS = 60 * 60 * 1_000;

interface RateSubject {
  kind: "ip" | "phone" | "email";
  value: string;
}

export interface RateLimitInput {
  clientIp: string;
  phone: string;
  email?: string;
}

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

function isLoopback(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopback(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const first = Number(normalized.split(".")[0]);
  return first === 127;
}

export function resolveClientIp(peerAddress: string, forwardedFor: string | undefined): string {
  if (!isLoopback(peerAddress) || !forwardedFor) return peerAddress;
  const chain = forwardedFor.split(",").map((value) => value.trim()).reverse();
  return chain.find((candidate) => isIP(candidate) !== 0 && !isLoopback(candidate)) ?? peerAddress;
}

function threshold(kind: RateSubject["kind"], window: "ten_minute" | "day"): number {
  if (kind === "ip") return window === "ten_minute" ? 5 : 20;
  return window === "ten_minute" ? 3 : 10;
}

function windowStart(nowMs: number, sizeMs: number): number {
  return Math.floor(nowMs / sizeMs) * sizeMs;
}

export function applyRateLimitsInTransaction(
  db: ControlDatabase,
  provider: KeyProvider,
  input: RateLimitInput,
  nowMs: number,
): RateLimitResult {
  if (!db.sqlite.inTransaction) throw new Error("Rate limits require an active write transaction");
  const subjects: RateSubject[] = [
    { kind: "ip", value: bucketAddress(input.clientIp) },
    { kind: "phone", value: input.phone },
    ...(input.email ? [{ kind: "email" as const, value: input.email.trim().normalize("NFKC").toLowerCase() }] : []),
  ];
  const upsert = db.sqlite.prepare(`
    INSERT INTO abuse_buckets (
      subject_kind, subject_hash, window_kind, window_start_ms, count, expires_at_ms
    ) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (subject_kind, subject_hash, window_kind, window_start_ms)
    DO UPDATE SET count = count + 1, expires_at_ms = excluded.expires_at_ms
    RETURNING count
  `);
  let retryAtMs = Number.POSITIVE_INFINITY;
  let limited = false;
  for (const subject of subjects) {
    const digest = keyedDigest(
      provider,
      "abuse",
      `wisdom:abuse:v1\0${subject.kind}\0${subject.value}`,
    );
    for (const [window, sizeMs] of [
      ["ten_minute", TEN_MINUTES_MS],
      ["day", DAY_MS],
    ] as const) {
      const start = windowStart(nowMs, sizeMs);
      const expiresAtMs = start + sizeMs + EXPIRY_GRACE_MS;
      const row = upsert.get(subject.kind, digest, window, start, expiresAtMs) as { count: number };
      if (row.count > threshold(subject.kind, window)) {
        limited = true;
        retryAtMs = Math.min(retryAtMs, start + sizeMs);
      }
    }
  }
  if (!limited) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)),
  };
}
