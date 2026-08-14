/**
 * The app's entire haptic vocabulary in one place (docs/design-doc.md §2.5).
 * Never fires on stream deltas.
 */
import * as Haptics from "expo-haptics";

export const haptic = {
  send: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  stop: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium),
  approve: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  deny: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  queue: () => Haptics.selectionAsync(),
  copy: () => Haptics.selectionAsync(),
  tap: () => Haptics.selectionAsync(),
  reconnected: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};
