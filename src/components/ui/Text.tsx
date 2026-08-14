/**
 * Token-typed text. Every piece of text in the app declares a role from the
 * type scale (docs/design-doc.md §2.2) and an ink level — no ad-hoc styles.
 */
import { Text as RNText, Platform, type TextProps, type TextStyle } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { monoFamily, type, type TypeToken } from "../../theme/tokens";

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
  const color = tone ? colors[tone] : ink === 1 ? colors.ink : ink === 2 ? colors.ink2 : colors.ink3;
  const base = type[role] as TextStyle;
  const monoStyle: TextStyle | undefined = mono
    ? { fontFamily: Platform.select(monoFamily), fontSize: 13, lineHeight: 18 }
    : undefined;
  return <RNText {...rest} style={[base, { color }, monoStyle, style]} />;
}
