import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./letta/model";
import {
  completedAssistantReplies,
  latestCompletedAssistantReply,
  newestAssistantTimestamp,
  voiceReplyToAutoSpeak,
} from "./voiceEligibility";

describe("voice assistant eligibility", () => {
  test("completed assistant prose is eligible even when tool activity follows it", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "a1", text: "I found it.", occurredAt: 100 },
      { kind: "tool", id: "t1", name: "lookup", status: "running" },
    ];
    expect(completedAssistantReplies(transcript).map((item) => item.id)).toEqual(["a1"]);
    expect(latestCompletedAssistantReply(transcript)?.id).toBe("a1");
  });

  test("streaming and interrupted assistant rows are not eligible", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "a1", text: "still talking", streaming: true },
      { kind: "assistant", id: "a2", text: "stopped", interrupted: true },
      { kind: "assistant", id: "a3", text: "done" },
    ];
    expect(completedAssistantReplies(transcript).map((item) => item.id)).toEqual(["a3"]);
  });

  test("a re-keyed older reply cannot displace the newest visible assistant", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "old-persisted", text: "older", occurredAt: 100 },
      { kind: "tool", id: "t1", name: "lookup", status: "success" },
      { kind: "assistant", id: "latest", text: "newest", occurredAt: 200 },
    ];
    expect(voiceReplyToAutoSpeak(transcript, new Set(["latest"]), 100)).toBeNull();
  });

  test("timestamp watermark rejects historical/catch-up prose even if its id is unseen", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "historical-new-id", text: "old", occurredAt: 100 },
    ];
    expect(voiceReplyToAutoSpeak(transcript, new Set(), 100)).toBeNull();
  });

  test("the newest truly new completed reply passes both guards", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "old", text: "old", occurredAt: 100 },
      { kind: "assistant", id: "new", text: "new", occurredAt: 250 },
      { kind: "tool", id: "t2", name: "next", status: "running" },
    ];
    expect(voiceReplyToAutoSpeak(transcript, new Set(["old"]), 100)?.id).toBe("new");
    expect(newestAssistantTimestamp(transcript)).toBe(250);
  });
});
