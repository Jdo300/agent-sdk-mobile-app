import { describe, expect, it } from "bun:test";

import { createTranscriptAccumulator, type SDKMessage, type TranscriptRow } from "@letta-ai/letta-agent-sdk/client";
import { authoritativeRowsCoverCurrent, rebuildAuthoritativeTranscript } from "./authoritativeTranscript";

const persisted = [
  {
    id: "server-user-uuid",
    date: "2026-08-28T20:00:00Z",
    message_type: "user_message",
    role: "user",
    content: [{ type: "text", text: "Run the check" }],
  },
  {
    id: "server-tool-uuid",
    date: "2026-08-28T20:00:01Z",
    message_type: "approval_request_message",
    tool_call: { tool_call_id: "call-1", name: "Bash", arguments: '{"command":"npm test"}' },
  },
  {
    id: "server-tool-result-uuid",
    date: "2026-08-28T20:00:02Z",
    message_type: "tool_return_message",
    tool_call_id: "call-1",
    status: "success",
    tool_return: "ok",
  },
  {
    id: "server-assistant-uuid",
    date: "2026-08-28T20:00:03Z",
    message_type: "assistant_message",
    role: "assistant",
    content: [{ type: "text", text: "The check passed." }],
  },
];

describe("authoritative transcript rebuild", () => {
  it("drops an anonymous content-block live row that SDK rebase retains beside its server UUID", () => {
    const live = createTranscriptAccumulator();
    live.apply({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { text: "The check passed." } },
    } as SDKMessage);

    // SDK 0.7.1 gives this anonymous delta a synthetic live identity. The
    // persisted assistant message has a server UUID, so merge rebase keeps both.
    live.rebase({ messages: persisted }, { order: "asc" });
    expect(live.rows().filter((row) => row.kind === "assistant").map((row) => row.text)).toEqual([
      "The check passed.",
      "The check passed.",
    ]);

    const rebuilt = rebuildAuthoritativeTranscript(persisted);
    expect(rebuilt.rows().map((row) => row.kind)).toEqual(["user", "tool_call", "assistant"]);
    expect(rebuilt.rows().filter((row) => row.kind === "assistant")).toHaveLength(1);
    expect(rebuilt.rows().find((row) => row.kind === "tool_call")).toMatchObject({
      toolCallId: "call-1",
      status: "complete",
    });
  });

  it("does not hand off when persisted history is missing the completed live assistant row", () => {
    const live = rebuildAuthoritativeTranscript(persisted);
    const stale = rebuildAuthoritativeTranscript(persisted.slice(0, -1));

    expect(authoritativeRowsCoverCurrent(live.rows(), stale.rows())).toBe(false);
  });

  it("allows handoff when equivalent rows are present, with one persisted row required per duplicate", () => {
    const assistant = (text: string, key: string): TranscriptRow => ({ kind: "assistant", key, text });
    const current = [assistant("Done.", "live-1"), assistant("Done.", "live-2")];

    expect(authoritativeRowsCoverCurrent(current, [assistant("Done.", "history-1")])).toBe(false);
    expect(
      authoritativeRowsCoverCurrent(current, [
        assistant("Done.", "history-1"),
        assistant("Done.", "history-2"),
      ]),
    ).toBe(true);
  });

  it("requires a persisted tool return before replacing a completed live tool row", () => {
    const live = rebuildAuthoritativeTranscript(persisted);
    const missingReturn = rebuildAuthoritativeTranscript(persisted.slice(0, 2));

    expect(authoritativeRowsCoverCurrent(live.rows(), missingReturn.rows())).toBe(false);
  });
});
