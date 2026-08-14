/**
 * Skeleton loaders — lists never show bare spinners (docs/design-doc.md
 * polish bar). A soft opacity pulse over token-colored blocks.
 */
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";

function Pulse({ children }: { children: React.ReactNode }) {
  const opacity = useSharedValue(0.55);
  useEffect(() => {
    opacity.set(withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    ));
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

/** Skeleton for an agent/conversation row: avatar + two text lines. */
export function SkeletonRow({ avatar = true }: { avatar?: boolean }) {
  const { colors } = useTheme();
  const block = { backgroundColor: colors.bubble };
  return (
    <Pulse>
      <View style={styles.row} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {avatar ? <View style={[styles.avatar, block]} /> : null}
        <View style={styles.lines}>
          <View style={[styles.line, styles.lineWide, block]} />
          <View style={[styles.line, styles.lineNarrow, block]} />
        </View>
      </View>
    </Pulse>
  );
}

export function SkeletonList({ rows = 5, avatar = true }: { rows?: number; avatar?: boolean }) {
  return (
    <View>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} avatar={avatar} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.gutter,
    paddingVertical: 14,
  },
  avatar: { width: 40, height: 40, borderRadius: radius.row },
  lines: { flex: 1, gap: 8 },
  line: { height: 12, borderRadius: 6 },
  lineWide: { width: "55%" },
  lineNarrow: { width: "35%" },
});
