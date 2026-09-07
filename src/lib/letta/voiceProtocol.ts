import type { SDKMessage } from "@letta-ai/letta-agent-sdk";

type VoiceProtocolMessage = Extract<
  SDKMessage,
  { type: "assistant" | "reasoning" | "tool_call" | "tool_result" | "stream_event" }
>;

/**
 * True when the live protocol proves that the current assistant content block
 * has ended. App Server forwards headless content-block lifecycle events as
 * generic SDK stream_event payloads, so this gives voice playback the block's
 * own completion boundary instead of waiting for the next reasoning/tool row.
 */
export function isAssistantContentBlockBoundary(message: VoiceProtocolMessage): boolean {
  if (message.type !== "stream_event") return false;
  const event = message.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const type = (event as Record<string, unknown>).type;
  return type === "content_block_stop" || type === "message_stop";
}
