import { describe, expect, it } from "bun:test";
import { liveAssistantSegmentIsPersisted } from "./voicePersistence";

const user = (text: string) => ({ message_type: "user_message", content: [{ type: "text", text }] });
const assistant = (text: string, run_id?: string) => ({
  message_type: "assistant_message",
  ...(run_id ? { run_id } : {}),
  content: [{ type: "text", text }],
});

describe("persisted live voice boundary", () => {
  it("accepts the complete assistant message in the newest user turn", () => {
    expect(liveAssistantSegmentIsPersisted([user("go"), assistant("Hello world", "r1")], "Hello world", "r1")).toBe(true);
  });

  it("rejects a partial streaming prefix", () => {
    expect(liveAssistantSegmentIsPersisted([user("go"), assistant("Hello world", "r1")], "Hello ", "r1")).toBe(false);
  });

  it("does not match an identical assistant message from an older turn", () => {
    expect(liveAssistantSegmentIsPersisted([
      user("old"), assistant("Same", "r0"), user("new"),
    ], "Same", "r1")).toBe(false);
  });

  it("honors run lineage when history provides it", () => {
    expect(liveAssistantSegmentIsPersisted([user("go"), assistant("Done", "other")], "Done", "r1")).toBe(false);
  });
});
