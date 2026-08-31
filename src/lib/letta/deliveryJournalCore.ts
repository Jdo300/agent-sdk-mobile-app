/** Pure delivery-journal rules, deliberately independent from transcript sync. */

export type DeliveryJournalState = "queued" | "sending" | "awaiting_echo" | "failed";
export type DeliveryRecoveryAction = "replay" | "delivery_unknown" | "manual_retry";

/**
 * A queued row is known not to have begun server handoff and can be replayed.
 * A sending/legacy awaiting_echo row crossed the handoff boundary and is
 * ambiguous without server idempotency. A failed row waits for explicit retry.
 */
export function deliveryRecoveryAction(state: DeliveryJournalState): DeliveryRecoveryAction {
  if (state === "queued") return "replay";
  if (state === "sending" || state === "awaiting_echo") return "delivery_unknown";
  return "manual_retry";
}

/** Only a persisted server user UUID explicitly acknowledges a client OTID. */
export function persistedUserOtids(messages: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { id?: unknown; message_type?: unknown; otid?: unknown };
    if (
      record.message_type === "user_message" &&
      typeof record.id === "string" && record.id.length > 0 &&
      typeof record.otid === "string" && record.otid.length > 0
    ) {
      seen.add(record.otid);
    }
  }
  return [...seen];
}
