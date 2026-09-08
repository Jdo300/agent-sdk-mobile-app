export type MiloNotificationData = {
  type?: unknown;
  conversationId?: unknown;
  agentId?: unknown;
  agentName?: unknown;
  title?: unknown;
};

export type ChatNotificationRoute = {
  pathname: "/chat";
  params: {
    conversationId: string;
    agentId: string;
    agentName?: string;
    title?: string;
  };
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Strictly translate our own push payload into an RG Agent Link route. */
export function routeForMiloNotification(data: MiloNotificationData | undefined): ChatNotificationRoute | null {
  if (!data || (data.type !== "milo_turn_complete" && data.type !== "milo_notification")) return null;
  const conversationId = optionalString(data.conversationId);
  const agentId = optionalString(data.agentId);
  if (!conversationId || !agentId) return null;
  return {
    pathname: "/chat",
    params: {
      conversationId,
      agentId,
      ...(optionalString(data.agentName) ? { agentName: optionalString(data.agentName) } : {}),
      ...(optionalString(data.title) ? { title: optionalString(data.title) } : {}),
    },
  };
}

/** Tapping a push for the chat already visible should only foreground the app. */
export function notificationRouteAlreadyActive(
  pathname: string,
  activeConversationId: string | undefined,
  route: ChatNotificationRoute,
): boolean {
  return pathname === "/chat" && activeConversationId === route.params.conversationId;
}
