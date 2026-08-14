/**
 * Approval card — replaces the composer while a `can_use_tool` control request
 * is pending (docs/design-doc.md §4.4). The full input is one tap away (the
 * user is deciding on this payload) and the card holds its submitting state
 * until the session confirms the decision left the device.
 */
import { useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";

import type { ApprovalRequest } from "../../lib/letta/model";
import { haptic } from "../../lib/haptics";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { useCopyFeedback } from "./Markdown";

interface Props {
  request: ApprovalRequest;
  /** 1-based position and total when multiple approvals are pending. */
  position?: { index: number; total: number };
  /** Where the tool would run — approval context the input alone can't show. */
  cwd?: string | null;
  submitting?: "allow" | "deny";
  onAllow: (reason?: string) => void;
  onDeny: (reason?: string) => void;
  /** Accept a server permission suggestion: allow + persist the rule. */
  onAcceptSuggestion?: (suggestionId: string) => void;
}

export function ApprovalCard({ request, position, cwd, submitting, onAllow, onDeny, onAcceptSuggestion }: Props) {
  const { colors } = useTheme();
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);
  const { copied, copy } = useCopyFeedback(request.input);
  // Recovered from the device without a live resolver: the decision can't be
  // routed anywhere yet, so the card explains instead of offering dead buttons.
  const busy = submitting !== undefined || request.unresolvable === true;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
      <View style={styles.head}>
        <Text role="micro" tone="wait">
          Approval{position && position.total > 1 ? ` · ${position.index} of ${position.total}` : ""}
        </Text>
      </View>
      <Text role="bodyEm">{request.summary}</Text>
      {request.unresolvable ? (
        <Text role="sub" ink={2}>
          This approval is still pending on {cwd ? "that device" : "the device"} from an earlier
          session — reconnecting to take it over.
        </Text>
      ) : null}
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={expanded ? "Collapse tool input" : "Show full tool input"}
        accessibilityHint="Long press to copy"
        onPress={() => setExpanded((v) => !v)}
        onLongPress={copy}
        scaleOnPress={false}
        style={styles.inputPreview}
      >
        {expanded ? (
          <ScrollView style={styles.inputScroll} nestedScrollEnabled>
            <Text role="sub" ink={2} mono selectable>
              {request.input}
            </Text>
          </ScrollView>
        ) : (
          <Text role="sub" ink={2} mono numberOfLines={2}>
            {request.input}
          </Text>
        )}
        <Text role="micro" ink={3}>
          {copied ? "copied ✓" : expanded ? "show less ▾" : "show all ›"}
        </Text>
      </Touchable>
      {cwd ? (
        <Text role="sub" ink={3} mono numberOfLines={1}>
          cwd: {cwd}
        </Text>
      ) : null}
      {request.permissionSuggestions.length > 0 && onAcceptSuggestion ? (
        <View style={styles.suggestions}>
          {request.permissionSuggestions.map((suggestion) => (
            <Touchable
              key={suggestion.id}
              accessibilityRole="button"
              accessibilityLabel={`Allow and remember: ${suggestion.text}`}
              disabled={busy}
              onPress={() => {
                haptic.approve();
                onAcceptSuggestion(suggestion.id);
              }}
              style={[styles.suggestion, { borderColor: colors.surfaceEdge }]}
            >
              <Text role="sub" tone="accent" numberOfLines={2}>
                ✓ {suggestion.text}
              </Text>
            </Touchable>
          ))}
        </View>
      ) : null}
      <TextInput
        placeholder="Reason (optional)"
        placeholderTextColor={colors.ink3}
        value={reason}
        onChangeText={setReason}
        editable={!busy}
        style={[styles.reason, { color: colors.ink, borderColor: colors.surfaceEdge }]}
      />
      <View style={styles.actions}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Deny"
          disabled={busy}
          onPress={() => {
            haptic.deny();
            onDeny(reason || undefined);
          }}
          style={[styles.deny, { borderColor: colors.surfaceEdge, opacity: busy && submitting !== "deny" ? 0.5 : 1 }]}
        >
          <Text role="bodyEm" tone="danger" style={styles.actionLabel}>
            {submitting === "deny" ? "Denying…" : "Deny"}
          </Text>
        </Touchable>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Allow"
          disabled={busy}
          onPress={() => {
            haptic.approve();
            onAllow(reason || undefined);
          }}
          style={[styles.allow, { backgroundColor: colors.accent, opacity: busy && submitting !== "allow" ? 0.5 : 1 }]}
        >
          <Text role="bodyEm" style={[styles.actionLabel, styles.allowLabel]}>
            {submitting === "allow" ? "Allowing…" : "Allow"}
          </Text>
        </Touchable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sheet - 8,
    padding: space.lg,
    gap: space.sm,
  },
  head: { flexDirection: "row" },
  suggestions: { gap: space.sm },
  suggestion: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    minHeight: 40,
  },
  inputPreview: { minHeight: 0, paddingVertical: 2, gap: 4 },
  inputScroll: { maxHeight: 220 },
  reason: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 8,
    fontSize: 15,
  },
  actions: { flexDirection: "row", gap: space.md, marginTop: space.xs },
  deny: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    alignItems: "center",
  },
  allow: { flex: 2, borderRadius: radius.row, alignItems: "center" },
  actionLabel: { paddingVertical: 12 },
  allowLabel: { color: "#FFFFFF" },
});
