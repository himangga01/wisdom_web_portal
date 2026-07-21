import type { ControlDatabase } from "../db/client.js";
import type {
  NotificationDeliveryResult,
  NotificationMetadata,
  PreparedNotificationDelivery,
} from "./adapters.js";
import {
  cancelClaimedNotification,
  claimNotification,
  finalizeNotificationFailure,
  finalizeNotificationSuccess,
} from "./outbox.js";
import { mintMarketingWithdrawalCapability } from "../withdrawal/service.js";

export interface NotificationAdapter extends PreparedNotificationDelivery {
  prepare?(): Promise<PreparedNotificationDelivery>;
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

interface ExternalCancellationRow {
  last_error_code: string;
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

  const readExternalCancellation = (): string | undefined => (
    options.db.sqlite.prepare(`
      SELECT o.last_error_code
      FROM notification_outbox o
      JOIN notification_delivery_attempts a
        ON a.outbox_id = o.id
       AND a.delivery_cycle = o.delivery_cycle
       AND a.attempt_no = o.attempt_count
      WHERE o.id = ? AND o.state = 'cancelled'
        AND o.delivery_cycle = ? AND o.attempt_count = ?
        AND o.last_error_code IN ('RETENTION_PURGED', 'MARKETING_WITHDRAWN')
        AND a.id = ? AND a.worker_id = ? AND a.finished_at_ms IS NOT NULL
    `).get(
      claim.id,
      claim.deliveryCycle,
      claim.attemptNo,
      claim.attemptId,
      claim.workerId,
    ) as ExternalCancellationRow | undefined
  )?.last_error_code;

  const cancel = (outcomeCode: string): ProcessNotificationResult => {
    const finishedAtMs = clock();
    try {
      cancelClaimedNotification(options.db, claim, finishedAtMs, outcomeCode);
    } catch (error) {
      // A retention purge or accountless marketing withdrawal can commit while
      // provider preparation is awaiting DNS. Those transactions atomically
      // cancel the claim and finish its attempt, so treat that verified state as
      // the same successful cancellation rather than surfacing a worker crash.
      if (!readExternalCancellation()) throw error;
    }
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
    try {
      finalizeNotificationFailure(options.db, claim, finishedAtMs, outcomeCode);
    } catch (error) {
      const externalCancellation = readExternalCancellation();
      if (!externalCancellation) throw error;
      logOutcome(options, {
        deliveryId: claim.deliveryId,
        channel: claim.channel,
        attempt: claim.attemptNo,
        outcomeCode: externalCancellation,
      });
      return { kind: "cancelled", outcomeCode: externalCancellation };
    }
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

  let preparedAdapter: PreparedNotificationDelivery = adapter;
  try {
    preparedAdapter = adapter.prepare ? await adapter.prepare() : adapter;
  } catch {
    return fail("PROVIDER_ERROR");
  }

  // Provider preparation may yield for DNS without touching PII. A short
  // cross-process write guard now linearizes the last authorization read and
  // the synchronous provider handoff. Purge/withdrawal can commit either
  // before this transaction (and cancel delivery) or after handoff starts,
  // never between the two.
  let deliveryPromise: Promise<NotificationDeliveryResult> | undefined;
  let cancellationCode: string | undefined;
  try {
    options.db.sqlite.exec("BEGIN IMMEDIATE");
    checkedAtMs = clock();
    row = readDeliveryRow();
    if (!row || (claim.purpose !== "test" && (
      row.purged_at_ms !== null || row.pii_envelope === null
    ))) {
      cancellationCode = "CONSULTATION_PURGED";
    } else if (claim.purpose !== "test" && row.retention_expires_at_ms <= checkedAtMs) {
      cancellationCode = "RETENTION_EXPIRED";
    } else if (
      claim.purpose === "marketing" &&
      (row.marketing_accepted !== 1 || row.marketing_withdrawn_at_ms !== null)
    ) {
      cancellationCode = "MARKETING_WITHDRAWN";
    } else if (row.channel_enabled !== 1) {
      cancellationCode = "CHANNEL_DISABLED";
    } else {
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
      const marked = options.db.sqlite.prepare(`
        UPDATE notification_outbox
        SET last_error_code = 'PROVIDER_HANDOFF_STARTED', updated_at_ms = ?
        WHERE id = ? AND state = 'processing' AND locked_by = ?
          AND delivery_cycle = ? AND attempt_count = ? AND lease_expires_at_ms > ?
      `).run(
        checkedAtMs,
        claim.id,
        claim.workerId,
        claim.deliveryCycle,
        claim.attemptNo,
        checkedAtMs,
      );
      if (marked.changes !== 1) throw new Error("Notification handoff guard lost its claim");
      // Production adapters perform PII decryption and hand the message to the
      // provider synchronously before returning this completion promise.
      deliveryPromise = preparedAdapter.deliver(metadata);
    }
    options.db.sqlite.exec("COMMIT");
  } catch {
    if (options.db.sqlite.inTransaction) options.db.sqlite.exec("ROLLBACK");
    // If the provider handoff already started but COMMIT failed, the delivery
    // promise is abandoned here; observe it so a later rejection cannot surface
    // as an unhandledRejection and crash the worker process.
    if (deliveryPromise) void deliveryPromise.catch(() => undefined);
    return fail("PROVIDER_HANDOFF_ERROR");
  }
  if (cancellationCode !== undefined) return cancel(cancellationCode);
  if (!deliveryPromise) return fail("PROVIDER_HANDOFF_ERROR");
  let delivered: NotificationDeliveryResult;
  try {
    delivered = await deliveryPromise;
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
