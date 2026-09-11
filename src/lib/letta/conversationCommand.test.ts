import { describe, expect, test } from "bun:test";

import { parseConversationCommandResult } from "./conversationCommand";

describe("conversation command result correlation", () => {
  test("accepts request-correlated execute_command_response", () => {
    expect(parseConversationCommandResult({
      type: "execute_command_response",
      request_id: "execute_command-7",
      success: true,
      output: "done",
    }, "execute_command-7", "compact")).toEqual({ success: true, output: "done" });
  });

  test("accepts slash_command_end for listener mod commands without request_id", () => {
    expect(parseConversationCommandResult({
      type: "stream_delta",
      delta: {
        message_type: "slash_command_end",
        command_id: "context",
        success: true,
        output: '{"context_tokens":1234}',
      },
    }, "execute_command-9", "context")).toEqual({
      success: true,
      output: '{"context_tokens":1234}',
    });
  });

  test("ignores unrelated request ids and slash commands", () => {
    expect(parseConversationCommandResult({
      type: "execute_command_response",
      request_id: "other",
      success: true,
      output: "wrong",
    }, "execute_command-9", "context")).toBeNull();
    expect(parseConversationCommandResult({
      type: "stream_delta",
      delta: { message_type: "slash_command_end", command_id: "compact", success: true, output: "wrong" },
    }, "execute_command-9", "context")).toBeNull();
  });
});
