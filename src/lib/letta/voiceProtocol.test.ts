import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import { isAssistantContentBlockBoundary } from "./voiceProtocol";

const streamEvent = (event: Record<string, unknown>) => ({
  type: "stream_event",
  uuid: "wire",
  event,
} as SDKMessage);

describe("voice protocol assistant boundaries", () => {
  it("recognizes content_block_stop immediately", () => {
    expect(isAssistantContentBlockBoundary(streamEvent({ type: "content_block_stop", index: 0 }) as never)).toBe(true);
  });

  it("accepts message_stop as a terminal fallback", () => {
    expect(isAssistantContentBlockBoundary(streamEvent({ type: "message_stop" }) as never)).toBe(true);
  });

  it("does not mistake text deltas for completion", () => {
    expect(isAssistantContentBlockBoundary(streamEvent({ type: "content_block_delta", delta: { text: "Still streaming" } }) as never)).toBe(false);
  });

  it("does not treat typed assistant chunks as boundaries", () => {
    expect(isAssistantContentBlockBoundary({ type: "assistant", content: "Hello", uuid: "a1" } as never)).toBe(false);
  });
});
