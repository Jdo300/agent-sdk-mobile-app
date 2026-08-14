/**
 * Connection banner — in-context recovery above the composer
 * (docs/design-doc.md §4.4 Reconnect). The transcript stays readable;
 * this row explains what's happening and what survives.
 */
import { StyleSheet, View } from "react-native";

import type { ConnectionPhase } from "../../lib/letta/model";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

interface Props {
  phase: Exclude<ConnectionPhase, "connected">;
  /** e.g. profile name for "Reconnecting to Homeserver…". */
  target?: string;
  onRetry?: () => void;
  onEditProfile?: () => void;
}

const copy: Record<Props["phase"], (target?: string) => { title: string; detail?: string }> = {
  reconnecting: (t) => ({
    title: `Reconnecting${t ? ` to ${t}` : ""}…`,
    detail: "Your draft is safe.",
  }),
  reconciling: () => ({ title: "Catching up…", detail: "Syncing the latest run state." }),
  offline: (t) => ({
    title: `Can't reach ${t ?? "the server"}`,
    detail: "Check the connection and try again.",
  }),
  auth_failed: () => ({
    title: "Connection was rejected",
    detail: "The saved credentials no longer work.",
  }),
};

export function ConnectionBanner({ phase, target, onRetry, onEditProfile }: Props) {
  const { colors } = useTheme();
  const tone = phase === "offline" || phase === "auth_failed" ? "danger" : "wait";
  const { title, detail } = copy[phase](target);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
    >
      <View style={styles.textBlock}>
        <Text role="sub" tone={tone}>
          {title}
        </Text>
        {detail ? (
          <Text role="sub" ink={3}>
            {detail}
          </Text>
        ) : null}
      </View>
      {phase === "offline" && onRetry ? (
        <Touchable accessibilityRole="button" accessibilityLabel="Retry connection" onPress={onRetry} style={styles.action}>
          <Text role="sub" tone="accent">
            Retry
          </Text>
        </Touchable>
      ) : null}
      {phase === "auth_failed" && onEditProfile ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Update connection settings"
          onPress={onEditProfile}
          style={styles.action}
        >
          <Text role="sub" tone="accent">
            Update
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  textBlock: { flex: 1, gap: 1 },
  action: { minHeight: 36, paddingHorizontal: space.xs },
});
