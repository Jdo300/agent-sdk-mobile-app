/**
 * Queue capsule — sits above the composer during an active run when
 * follow-ups are queued. The count change animates with the `move` spring
 * (docs/design-doc.md §4.4).
 */
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from "react-native-reanimated";

import type { QueueItem } from "../../lib/letta/model";
import { useTheme } from "../../theme/ThemeProvider";
import { motion, radius, space } from "../../theme/tokens";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

export function QueueCapsule({ queue, onPress }: { queue: QueueItem[]; onPress: () => void }) {
  const { colors } = useTheme();
  const pop = useSharedValue(1);

  useEffect(() => {
    if (queue.length > 0) {
      pop.set(withSequence(withSpring(1.06, motion.move), withSpring(1, motion.move)));
    }
  }, [queue.length, pop]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: pop.get() }] }));

  if (queue.length === 0) return null;
  const next = queue[0]!;
  return (
    <Animated.View style={style}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${queue.length} queued. Next: ${next.text}. Manage queue`}
        onPress={onPress}
        scaleOnPress={false}
        style={[styles.capsule, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
      >
        <View style={styles.inner}>
          <Text role="micro" ink={2}>
            Queued {queue.length}
          </Text>
          <Text role="sub" ink={3} numberOfLines={1} style={styles.preview}>
            “{next.text}”
          </Text>
          <Text role="sub" ink={3}>
            ›
          </Text>
        </View>
      </Touchable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  capsule: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.chip,
    minHeight: 36,
    paddingHorizontal: space.md,
  },
  inner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  preview: { flex: 1 },
});
