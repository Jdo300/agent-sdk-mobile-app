import type { SDKMessage } from "@letta-ai/letta-agent-sdk/client";

export type SyncTelemetryKind =
  | "protocol_gap"
  | "protocol_replay"
  | "protocol_identity_missing"
  | "sync_stale_discard"
  | "sync_converged"
  | "sync_retry";

export interface SyncTelemetryEvent {
  kind: SyncTelemetryKind;
  conversationId: string;
  generation?: number;
  runId?: string;
  seqId?: number;
  previousSeqId?: number;
  attempt?: number;
  count?: number;
  reason?: string;
}

/** No message contents, tool input, URLs, tokens, or secrets are accepted here. */
export function emitSyncTelemetry(event: SyncTelemetryEvent): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) console.info("[bloop-sync]", event);
}

export interface ProtocolObservation {
  accept: boolean;
  events: Omit<SyncTelemetryEvent, "conversationId">[];
}

/**
 * Observes SDK ordering metadata without replacing the SDK accumulator. Replay
 * and gap observations are telemetry only: the SDK remains the sole owner of
 * replay suppression and transcript accumulation.
 */
export class ProtocolObserver {
  private readonly highestSeqByRun = new Map<string, number>();

  observe(message: SDKMessage): ProtocolObservation {
    const events: Omit<SyncTelemetryEvent, "conversationId">[] = [];
    const meta = protocolMeta(message);
    if (!meta) return { accept: true, events };

    if (meta.visible && !meta.uuid) {
      events.push({ kind: "protocol_identity_missing", runId: meta.runId, seqId: meta.seqId, reason: "uuid" });
    }
    if (meta.visible && (!meta.runId || meta.seqId === undefined)) {
      events.push({
        kind: "protocol_identity_missing",
        runId: meta.runId,
        seqId: meta.seqId,
        reason: !meta.runId ? "run_id" : "seq_id",
      });
    }

    if (!meta.runId || meta.seqId === undefined || !meta.sequenceAuthoritative) return { accept: true, events };
    const previous = this.highestSeqByRun.get(meta.runId);
    if (previous !== undefined) {
      if (meta.seqId <= previous) {
        events.push({ kind: "protocol_replay", runId: meta.runId, seqId: meta.seqId, previousSeqId: previous });
        return { accept: true, events };
      }
      if (meta.seqId > previous + 1) {
        events.push({ kind: "protocol_gap", runId: meta.runId, seqId: meta.seqId, previousSeqId: previous });
      }
    }
    this.highestSeqByRun.set(meta.runId, meta.seqId);
    return { accept: true, events };
  }
}

function protocolMeta(message: SDKMessage): {
  visible: boolean;
  uuid?: string;
  runId?: string;
  seqId?: number;
  sequenceAuthoritative?: boolean;
} | null {
  switch (message.type) {
    case "assistant":
    case "reasoning":
      return { visible: true, uuid: message.uuid, runId: message.runId, seqId: message.seqId, sequenceAuthoritative: false };
    case "tool_call":
    case "tool_result":
      return { visible: true, uuid: message.uuid, runId: message.runId, sequenceAuthoritative: false };
    case "stream_event": { // raw event metadata is authoritative when present
      const event = message.event as { run_id?: unknown; seq_id?: unknown; id?: unknown; message_type?: unknown };
      return {
        visible: typeof event.message_type === "string",
        uuid: typeof event.id === "string" ? event.id : message.uuid,
        runId: typeof event.run_id === "string" ? event.run_id : undefined,
        seqId: typeof event.seq_id === "number" ? event.seq_id : undefined,
        sequenceAuthoritative: true,
      };
    }
    default:
      return null;
  }
}


export interface PersistedHistoryObservation {
  visibleCount: number;
  missingIdCount: number;
  duplicateIdCount: number;
}

/** Validate identity metadata only; never inspects or emits message content. */
export function inspectPersistedHistory(messages: readonly unknown[]): PersistedHistoryObservation {
  const ids = new Set<string>();
  let visibleCount = 0;
  let missingIdCount = 0;
  let duplicateIdCount = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { id?: unknown; message_type?: unknown };
    if (typeof record.message_type !== "string") continue;
    visibleCount += 1;
    if (typeof record.id !== "string" || record.id.length === 0) {
      missingIdCount += 1;
      continue;
    }
    if (ids.has(record.id)) duplicateIdCount += 1;
    else ids.add(record.id);
  }
  return { visibleCount, missingIdCount, duplicateIdCount };
}

/** Async sync callbacks may mutate state only in the lifecycle generation that spawned them. */
export function isGenerationCurrent(captured: number, active: number): boolean {
  return captured === active;
}
