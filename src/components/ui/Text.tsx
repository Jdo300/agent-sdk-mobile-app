/**
 * Token-typed text. Every piece of text in the app declares a role from the
 * type scale (docs/design-doc.md §2.2) and an ink level — no ad-hoc styles.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Text as RNText, Platform, StyleSheet, type TextProps, type TextStyle } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { monoFamily, type, type TypeToken } from "../../theme/tokens";

const TextScaleContext = createContext(1);

export function TextScaleProvider({ scale, children }: { scale: number; children: ReactNode }) {
  return <TextScaleContext.Provider value={scale}>{children}</TextScaleContext.Provider>;
}

export function useTextScale(): number {
  return useContext(TextScaleContext);
}

interface Props extends Omit<TextProps, "role"> {
  /** Type-scale role (docs/design-doc.md §2.2) — not the ARIA role. */
  role?: TypeToken;
  /** 1 = primary ink, 2 = secondary, 3 = tertiary. */
  ink?: 1 | 2 | 3;
  /** Semantic color overrides ink. */
  tone?: "accent" | "run" | "wait" | "danger";
  mono?: boolean;
}

export function Text({ role = "body", ink = 1, tone, mono, style, ...rest }: Props) {
  const { colors } = useTheme();
  const scale = useContext(TextScaleContext);
  const color = tone ? colors[tone] : ink === 1 ? colors.ink : ink === 2 ? colors.ink2 : colors.ink3;
  const base = type[role] as TextStyle;
  const explicit = StyleSheet.flatten(style) as TextStyle | undefined;
  const sourceFontSize = typeof explicit?.fontSize === "number"
    ? explicit.fontSize
    : mono
      ? 13
      : typeof base.fontSize === "number"
        ? base.fontSize
        : undefined;
  const sourceLineHeight = typeof explicit?.lineHeight === "number"
    ? explicit.lineHeight
    : mono
      ? 18
      : typeof base.lineHeight === "number"
        ? base.lineHeight
        : undefined;
  const scaledTypography: TextStyle = {
    ...(sourceFontSize != null ? { fontSize: sourceFontSize * scale } : {}),
    ...(sourceLineHeight != null ? { lineHeight: sourceLineHeight * scale } : {}),
  };
  const monoStyle: TextStyle | undefined = mono
    ? { fontFamily: Platform.select(monoFamily) }
    : undefined;
  // Put scaledTypography last so role styles and component-specific font sizes
  // participate in the same desktop scale instead of overriding it.
  return <RNText {...rest} style={[base, { color }, monoStyle, style, scaledTypography]} />;
}
