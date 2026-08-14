/**
 * Model & reasoning sheet (docs/design-doc.md §4.5): search, model rows
 * with mono handles, and an effort segment. Saving state stays on the chip
 * until the server confirms; failures revert with an inline error.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import type { ModelOption, ReasoningEffort } from "../../lib/letta/api";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

interface Props {
  models: ModelOption[];
  currentModel: string | null;
  currentEffort: string | null;
  onSelect: (model: string, effort?: ReasoningEffort) => void;
  error?: string | null;
}

export const ModelSheet = forwardRef<BottomSheetModal, Props>(function ModelSheet(
  { models, currentModel, currentEffort, onSelect, error },
  ref,
) {
  const { colors } = useTheme();
  const [search, setSearch] = useState("");
  const [effort, setEffort] = useState<ReasoningEffort | null>(
    EFFORTS.includes(currentEffort as ReasoningEffort) ? (currentEffort as ReasoningEffort) : null,
  );

  const filtered = models.filter(
    (m) =>
      m.label.toLowerCase().includes(search.toLowerCase()) ||
      m.handle.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Sheet ref={ref} title="Model">
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search models…"
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        style={[styles.search, { borderColor: colors.surfaceEdge, color: colors.ink }]}
      />
      <View style={styles.effortBlock}>
        <Text role="micro" ink={3}>
          Reasoning effort
        </Text>
        <View style={[styles.segment, { borderColor: colors.surfaceEdge }]}>
          {EFFORTS.map((e) => (
            <Touchable
              key={e}
              accessibilityRole="button"
              accessibilityLabel={`Effort ${e}${effort === e ? ", selected" : ""}`}
              onPress={() => setEffort(effort === e ? null : e)}
              style={[styles.segmentItem, effort === e && { backgroundColor: colors.bubble }]}
            >
              <Text role="sub" ink={effort === e ? 1 : 2} style={styles.segmentLabel}>
                {e}
              </Text>
            </Touchable>
          ))}
        </View>
      </View>
      {error ? (
        <Text role="sub" tone="danger">
          {error}
        </Text>
      ) : null}
      <View style={styles.listBlock}>
        {filtered.slice(0, 8).map((m) => {
          const selected = currentModel === m.handle;
          return (
            <Touchable
              key={m.handle}
              accessibilityRole="button"
              accessibilityLabel={`Model ${m.label}${selected ? ", selected" : ""}`}
              onPress={() => onSelect(m.handle, effort ?? undefined)}
              style={styles.modelRow}
            >
              <View style={styles.modelRowInner}>
                <View style={styles.modelText}>
                  <Text role="body">{m.label}</Text>
                  <Text role="sub" ink={3} mono>
                    {m.handle}
                  </Text>
                </View>
                {selected ? (
                  <Text role="bodyEm" tone="accent">
                    ✓
                  </Text>
                ) : null}
              </View>
            </Touchable>
          );
        })}
        {filtered.length === 0 ? (
          <Text role="sub" ink={3}>
            No models match “{search}”.
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
});

const styles = StyleSheet.create({
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    fontSize: 15,
  },
  effortBlock: { gap: space.sm },
  segment: {
    flexDirection: "row",
    flexWrap: "wrap",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    overflow: "hidden",
  },
  segmentItem: { flexGrow: 1, flexBasis: "16%", minHeight: 38, alignItems: "center" },
  segmentLabel: { textTransform: "capitalize", fontSize: 12 },
  listBlock: { gap: 2 },
  modelRow: { minHeight: 46 },
  modelRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  modelText: { flex: 1, gap: 1 },
});
