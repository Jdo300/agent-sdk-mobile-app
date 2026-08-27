import { describe, expect, it } from "bun:test";

import { createTranscriptAccumulator } from "@letta-ai/letta-agent-sdk/client";
import { groupToolRuns } from "./grouping";
import { projectRows, type ProjectionState } from "./transcriptProjection";

const projection: ProjectionState = {
  liveKey: null,
  interruptedKey: null,
  toolStatusOverride: new Map(),
  thinkStartedAt: new Map(),
  thinkSeconds: new Map(),
  toolDurationMs: new Map(),
  rowOccurredAt: new Map(),
  toolCompletedAt: new Map(),
};

function user(id: string, text: string) {
  return { id, date: "2026-08-24T20:00:00Z", message_type: "user_message", role: "user", content: [{ type: "text", text }] };
}

function assistant(id: string, text: string) {
  return { id, date: "2026-08-24T20:00:01Z", message_type: "assistant_message", role: "assistant", content: [{ type: "text", text }] };
}

function toolCall(id: string, name = "Bash") {
  return {
    id: `msg-${id}`,
    date: "2026-08-24T20:00:02Z",
    message_type: "approval_request_message",
    tool_call: { tool_call_id: id, name, arguments: JSON.stringify({ command: "echo ok" }) },
  };
}

function toolReturn(id: string) {
  return {
    id: `result-${id}`,
    date: "2026-08-24T20:00:03Z",
    message_type: "tool_return_message",
    tool_call_id: id,
    status: "success",
    tool_return: "ok",
  };
}

describe("authoritative history integrity", () => {
  it("reconstructs persisted tool calls into visible transcript rows", () => {
    const messages = [
      user("u1", "check it"),
      assistant("a1", "I will inspect that."),
      toolCall("call-1"),
      toolReturn("call-1"),
      assistant("a2", "Done."),
    ];
    const accumulator = createTranscriptAccumulator();
    const rows = accumulator.rebase({ messages }, { order: "asc" });
    const projected = projectRows(rows, projection);
    const tool = projected.find((row) => row.kind === "tool");
    expect(tool).toMatchObject({ kind: "tool", toolCallId: "call-1", name: "Bash", status: "success" });
    expect(groupToolRuns(projected, new Set()).some((row) => row.kind === "tool")).toBe(true);
  });

  it("repairs a missed live tool event when persisted history is rebased later", () => {
    const accumulator = createTranscriptAccumulator();
    accumulator.rebase({ messages: [user("u1", "check it"), assistant("a1", "Working."), assistant("a2", "Done.")] }, { order: "asc" });
    expect(accumulator.rows().some((row) => row.kind === "tool_call")).toBe(false);

    accumulator.rebase({ messages: [user("u1", "check it"), assistant("a1", "Working."), toolCall("call-1"), toolReturn("call-1"), assistant("a2", "Done.")] }, { order: "asc" });
    const projected = projectRows(accumulator.rows(), projection);
    expect(projected.find((row) => row.kind === "tool")).toMatchObject({ toolCallId: "call-1", status: "success" });
  });
});
