import { BottomSheetTextInput, type BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

interface Props {
  names: string[];
  loading: boolean;
  error?: string | null;
  onRefresh: () => Promise<void>;
  onApply: (set: Record<string, string>, unset: string[]) => Promise<void>;
}

export const SecretSheet = forwardRef<BottomSheetModal, Props>(function SecretSheet(
  { names, loading, error, onRefresh, onApply },
  ref,
) {
  const { colors } = useTheme();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const normalizedKey = key.trim().toUpperCase();
  const valid = SECRET_NAME.test(normalizedKey) && value.length > 0;

  const save = useCallback(async () => {
    if (!valid || saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await onApply({ [normalizedKey]: value }, []);
      // Drop plaintext immediately after the App Server accepts it.
      setValue("");
      setKey("");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Could not save secret.");
    } finally {
      setSaving(false);
    }
  }, [normalizedKey, onApply, saving, valid, value]);

  const remove = useCallback(
    async (name: string) => {
      if (saving) return;
      setSaving(true);
      setLocalError(null);
      try {
        await onApply({}, [name]);
        if (normalizedKey === name) {
          setKey("");
          setValue("");
        }
      } catch (e) {
        setLocalError(e instanceof Error ? e.message : "Could not remove secret.");
      } finally {
        setSaving(false);
      }
    },
    [normalizedKey, onApply, saving],
  );

  return (
    <Sheet ref={ref} title="Agent secrets" scroll>
      <Text role="sub" ink={2}>
        Stored by Letta for this agent. Values are never shown here or sent through chat.
      </Text>

      <View style={styles.form}>
        <BottomSheetTextInput
          value={key}
          onChangeText={(next) => setKey(next.toUpperCase())}
          placeholder="SECRET_NAME"
          placeholderTextColor={colors.ink3}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Secret name"
          style={[styles.input, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        <BottomSheetTextInput
          value={value}
          onChangeText={setValue}
          placeholder={normalizedKey && names.includes(normalizedKey) ? "New value (replaces stored value)" : "Secret value"}
          placeholderTextColor={colors.ink3}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          accessibilityLabel="Secret value"
          style={[styles.input, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        {normalizedKey.length > 0 && !SECRET_NAME.test(normalizedKey) ? (
          <Text role="sub" tone="danger">Use A–Z, 0–9, and underscores; the name cannot start with a number.</Text>
        ) : null}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={names.includes(normalizedKey) ? "Replace secret" : "Save secret"}
          disabled={!valid || saving}
          onPress={() => void save()}
          style={[styles.primary, { backgroundColor: colors.accent, opacity: !valid || saving ? 0.45 : 1 }]}
        >
          {saving ? <ActivityIndicator /> : <Text role="bodyEm" style={styles.primaryText}>{names.includes(normalizedKey) ? "Replace secret" : "Save secret"}</Text>}
        </Touchable>
      </View>

      <View style={styles.sectionHeader}>
        <Text role="bodyEm">Stored names</Text>
        <Touchable accessibilityRole="button" accessibilityLabel="Refresh secrets" disabled={loading || saving} onPress={() => void onRefresh()}>
          <Text role="sub" tone="accent">Refresh</Text>
        </Touchable>
      </View>

      {loading ? <ActivityIndicator /> : names.length === 0 ? (
        <Text role="sub" ink={3}>No agent secrets stored yet.</Text>
      ) : (
        <View style={styles.list}>
          {names.map((name) => (
            <View key={name} style={[styles.row, { borderColor: colors.surfaceEdge }]}>
              <View style={styles.rowText}>
                <Text role="bodyEm" mono>{name}</Text>
                <Text role="micro" ink={3}>Stored • value hidden</Text>
              </View>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Replace ${name}`}
                disabled={saving}
                onPress={() => { setKey(name); setValue(""); setLocalError(null); }}
                style={styles.rowAction}
              >
                <Text role="sub" tone="accent">Replace</Text>
              </Touchable>
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${name}`}
                disabled={saving}
                onPress={() =>
                  Alert.alert(
                    "Delete secret?",
                    `${name} will be removed from this agent.`,
                    [
                      { text: "Cancel", style: "cancel" },
                      { text: "Delete", style: "destructive", onPress: () => void remove(name) },
                    ],
                  )
                }
                style={styles.rowAction}
              >
                <Text role="sub" tone="danger">Delete</Text>
              </Touchable>
            </View>
          ))}
        </View>
      )}

      {localError || error ? <Text role="sub" tone="danger">{localError ?? error}</Text> : null}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  form: { gap: space.sm },
  input: {
    minHeight: 46,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    fontSize: 16,
  },
  primary: { minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#FFFFFF" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.sm },
  list: { gap: space.xs },
  row: { minHeight: 58, flexDirection: "row", alignItems: "center", borderBottomWidth: StyleSheet.hairlineWidth, gap: space.sm },
  rowText: { flex: 1, gap: 2 },
  rowAction: { paddingHorizontal: space.xs, paddingVertical: space.sm },
});
