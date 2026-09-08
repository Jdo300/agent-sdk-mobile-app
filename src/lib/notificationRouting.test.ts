import { describe, expect, test } from "bun:test";
import { notificationRouteAlreadyActive, routeForMiloNotification } from "./notificationRouting";

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

  test("deep-links an explicit Milo notification when it targets a conversation", () => {
    expect(routeForMiloNotification({
      type: "milo_notification",
      conversationId: "local-conv-173",
      agentId: "agent-local-1",
      agentName: "Milo",
      title: "Project Management",
    })?.params.conversationId).toBe("local-conv-173");
  });

  test("does not stack another chat screen for the already-active conversation", () => {
    const route = routeForMiloNotification({
      type: "milo_turn_complete",
      conversationId: "local-conv-173",
      agentId: "agent-local-1",
    });
    expect(route).not.toBeNull();
    expect(notificationRouteAlreadyActive("/chat", "local-conv-173", route!)).toBe(true);
    expect(notificationRouteAlreadyActive("/chat", "local-conv-other", route!)).toBe(false);
    expect(notificationRouteAlreadyActive("/conversations", "local-conv-173", route!)).toBe(false);
  });

  test("rejects unrelated or incomplete notification data", () => {
    expect(routeForMiloNotification({ type: "other", conversationId: "c", agentId: "a" })).toBeNull();
    expect(routeForMiloNotification({ type: "milo_turn_complete", conversationId: "c" })).toBeNull();
  });
});
