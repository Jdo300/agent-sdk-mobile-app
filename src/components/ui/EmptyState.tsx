/**
 * Empty state: one concise explanation, one primary recovery action.
 */
import { StyleSheet, View } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

interface Props {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ message, actionLabel, onAction }: Props) {
  const { colors } = useTheme();
  return (
    <View style={styles.wrap}>
      <Text role="body" ink={2} style={styles.message}>
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={[styles.action, { backgroundColor: colors.accent }]}
        >
          <Text role="bodyEm" style={styles.actionLabel}>
            {actionLabel}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.lg, paddingHorizontal: space.gutter },
  message: { textAlign: "center" },
  action: { borderRadius: radius.row, paddingHorizontal: space.xl },
  actionLabel: { color: "#FFFFFF", paddingVertical: 12 },
});
