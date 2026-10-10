/**
 * Voice output sheet (issue #45): pick the active voice profile and tune its
 * speech rate. Long-press the voice pill in the chat header to open it.
 * Settings persist on-device; the active profile rides every TTS request.
 */
import { forwardRef } from "react";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { StyleSheet, View } from "react-native";

import {
  VOICE_PROFILE_OPTIONS,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  clampVoiceSpeed,
  type VoiceSettings,
} from "../../lib/voiceProfiles";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

interface Props {
  settings: VoiceSettings;
  onSelectProfile: (id: string) => void;
  onSpeedChange: (id: string, speed: number) => void;
}

export const VoiceSheet = forwardRef<BottomSheetModal, Props>(function VoiceSheet(
  { settings, onSelectProfile, onSpeedChange },
  ref,
) {
  const { colors } = useTheme();
  return (
    <Sheet ref={ref} title="Voice output" compact>
      <View style={styles.list}>
        {VOICE_PROFILE_OPTIONS.map((profile) => {
          const active = profile.id === settings.activeId;
          const speed = settings.speeds[profile.id] ?? profile.defaultSpeed;
          return (
            <View key={profile.id} style={[styles.row, active ? styles.rowActive : null]}>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Use ${profile.label} voice`}
                onPress={() => onSelectProfile(profile.id)}
                style={styles.rowMain}
              >
                <Text role="bodyEm" tone={active ? "accent" : undefined}>{profile.label}</Text>
                <Text role="sub" ink={2}>{active ? "Active" : "Tap to use"}</Text>
              </Touchable>
              <View style={styles.speed}>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Slow down ${profile.label}`}
                  disabled={speed <= VOICE_SPEED_MIN}
                  onPress={() => onSpeedChange(profile.id, clampVoiceSpeed(speed - 0.05))}
                  style={styles.step}
                >
                  <Text role="bodyEm" ink={speed <= VOICE_SPEED_MIN ? 3 : 1}>−</Text>
                </Touchable>
                <Text role="sub" style={styles.speedValue}>{Math.round(speed * 100)}%</Text>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Speed up ${profile.label}`}
                  disabled={speed >= VOICE_SPEED_MAX}
                  onPress={() => onSpeedChange(profile.id, clampVoiceSpeed(speed + 0.05))}
                  style={styles.step}
                >
                  <Text role="bodyEm" ink={speed >= VOICE_SPEED_MAX ? 3 : 1}>+</Text>
                </Touchable>
              </View>
            </View>
          );
        })}
        <Text role="sub" ink={3} style={styles.hint}>
          Rates apply to new voice replies.
        </Text>
      </View>
    </Sheet>
  );
});

const styles = StyleSheet.create({
  list: { gap: space.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "transparent",
  },
  rowActive: { borderColor: "rgba(127,127,127,0.4)" },
  rowMain: { flex: 1, gap: 2 },
  speed: { flexDirection: "row", alignItems: "center", gap: space.xs },
  step: {
    minWidth: 32,
    minHeight: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.row,
    backgroundColor: "rgba(127,127,127,0.12)",
  },
  speedValue: { minWidth: 44, textAlign: "center" },
  hint: { paddingTop: space.xs },
});
