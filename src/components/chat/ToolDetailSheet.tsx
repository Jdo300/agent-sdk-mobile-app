/**
 * Tool detail sheet (docs/design-doc.md §3, §4.5): the full input/result
 * payloads behind a ToolCard. Payloads are capped per section (the references
 * clamp the same way — litter 2000 chars per section) with a Show more toggle;
 * a running tool shows the tail of its output, a settled one the head.
 * Edit-shaped inputs and unified-diff-shaped text render as a colored diff.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { diffFromEditInput, isUnifiedDiff } from "../../lib/diff";
import type { ToolItem } from "../../lib/letta/model";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { DiffBlock } from "./DiffBlock";
import { useCopyFeedback } from "./Markdown";

const PAYLOAD_CAP = 2000;

const statusLabel: Record<ToolItem["status"], string> = {
  pending: "Pending",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  success: "Success",
  denied: "Denied",
  error: "Error",
};

function PayloadSection({ label, text, tail }: { label: string; text: string; tail: boolean }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopyFeedback(text);
  const diff = isUnifiedDiff(text) ? text : diffFromEditInput(text);
  const body = diff ?? text;
  const truncated = body.length > PAYLOAD_CAP;
  const shown =
    !truncated || expanded
      ? body
      : tail
        ? `…${body.slice(-PAYLOAD_CAP)}`
        : `${body.slice(0, PAYLOAD_CAP)}…`;
  return (
    <View style={[styles.section, { borderColor: colors.surfaceEdge }]}>
      <View style={styles.sectionHead}>
        <Text role="micro" ink={3}>
          {label}
        </Text>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}
          onPress={copy}
          style={styles.sectionCopy}
        >
          <Text role="micro" ink={copied ? 2 : 3}>
            {copied ? "copied ✓" : "copy"}
          </Text>
        </Touchable>
      </View>
      {diff ? (
        <DiffBlock text={shown} />
      ) : (
        <Text role="sub" ink={2} mono selectable>
          {shown}
        </Text>
      )}
      {truncated ? (
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Show less ${label.toLowerCase()}` : `Show all ${label.toLowerCase()}`}
          onPress={() => setExpanded((v) => !v)}
          style={styles.showMore}
        >
          <Text role="sub" tone="accent">
            {expanded ? "Show less" : `Show all (${body.length.toLocaleString()} chars)`}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

export const ToolDetailSheet = forwardRef<BottomSheetModal, { tool: ToolItem | null }>(
  function ToolDetailSheet({ tool }, ref) {
    const active = tool?.status === "pending" || tool?.status === "running";
    return (
      <Sheet ref={ref} scroll title={tool?.name ?? "Tool"}>
        {tool ? (
          <>
            <View style={styles.metaRow}>
              <Text
                role="sub"
                tone={
                  tool.status === "error" || tool.status === "denied"
                    ? "danger"
                    : tool.status === "awaiting_approval"
                      ? "wait"
                      : tool.status === "success"
                        ? "run"
                        : undefined
                }
                ink={2}
              >
                {statusLabel[tool.status]}
              </Text>
              {tool.durationMs !== undefined ? (
                <Text role="sub" ink={3}>
                  · {(tool.durationMs / 1000).toFixed(1)}s
                </Text>
              ) : null}
            </View>
            {/* Keyed per call so Show more state never leaks across tools. */}
            <PayloadSection key={`${tool.id}-in`} label="Input" text={tool.input ?? tool.summary} tail={false} />
            {tool.result ? (
              <PayloadSection
                key={`${tool.id}-out`}
                label={active ? "Output so far" : "Output"}
                text={tool.result}
                tail={active}
              />
            ) : (
              <Text role="sub" ink={3}>
                {active ? "No output yet." : "No output."}
              </Text>
            )}
          </>
        ) : null}
      </Sheet>
    );
  },
);

const styles = StyleSheet.create({
  metaRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  section: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: space.xs,
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginRight: -space.xs,
  },
  sectionCopy: { minHeight: 32, paddingHorizontal: space.xs },
  showMore: { minHeight: 32, alignSelf: "flex-start" },
});
