import { useEffect, useRef, type ReactNode } from "react";
import { AppState } from "react-native";

import { reconnectRetainedChatSessions } from "./ChatSession";

/**
 * App-scoped foreground recovery. Navigation no longer owns transport repair:
 * every retained conversation gets one authoritative reconnect/sync when iOS
 * really backgrounded the app (or an inactive transition lasted >30 seconds).
 */
export function ChatLifecycleCoordinator({ children }: { children: ReactNode }) {
  const backgroundedAt = useRef<number | null>(null);
  const wasBackgrounded = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : 0;
        const shouldResync = wasBackgrounded.current || away > 30_000;
        backgroundedAt.current = null;
        wasBackgrounded.current = false;
        if (shouldResync) void reconnectRetainedChatSessions();
        return;
      }
      backgroundedAt.current ??= Date.now();
      if (state === "background") wasBackgrounded.current = true;
    });
    return () => subscription.remove();
  }, []);

  return children;
}
