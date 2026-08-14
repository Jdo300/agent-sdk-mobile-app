/**
 * Markdown — assistant prose rendering (docs/design-doc.md §4.4).
 *
 * Text is split into blocks at blank lines with fence awareness (ported from
 * paseo's splitMarkdownBlocks) so settled blocks are memoized children and a
 * streaming flush only re-parses the tail block. Everything visual resolves
 * through the token system; links open externally via Linking.
 */
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Platform, ScrollView, StyleSheet, View, type TextStyle } from "react-native";
import MarkdownDisplay, { MarkdownIt, type ASTNode, type RenderRules } from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";

import { haptic } from "../../lib/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space, monoFamily, type as typeScale, type Palette } from "../../theme/tokens";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

// ── Fence-aware block splitting (paseo packages/app/src/utils) ──────────────

function getFenceDelimiter(line: string): string | null {
  const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
  return match?.[2] ?? null;
}

/**
 * Split markdown into standalone blocks at blank lines — except inside a
 * fence, where blank lines belong to the code. An unterminated trailing fence
 * stays one growing block, so a streaming code block never renders half-open
 * fences as prose.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (text.length === 0) return [];

  const blocks: string[] = [];
  let currentLines: string[] = [];
  let activeFenceCharacter: "`" | "~" | null = null;
  let activeFenceLength = 0;
  let sawBlockSeparator = false;

  for (const line of text.split("\n")) {
    const isBlankLine = line.trim().length === 0;

    if (!activeFenceCharacter && isBlankLine) {
      if (currentLines.length > 0) sawBlockSeparator = true;
      continue;
    }

    if (!activeFenceCharacter && sawBlockSeparator) {
      blocks.push(currentLines.join("\n"));
      currentLines = [];
      sawBlockSeparator = false;
    }

    currentLines.push(line);

    const fenceDelimiter = getFenceDelimiter(line);
    if (!fenceDelimiter) continue;

    if (!activeFenceCharacter) {
      activeFenceCharacter = fenceDelimiter[0] as "`" | "~";
      activeFenceLength = fenceDelimiter.length;
      continue;
    }

    if (fenceDelimiter[0] === activeFenceCharacter && fenceDelimiter.length >= activeFenceLength) {
      activeFenceCharacter = null;
      activeFenceLength = 0;
    }
  }

  if (currentLines.length > 0) blocks.push(currentLines.join("\n"));

  return blocks.filter((block) => block.length > 0);
}

// ── Renderer ────────────────────────────────────────────────────────────────

// linkify makes bare URLs tappable — agent replies rarely bother with [](…).
const parser = MarkdownIt({ typographer: true, linkify: true });

function openLink(url: string): boolean {
  Linking.openURL(url).catch(() => {});
  // Handled here — the library's default opener must not double-fire.
  return false;
}

/**
 * Clipboard write + haptic tick + a transient flag the caller renders as a
 * "Copied" acknowledgement. One vocabulary for every copy affordance.
 */
export function useCopyFeedback(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(text);
    haptic.copy();
    setCopied(true);
  }, [text]);
  return { copied, copy };
}

/** Fenced code with a quiet copy affordance and horizontal overflow scroll. */
function CodeFence({ code, language }: { code: string; language: string | null }) {
  const { colors } = useTheme();
  const body = code.replace(/\n$/, "");
  const { copied, copy } = useCopyFeedback(body);
  return (
    <View style={[styles.fence, { borderColor: colors.surfaceEdge, backgroundColor: colors.surface }]}>
      <View style={styles.fenceHead}>
        <Text role="micro" ink={3}>
          {language ?? "code"}
        </Text>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={copied ? "Code copied" : "Copy code"}
          onPress={copy}
          style={styles.fenceCopy}
        >
          <Text role="micro" ink={copied ? 2 : 3}>
            {copied ? "copied ✓" : "copy"}
          </Text>
        </Touchable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.fenceScroll}>
        <Text role="sub" mono>
          {body}
        </Text>
      </ScrollView>
    </View>
  );
}

// The typed ASTNode predates sourceInfo; the runtime carries the fence's
// language string on it.
function fenceLanguage(node: ASTNode): string | null {
  const info = (node as ASTNode & { sourceInfo?: string }).sourceInfo?.trim();
  return info ? info.split(/\s+/)[0]! : null;
}

const rules: RenderRules = {
  fence: (node) => <CodeFence key={node.key} code={node.content} language={fenceLanguage(node)} />,
  code_block: (node) => <CodeFence key={node.key} code={node.content} language={null} />,
};

const mono: TextStyle = {
  fontFamily: Platform.select(monoFamily),
  fontSize: 13,
  lineHeight: 18,
};

/**
 * Map markdown elements onto the app's type scale and palette — headings
 * collapse to title/bodyEm so prose never invents new sizes.
 */
function markdownStyles(colors: Palette) {
  const heading: TextStyle = { ...typeScale.bodyEm, color: colors.ink, marginTop: space.xs };
  return {
    body: { ...typeScale.body, color: colors.ink },
    paragraph: { marginTop: 0, marginBottom: 0 },
    heading1: { ...typeScale.title, color: colors.ink, marginTop: space.xs },
    heading2: { ...typeScale.title, color: colors.ink, marginTop: space.xs },
    heading3: heading,
    heading4: heading,
    heading5: heading,
    heading6: heading,
    strong: { fontWeight: "600" },
    em: { fontStyle: "italic" },
    s: { textDecorationLine: "line-through" },
    link: { color: colors.accent },
    blocklink: { color: colors.accent, borderBottomWidth: 0 },
    code_inline: {
      ...mono,
      backgroundColor: colors.pressed,
      borderRadius: 4,
      paddingHorizontal: 3,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftWidth: 2,
      borderLeftColor: colors.surfaceEdge,
      marginLeft: 0,
      paddingLeft: space.md,
      paddingRight: 0,
    },
    bullet_list: { marginTop: 0, marginBottom: 0 },
    ordered_list: { marginTop: 0, marginBottom: 0 },
    list_item: { flexDirection: "row", marginBottom: space.xs },
    bullet_list_icon: { color: colors.ink2, marginLeft: 0, marginRight: space.sm },
    ordered_list_icon: { color: colors.ink2, marginLeft: 0, marginRight: space.sm },
    hr: { backgroundColor: colors.surfaceEdge, height: StyleSheet.hairlineWidth, marginVertical: space.sm },
    table: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.surfaceEdge, borderRadius: 4 },
    thead: {},
    th: { padding: space.xs, ...typeScale.sub, fontWeight: "600" },
    tr: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.surfaceEdge, flexDirection: "row" },
    td: { padding: space.xs, ...typeScale.sub },
  } as const;
}

/** One parsed block. Memoized on text: settled blocks skip streaming flushes. */
const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  const { colors } = useTheme();
  const style = useMemo(() => markdownStyles(colors), [colors]);
  return (
    <MarkdownDisplay markdownit={parser} style={style} rules={rules} onLinkPress={openLink}>
      {text}
    </MarkdownDisplay>
  );
});

/**
 * Assistant markdown. Block index is a stable key: streaming only ever
 * appends blocks or grows the last one, so earlier indices never re-bind.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(text), [text]);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: space.sm },
  fence: {
    alignSelf: "stretch",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    marginTop: space.xs,
  },
  fenceHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: space.md,
    paddingRight: space.sm,
    paddingTop: space.sm,
  },
  fenceCopy: { minHeight: 28, paddingHorizontal: space.xs },
  fenceScroll: { paddingHorizontal: space.md, paddingBottom: space.md, paddingTop: space.xs },
});
