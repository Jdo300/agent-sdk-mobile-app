/**
 * Connect — the front door. Two connection-mode cards (Letta Cloud, your own
 * server) and the saved-profiles list. See docs/design-doc.md §4.1.
 *
 * Milestone 1 renders the full visual shell; profile storage and the live
 * test-connection flow arrive in milestone 3.
 */
import { router } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";

import { Screen } from "../components/ui/Screen";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { Bloop } from "../components/ui/Bloop";
import { useTheme } from "../theme/ThemeProvider";
import { brandMark, radius, space } from "../theme/tokens";

/**
 * The app's own mark: the same bloop the agents wear, so the icon, the avatars
 * and this screen are one idea. Placeholder art on purpose — fork this and
 * swap it for your own (docs/press/README.md).
 */
function Logomark({ size = 44 }: { size?: number; color?: string }) {
  return <Bloop id="bloop-app-mark" size={size} color={brandMark.bloop} />;
}

function ModeCard({
  glyph,
  title,
  detail,
  onPress,
}: {
  glyph: string;
  title: string;
  detail: string;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
    >
      <View style={styles.cardRow}>
        <Text role="title" style={{ width: 32 }}>
          {glyph}
        </Text>
        <View style={styles.cardText}>
          <Text role="bodyEm">{title}</Text>
          <Text role="sub" ink={2}>
            {detail}
          </Text>
        </View>
        <Text role="title" ink={3}>
          ›
        </Text>
      </View>
    </Touchable>
  );
}

export default function ConnectScreen() {
  const { colors } = useTheme();
  const { profiles, activeProfile, setActive } = useProfiles();
  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Logomark color={colors.ink} />
          <Text role="display" style={styles.heroTitle}>
            Chat with your agents,{"\n"}anywhere.
          </Text>
          <Text role="body" ink={2}>
            A reference client for the Letta Agent SDK.
          </Text>
        </View>

        <View style={styles.cards}>
          <ModeCard
            glyph="☁︎"
            title="Letta Cloud"
            detail="Sign in with an API key"
            onPress={() => router.push({ pathname: "/profile", params: { type: "cloud" } })}
          />
          <ModeCard
            glyph="⌂"
            title="Your own server"
            detail="Connect over WebSocket"
            onPress={() => router.push({ pathname: "/profile", params: { type: "remote" } })}
          />
        </View>

        <View style={styles.saved}>
          <Text role="micro" ink={3}>
            Saved
          </Text>
          {profiles.length === 0 ? (
            <Text role="sub" ink={2} style={styles.savedEmpty}>
              Connections you save appear here.
            </Text>
          ) : (
            profiles.map((profile) => (
              <Touchable
                key={profile.id}
                accessibilityRole="button"
                accessibilityLabel={`Connect with ${profile.name}`}
                onPress={async () => {
                  await setActive(profile.id);
                  router.push("/agents");
                }}
                onLongPress={() =>
                  router.push({ pathname: "/profile", params: { id: profile.id } })
                }
                scaleOnPress={false}
                style={styles.profileRow}
              >
                <View style={styles.profileInner}>
                  <StatusDot tone={profile.lastTest === "ok" ? "run" : profile.lastTest ? "danger" : "idle"} />
                  <View style={styles.profileText}>
                    <Text role="bodyEm">{profile.name}</Text>
                    <Text role="sub" ink={3}>
                      {profile.type === "cloud" ? "Letta Cloud" : "Remote server"}
                      {activeProfile?.id === profile.id ? " · active" : ""}
                    </Text>
                  </View>
                  <Text role="title" ink={3}>
                    ›
                  </Text>
                </View>
              </Touchable>
            ))
          )}
          {profiles.length > 0 ? (
            <Text role="sub" ink={3}>
              Long-press a connection to edit it.
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.gutter, paddingBottom: space.xxl },
  hero: { paddingTop: space.xxl, paddingBottom: space.section, gap: space.md },
  heroTitle: { marginTop: space.sm },
  cards: { gap: space.md },
  card: {
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: space.lg,
  },
  cardRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  cardText: { flex: 1, gap: 2 },
  saved: { paddingTop: space.section, gap: space.sm },
  savedEmpty: { paddingVertical: space.sm },
  profileRow: { marginHorizontal: -space.xs, paddingHorizontal: space.xs, borderRadius: radius.row },
  profileInner: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 10 },
  profileText: { flex: 1, gap: 1 },
});
