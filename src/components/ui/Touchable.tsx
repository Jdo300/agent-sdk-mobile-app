/**
 * Pressable with the app's standard pressed treatment: a token overlay and a
 * 120ms scale dip. Guarantees the 44pt minimum target.
 *
 * The pressed overlay is a separate absolute-fill layer (not an animated
 * backgroundColor) so callers can pass their own fill — Reanimated writes
 * native props directly and would otherwise override static backgrounds.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { useTheme } from "../../theme/ThemeProvider";
import { hit, motion } from "../../theme/tokens";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface Props extends PressableProps {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  /** Set false for rows inside lists that provide their own feedback. */
  scaleOnPress?: boolean;
}

export function Touchable({ style, children, scaleOnPress = true, onPressIn, onPressOut, ...rest }: Props) {
  const { colors } = useTheme();
  const pressed = useSharedValue(0);

  const scaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scaleOnPress ? 1 - pressed.get() * 0.015 : 1 }],
  }));
  const overlayStyle = useAnimatedStyle(() => ({ opacity: pressed.get() }));

  return (
    <AnimatedPressable
      {...rest}
      onPressIn={(e) => {
        pressed.set(withTiming(1, { duration: motion.micro.duration }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.set(withTiming(0, { duration: motion.micro.duration }));
        onPressOut?.(e);
      }}
      style={[styles.base, scaleStyle, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.overlay, { backgroundColor: colors.pressed }, overlayStyle]}
      />
      {children}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: hit.minTarget, justifyContent: "center", overflow: "hidden" },
  overlay: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0 },
});
