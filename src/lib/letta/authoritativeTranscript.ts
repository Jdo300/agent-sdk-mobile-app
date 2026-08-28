/**
 * Rebuild transcript state from persisted history only.
 *
 * The SDK accumulator correctly coalesces live deltas, but anonymous
 * content-block deltas have a synthetic live identity. Once the App Server
 * persists that content under its UUID, a merge-style rebase cannot prove the
 * two rows are the same. A fresh accumulator is therefore the authoritative
 * handoff only during reconnect catch-up, after the executing device reports
 * idle. Healthy live runs retain their existing accumulator.
 */
import {
  createTranscriptAccumulator,
  type TranscriptAccumulator,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk/client";

/**
 * Whether a persisted rebuild is safe to hand off to in place of live rows.
 *
 * Stream identities and persisted UUIDs can differ, so identity alone cannot
 * establish this. Every non-empty text row must instead have an equivalent
 * persisted row, and every tool row must retain its call identity and terminal
 * state. Matching consumes a candidate row: two identical assistant messages
 * need two persisted copies, rather than one copy accidentally covering both.
 */
export function authoritativeRowsCoverCurrent(
  current: readonly TranscriptRow[],
  candidate: readonly TranscriptRow[],
): boolean {
  const available = [...candidate];
  for (const row of current) {
    if (!isMeaningfulRow(row)) continue;
    const match = available.findIndex((next) => rowIsCoveredBy(row, next));
    if (match < 0) return false;
    available.splice(match, 1);
  }
  return true;
}

function isMeaningfulRow(row: TranscriptRow): boolean {
  return row.kind === "tool_call" || row.text.length > 0;
}

function rowIsCoveredBy(current: TranscriptRow, candidate: TranscriptRow): boolean {
  if (current.kind !== candidate.kind) return false;
  if (current.kind !== "tool_call" && candidate.kind !== "tool_call") {
    return current.text === candidate.text;
  }
  if (current.kind !== "tool_call" || candidate.kind !== "tool_call") return false;
  if (current.toolCallId !== candidate.toolCallId) return false;
  // A completed live tool row must never regress to a call whose return has
  // not reached persisted history yet.
  return current.status !== "complete" || candidate.status === "complete";
}

export function rebuildAuthoritativeTranscript(
  messages: readonly unknown[],
): TranscriptAccumulator {
  const accumulator = createTranscriptAccumulator();
  accumulator.rebase({ messages: messages as never }, { order: "asc" });
  return accumulator;
}
