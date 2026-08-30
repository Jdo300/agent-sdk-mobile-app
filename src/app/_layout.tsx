/**
 * Root layout: gesture root → theme → navigation stack.
 * Router chrome is disabled; screens render their own headers (Screen/Header)
 * so the design system owns every pixel.
 */
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { router, Stack } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { routeForMiloNotification } from "../lib/notificationRouting";
import { ProfilesProvider } from "../lib/profiles/ProfilesContext";
import { ChatLifecycleCoordinator } from "../lib/letta/ChatLifecycleCoordinator";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

function NotificationRouter() {
  useEffect(() => {
    if (Platform.OS === "web" || Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return;
    let alive = true;
    let remove: (() => void) | null = null;

    void import("expo-notifications").then((Notifications) => {
      if (!alive) return;
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      const openResponse = (response: import("expo-notifications").NotificationResponse) => {
        if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
        const route = routeForMiloNotification(response.notification.request.content.data);
        if (!route) return;
        router.push(route);
        try { Notifications.clearLastNotificationResponse(); } catch { /* unavailable during teardown */ }
      };

      const last = Notifications.getLastNotificationResponse();
      if (last) requestAnimationFrame(() => openResponse(last));
      const subscription = Notifications.addNotificationResponseReceivedListener(openResponse);
      remove = () => subscription.remove();
    }).catch(() => {
      // Notification native modules are intentionally absent from Expo Go.
    });

    return () => {
      alive = false;
      remove?.();
    };
  }, []);
  return null;
}

function ThemedStack() {
  const { name, colors } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ProfilesProvider>
          <ChatLifecycleCoordinator>
            <NotificationRouter />
            <BottomSheetModalProvider>
              <ThemedStack />
            </BottomSheetModalProvider>
          </ChatLifecycleCoordinator>
        </ProfilesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
