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

/** Strictly translate our own push payload into a Bloop route. */
export function routeForMiloNotification(data: MiloNotificationData): ChatNotificationRoute | null {
  if (data.type !== "milo_turn_complete") return null;
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
