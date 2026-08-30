import { describe, expect, test } from "bun:test";
import { routeForMiloNotification } from "./notificationRouting";

describe("Milo notification routing", () => {
  test("deep-links a completion notification to its exact conversation", () => {
    expect(routeForMiloNotification({
      type: "milo_turn_complete",
      conversationId: "local-conv-105",
      agentId: "agent-local-1",
      agentName: "Milo",
      title: "New Skills",
    })).toEqual({
      pathname: "/chat",
      params: {
        conversationId: "local-conv-105",
        agentId: "agent-local-1",
        agentName: "Milo",
        title: "New Skills",
      },
    });
  });

  test("rejects unrelated or incomplete notification data", () => {
    expect(routeForMiloNotification({ type: "other", conversationId: "c", agentId: "a" })).toBeNull();
    expect(routeForMiloNotification({ type: "milo_turn_complete", conversationId: "c" })).toBeNull();
  });
});
