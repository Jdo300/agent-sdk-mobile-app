/**
 * Tool-run grouping — a pure view projection over the transcript.
 *
 * A 30-call exploration turn should not be 30 full-width cards the user
 * scrolls past to reach the prose. Consecutive settled tool calls collapse
 * into one summary row (as paseo, remodex and litter all do); the live call
 * stays standalone so a running turn keeps showing what it is doing.
 */
import type { ReasoningItem, ToolItem, TranscriptItem } from "./model";

/** Summary row standing in for a run of collapsed tool calls. */
export interface ToolGroupItem {
  kind: "toolGroup";
  id: string;
  tools: ToolItem[];
  /** Members that denied or errored — the reason to expand. */
  failed: number;
  expanded: boolean;
}

export type TranscriptRowItem = TranscriptItem | ToolGroupItem;

/** Below this a run reads fine as individual cards; collapsing would hide more than it saves. */
const MIN_RUN = 3;

function isSettledTool(item: TranscriptItem): item is ToolItem {
  return (
    item.kind === "tool" &&
    (item.status === "success" || item.status === "denied" || item.status === "error")
  );
}

function joinReasoningText(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left}${left.endsWith("\n") || right.startsWith("\n") ? "" : "\n"}${right}`;
}

/**
 * App Server history may persist one continuous reasoning phase as several
 * adjacent reasoning messages. Keep canonical rows untouched, but present
 * adjacent slices from the same run as one expandable thought in the UI.
 */
export function coalesceReasoningRuns(transcript: readonly TranscriptItem[]): TranscriptItem[] {
  const rows: TranscriptItem[] = [];
  for (const item of transcript) {
    const previous = rows[rows.length - 1];
    if (
      item.kind === "reasoning" &&
      previous?.kind === "reasoning" &&
      item.runId &&
      previous.runId === item.runId
    ) {
      const left = previous as ReasoningItem;
      const right = item as ReasoningItem;
      const starts = [left.startedAt, right.startedAt].filter((v): v is number => v !== undefined);
      rows[rows.length - 1] = {
        ...left,
        text: joinReasoningText(left.text, right.text),
        seconds: left.seconds + right.seconds,
        ...(starts.length > 0 ? { startedAt: Math.min(...starts) } : {}),
        ...((left.streaming || right.streaming) ? { streaming: true } : { streaming: undefined }),
        ...(left.occurredAt !== undefined ? { occurredAt: left.occurredAt } : right.occurredAt !== undefined ? { occurredAt: right.occurredAt } : {}),
      };
      continue;
    }
    rows.push(item);
  }
  return rows;
}

export function groupToolRuns(
  transcript: TranscriptItem[],
  expandedIds: ReadonlySet<string>,
): TranscriptRowItem[] {
  const rows: TranscriptRowItem[] = [];
  let run: ToolItem[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length < MIN_RUN) {
      rows.push(...run);
    } else {
      // Keyed off the first member so the id is stable as the run grows.
      const id = `toolgroup-${run[0]!.id}`;
      const expanded = expandedIds.has(id);
      rows.push({
        kind: "toolGroup",
        id,
        tools: run,
        failed: run.filter((t) => t.status === "error" || t.status === "denied").length,
        expanded,
      });
      if (expanded) rows.push(...run);
    }
    run = [];
  };

  for (const item of coalesceReasoningRuns(transcript)) {
    if (isSettledTool(item)) {
      run.push(item);
      continue;
    }
    // Anything else (prose, reasoning, a still-running call) ends the run.
    flush();
    rows.push(item);
  }
  flush();

  return rows;
}
