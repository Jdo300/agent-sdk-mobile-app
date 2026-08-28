import { describe, expect, test } from "bun:test";
import { voiceHttpBaseUrl } from "./voiceTransport";

describe("voice transport", () => {
  test("uses the same public origin as a secure WebSocket profile", () => {
    expect(voiceHttpBaseUrl("wss://rgai-letta.resonancegroupusa.com")).toBe(
      "https://rgai-letta.resonancegroupusa.com",
    );
  });

  test("strips websocket paths/query strings", () => {
    expect(voiceHttpBaseUrl("wss://example.test/ws?token=ignored")).toBe("https://example.test");
  });

  test("keeps local development profiles local without hardcoding one", () => {
    expect(voiceHttpBaseUrl("ws://10.0.0.128:4610")).toBe("http://10.0.0.128:4610");
  });
});
