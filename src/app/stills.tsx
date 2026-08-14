/**
 * Dev-only capture route for press/blog stills.
 *
 * Renders the real components against curated fixtures so a still never leaks a
 * live account: no agent names, conversation titles, paths, or transcripts from
 * a real session. `?scene=` picks the shot; `?chrome=off` drops the status row
 * so the frame is pure product.
 */
import { Redirect, useLocalSearchParams } from "expo-router";
import { FlatList, StyleSheet, View } from "react-native";

import { ApprovalCard } from "../components/chat/ApprovalCard";
import {
  AssistantBlock,
  ReasoningRow,
  ToolCard,
  ToolGroupRow,
  UserBubble,
} from "../components/chat/TranscriptRows";
import { Header, Screen } from "../components/ui/Screen";
import { Bloop } from "../components/ui/Bloop";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import type { ApprovalRequest, ToolItem } from "../lib/letta/model";
import { useTheme } from "../theme/ThemeProvider";
import { space } from "../theme/tokens";

const REPLY = `Here's what changed in \`reconnect.ts\`:

- the retry timer now clears **after** the socket settles
- reconciling is debounced, so the banner stops flickering

\`\`\`ts
socket.on("state", debounce(setPhase, 250));
\`\`\``;

const TOOLS: ToolItem[] = [
  { kind: "tool", id: "t1", toolCallId: "c1", name: "read_file", summary: "src/net/reconnect.ts", status: "success", durationMs: 800 },
  { kind: "tool", id: "t2", toolCallId: "c2", name: "grep", summary: "setPhase", status: "success", durationMs: 300 },
  { kind: "tool", id: "t3", toolCallId: "c3", name: "shell", summary: "npm test -- reconnect · 14 passed", status: "success", durationMs: 5300 },
];

const APPROVAL: ApprovalRequest = {
  requestId: "r1",
  toolCallId: "c9",
  toolName: "shell",
  summary: "Run shell command",
  input: "npm run deploy -- --env staging",
  permissionSuggestions: [{ id: "s1", text: "Always allow npm commands in this project" }],
};

const AGENTS = [
  { name: "Reconnect fix", model: "claude-sonnet-4-5", when: "just now", running: true },
  { name: "Docs rewrite", model: "gpt-5.5", when: "12m ago", running: false },
  { name: "Nightly triage", model: "claude-haiku-4-5", when: "2h ago", running: false },
  { name: "Schema migration", model: "auto", when: "yesterday", running: false },
];

/** Static composer: the real one is interactive, this just anchors the frame. */
function Composer({ label, model }: { label: string; model: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.composerWrap, { borderColor: colors.surfaceEdge }]}>
      <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
        <Text role="title" ink={2}>
          ＋
        </Text>
        <Text role="body" ink={3} style={styles.placeholder}>
          {label}
        </Text>
      </View>
      <View style={styles.chipRow}>
        <Text role="sub" ink={2} mono numberOfLines={1}>
          {model}
        </Text>
        <View style={[styles.send, { backgroundColor: colors.accent }]}>
          <Text role="bodyEm" style={styles.sendGlyph}>
            ↑
          </Text>
        </View>
      </View>
    </View>
  );
}

function ChatScene() {
  const rows = [
    <UserBubble key="u1" item={{ kind: "user", id: "u1", text: "Why does the reconnect banner flicker?" }} />,
    <ReasoningRow key="r1" item={{ kind: "reasoning", id: "r1", text: "Checking the retry timer against the socket lifecycle.", seconds: 3 }} />,
    <ToolGroupRow key="g1" group={{ kind: "toolGroup", id: "g1", tools: TOOLS, failed: 0, expanded: false }} onToggle={() => {}} />,
    <AssistantBlock key="a1" item={{ kind: "assistant", id: "a1", text: REPLY }} />,
  ];
  return (
    <View style={styles.flex}>
      <View style={styles.transcript}>{rows}</View>
      <Composer label="Message code-agent…" model="claude-sonnet-4-5 · Standard" />
    </View>
  );
}

function ApprovalScene() {
  return (
    <View style={styles.flex}>
      <View style={styles.transcript}>
      <UserBubble item={{ kind: "user", id: "u1", text: "Ship the staging build." }} />
      <ToolCard item={{ kind: "tool", id: "t1", toolCallId: "c8", name: "read_file", summary: "deploy/staging.yml", status: "success", durationMs: 400 }} />
      </View>
      <View style={styles.approvalSlot}>
        <ApprovalCard request={APPROVAL} cwd="~/work/api" onAllow={() => {}} onDeny={() => {}} onAcceptSuggestion={() => {}} />
      </View>
    </View>
  );
}

function AgentsScene() {
  const { colors } = useTheme();
  return (
    <FlatList
      scrollEnabled={false}
      data={AGENTS}
      keyExtractor={(a) => a.name}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => (
        <Touchable accessibilityRole="button" accessibilityLabel={item.name} onPress={() => {}} scaleOnPress={false} style={styles.row}>
          <View style={styles.rowInner}>
            <Bloop id={item.name} />
            <View style={styles.rowText}>
              <Text role="bodyEm" numberOfLines={1}>
                {item.name}
              </Text>
              <Text role="sub" ink={3} mono numberOfLines={1}>
                {item.model} · {item.when}
              </Text>
            </View>
            {item.running ? <StatusDot tone="run" /> : null}
          </View>
          <View style={[styles.divider, { backgroundColor: colors.surfaceEdge }]} />
        </Touchable>
      )}
    />
  );
}

export default function StillsScreen() {
  const params = useLocalSearchParams<{ scene?: string; chrome?: string }>();
  if (!__DEV__) return <Redirect href="/" />;
  const scene = params.scene ?? "chat";
  const chrome = params.chrome !== "off";

  if (scene === "agents") {
    return (
      <Screen>
        <Header title="Agents" large subtitle={chrome ? <Text role="sub" ink={2}>4 agents</Text> : undefined} />
        <AgentsScene />
      </Screen>
    );
  }

  const title = scene === "approval" ? "Staging deploy" : "Reconnect banner";
  return (
    <Screen>
      <Header
        title={title}
        back
        subtitle={
          chrome ? (
            <View style={styles.statusRow}>
              <Text role="sub" ink={2}>
                {scene === "approval" ? "release-bot · Waiting for you" : "code-agent · Connected"}
              </Text>
              <StatusDot tone={scene === "approval" ? "wait" : "run"} />
            </View>
          ) : undefined
        }
      />
      {scene === "approval" ? <ApprovalScene /> : <ChatScene />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  composerWrap: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.gutter, paddingTop: space.md, paddingBottom: space.xl, gap: space.sm },
  composer: { flexDirection: "row", alignItems: "center", gap: space.sm, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.lg, paddingVertical: 12 },
  placeholder: { flex: 1 },
  chipRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  send: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  sendGlyph: { color: "#FFFFFF" },
  approvalSlot: { paddingHorizontal: space.gutter, paddingBottom: space.xl },
  transcript: { flex: 1, paddingHorizontal: space.gutter, paddingTop: space.md, gap: space.md },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  list: { paddingTop: space.sm },
  row: { paddingHorizontal: space.gutter },
  rowInner: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth },
});
