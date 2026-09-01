import { describe, expect, it } from "bun:test";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk";
import { streamDisposition } from "./streamDisposition";

describe("resumed stream disposition", () => {
  it("never admits transcript-bearing SDK replay into canonical history", () => {
    const transcriptMessages: SDKMessage[] = [
      { type: "assistant", content: "old", uuid: "a", runId: "old-run" },
      { type: "reasoning", content: "old", uuid: "r", runId: "old-run" },
      { type: "tool_call", toolCallId: "tc", toolName: "Bash", toolInput: {}, uuid: "t", runId: "old-run" },
      { type: "tool_result", toolCallId: "tc", content: "done", isError: false, uuid: "tr", runId: "old-run" },
      { type: "stream_event", uuid: "wire", event: { message_type: "assistant_message", run_id: "old-run", content: "old" } },
    ];
    for (const message of transcriptMessages) {
      expect(streamDisposition(message)).toBe("authoritative_history");
    }
  });

  it("keeps control/status signals on the SDK path", () => {
    const controls: SDKMessage[] = [
      { type: "queue_update", queue: [] },
      { type: "loop_status", status: "WAITING_ON_INPUT", activeRunIds: [] },
      { type: "retry", reason: "rate_limit", attempt: 1, maxAttempts: 3, delayMs: 100 },
    ];
    for (const message of controls) expect(streamDisposition(message)).toBe("control");
  });
});
