export interface ConversationCommandResult {
  success: boolean;
  output: string;
}

/**
 * Extract the terminal result for execute_command. Built-in commands answer
 * with an execute_command_response carrying request_id. Listener mod commands
 * (such as /context) currently finish only through a
 * stream_delta/slash_command_end, so callers must accept both protocol shapes.
 */
export function parseConversationCommandResult(
  message: unknown,
  requestId: string,
  commandId: string,
): ConversationCommandResult | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const record = message as Record<string, unknown>;
  if (
    record.type === "execute_command_response" &&
    record.request_id === requestId &&
    typeof record.success === "boolean"
  ) {
    return {
      success: record.success,
      output: typeof record.output === "string" ? record.output : "",
    };
  }

  if (record.type !== "stream_delta") return null;
  const delta = record.delta;
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) return null;
  const event = delta as Record<string, unknown>;
  if (
    event.message_type !== "slash_command_end" ||
    event.command_id !== commandId ||
    typeof event.success !== "boolean"
  ) return null;

  return {
    success: event.success,
    output: typeof event.output === "string" ? event.output : "",
  };
}
