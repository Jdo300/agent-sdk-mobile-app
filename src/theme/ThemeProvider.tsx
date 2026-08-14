/**
 * Theme context: resolves the system color scheme into a token palette once,
 * at the top of the tree. Components call useTheme() and never touch raw hex.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useColorScheme } from "react-native";

import { palettes, type Palette, type ThemeName } from "./tokens";

interface Theme {
  name: ThemeName;
  colors: Palette;
}

const ThemeContext = createContext<Theme>({ name: "light", colors: palettes.light });

export function ThemeProvider({
  children,
  /** Force a scheme (used by the /gallery screen to render both themes side by side). */
  force,
}: {
  children: ReactNode;
  force?: ThemeName;
}) {
  const system = useColorScheme();
  const name: ThemeName = force ?? (system === "dark" ? "dark" : "light");
  const value = useMemo<Theme>(() => ({ name, colors: palettes[name] }), [name]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
