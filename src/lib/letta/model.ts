/**
 * App-level domain model for a Letta conversation.
 *
 * These types are the seam between the UI and the transport. The mock session
 * (milestone 2) and the real Agent SDK session (milestone 6) both produce this
 * vocabulary, so every component can be built and reviewed against fixtures
 * before a single live turn runs. Names deliberately mirror the SDK / wire
 * protocol (docs/design-doc.md §6, Appendix A).
 */
import type {
  CanUseToolPermissionSuggestion,
  PermissionMode,
  SessionDeviceStatus,
} from "@letta-ai/letta-agent-sdk/client";

// Re-exported so UI components depend on the app's domain module, but the
// definitions are the SDK's — no drift.
export type { PermissionMode };

export type RunPhase = "idle" | "running" | "awaiting_approval" | "aborting";

export type ConnectionPhase =
  | "connected"
  | "reconnecting"
  | "reconciling"
  | "offline"
  | "auth_failed";

export interface UserItem {
  kind: "user";
  id: string;
  text: string;
  /** Local uris of images sent with this message (echo only; history has none). */
  images?: string[];
  /** Local echo until the server confirms the message. */
  pending?: boolean;
  failed?: boolean;
}

export interface AssistantItem {
  kind: "assistant";
  id: string;
  text: string;
  streaming?: boolean;
  /** Run ended before the assistant finished (abort or error). */
  interrupted?: boolean;
}

export interface ReasoningItem {
  kind: "reasoning";
  id: string;
  /** Full reasoning text, revealed on expand. */
  text: string;
  /** Seconds spent thinking — the settled total once streaming ends. */
  seconds: number;
  /** Wall-clock start of the live think; the row ticks its own elapsed time
   *  from this, independent of delta cadence. */
  startedAt?: number;
  streaming?: boolean;
}

export type ToolStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "success"
  | "denied"
  | "error";

export interface ToolItem {
  kind: "tool";
  id: string;
  /** Wire `tool_call_id` — one card per identity. */
  toolCallId: string;
  name: string;
  /** One-line input/result summary, mono. */
  summary: string;
  status: ToolStatus;
  durationMs?: number;
  /** Full input/result payloads for the detail sheet. */
  input?: string;
  result?: string;
}

export interface ErrorItem {
  kind: "error";
  id: string;
  message: string;
  retryable?: boolean;
}

export type TranscriptItem = UserItem | AssistantItem | ReasoningItem | ToolItem | ErrorItem;

/** Wire `can_use_tool` control request (protocol_v2 CanUseToolControlRequestBody). */
export interface ApprovalRequest {
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** Human-readable one-liner of what the tool wants to do. */
  summary: string;
  /** Full raw input, shown in the detail sheet. */
  input: string;
  permissionSuggestions: CanUseToolPermissionSuggestion[];
  /**
   * The device reports this approval as pending but we hold no resolver for it
   * (it outlived the process that asked). Shown read-only until
   * recoverPendingApprovals() re-delivers it with a live resolver.
   */
  unresolvable?: boolean;
}

export interface QueueItem {
  id: string;
  text: string;
  /** Mutation sent, awaiting the server's `update_queue`. */
  pendingRemoval?: boolean;
}

/** The slice of live device status the UI renders — SDK-derived, no drift. */
export type DeviceState = Pick<
  SessionDeviceStatus,
  "permissionMode" | "workingDirectory" | "memoryDirectory"
>;

export interface ChatSnapshot {
  transcript: TranscriptItem[];
  run: RunPhase;
  connection: ConnectionPhase;
  queue: QueueItem[];
  approvals: ApprovalRequest[];
  /** Live device state once a session is active; null before that. */
  device: DeviceState | null;
  /** True while history/runtime state loads. */
  hydrating: boolean;
  /** Older history pages exist beyond the loaded transcript. */
  hasMore: boolean;
  /** An older-page fetch is in flight (spinner at the visual top). */
  loadingOlder: boolean;
}

export const emptyChat: ChatSnapshot = {
  transcript: [],
  run: "idle",
  connection: "connected",
  queue: [],
  approvals: [],
  device: null,
  hydrating: false,
  hasMore: false,
  loadingOlder: false,
};
