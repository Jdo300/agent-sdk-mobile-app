/**
 * Dev-only: seed a Cloud connection profile from EXPO_PUBLIC_LETTA_API_KEY so
 * the simulator can be driven headlessly (deep-link to /dev-seed) without
 * typing a key. No-op in production builds; the key never ships in the repo —
 * it comes from the developer's environment at `expo start` time.
 */
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";

import { Screen } from "../components/ui/Screen";
import { Text } from "../components/ui/Text";
import {
  CLOUD_DEFAULT_URL,
  deleteProfile,
  listProfiles,
  newProfileId,
  saveProfile,
} from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";

export default function DevSeedScreen() {
  const params = useLocalSearchParams<{ type?: string; url?: string; token?: string }>();
  const { refresh, setActive } = useProfiles();
  const [status, setStatus] = useState("Seeding…");
  const wantRemote = params.type === "remote";

  useEffect(() => {
    if (!__DEV__) return;
    const key = process.env.EXPO_PUBLIC_LETTA_API_KEY;
    if (!wantRemote && !key) {
      queueMicrotask(() => setStatus("EXPO_PUBLIC_LETTA_API_KEY is not set."));
      return;
    }
    void (async () => {
      // Idempotent: one seeded profile at a time keeps demo state clean.
      for (const existing of await listProfiles()) {
        await deleteProfile(existing.id);
      }
      const id = newProfileId();
      await saveProfile(
        wantRemote
          ? {
              id,
              type: "remote",
              // The iOS simulator shares the host loopback.
              name: "Local server",
              url: params.url ?? "ws://127.0.0.1:4610",
              lastTest: "ok",
              createdAt: Date.now(),
            }
          : {
              id,
              type: "cloud",
              name: "Dev Cloud",
              url: CLOUD_DEFAULT_URL,
              lastTest: "ok",
              createdAt: Date.now(),
            },
        wantRemote ? (params.token ?? "") : key!,
      );
      await setActive(id);
      await refresh();
      router.replace("/agents");
    })();
  }, [refresh, setActive, wantRemote, params.url, params.token]);

  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen>
      <Text role="body" ink={2} style={{ padding: 20 }}>
        {status}
      </Text>
    </Screen>
  );
}
