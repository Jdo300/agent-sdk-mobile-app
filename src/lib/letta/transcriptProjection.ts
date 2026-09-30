/**
 * Projection from the SDK's transcript rows into this app's render vocabulary.
 *
 * Row identity, delta accumulation, replay suppression and backfill merging are
 * the accumulator's job (letta-agent-sdk#274). What is left — and what lives
 * here — is presentation: which row carries the caret, how a think's duration
 * reads, and the two tool states only the approval flow knows about. Pure, so
 * the mapping is testable without a session.
 */
import type { TranscriptRow } from "@letta-ai/letta-agent-sdk/client";

import type { ToolStatus, TranscriptItem } from "./model";
import { cleanUserText, formatToolInput, summarizeToolInput } from "./toolText";

export interface ProjectionState {
  /** Assistant row currently being written, if any. Kept separate from reasoning. */
  liveKey: string | null;
  /** Trailing reasoning row while the device is actively processing. */
  liveReasoningKey: string | null;
  /** Row a turn abandoned — rendered "Stopped". */
  interruptedKey: string | null;
  /** awaiting_approval / denied, which no wire status expresses. */
  toolStatusOverride: ReadonlyMap<string, ToolStatus>;
  thinkStartedAt: ReadonlyMap<string, number>;
  thinkSeconds: ReadonlyMap<string, number>;
  toolDurationMs: ReadonlyMap<string, number>;
  rowOccurredAt: ReadonlyMap<string, number>;
  toolCompletedAt: ReadonlyMap<string, number>;
}

export function projectRow(row: TranscriptRow, state: ProjectionState): TranscriptItem {
  const live = row.key === state.liveKey;
  const liveReasoning = row.key === state.liveReasoningKey;

  if (row.kind === "tool_call") {
    const override = state.toolStatusOverride.get(row.toolCallId);
    const settled = row.status === "complete";
    const duration = state.toolDurationMs.get(row.toolCallId);
    return {
      kind: "tool",
      id: row.key,
      toolCallId: row.toolCallId,
      name: row.toolName,
      summary: summarizeToolInput(row.toolInput, row.toolName),
      input: formatToolInput(row.toolInput),
      // A denial is the user-meaningful terminal state and outranks the error
      // tool_result the server sends after it.
      status: override ?? (settled ? (row.result?.isError ? "error" : "success") : "running"),
      ...(row.result ? { result: row.result.content } : {}),
      ...(duration !== undefined ? { durationMs: duration } : {}),
      ...(state.rowOccurredAt.has(row.key) ? { occurredAt: state.rowOccurredAt.get(row.key)! } : {}),
      ...(state.toolCompletedAt.has(row.toolCallId) ? { completedAt: state.toolCompletedAt.get(row.toolCallId)! } : {}),
    };
  }

  if (row.kind === "reasoning") {
    const startedAt = state.thinkStartedAt.get(row.key);
    return {
      kind: "reasoning",
      id: row.key,
      ...(row.runId ? { runId: row.runId } : {}),
      text: row.text,
      seconds: state.thinkSeconds.get(row.key) ?? 0,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(liveReasoning ? { streaming: true } : {}),
      ...(state.rowOccurredAt.has(row.key) ? { occurredAt: state.rowOccurredAt.get(row.key)! } : {}),
    };
  }

  if (row.kind === "assistant") {
    return {
      kind: "assistant",
      id: row.key,
      text: row.text,
      ...(live ? { streaming: true } : {}),
      ...(state.interruptedKey === row.key ? { interrupted: true } : {}),
      ...(state.rowOccurredAt.has(row.key) ? { occurredAt: state.rowOccurredAt.get(row.key)! } : {}),
    };
  }

  // User rows arrive from history and from the stream's own echo; strip the
  // system-reminder wrappers the wire carries either way.
  return {
    kind: "user",
    id: row.key,
    text: cleanUserText(row.text),
    ...(state.rowOccurredAt.has(row.key) ? { occurredAt: state.rowOccurredAt.get(row.key)! } : {}),
  };
}

export function projectRows(
  rows: readonly TranscriptRow[],
  state: ProjectionState,
): TranscriptItem[] {
  return rows.map((row) => projectRow(row, state));
}

/** Newest text row — the one an abrupt end leaves unfinished. */
/** OTIDs that belong to actual user rows, not other rows in the same turn. */
export function userRowOtids(rows: readonly TranscriptRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.kind === "user")
      .map((row) => row.otid)
      .filter(Boolean) as string[],
  );
}

export function newestTextKey(rows: readonly TranscriptRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.kind === "assistant" || row.kind === "reasoning") return row.key;
  }
  return null;
}

/**
 * Text is actively streaming only while a text row is the transcript's live edge.
 * Once a tool row arrives after assistant prose, that prose is complete even if
 * the overall Letta run continues. Treating the newest text anywhere in the run
 * as live keeps finished assistant messages falsely streaming through tool work.
 */
export function liveTextKeyAtEdge(rows: readonly TranscriptRow[]): string | null {
  const row = rows[rows.length - 1];
  return row && (row.kind === "assistant" || row.kind === "reasoning") ? row.key : null;
}

/**
 * The assistant live key intentionally stays disabled for persisted history so
 * TTS never mistakes already-complete prose for an in-flight message. Reasoning
 * needs a different rule: while the device is processing, the trailing
 * reasoning row is live so its elapsed timer continues to tick.
 */
export function liveReasoningKeyAtEdge(
  rows: readonly TranscriptRow[],
  active: boolean,
): string | null {
  if (!active) return null;
  const row = rows[rows.length - 1];
  return row?.kind === "reasoning" ? row.key : null;
}
