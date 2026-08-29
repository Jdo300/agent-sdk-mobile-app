import type { AssistantItem, TranscriptItem } from "./letta/model";

export function completedAssistantReplies(transcript: readonly TranscriptItem[]): AssistantItem[] {
  return transcript.filter(
    (item): item is AssistantItem =>
      item.kind === "assistant" &&
      !item.streaming &&
      !item.interrupted &&
      item.text.trim().length > 0,
  );
}

export function latestCompletedAssistantReply(transcript: readonly TranscriptItem[]): AssistantItem | null {
  const completed = completedAssistantReplies(transcript);
  return completed[completed.length - 1] ?? null;
}

export function newestAssistantTimestamp(transcript: readonly TranscriptItem[]): number {
  let newest = 0;
  for (const item of completedAssistantReplies(transcript)) {
    if (typeof item.occurredAt === "number" && Number.isFinite(item.occurredAt)) {
      newest = Math.max(newest, item.occurredAt);
    }
  }
  return newest;
}

/**
 * Return the one assistant reply that is safe to auto-speak.
 *
 * Reconnect/history reconciliation can replace an old live row with a persisted
 * row under a different id. "Unhandled id" therefore is not sufficient proof
 * that prose is new. The candidate must also be the transcript's newest
 * completed assistant and newer than the screen's voice timestamp watermark.
 */
export function voiceReplyToAutoSpeak(
  transcript: readonly TranscriptItem[],
  handledIds: ReadonlySet<string>,
  timestampWatermark: number,
): AssistantItem | null {
  const latest = latestCompletedAssistantReply(transcript);
  if (!latest || handledIds.has(latest.id)) return null;
  if (
    typeof latest.occurredAt === "number" &&
    Number.isFinite(latest.occurredAt) &&
    latest.occurredAt <= timestampWatermark
  ) {
    return null;
  }
  return latest;
}
