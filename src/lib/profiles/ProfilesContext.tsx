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
    Promise.all([listProfiles(), getActiveProfileId()]).then(([list, active]) => {
      if (cancelled) return;
      setProfiles(list);
      setActiveId(active);
      setLoaded(true);
    });
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
