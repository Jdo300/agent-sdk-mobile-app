/**
 * /gallery — dev-only design-iteration surface.
 *
 * Renders every component in every state from static fixtures, plus a live
 * section that replays the mock-session demo turn on a loop. Design review
 * screenshots come from here; it ships as living documentation but is not
 * linked from production navigation.
 */
import { useEffect, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { ConnectionBanner } from "../components/chat/Banner";
import { ApprovalCard } from "../components/chat/ApprovalCard";
import { QueueCapsule } from "../components/chat/QueueCapsule";
import {
  AssistantBlock,
  ErrorRow,
  ReasoningRow,
  ToolCard,
  ToolGroupRow,
  UserBubble,
} from "../components/chat/TranscriptRows";
import { EmptyState } from "../components/ui/EmptyState";
import { Bloop } from "../components/ui/Bloop";
import { Header, Screen } from "../components/ui/Screen";
import { SkeletonRow } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { emptyChat, type ChatSnapshot } from "../lib/letta/model";
import { demoTurn, playScript } from "../lib/letta/mockSession";
import { useTheme } from "../theme/ThemeProvider";
import { space } from "../theme/tokens";

/** 1x1 gray pixel — enough to show the thumbnail treatment without an asset. */
const PLACEHOLDER_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAJmZmQAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text role="micro" ink={3}>
        {title}
      </Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

/** Replays the full demo turn on a loop — motion review without a server. */
function LiveDemo() {
  const [snapshot, setSnapshot] = useState<ChatSnapshot>(emptyChat);
  useEffect(() => playScript(demoTurn, setSnapshot, { loop: true }), []);
  return (
    <View style={styles.demo}>
      {snapshot.transcript.map((item) => {
        switch (item.kind) {
          case "user":
            return <UserBubble key={item.id} item={item} />;
          case "assistant":
            return <AssistantBlock key={item.id} item={item} />;
          case "reasoning":
            return <ReasoningRow key={item.id} item={item} />;
          case "tool":
            return <ToolCard key={item.id} item={item} />;
          case "error":
            return <ErrorRow key={item.id} item={item} />;
        }
      })}
      {snapshot.approvals[0] ? (
        <ApprovalCard request={snapshot.approvals[0]} onAllow={() => {}} onDeny={() => {}} />
      ) : null}
    </View>
  );
}

export default function GalleryScreen() {
  const { name } = useTheme();
  return (
    <Screen>
      <Header title="Gallery" large back subtitle={<Text role="sub" ink={2}>{name} theme · dev only</Text>} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Section title="Live demo turn (loops)">
          <LiveDemo />
        </Section>

        <Section title="User message">
          <UserBubble item={{ kind: "user", id: "g-u1", text: "Ship the queue sheet next." }} />
          <UserBubble item={{ kind: "user", id: "g-u2", text: "Pending send…", pending: true }} />
          <UserBubble item={{ kind: "user", id: "g-u3", text: "This one failed.", failed: true }} />
        </Section>

        <Section title="Assistant">
          <AssistantBlock
            item={{ kind: "assistant", id: "g-a1", text: "Streaming with the caret", streaming: true }}
          />
          <AssistantBlock
            item={{
              kind: "assistant",
              id: "g-a2",
              text: "A complete answer reads as quiet body text on the background — no box.",
            }}
          />
          <AssistantBlock item={{ kind: "assistant", id: "g-a3", text: "Partial answer…", interrupted: true }} />
        </Section>

        <Section title="Assistant markdown">
          <AssistantBlock
            item={{
              kind: "assistant",
              id: "g-a4",
              text:
                "Markdown prose: **bold**, *italic*, `inline code`, and a [tappable link](https://docs.letta.com).\n\n" +
                "- Debounce the banner\n- Keep the timer owner stable\n\n" +
                '```ts\nconst settled = debounce(setPhase, 250);\nsocket.on("state", settled);\n```\n\n' +
                "> Long-press the block to copy the raw markdown.",
            }}
          />
          <AssistantBlock
            item={{
              kind: "assistant",
              id: "g-a5",
              text: "Streaming markdown — settled blocks stay memoized while the tail block grows:\n\n```ts\nconst phase = usePhase();",
              streaming: true,
            }}
          />
        </Section>

        <Section title="Reasoning">
          <ReasoningRow
            item={{
              kind: "reasoning",
              id: "g-r1",
              text: "Weighing whether the debounce belongs to the banner or to the socket owner…",
              seconds: 4,
              streaming: true,
            }}
          />
          <ReasoningRow
            item={{
              kind: "reasoning",
              id: "g-r2",
              text: "Collapsed by default; the detail expands inline in secondary ink.",
              seconds: 8,
            }}
          />
        </Section>

        <Section title="Tool cards">
          <ToolCard item={{ kind: "tool", id: "g-t1", toolCallId: "g1", name: "read_file", summary: "src/net/reconnect.ts", status: "running" }} />
          <ToolCard item={{ kind: "tool", id: "g-t2", toolCallId: "g2", name: "shell", summary: "npm test -- reconnect", status: "awaiting_approval" }} />
          <ToolCard item={{ kind: "tool", id: "g-t3", toolCallId: "g3", name: "read_file", summary: "src/net/reconnect.ts", status: "success", durationMs: 800 }} />
          <ToolCard item={{ kind: "tool", id: "g-t4", toolCallId: "g4", name: "shell", summary: "rm -rf build", status: "denied" }} />
          <ToolCard item={{ kind: "tool", id: "g-t5", toolCallId: "g5", name: "web_fetch", summary: "https://example.com — timeout", status: "error", durationMs: 30000 }} />
        </Section>

        <Section title="Collapsed tool run">
          <ToolGroupRow
            group={{
              kind: "toolGroup",
              id: "g-run-1",
              tools: [
                { kind: "tool", id: "g-r1", toolCallId: "r1", name: "read_file", summary: "src/a.ts", status: "success" },
                { kind: "tool", id: "g-r2", toolCallId: "r2", name: "read_file", summary: "src/b.ts", status: "success" },
                { kind: "tool", id: "g-r3", toolCallId: "r3", name: "grep", summary: "reconnect", status: "success" },
                { kind: "tool", id: "g-r4", toolCallId: "r4", name: "shell", summary: "npm test", status: "error" },
              ],
              failed: 1,
              expanded: false,
            }}
            onToggle={() => {}}
          />
        </Section>

        <Section title="Message with attachments">
          <UserBubble
            item={{
              kind: "user",
              id: "g-att",
              text: "Why does this screen look wrong?",
              images: [PLACEHOLDER_IMAGE, PLACEHOLDER_IMAGE],
            }}
          />
        </Section>

        <Section title="Approval">
          <ApprovalCard
            request={{
              requestId: "g-req",
              toolCallId: "g-t2",
              toolName: "shell",
              summary: "Run shell command",
              input: "npm test -- reconnect",
              permissionSuggestions: [{ id: "s1", text: "Always allow npm test here" }],
            }}
            position={{ index: 1, total: 2 }}
            onAllow={() => {}}
            onDeny={() => {}}
          />
        </Section>

        <Section title="Queue capsule">
          <QueueCapsule
            queue={[
              { id: "q1", text: "Then run the focused tests" },
              { id: "q2", text: "Summarize remaining risk" },
            ]}
            onPress={() => {}}
          />
        </Section>

        <Section title="Connection banners">
          <ConnectionBanner phase="reconnecting" target="Homeserver" />
          <ConnectionBanner phase="reconciling" />
          <ConnectionBanner phase="offline" target="Homeserver" onRetry={() => {}} />
          <ConnectionBanner phase="auth_failed" onEditProfile={() => {}} />
        </Section>

        <Section title="Identity & status">
          <View style={styles.rowWrap}>
            <Bloop id="agent-ada" />
            <Bloop id="agent-release" />
            <Bloop id="agent-notes" />
            <Bloop id="agent-x" />
            <StatusDot tone="run" />
            <StatusDot tone="wait" />
            <StatusDot tone="danger" />
            <StatusDot tone="idle" />
          </View>
        </Section>

        <Section title="Loading & empty">
          <SkeletonRow />
          <SkeletonRow />
          <EmptyState message="No conversations yet." actionLabel="New conversation" onAction={() => {}} />
        </Section>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: space.xxl },
  section: { paddingHorizontal: space.gutter, paddingTop: space.section, gap: space.md },
  sectionBody: { gap: space.md },
  demo: { gap: space.md, minHeight: 320 },
  rowWrap: { flexDirection: "row", alignItems: "center", gap: space.md, flexWrap: "wrap" },
});
