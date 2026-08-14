/**
 * 6pt status dot. Color never carries state alone — always pair with a word
 * (docs/design-doc.md §8), so this component is decorative and hidden from
 * the accessibility tree.
 */
import { View } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";

export type StatusTone = "run" | "wait" | "danger" | "idle";

export function StatusDot({ tone, size = 6 }: { tone: StatusTone; size?: number }) {
  const { colors } = useTheme();
  const color = tone === "idle" ? colors.ink3 : colors[tone];
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }}
    />
  );
}
