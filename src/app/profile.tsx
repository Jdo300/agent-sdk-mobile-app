/**
 * Profile editor — create (?type=cloud|remote) or edit (?id=...) a connection
 * profile. "Test connection" runs a real handshake and reports a specific
 * verdict; Save activates the profile and enters the app.
 * See docs/design-doc.md §4.1.
 */
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";

import { Header, Screen } from "../components/ui/Screen";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { testConnection, type TestResult } from "../lib/letta/testConnection";
import {
  CLOUD_DEFAULT_URL,
  hasSecret,
  newProfileId,
  saveProfile,
  type Profile,
  type ProfileType,
} from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { radius, space } from "../theme/tokens";

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret,
  hasStoredSecret,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secret?: boolean;
  hasStoredSecret?: boolean;
  autoFocus?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text role="micro" ink={3}>
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={hasStoredSecret && secret ? "•••••••• (stored — type to replace)" : placeholder}
        placeholderTextColor={colors.ink3}
        secureTextEntry={secret}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={autoFocus}
        style={[styles.input, { color: colors.ink, borderColor: colors.surfaceEdge, backgroundColor: colors.surface }]}
      />
    </View>
  );
}

export default function ProfileEditorScreen() {
  const params = useLocalSearchParams<{ type?: ProfileType; id?: string }>();
  const { colors } = useTheme();
  const { profiles, refresh, setActive } = useProfiles();

  const existing = params.id ? profiles.find((p) => p.id === params.id) : undefined;
  const type: ProfileType = existing?.type ?? (params.type === "remote" ? "remote" : "cloud");

  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? (type === "cloud" ? CLOUD_DEFAULT_URL : ""));
  const [secret, setSecret] = useState("");
  const [storedSecret, setStoredSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (existing) void hasSecret(existing.id).then(setStoredSecret);
  }, [existing]);

  const canTest = url.trim().length > 0 && (secret.length > 0 || storedSecret) && !testing;
  const canSave = result?.ok === true || existing !== undefined;

  const runTest = async () => {
    setTesting(true);
    setResult(null);
    let effectiveSecret = secret;
    if (!effectiveSecret && existing) {
      const { getSecret } = await import("../lib/profiles/profiles");
      effectiveSecret = (await getSecret(existing.id)) ?? "";
    }
    const verdict = await testConnection(type, url.trim(), effectiveSecret);
    setResult(verdict);
    setTesting(false);
  };

  const save = async () => {
    setSaving(true);
    const profile: Profile = {
      id: existing?.id ?? newProfileId(),
      type,
      name: name.trim() || (type === "cloud" ? "Letta Cloud" : "My server"),
      url: url.trim(),
      lastTest: result ? (result.ok ? "ok" : result.reason === "unauthorized" ? "unauthorized" : "unreachable") : existing?.lastTest,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await saveProfile(profile, secret || null);
    await setActive(profile.id);
    await refresh();
    setSaving(false);
    router.replace("/agents");
  };

  return (
    <Screen>
      <Header title={type === "cloud" ? "Letta Cloud" : "Your own server"} back />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Field label="Name" value={name} onChange={setName} placeholder={type === "cloud" ? "Personal Cloud" : "Homeserver"} autoFocus={!existing} />
          <Field
            label={type === "cloud" ? "API URL" : "WebSocket URL"}
            value={url}
            onChange={setUrl}
            placeholder={type === "cloud" ? CLOUD_DEFAULT_URL : "wss://your-server:4500"}
          />
          <Field
            label={type === "cloud" ? "API key" : "Capability token"}
            value={secret}
            onChange={(v) => {
              setSecret(v);
              setResult(null);
            }}
            placeholder={type === "cloud" ? "sk-…" : "token"}
            secret
            hasStoredSecret={storedSecret}
          />

          {type === "remote" ? (
            <Text role="sub" ink={2} style={styles.notice}>
              A remote server can run tools on that machine. Prefer wss:// or a private
              network like Tailscale; plain ws:// is for development.
            </Text>
          ) : (
            <Text role="sub" ink={2} style={styles.notice}>
              Your key is stored in the device keychain and only sent to the API URL above.
            </Text>
          )}

          {result ? (
            <Text role="sub" tone={result.ok ? "run" : "danger"} accessibilityLiveRegion="polite">
              {result.detail}
            </Text>
          ) : null}

          <View style={styles.actions}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Test connection"
              disabled={!canTest}
              onPress={runTest}
              style={[styles.test, { borderColor: colors.surfaceEdge, opacity: canTest ? 1 : 0.5 }]}
            >
              <Text role="bodyEm" tone="accent" style={styles.actionLabel}>
                {testing ? "Testing…" : "Test connection"}
              </Text>
            </Touchable>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Save"
              disabled={!canSave || saving}
              onPress={save}
              style={[styles.save, { backgroundColor: colors.accent, opacity: canSave && !saving ? 1 : 0.5 }]}
            >
              <Text role="bodyEm" style={[styles.actionLabel, styles.saveLabel]}>
                {saving ? "Saving…" : "Save"}
              </Text>
            </Touchable>
          </View>
          {!result?.ok && !existing ? (
            <Text role="sub" ink={3} style={styles.hint}>
              Run a successful test to enable Save.
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: space.gutter, paddingTop: space.sm, gap: space.lg, paddingBottom: space.xxl },
  field: { gap: 6 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 16,
  },
  notice: { paddingTop: space.xs },
  actions: { flexDirection: "row", gap: space.md, paddingTop: space.sm },
  test: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.row, alignItems: "center" },
  save: { flex: 1, borderRadius: radius.row, alignItems: "center" },
  actionLabel: { paddingVertical: 13 },
  saveLabel: { color: "#FFFFFF" },
  hint: { textAlign: "center" },
});
