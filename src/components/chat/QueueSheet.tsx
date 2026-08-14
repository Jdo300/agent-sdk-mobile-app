/**
 * Queue sheet (docs/design-doc.md §4.5): ordered follow-ups with Remove and
 * "Edit & resend" (remove + restore text to the composer — labeled exactly
 * what it does). Order and membership are server-confirmed; mutations show a
 * pending state until the next queue_update.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef } from "react";
import { StyleSheet, View } from "react-native";

import type { QueueItem } from "../../lib/letta/model";
import { haptic } from "../../lib/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

interface Props {
  queue: QueueItem[];
  onRemove: (id: string) => void;
  onEditResend: (item: QueueItem) => void;
}

export const QueueSheet = forwardRef<BottomSheetModal, Props>(function QueueSheet(
  { queue, onRemove, onEditResend },
  ref,
) {
  const { colors } = useTheme();
  return (
    <Sheet ref={ref} title="Queued follow-ups">
      {queue.length === 0 ? (
        <Text role="sub" ink={3}>
          Nothing queued.
        </Text>
      ) : (
        queue.map((item, index) => (
          <View key={item.id} style={[styles.item, { borderColor: colors.surfaceEdge }]}>
            <View style={styles.itemHead}>
              <Text role="micro" ink={3}>
                {index + 1}
              </Text>
              <Text role="body" numberOfLines={2} style={styles.itemText}>
                {item.text}
              </Text>
            </View>
            {item.pendingRemoval ? (
              <Text role="sub" ink={3}>
                Removing…
              </Text>
            ) : (
              <View style={styles.actions}>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit and resend: ${item.text}`}
                  onPress={() => {
                    haptic.queue();
                    onEditResend(item);
                  }}
                  style={styles.action}
                >
                  <Text role="sub" tone="accent">
                    Edit & resend
                  </Text>
                </Touchable>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Remove from queue: ${item.text}`}
                  onPress={() => {
                    haptic.queue();
                    onRemove(item.id);
                  }}
                  style={styles.action}
                >
                  <Text role="sub" tone="danger">
                    Remove
                  </Text>
                </Touchable>
              </View>
            )}
          </View>
        ))
      )}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  item: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: space.sm, gap: 4 },
  itemHead: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  itemText: { flex: 1 },
  actions: { flexDirection: "row", gap: space.lg, paddingLeft: space.lg },
  action: { minHeight: 32 },
});
