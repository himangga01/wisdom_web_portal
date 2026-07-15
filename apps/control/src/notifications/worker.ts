import type { ControlDatabase } from "../db/client.js";
import type { NotificationDeliveryResult, NotificationMetadata } from "./adapters.js";
import {
  cancelClaimedNotification,
  claimNotification,
  finalizeNotificationFailure,
  finalizeNotificationSuccess,
} from "./outbox.js";
import { mintMarketingWithdrawalCapability } from "../withdrawal/service.js";

export interface NotificationAdapter {
  deliver(input: NotificationMetadata): Promise<NotificationDeliveryResult>;
}

export interface NotificationWorkerLogEvent {
  deliveryId: string;
  channel: "email" | "hermes-telegram";
  attempt: number;
  outcomeCode: string;
}

export interface NotificationWorkerOptions {
  db: ControlDatabase;
  workerId: string;
  adminOrigin: string;
  now?: () => number;
  attemptId?: () => string;
  adapters: Partial<Record<"email" | "hermes-telegram", NotificationAdapter>>;
  logger?: { write(event: NotificationWorkerLogEvent): void };
  withdrawalSecret?: Uint8Array;
  publicOrigin?: string;
}

interface DeliveryRow {
  receipt_id: string;
  status: string;
  locale: string;
  category: string;
  received_at_ms: number;
  pii_envelope: string | null;
  purged_at_ms: number | null;
  marketing_accepted: number;
  marketing_withdrawn_at_ms: number | null;
  retention_expires_at_ms: number;
  channel_enabled: number | null;
}

export type ProcessNotificationResult =
  | { kind: "idle" }
  | { kind: "sent"; outcomeCode: "SENT" }
  | { kind: "cancelled"; outcomeCode: string }
  | { kind: "retrying" | "failed"; outcomeCode: string };

function logOutcome(options: NotificationWorkerOptions, event: NotificationWorkerLogEvent): void {
  try {
    options.logger?.write(event);
  } catch {
    // Delivery state must never depend on logging availability.
  }
}

