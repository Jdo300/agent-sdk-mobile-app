import { contentToText } from "./toolText";

/**
 * Authoritative proof that the currently accumulated live assistant text has
 * finished persisting as one complete assistant message in the newest user turn.
 *
 * The live SDK emits assistant text in small chunks, while App Server history
 * exposes the completed assistant message. Matching the accumulated chunk text
 * against that persisted row gives voice a deterministic message boundary
 * without waiting for a later reasoning/tool event or using a quiet-time timer.
 */
export function liveAssistantSegmentIsPersisted(
  messages: readonly unknown[],
  text: string,
  runId?: string,
): boolean {
  if (!text) return false;

  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const raw = messages[i];
    if (
      raw &&
      typeof raw === "object" &&
      (raw as { message_type?: unknown }).message_type === "user_message"
    ) {
      turnStart = i + 1;
      break;
    }
  }

  for (let i = messages.length - 1; i >= turnStart; i -= 1) {
    const raw = messages[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.message_type !== "assistant_message") continue;
    if (runId && typeof record.run_id === "string" && record.run_id !== runId) continue;
    return contentToText(record.content) === text;
  }

  return false;
}
