import { ScrollView, StyleSheet, View } from "react-native";
import * as Clipboard from "expo-clipboard";

import { SyntaxCode } from "../components/chat/SyntaxCode";
import { Header, Screen } from "../components/ui/Screen";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { getViewerPayload } from "../lib/viewerPayload";
import { useTheme } from "../theme/ThemeProvider";
import { space } from "../theme/tokens";

export default function CodeViewerScreen() {
  const { colors } = useTheme();
  const payload = getViewerPayload();
  const code = payload?.kind === "code" ? payload.code : "";
  const language = payload?.kind === "code" ? payload.language : null;

  return (
    <Screen>
      <Header
        title={language ?? "Code"}
        back
        trailing={
          code ? (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Copy code"
              onPress={() => void Clipboard.setStringAsync(code)}
              style={styles.copy}
            >
              <Text role="sub" tone="accent">Copy</Text>
            </Touchable>
          ) : undefined
        }
      />
      {code ? (
        <ScrollView style={styles.vertical} contentContainerStyle={styles.verticalContent}>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.horizontalContent}>
            <View style={[styles.codeSurface, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
              <SyntaxCode code={code} language={language} selectable />
            </View>
          </ScrollView>
        </ScrollView>
      ) : (
        <View style={styles.empty}><Text ink={2}>This code is no longer available.</Text></View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  vertical: { flex: 1 },
  verticalContent: { flexGrow: 1 },
  horizontalContent: { paddingHorizontal: space.gutter, paddingBottom: space.gutter },
  codeSurface: { minWidth: "100%", borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, padding: space.lg },
  copy: { paddingHorizontal: space.sm },
  empty: { padding: space.gutter },
});
