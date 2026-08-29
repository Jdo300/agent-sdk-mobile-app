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

export function newCompletedAssistantReplies(
  transcript: readonly TranscriptItem[],
  handledIds: ReadonlySet<string>,
): AssistantItem[] {
  return completedAssistantReplies(transcript).filter((item) => !handledIds.has(item.id));
}
