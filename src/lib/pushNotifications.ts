import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { Platform } from "react-native";

import { voiceHttpBaseUrl } from "./voiceTransport";

const DEVICE_ID_KEY = "bloop.push.deviceId.v1";
let expoPushTokenPromise: Promise<string | null> | null = null;

async function deviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const created = Crypto.randomUUID();
  await AsyncStorage.setItem(DEVICE_ID_KEY, created);
  return created;
}

function easProjectId(): string | null {
  const fromManifest = (Constants.expoConfig?.extra?.eas as { projectId?: unknown } | undefined)?.projectId;
  if (typeof fromManifest === "string" && fromManifest) return fromManifest;
  const fromNative = (Constants.easConfig as { projectId?: unknown } | null)?.projectId;
  return typeof fromNative === "string" && fromNative ? fromNative : null;
}

/**
 * Expo Go cannot receive remote push notifications on current Expo SDKs. Keep
 * this path silent there so the existing development workflow remains usable;
 * a Bloop development/production build activates registration automatically.
 */
async function expoPushToken(): Promise<string | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null;
  if (Constants.executionEnvironment === ExecutionEnvironment.StoreClient) return null;
  if (!expoPushTokenPromise) {
    expoPushTokenPromise = (async () => {
      const projectId = easProjectId();
      if (!projectId) return null;
      try {
        const Notifications = await import("expo-notifications");
        const current = await Notifications.getPermissionsAsync();
        const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
        if (!permission.granted) return null;
        return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
      } catch {
        return null;
      }
    })();
  }
  return expoPushTokenPromise;
}

export async function registerConversationPush(options: {
  capabilityToken: string;
  serverUrl: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  title: string;
}): Promise<boolean> {
  const pushToken = await expoPushToken();
  if (!pushToken) return false;
  const id = await deviceId();
  try {
    const response = await fetch(`${voiceHttpBaseUrl(options.serverUrl)}/voice/push/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.capabilityToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expo_push_token: pushToken,
        device_id: id,
        conversation: {
          conversation_id: options.conversationId,
          agent_id: options.agentId,
          agent_name: options.agentName,
          title: options.title,
        },
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
