import type { SDKMessage } from "@letta-ai/letta-agent-sdk";

export type StreamDisposition = "authoritative_history" | "control";

/**
 * App Server resume can replay historical transcript deltas. Those deltas lack a
 * reliable resume cursor on Local Milo, so they must never mutate the visible
 * transcript. Persisted conversation history is the transcript data plane;
 * the SDK viewer stream remains the control/status plane.
 */
export function streamDisposition(message: SDKMessage): StreamDisposition {
  switch (message.type) {
    case "stream_event":
    case "assistant":
    case "reasoning":
    case "tool_call":
    case "tool_result":
      return "authoritative_history";
    default:
      return "control";
  }
}