export async function processNextNotification(
  options: NotificationWorkerOptions,
): Promise<ProcessNotificationResult> {
  const clock = options.now ?? Date.now;
  const claimedAtMs = clock();
  const claim = claimNotification(options.db, {
    workerId: options.workerId,
    nowMs: claimedAtMs,
    ...(options.attemptId ? { attemptId: options.attemptId } : {}),
  });
  if (!claim) return { kind: "idle" };

  const readDeliveryRow = (): DeliveryRow | undefined => options.db.sqlite.prepare(`
      SELECT c.receipt_id, c.status, c.locale, c.category, c.received_at_ms,
             c.pii_envelope, c.purged_at_ms, c.marketing_accepted,
             c.marketing_withdrawn_at_ms, c.retention_expires_at_ms,
             s.enabled channel_enabled
      FROM consultations c
      LEFT JOIN notification_settings s ON s.channel = ?
      WHERE c.id = ?
    `).get(claim.channel, claim.consultationId) as DeliveryRow | undefined;

  const cancel = (outcomeCode: string): ProcessNotificationResult => {
    const finishedAtMs = clock();
    cancelClaimedNotification(options.db, claim, finishedAtMs, outcomeCode);
    logOutcome(options, {
      deliveryId: claim.deliveryId,
      channel: claim.channel,
      attempt: claim.attemptNo,
      outcomeCode,
    });
    return { kind: "cancelled", outcomeCode };
  };
  const fail = (outcomeCode: string): ProcessNotificationResult => {
    const finishedAtMs = clock();
    finalizeNotificationFailure(options.db, claim, finishedAtMs, outcomeCode);
    logOutcome(options, {
      deliveryId: claim.deliveryId,
      channel: claim.channel,
      attempt: claim.attemptNo,
      outcomeCode,
    });
    return {
      kind: claim.attemptNo >= 5 ? "failed" : "retrying",
      outcomeCode,
    };
  };

  // Read after obtaining the current time so a withdrawal/retention change that races
  // with the claim is visible before any PII is passed to a provider adapter.
  let checkedAtMs = clock();
  let row = readDeliveryRow();
  if (!row) {
    return cancel("CONSULTATION_PURGED");
  }
  if (
    claim.purpose !== "test" &&
    (row.purged_at_ms !== null || row.pii_envelope === null)
  ) return cancel("CONSULTATION_PURGED");
  if (claim.purpose !== "test" && row.retention_expires_at_ms <= checkedAtMs) {
    return cancel("RETENTION_EXPIRED");
  }
  if (
    claim.purpose === "marketing" &&
    (row.marketing_accepted !== 1 || row.marketing_withdrawn_at_ms !== null)
  ) {
    return cancel("MARKETING_WITHDRAWN");
  }
  if (row.channel_enabled !== 1) return cancel("CHANNEL_DISABLED");
  const adapter = options.adapters[claim.channel];
  if (!adapter) return cancel("ADAPTER_UNAVAILABLE");

  const adminUrl = new URL(
    `/admin/consultations/${encodeURIComponent(claim.consultationId)}`,
    options.adminOrigin,
  ).href;
  let withdrawalUrl: string | undefined;
  if (claim.purpose === "marketing") {
    if (claim.channel !== "email" || !options.withdrawalSecret || !options.publicOrigin) {
      return cancel("WITHDRAWAL_CONFIGURATION_MISSING");
    }
    // Recheck immediately before capability minting. Mint failures must finalize the
    // claim rather than leaving it processing until the lease recovery pass.
    checkedAtMs = clock();
    row = readDeliveryRow();
    if (!row || row.purged_at_ms !== null || row.pii_envelope === null) {
      return cancel("CONSULTATION_PURGED");
    }
    if (row.retention_expires_at_ms <= checkedAtMs) return cancel("RETENTION_EXPIRED");
    if (row.marketing_accepted !== 1 || row.marketing_withdrawn_at_ms !== null) {
      return cancel("MARKETING_WITHDRAWN");
    }
    try {
      withdrawalUrl = mintMarketingWithdrawalCapability(
        options.db,
        options.withdrawalSecret,
        {
          consultationId: claim.consultationId,
          publicOrigin: options.publicOrigin,
          nowMs: checkedAtMs,
          expiresAtMs: row.retention_expires_at_ms,
        },
      ).url;
    } catch {
      return fail("WITHDRAWAL_CAPABILITY_ERROR");
    }
  }

  // The capability insert and adapter construction may have yielded to another
  // connection. This is the last synchronous privacy check before external I/O.
  checkedAtMs = clock();
  row = readDeliveryRow();
  if (!row) {
    return cancel("CONSULTATION_PURGED");
  }
  if (
    claim.purpose !== "test" &&
    (row.purged_at_ms !== null || row.pii_envelope === null)
  ) return cancel("CONSULTATION_PURGED");
  if (claim.purpose !== "test" && row.retention_expires_at_ms <= checkedAtMs) {
    return cancel("RETENTION_EXPIRED");
  }
  if (
    claim.purpose === "marketing" &&
    (row.marketing_accepted !== 1 || row.marketing_withdrawn_at_ms !== null)
  ) {
    return cancel("MARKETING_WITHDRAWN");
  }
  if (row.channel_enabled !== 1) return cancel("CHANNEL_DISABLED");
  const isTest = claim.purpose === "test";
  const metadata: NotificationMetadata = {
    deliveryId: claim.deliveryId,
    consultationId: isTest ? "notification-test" : claim.consultationId,
    purpose: claim.purpose,
    eventType: claim.eventType,
    receiptId: isTest ? "TEST" : row.receipt_id,
    category: isTest ? "system" : row.category,
    locale: isTest ? "en" : row.locale,
    status: isTest ? "test" : row.status,
    receivedAt: new Date(isTest ? claimedAtMs : row.received_at_ms).toISOString(),
    adminUrl: isTest
      ? new URL("/admin/notifications", options.adminOrigin).href
      : adminUrl,
    piiEnvelope: isTest ? "notification-test-no-pii" : row.pii_envelope!,
    ...(withdrawalUrl ? { withdrawalUrl } : {}),
  };
  let delivered: NotificationDeliveryResult;
  try {
    delivered = await adapter.deliver(metadata);
  } catch {
    return fail("PROVIDER_ERROR");
  }
  try {
    const finishedAtMs = clock();
    finalizeNotificationSuccess(
      options.db,
      claim,
      finishedAtMs,
      delivered.providerMessageId,
    );
    logOutcome(options, {
      deliveryId: claim.deliveryId,
      channel: claim.channel,
      attempt: claim.attemptNo,
      outcomeCode: "SENT",
    });
    return { kind: "sent", outcomeCode: "SENT" };
  } catch {
    // The provider may already have accepted the stable delivery ID. Retrying is
    // intentionally at-least-once and is distinguished from a provider rejection.
    return fail("DELIVERY_FINALIZE_ERROR");
  }
}
