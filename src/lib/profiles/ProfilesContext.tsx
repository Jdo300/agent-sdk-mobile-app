/**
 * Profile state shared across screens: the saved list and the active
 * selection. Storage is the source of truth; this context is a cache with a
 * refresh() invalidation, which is enough for a reference app.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getActiveProfileId,
  listProfiles,
  saveProfile,
  setActiveProfileId,
  type Profile,
} from "./profiles";

interface ProfilesState {
  loaded: boolean;
  profiles: Profile[];
  activeProfile: Profile | null;
  setActive: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Context = createContext<ProfilesState>({
  loaded: false,
  profiles: [],
  activeProfile: null,
  setActive: async () => {},
  refresh: async () => {},
});

async function bootstrapOfficeBrowserProfile(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const response = await fetch("/__bloop/bootstrap", { cache: "no-store" });
    if (!response.ok) return;
    const payload = (await response.json()) as { profile?: Profile };
    const profile = payload.profile;
    if (
      !profile ||
      profile.type !== "remote" ||
      typeof profile.id !== "string" ||
      typeof profile.name !== "string" ||
      typeof profile.url !== "string"
    ) return;
    // The office bridge owns authentication. Intentionally persist no browser
    // secret: WebSocket NO_AUTH is accepted only for this bridge's allowlisted
    // Local Milo target and the bridge injects the host-side capability token.
    await saveProfile(profile, null);
    await setActiveProfileId(profile.id);
  } catch {
    // Normal Expo/mobile/web builds do not expose this endpoint.
  }
}

export function ProfilesProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [list, active] = await Promise.all([listProfiles(), getActiveProfileId()]);
    setProfiles(list);
    setActiveId(active);
    setLoaded(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await bootstrapOfficeBrowserProfile();
      const [list, active] = await Promise.all([listProfiles(), getActiveProfileId()]);
      if (cancelled) return;
      setProfiles(list);
      setActiveId(active);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setActive = useCallback(
    async (id: string) => {
      await setActiveProfileId(id);
      setActiveId(id);
    },
    [],
  );

  const value = useMemo<ProfilesState>(
    () => ({
      loaded,
      profiles,
      activeProfile: profiles.find((p) => p.id === activeId) ?? null,
      setActive,
      refresh,
    }),
    [loaded, profiles, activeId, setActive, refresh],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useProfiles(): ProfilesState {
  return useContext(Context);
}
