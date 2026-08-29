import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./letta/model";
import { completedAssistantReplies, newCompletedAssistantReplies } from "./voiceEligibility";

describe("voice assistant eligibility", () => {
  test("completed assistant prose is eligible even when tool activity follows it", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "a1", text: "I found it." },
      { kind: "tool", id: "t1", name: "lookup", status: "running" },
    ];
    expect(completedAssistantReplies(transcript).map((item) => item.id)).toEqual(["a1"]);
  });

  test("streaming and interrupted assistant rows are not eligible", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "a1", text: "still talking", streaming: true },
      { kind: "assistant", id: "a2", text: "stopped", interrupted: true },
      { kind: "assistant", id: "a3", text: "done" },
    ];
    expect(completedAssistantReplies(transcript).map((item) => item.id)).toEqual(["a3"]);
  });

  test("handled replies are not emitted twice", () => {
    const transcript: TranscriptItem[] = [
      { kind: "assistant", id: "old", text: "old" },
      { kind: "assistant", id: "new", text: "new" },
    ];
    expect(newCompletedAssistantReplies(transcript, new Set(["old"])).map((item) => item.id)).toEqual(["new"]);
  });
});
