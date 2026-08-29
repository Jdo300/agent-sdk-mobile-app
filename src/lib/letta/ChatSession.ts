/**
 * ChatSession — the bridge between the Agent SDK and the UI's ChatSnapshot.
 *
 * This is the file to read to learn the SDK: it opens a session for a
 * conversation (cloud or remote), hydrates history via listMessages(),
 * consumes the session.stream() generator, and reduces every SDKMessage into
 * the same immutable snapshot vocabulary the mock transport produces — so the
 * UI can't tell them apart. State is server-authoritative throughout: run
 * phase, queue order, and errors all come from the stream, never local guesses.
 */
import type {
  TranscriptAccumulator,
  TranscriptRow,
  CanUseToolContext,
  CanUseToolPermissionSuggestion,
  LettaCodeSession,
  SDKMessage,
  SessionDeviceStatus,
} from "@letta-ai/letta-agent-sdk/client";
import { createTranscriptAccumulator } from "@letta-ai/letta-agent-sdk/client";

import { toImageContent, type Attachment } from "./attachments";
import type { Profile } from "../profiles/profiles";
import { getConversationModel, getConversationStaticDiagnostics, isAuthError, listConversationMessages, sdkClient, type ConversationDiagnostics } from "./api";
import { emptyChat, type ApprovalRequest, type ChatSnapshot, type PermissionMode, type ToolStatus, type TranscriptItem } from "./model";
import { patch } from "./mockSession";
import { contentToText, formatToolInput } from "./toolText";
import { liveTextKeyAtEdge, newestTextKey, projectRows, userRowOtids, type ProjectionState } from "./transcriptProjection";
import { authoritativeRowsCoverCurrent, rebuildAuthoritativeTranscript } from "./authoritativeTranscript";
import { isAuthoritativeCatchUpCurrent, shouldReconnectSilentSend, shouldWaitForAuthoritativeIdle } from "./authoritativeCatchUp";
import {
  emitSyncTelemetry,
  inspectPersistedHistory,
  isGenerationCurrent,
  outboxRecoveryAction,
  ProtocolObserver,
  syncConvergenceState,
} from "./protocolHardening";
import {
  loadDurableConversation,
  putDurableOutbox,
  removeDurableOutbox,
  retirePersistedOutboxEchoes,
  saveDurableCanonicalWindow,
  updateDurableOutboxState,
  type DurableOutboxItem,
} from "./durableChatStore";
import { mergeForwardMessages, newestDurableMessageId } from "./durableSyncCore";

export type SnapshotListener = (snapshot: ChatSnapshot) => void;

/**
 * Steady-state delta flush interval. Wire chunks arrive far faster than the
 * UI can usefully paint them; committing each one re-renders every visible
 * row. The references coalesce the same way (remodex 80ms steady tier,
 * paseo 48ms) — the first delta of a burst still commits immediately.
 */
const STREAM_FLUSH_MS = 80;

/**
 * How long a resolved approval waits for evidence the decision reached the
 * server. The SDK sends the approval_response fire-and-forget, so subsequent
 * stream traffic is the closest confirmation available (paseo's
 * respondToPermissionAndWait uses the same 15s bound).
 */
const APPROVAL_CONFIRM_TIMEOUT_MS = 15000;

/**
 * How long a reconnect may run before it announces itself. A resume resync
 * usually settles in well under this, and flashing "Reconnecting…" over a
 * healthy screen on every app switch reads as flakiness (paseo gates resume
 * revalidation the same way).
 */
const RECONNECT_BANNER_DELAY_MS = 400;
const ABORT_ACK_TIMEOUT_MS = 2000;
const ABORT_CONFIRM_TIMEOUT_MS = 5000;
const ABORT_CONFIRM_INTERVAL_MS = 250;
const AUTHORITATIVE_PAGE_SIZE = 50;
const AUTHORITATIVE_MAX_PAGES = 8;
const FORWARD_SYNC_MAX_PAGES = 100;
const RECONNECT_RETRY_BASE_MS = 1000;
const RECONNECT_RETRY_MAX_MS = 5000;
const AUTHORITATIVE_CATCHUP_MAX_MS = 30000;
const AUTHORITATIVE_CATCHUP_BACKOFF_BASE_MS = 250;
const AUTHORITATIVE_CATCHUP_BACKOFF_MAX_MS = 4000;
const SEND_STREAM_ACTIVITY_TIMEOUT_MS = 5000;

/** A transport loss does not imply the server-side run stopped. */
function preserveRunAcrossTransportLoss(run: ChatSnapshot["run"]): ChatSnapshot["run"] {
  return run === "running" || run === "awaiting_approval" || run === "aborting" ? run : "idle";
}

/**
 * Live activity for conversations this device currently has open, so list rows
 * can show a running / needs-you dot. Deliberately device-local: the server's
 * conversation records carry no run state, so a row is only ever marked from a
 * session this app opened (references scope it the same way).
 */
export type ConversationActivity = "running" | "awaiting_approval";

const activityByConversation = new Map<string, ConversationActivity>();
const activityListeners = new Set<() => void>();

/**
 * Screen navigation must not own the execution lifetime. A conversation can keep
 * running while no ChatScreen is mounted, so active sessions are retained here
 * until their server-authoritative run settles. Reopening the same conversation
 * simply reattaches a view to the existing stream/snapshot.
 */
const retainedChatSessions = new Map<string, ChatSession>();

/** App-level lifecycle hook: one foreground event repairs every retained chat. */
export async function reconnectRetainedChatSessions(): Promise<void> {
  await Promise.allSettled(
    [...retainedChatSessions.values()].map((session) => session.reconnect()),
  );
}

function retainedSessionKey(profileId: string, conversationId: string): string {
  return `${profileId}:${conversationId}`;
}

function publishActivity(conversationId: string, activity: ConversationActivity | null): void {
  const previous = activityByConversation.get(conversationId) ?? null;
  if (previous === activity) return;
  if (activity) activityByConversation.set(conversationId, activity);
  else activityByConversation.delete(conversationId);
  for (const listener of activityListeners) listener();
}

export function conversationActivity(conversationId: string): ConversationActivity | null {
  return activityByConversation.get(conversationId) ?? null;
}

/** Subscribe to activity changes; returns an unsubscribe. */
export function subscribeConversationActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export class ChatSession {
  private conn: { profile: Profile; secret: string };
  private conversationId: string;
  private session: LettaCodeSession | null = null;
  private snapshot: ChatSnapshot;
  private listeners = new Set<SnapshotListener>();
  private closed = false;
  /** Number of mounted ChatScreen views currently attached to this session. */
  private viewRefs = 0;
  private readonly retainedKey: string;
  /** Set when the stream errored terminally; reconnect() replaces the session. */
  private sessionDead = false;
  /**
   * Row identity, delta accumulation, replay suppression and backfill merging
   * all belong to the SDK's accumulator (letta-agent-sdk#274). What stays here
   * is presentation: which row is live, how long a think took, tool statuses the
   * approval flow owns, and rows the server has never seen.
   */
  private accumulator: TranscriptAccumulator = createTranscriptAccumulator();
  /**
   * Rows no server message can produce (an echo still in flight, an error),
   * each anchored to the number of accumulator rows that existed when it was
   * created — so it renders where it happened instead of floating to the end
   * once the reply streams in.
   */
  private localRows: { anchor: number; item: TranscriptItem }[] = [];
  /** OTIDs used only to project/retire optimistic user bubbles. */
  private echoOtids = new Set<string>();
  /** OTIDs that still lack a persisted user-message UUID acknowledgement. */
  private unacknowledgedOtids = new Set<string>();
  /** Reasoning think time, keyed by accumulator row key. */
  private thinkStartedAt = new Map<string, number>();
  private thinkSeconds = new Map<string, number>();
  private toolStartedAt = new Map<string, number>();
  private toolDurationMs = new Map<string, number>();
  /** Stable display timestamps, keyed by accumulator row / tool call identity. */
  private rowOccurredAt = new Map<string, number>();
  private toolCompletedAt = new Map<string, number>();
  /** awaiting_approval / denied — states only the approval flow knows about. */
  private toolStatusOverride = new Map<string, ToolStatus>();
  /** Row the last turn left unfinished, rendered as "Stopped". */
  private interruptedKey: string | null = null;
  /** App preference re-applied whenever a suspended transport is recreated. */
  private preferredPermissionMode: PermissionMode | null = null;
  /**
   * Last authoritative processing state reported by the executing device.
   * Loop-status messages describe the attached viewer's loop bookkeeping and can
   * transiently say WAITING_ON_INPUT immediately after a resume even while the
   * server-side device is still processing the existing turn.
   */
  private deviceIsProcessing = false;
  /** Cursor to the next older history page. */
  private nextBefore: string | null = null;
  /** Raw persisted history currently loaded in the transcript, oldest first. */
  private loadedHistoryMessages: unknown[] = [];
  /** Durable forward cursor: newest server UUID already committed locally. */
  private forwardAfter: string | null = null;
  private durableHydrated = false;
  private pendingStream: SDKMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Foreground, stream-failure and Retry triggers all join one recovery. */
  private reconnectInFlight: Promise<void> | null = null;
  /** Quiet background retry after a transient socket-open failure. */
  private reconnectRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectRetryAttempt = 0;
  /** Cancellation gate for persistence-lag retries after an idle reconnect. */
  private authoritativeCatchUpGeneration = 0;
  /** Lifecycle epoch for every async hydration/paging/reconciliation callback. */
  private reconciliationGeneration = 0;
  private readonly protocolObserver = new ProtocolObserver();
  private streamGeneration = 0;
  /** Incremented for every message observed on the live viewer stream. */
  private streamActivitySerial = 0;
  private sendActivityTimer: ReturnType<typeof setTimeout> | null = null;
  private authoritativeCatchUpTimer: ReturnType<typeof setTimeout> | null = null;
  private authoritativeCatchUpWake: (() => void) | null = null;
  private counter = 0;
  /** Attachments behind pending local echoes, so retry re-sends the images too. */
  private pendingAttachments = new Map<string, Attachment[]>();
  /** User cancellations accepted before the App Server handoff begins. */
  private cancelledLocalOtids = new Set<string>();
  /** Definitely-unsent journal rows recovered after a process restart. */
  private queuedRecoveryTurns: DurableOutboxItem[] = [];
  private approvalResolvers = new Map<
    string,
    (response: { behavior: "allow" } | { behavior: "deny"; message: string }) => void
  >();
  /** Resolved approvals waiting for post-decision stream traffic. */
  private activityWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  private constructor(
    conn: { profile: Profile; secret: string },
    conversationId: string,
    initialPermissionMode?: PermissionMode,
  ) {
    this.conn = conn;
    this.conversationId = conversationId;
    this.retainedKey = retainedSessionKey(conn.profile.id, conversationId);
    this.preferredPermissionMode = initialPermissionMode ?? null;
    this.snapshot = { ...emptyChat, hydrating: true };
  }

  /**
   * Open a chat: history hydrates over REST immediately (free — no execution
   * environment), and the SDK session opens lazily on the first send. Opening
   * a cloud session provisions a sandbox, which is too heavy to pay for just
   * reading a conversation (see SDK-FEEDBACK.md #3).
   */
  static open(
    conn: { profile: Profile; secret: string },
    conversationId: string,
    initialPermissionMode?: PermissionMode,
  ): ChatSession {
    const key = retainedSessionKey(conn.profile.id, conversationId);
    const existing = retainedChatSessions.get(key);
    if (existing && !existing.closed) {
      // Refresh credentials/profile metadata in case the saved connection changed
      // while the screen was away, but preserve the live SDK session and stream.
      existing.conn = conn;
      if (initialPermissionMode) existing.preferredPermissionMode = initialPermissionMode;
      existing.viewRefs += 1;
      return existing;
    }

    const chat = new ChatSession(conn, conversationId, initialPermissionMode);
    chat.viewRefs = 1;
    retainedChatSessions.set(key, chat);
    void chat.hydrate();
    return chat;
  }

  /**
   * Release one mounted chat view without terminating an active Milo turn.
   * The session disposes immediately when idle, or automatically once an
   * unobserved active run later settles.
   */
  releaseView(): void {
    this.viewRefs = Math.max(0, this.viewRefs - 1);
    this.maybeDisposeWhenUnobserved();
  }

  /** Credential already associated with the active authenticated session. */
  authToken(): string {
    return this.conn.secret;
  }

  private maybeDisposeWhenUnobserved(): void {
    if (this.closed || this.viewRefs > 0) return;
    const active =
      this.deviceIsProcessing ||
      this.snapshot.run === "running" ||
      this.snapshot.run === "awaiting_approval" ||
      this.snapshot.run === "aborting";
    if (!active) this.close();
  }

  /** Create the SDK session on demand and start consuming its stream. */
  private ensureSession(): LettaCodeSession {
    if (this.session) return this.session;
    const client = sdkClient(this.conn);
    // Cloud sessions execute in an SDK-managed sandbox (the SDK default).
    // TODO(sdk) BUG: routing to an online environment via
    // resumeSession(id, { environment }) fails against production — cloud-api
    // closes the status socket with 1013 "Listener connection unavailable"
    // when the SDK sends runtime_start, even with the listener online (see
    // SDK-FEEDBACK.md). Re-enable pickCloudEnvironment() once fixed.
    this.session = client.resumeSession(this.conversationId, {
      ...(this.preferredPermissionMode ? { permissionMode: this.preferredPermissionMode } : {}),
      // Tool approvals surface as an ApprovalRequest in the snapshot; the
      // ApprovalCard resolves it via resolveApproval(). The run stays in
      // awaiting_approval until the user decides.
      // TODO(sdk): the callback only receives (toolName, toolInput) — the
      // wire protocol's permission_suggestions, diffs, and tool_call_id
      // never reach it (SDK-FEEDBACK.md #4).
      canUseTool: (toolName, toolInput, context) =>
        this.requestApproval(toolName, toolInput, context),
    });
    // Safe alongside the other first calls: initialize is single-flight since
    // SDK 0.3.2 (#214), and since 0.5.0 (#218) the app-server serves
    // concurrent clients, so nothing here contends for a socket.
    const streamGeneration = ++this.streamGeneration;
    void this.consume(this.session, streamGeneration);
    this.watchDeviceStatus(this.session);
    return this.session;
  }

  /** List agent-scoped secret names without retaining plaintext values.
   * The App Server response necessarily contains values for its native secret
   * editor; Bloop immediately projects it to names so values never enter UI
   * state, logs, transcript, or persistence.
   */
  async listAgentSecretNames(agentId: string): Promise<string[]> {
    const response = await this.ensureSession().sendCommand(
      { type: "secret_list", request_id: this.id("secret-list"), agent_id: agentId },
      { responseType: "secret_list_response", timeoutMs: 15000 },
    );
    if (!response || response.success !== true) {
      throw new Error(typeof response?.error === "string" ? response.error : "Could not load agent secrets.");
    }
    const entries = Array.isArray(response.secrets) ? response.secrets : [];
    return entries
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string"
          ? (entry as { key: string }).key
          : null,
      )
      .filter((key): key is string => Boolean(key))
      .sort((a, b) => a.localeCompare(b));
  }

  /** Atomically add/replace and remove agent-scoped secrets through Letta's
   * native App Server secret store. Values exist only for the duration of this
   * call and are never appended to the conversation.
   */
  async applyAgentSecrets(
    agentId: string,
    set: Record<string, string>,
    unset: string[],
  ): Promise<string[]> {
    const response = await this.ensureSession().sendCommand(
      {
        type: "secret_apply",
        request_id: this.id("secret-apply"),
        agent_id: agentId,
        set,
        unset,
      },
      { responseType: "secret_apply_response", timeoutMs: 15000 },
    );
    if (!response || response.success !== true) {
      throw new Error(typeof response?.error === "string" ? response.error : "Could not update agent secrets.");
    }
    return (Array.isArray(response.names) ? response.names : [])
      .filter((name): name is string => typeof name === "string")
      .sort((a, b) => a.localeCompare(b));
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  current(): ChatSnapshot {
    return this.snapshot;
  }

  private armSendActivityWatch(serialBeforeSend: number): void {
    if (this.sendActivityTimer) clearTimeout(this.sendActivityTimer);
    this.sendActivityTimer = setTimeout(() => {
      this.sendActivityTimer = null;
      if (!shouldReconnectSilentSend({
        closed: this.closed,
        serialBeforeSend,
        currentSerial: this.streamActivitySerial,
        run: this.snapshot.run,
        connection: this.snapshot.connection,
      })) return;
      // The control path accepted the send but the viewer stream stayed silent.
      // Rebuild the transport so the user is not left staring at a frozen echo;
      // authoritative catch-up will converge whatever the server already did.
      void this.reconnect({ forceNewTransport: true });
    }, SEND_STREAM_ACTIVITY_TIMEOUT_MS);
  }

  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    const otid = `echo-${this.conversationId}-${Date.now()}-${this.counter++}`;
    await this.submitDurableTurn({
      profileId: this.conn.profile.id,
      conversationId: this.conversationId,
      otid,
      text,
      attachments,
      state: "queued",
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** Persist first, then submit the exact same OTID on every retry. */
  private async submitDurableTurn(item: DurableOutboxItem): Promise<void> {
    this.advanceReconciliationGeneration();
    this.cancelAuthoritativeCatchUp();
    if (this.snapshot.loadingOlder) this.commit(patch(this.snapshot, { loadingOlder: false }));
    try {
      await putDurableOutbox(item);
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Could not journal message locally.";
      this.commit(this.appendError(this.snapshot, detail));
      return;
    }

    const { otid, text, attachments } = item;
    this.echoOtids.add(otid);
    this.unacknowledgedOtids.add(otid);
    if (!this.localRows.some((row) => row.item.kind === "user" && row.item.id === otid)) {
      this.commit(
        this.appendLocal(this.snapshot, {
          kind: "user",
          id: otid,
          text,
          pending: true,
          cancelable: true,
          occurredAt: item.createdAt,
          ...(attachments.length > 0 ? { images: attachments.map((a) => a.uri) } : {}),
        }),
      );
    } else {
      this.markEcho(otid, { pending: true, cancelable: true, failed: false });
      this.commit(this.project(this.snapshot));
    }
    if (attachments.length > 0) this.pendingAttachments.set(otid, attachments);
    if (this.snapshot.run === "idle") this.commit(patch(this.snapshot, { run: "running" }));

    try {
      // This is the last genuinely cancellable point. Once send() begins the SDK
      // exposes no abort primitive, so remove the Cancel affordance before handoff.
      if (this.cancelledLocalOtids.has(otid)) {
        this.cancelledLocalOtids.delete(otid);
        return;
      }
      this.markEcho(otid, { cancelable: false });
      this.commit(this.project(this.snapshot));
      await updateDurableOutboxState(this.conn.profile.id, this.conversationId, otid, "sending");
      if (this.cancelledLocalOtids.has(otid)) {
        this.cancelledLocalOtids.delete(otid);
        await removeDurableOutbox(this.conn.profile.id, this.conversationId, otid).catch(() => {});
        return;
      }
      const activityBeforeSend = this.streamActivitySerial;
      await this.ensureSession().send(
        attachments.length > 0
          ? [...toImageContent(attachments), ...(text ? [{ type: "text" as const, text }] : [])]
          : text,
        { otid },
      );
      this.armSendActivityWatch(activityBeforeSend);
      await updateDurableOutboxState(this.conn.profile.id, this.conversationId, otid, "awaiting_echo");
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Send failed.";
      await updateDurableOutboxState(this.conn.profile.id, this.conversationId, otid, "failed", detail).catch(() => {});
      const transportFailure = isTransportError(detail);
      this.markEcho(otid, { pending: false, failed: true });
      const next = patch(this.project(this.snapshot), {
        run: "idle" as const,
        ...(transportFailure
          ? { connection: isAuthError(e) ? ("auth_failed" as const) : ("reconnecting" as const) }
          : {}),
      });
      this.commit(transportFailure ? this.scrubTransportErrors(next) : this.appendError(next, detail));
      if (transportFailure && !isAuthError(e)) this.scheduleReconnectRetry();
      return;
    }
    this.pendingAttachments.delete(otid);
    this.markEcho(otid, { pending: false });
    this.commit(this.project(this.snapshot));
  }

  /** Update an in-flight echo in place (pending -> sent, or failed). */
  private markEcho(otid: string, changes: { pending?: boolean; cancelable?: boolean; failed?: boolean }): void {
    this.localRows = this.localRows.map((row) =>
      row.item.kind === "user" && row.item.id === otid
        ? {
            ...row,
            item: {
              ...row.item,
              ...changes,
              ...(changes.pending === false ? { pending: undefined, cancelable: undefined } : {}),
              ...(changes.cancelable === false ? { cancelable: undefined } : {}),
            },
          }
        : row,
    );
  }

  private dropLocalOutgoing(itemId: string): void {
    const items = this.snapshot.transcript;
    const index = items.findIndex((item) => item.id === itemId);
    const pairedErrorId = index >= 0 && items[index + 1]?.kind === "error" ? items[index + 1]!.id : null;
    this.localRows = this.localRows.filter((row) => row.item.id !== itemId && row.item.id !== pairedErrorId);
    this.echoOtids.delete(itemId);
    this.unacknowledgedOtids.delete(itemId);
    this.pendingAttachments.delete(itemId);
    this.queuedRecoveryTurns = this.queuedRecoveryTurns.filter((item) => item.otid !== itemId);
    const projected = this.project(this.snapshot);
    const hasOtherPendingLocalSend = this.localRows.some(
      (row) => row.item.kind === "user" && Boolean(row.item.pending),
    );
    this.commit(
      !this.deviceIsProcessing && !hasOtherPendingLocalSend && projected.run === "running"
        ? patch(projected, { run: "idle" })
        : projected,
    );
  }

  /** Cancel only while the message is still local and handoff has not begun. */
  async cancelPendingSend(itemId: string): Promise<void> {
    const item = this.snapshot.transcript.find((entry) => entry.id === itemId);
    if (!item || item.kind !== "user" || !item.pending || !item.cancelable) return;
    // Set synchronously so submitDurableTurn sees the cancellation after any
    // currently-awaited SQLite operation and before entering SDK send().
    this.cancelledLocalOtids.add(itemId);
    try {
      await removeDurableOutbox(this.conn.profile.id, this.conversationId, itemId);
    } catch {
      this.cancelledLocalOtids.delete(itemId);
      return;
    }
    this.dropLocalOutgoing(itemId);
  }

  /** Explicitly discard a failed local send; server history is untouched. */
  async removeFailedSend(itemId: string): Promise<void> {
    const item = this.snapshot.transcript.find((entry) => entry.id === itemId);
    if (!item || item.kind !== "user" || !item.failed) return;
    await removeDurableOutbox(this.conn.profile.id, this.conversationId, itemId);
    this.dropLocalOutgoing(itemId);
  }

  /** Re-send a failed bubble: drop it (and its error row) and send fresh. */
  async retrySend(itemId: string): Promise<void> {
    const items = this.snapshot.transcript;
    const index = items.findIndex((t) => t.id === itemId);
    const item = items[index];
    if (!item || item.kind !== "user" || !item.failed) return;
    // The error row committed alongside the failure sits right after it. Remove
    // it from local source state as well so project() cannot resurrect it.
    const next = items[index + 1];
    if (next?.kind === "error") {
      this.localRows = this.localRows.filter((row) => row.item.id !== next.id);
    }
    const durable = await loadDurableConversation(this.conn.profile.id, this.conversationId).catch(() => null);
    const saved = durable?.outbox.find((entry) => entry.otid === itemId);
    const images = saved?.attachments ?? this.pendingAttachments.get(itemId) ?? [];
    this.pendingAttachments.delete(itemId);
    await this.submitDurableTurn(saved
      ? { ...saved, state: "queued", error: null, updatedAt: Date.now() }
      : {
          profileId: this.conn.profile.id,
          conversationId: this.conversationId,
          otid: itemId,
          text: item.text,
          attachments: images,
          state: "queued",
          error: null,
          createdAt: item.occurredAt ?? Date.now(),
          updatedAt: Date.now(),
        });
  }

  /** Called by the SDK when a tool needs permission; resolved by the UI. */
  private requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    // SDK 0.3.1 (letta-agent-sdk#210): suggestions, diffs, and the tool call
    // id now arrive with the request, so the card can offer suggestion chips
    // and link itself to its tool row.
    context?: CanUseToolContext,
  ): Promise<{ behavior: "allow"; updatedPermissions?: unknown[] } | { behavior: "deny"; message: string }> {
    const requestId = context?.requestId ?? this.id("approval");
    const request: ApprovalRequest = {
      requestId,
      toolCallId: context?.toolCallId ?? requestId,
      toolName,
      summary: `Run ${toolName}`,
      // The user is deciding on this payload — it must be complete, never the
      // one-line summary (a hidden `&& rm -rf` past a truncation point is the
      // threat model approvals exist for).
      input: formatToolInput(toolInput) ?? JSON.stringify(toolInput),
      permissionSuggestions: (context?.permissionSuggestions ?? []).map((p) => ({
        id: p.id,
        text: p.text,
      })),
    };
    // The originating tool card must stop shimmering while the run is blocked
    // on the user (design-doc.md: awaiting-approval shows on the card, not
    // just in the composer slot the keyboard can cover).
    this.commit(
      patch(this.setToolStatus(this.snapshot, request.toolCallId, "awaiting_approval"), {
        approvals: [...this.snapshot.approvals, request],
        run: "awaiting_approval",
      }),
    );
    return new Promise((resolve) => {
      this.approvalResolvers.set(requestId, resolve);
    });
  }

  /**
   * UI decision for a pending approval. Accepting a server permission
   * suggestion allows the call AND persists the suggested rule via
   * updatedPermissions.
   *
   * The request stays in the snapshot (the card shows its submitting state)
   * until post-decision stream traffic confirms the session is alive, or the
   * confirmation window lapses — the SDK sends the decision fire-and-forget,
   * so this is the only honesty available (design-doc.md §4.4: "the card
   * leaves only on server confirmation").
   */
  async resolveApproval(
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
    acceptedSuggestionId?: string,
  ): Promise<void> {
    const resolve = this.approvalResolvers.get(requestId);
    if (!resolve) return;
    this.approvalResolvers.delete(requestId);
    const request = this.snapshot.approvals.find((a) => a.requestId === requestId);
    if (request) {
      // Duration measures execution, not how long the user deliberated: the
      // clock restarts on allow and is dropped on deny (the tool never ran).
      if (decision === "allow") this.toolStartedAt.set(request.toolCallId, Date.now());
      else this.toolStartedAt.delete(request.toolCallId);
      // The card's status must settle before the decision resolves: a denial
      // still yields an error tool_result, and the reducer keeps "denied"
      // only when it's already painted.
      this.commit(
        this.setToolStatus(this.snapshot, request.toolCallId, decision === "deny" ? "denied" : "running"),
      );
    }
    if (decision === "deny") {
      resolve({ behavior: "deny", message: reason?.trim() || "Denied from the mobile app" });
    } else {
      const suggestion = acceptedSuggestionId
        ? request?.permissionSuggestions.find((p) => p.id === acceptedSuggestionId)
        : undefined;
      resolve({
        behavior: "allow",
        ...(suggestion ? { updatedPermissions: [suggestion satisfies CanUseToolPermissionSuggestion] } : {}),
      });
    }
    let delivered = true;
    try {
      await this.awaitStreamActivity(APPROVAL_CONFIRM_TIMEOUT_MS);
    } catch {
      delivered = false;
    }
    if (this.closed) return;
    const approvals = this.snapshot.approvals.filter((a) => a.requestId !== requestId);
    if (delivered) {
      // The turn may have settled while we waited (loop_status idle is a
      // valid confirmation) — never resurrect "running" over it.
      const run =
        approvals.length > 0
          ? ("awaiting_approval" as const)
          : this.snapshot.run === "awaiting_approval"
            ? ("running" as const)
            : this.snapshot.run;
      this.commit(patch(this.snapshot, { approvals, run }));
      return;
    }
    // The stream died while waiting. Approval recovery is an App Server/SDK
    // concern on reconnect; do not turn transport uncertainty into transcript
    // content. Retire the stale card and preserve the active run until the fresh
    // device status tells us what actually happened.
    this.commit(
      patch(this.scrubTransportErrors(this.snapshot), {
        approvals,
        run: preserveRunAcrossTransportLoss(this.snapshot.run),
        connection: "reconnecting",
      }),
    );
    this.scheduleReconnectRetry();
  }

  /**
   * Settles on the next ingested stream message — any traffic after the
   * decision hand-off proves the socket is alive, the closest confirmation a
   * fire-and-forget approval_response allows. A silent-but-healthy stream
   * (long tool run) settles at the timeout; only a stream error rejects.
   */
  private awaitStreamActivity(timeoutMs: number): Promise<void> {
    if (this.sessionDead || !this.session) return Promise.reject(new Error("Session unavailable"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.activityWaiters.delete(waiter);
        resolve();
      }, timeoutMs);
      this.activityWaiters.add(waiter);
    });
  }

  private settleActivityWaiters(error?: Error): void {
    const waiters = [...this.activityWaiters];
    this.activityWaiters.clear();
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  /**
   * Current conversation model + effort, read through this session's own
   * connection (remote app-servers accept one control client, so a separate
   * connection would conflict with the session).
   */
  async getModelInfo(): Promise<{ model: string | null; reasoningEffort: string | null; title: string | null }> {
    // Plain management call again: since SDK 0.5.0 / letta-code 0.29.7
    // (letta-agent-sdk#218, letta-code#3524) an app-server serves management
    // requests and live sessions concurrently, so this no longer has to be
    // hand-rolled through the session's own socket to avoid evicting it.
    return getConversationModel(this.conn, this.conversationId);
  }

  /** Live context diagnostics from the exact App Server conversation runtime. */
  async getConversationDiagnostics(): Promise<ConversationDiagnostics> {
    const staticInfo = await getConversationStaticDiagnostics(this.conn, this.conversationId);
    const response = await this.ensureSession().sendCommand(
      {
        type: "execute_command",
        command_id: "context",
        runtime: { agent_id: staticInfo.agentId, conversation_id: this.conversationId },
      },
      {
        timeoutMs: 15000,
        predicate: (message) =>
          message.type === "slash_command_end" && message.command_id === "context",
      },
    );
    if (response.success !== true) {
      throw new Error(typeof response.output === "string" ? response.output : "Couldn't read context status.");
    }
    let live: {
      context_tokens?: unknown;
      context_history?: unknown;
      pending_compaction?: unknown;
    } = {};
    try {
      if (typeof response.output === "string") live = JSON.parse(response.output) as typeof live;
    } catch {
      // An older App Server may return human-readable /context output. Static
      // model/memory diagnostics still render rather than failing the sheet.
    }
    const history = Array.isArray(live.context_history)
      ? live.context_history
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => ({
            timestamp: typeof item.timestamp === "number" ? item.timestamp : 0,
            tokens: typeof item.tokens === "number" ? item.tokens : 0,
            ...(typeof item.turnId === "number" ? { turnId: item.turnId } : {}),
            ...(item.compacted === true ? { compacted: true } : {}),
          }))
      : [];
    const compactedIndex = history.findLastIndex((item) => item.compacted === true);
    const after = compactedIndex >= 0 ? history[compactedIndex] : undefined;
    const before = compactedIndex > 0 ? history[compactedIndex - 1] : undefined;
    const contextTokens = typeof live.context_tokens === "number" && live.context_tokens > 0
      ? live.context_tokens
      : history.at(-1)?.tokens ?? null;
    return {
      model: staticInfo.model,
      contextTokens,
      contextWindow: staticInfo.contextWindow,
      promptTokens: contextTokens,
      completionTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      coreMemoryEstimatedTokens: staticInfo.coreMemoryEstimatedTokens,
      coreMemoryCharacters: staticInfo.coreMemoryCharacters,
      coreMemoryBlocks: staticInfo.coreMemoryBlocks,
      latestStepId: null,
      pendingCompaction: live.pending_compaction === true,
      contextHistory: history,
      lastCompaction: after
        ? {
            date: after.timestamp ? new Date(after.timestamp).toISOString() : null,
            trigger: "runtime compaction",
            contextTokensBefore: before?.tokens ?? null,
            contextTokensAfter: after.tokens,
            messagesBefore: null,
            messagesAfter: null,
          }
        : null,
    };
  }

  /** Run Letta's native compact command without injecting `/compact` into chat. */
  async compactConversation(): Promise<string> {
    const staticInfo = await getConversationStaticDiagnostics(this.conn, this.conversationId);
    const response = await this.ensureSession().sendCommand(
      {
        type: "execute_command",
        command_id: "compact",
        runtime: { agent_id: staticInfo.agentId, conversation_id: this.conversationId },
      },
      {
        timeoutMs: 120000,
        predicate: (message) =>
          message.type === "slash_command_end" && message.command_id === "compact",
      },
    );
    if (response.success !== true) {
      throw new Error(typeof response.output === "string" ? response.output : "Conversation compaction failed.");
    }
    return typeof response.output === "string" ? response.output : "Compaction completed.";
  }

  /** Change the conversation model/effort through the session (first-class SDK API). */
  async setModel(model: string, reasoningEffort?: string): Promise<void> {
    await this.ensureSession().updateModel({
      modelHandle: model,
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as never } : {}),
    });
  }

  /** Change the runtime permission mode (SDK 0.3.0 #208 write, 0.3.1 #212 read). */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.preferredPermissionMode = mode;
    await this.ensureSession().changeDeviceState({ permissionMode: mode });
    // The authoritative value lands via the next device-status update; show
    // the pending value immediately so the sheet feels responsive.
    this.commit(
      patch(this.snapshot, {
        device: {
          permissionMode: mode,
          workingDirectory: this.snapshot.device?.workingDirectory ?? null,
          memoryDirectory: this.snapshot.device?.memoryDirectory ?? null,
        },
      }),
    );
  }

  /** Mirror live device status (permission mode, cwd) into the snapshot. */
  private watchDeviceStatus(session: LettaCodeSession): void {
    session.onDeviceStatus((status) => this.commit(this.applyDeviceStatus(this.snapshot, status)));
    void session.getDeviceStatus().catch(() => {
      // Best-effort: some transports may not replay status until a turn runs.
    });
  }

  /**
   * The device owns the truth about whether a turn is running and which
   * approvals it is blocked on, so its status reconciles our in-memory guess.
   * Without this a resume can leave the UI stuck ("Running" forever, stop
   * button frozen) after the run it remembers has long since finished.
   */
  private applyDeviceStatus(snapshot: ChatSnapshot, status: SessionDeviceStatus): ChatSnapshot {
    this.deviceIsProcessing = status.isProcessing;
    const pending = status.pendingControlRequests ?? [];
    // Approvals we still hold a resolver for stay as they are — those cards can
    // be acted on. Ones the device reports but we can't answer (resolvers died
    // with the previous process) are surfaced read-only so the user at least
    // knows why the turn is stalled, and recoverPendingApprovals() re-delivers
    // them through canUseTool with fresh resolvers.
    const answerable = snapshot.approvals.filter((a) => this.approvalResolvers.has(a.requestId));
    const orphans = pending
      .filter((p) => !answerable.some((a) => a.requestId === p.requestId))
      .map((p) => ({
        requestId: p.requestId,
        toolCallId: (p as { toolCallId?: string }).toolCallId ?? p.requestId,
        toolName: p.toolName,
        summary: `Run ${p.toolName}`,
        input: "",
        permissionSuggestions: [],
        unresolvable: true,
      }));
    const approvals = [...answerable, ...orphans];
    return patch(snapshot, {
      device: {
        permissionMode: status.permissionMode as PermissionMode,
        workingDirectory: status.workingDirectory,
        // The path the executing harness actually resolved (SDK 0.5.1, #229) —
        // null on older servers that don't report it.
        memoryDirectory: status.memoryDirectory,
      },
      approvals,
      // Never downgrade a locally-known abort in flight; otherwise the device
      // decides. An unanswered approval outranks "running" for the composer.
      run:
        snapshot.run === "aborting"
          ? "aborting"
          : approvals.length > 0
            ? "awaiting_approval"
            : status.isProcessing
              ? "running"
              : "idle",
    });
  }

  /**
   * Remove a queued follow-up. The item shows as pending until the server's
   * next `queue_update` confirms the removal (never removed optimistically).
   * First-class in SDK 0.3.0 (letta-agent-sdk#208).
   */
  async removeQueueItem(itemId: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.commit(
      patch(this.snapshot, {
        queue: this.snapshot.queue.map((q) => (q.id === itemId ? { ...q, pendingRemoval: true } : q)),
      }),
    );
    await session.removeQueuedMessage(itemId);
  }

  /**
   * Foreground resume / retry: re-hydrate authoritative history over REST and
   * clear the offline banner if it succeeds. A live session keeps its own
   * socket; if it died, the next send() lazily opens a fresh one.
   */
  private scheduleReconnectRetry(): void {
    if (this.closed || this.snapshot.connection === "auth_failed" || this.reconnectRetryTimer) return;
    const delay = Math.min(
      RECONNECT_RETRY_MAX_MS,
      RECONNECT_RETRY_BASE_MS * Math.max(1, 2 ** this.reconnectRetryAttempt),
    );
    this.reconnectRetryAttempt += 1;
    this.reconnectRetryTimer = setTimeout(() => {
      this.reconnectRetryTimer = null;
      if (!this.closed && this.snapshot.connection !== "connected" && this.snapshot.connection !== "auth_failed") {
        void this.reconnect({ forceNewTransport: true });
      }
    }, delay);
  }

  private clearReconnectRetry(): void {
    if (this.reconnectRetryTimer) {
      clearTimeout(this.reconnectRetryTimer);
      this.reconnectRetryTimer = null;
    }
    this.reconnectRetryAttempt = 0;
  }

  async reconnect(options?: { forceNewTransport?: boolean }): Promise<void> {
    if (this.reconnectInFlight) return this.reconnectInFlight;
    const recovery = this.performReconnect(options).finally(() => {
      if (this.reconnectInFlight === recovery) this.reconnectInFlight = null;
    });
    this.reconnectInFlight = recovery;
    return recovery;
  }

  private async performReconnect(options?: { forceNewTransport?: boolean }): Promise<void> {
    const generation = this.advanceReconciliationGeneration();
    if (this.snapshot.loadingOlder) this.commit(patch(this.snapshot, { loadingOlder: false }));
    // Transport failures never belong in chat history. Scrub any legacy/local
    // transport rows before recovery so reconnect is visually transparent.
    this.commit(this.scrubTransportErrors(this.snapshot));
    // A visible failure state means the user pressed Retry — acknowledge
    // instantly. Otherwise hold the banner briefly so fast foreground resumes
    // remain visually seamless. Preserve any active server-side run while the
    // transport is uncertain; a dropped viewer socket is not evidence the work
    // stopped.
    let pending: ReturnType<typeof setTimeout> | null = null;
    if (this.snapshot.connection === "offline" || this.snapshot.connection === "auth_failed") {
      this.commit(patch(this.snapshot, { connection: "reconnecting" }));
    } else {
      pending = setTimeout(() => {
        pending = null;
        if (this.reconciliationIsCurrent(generation, "reconnect_banner")) {
          this.commit(patch(this.snapshot, { connection: "reconnecting" }));
        }
      }, RECONNECT_BANNER_DELAY_MS);
    }

    // A dead or background-suspended SDK session must be discarded BEFORE
    // hydrate(): remote history hydration itself uses ensureSession(), so
    // hydrating first would route recovery through the stale socket.
    if (this.sessionDead || options?.forceNewTransport) {
      this.cancelAuthoritativeCatchUp();
      const stale = this.session;
      this.session = null;
      this.streamGeneration += 1;
      this.sessionDead = false;
      stale?.close();
    }

    // Keep the live accumulator intact until device status proves the turn is
    // idle. SDK rebase merges anonymous content-block deltas with persisted
    // UUID rows rather than replacing the former.
    const ok = await this.hydrate({ reconcileDevice: false, applyHistory: false, generation });
    if (!ok || !this.reconciliationIsCurrent(generation, "reconnect_hydrate")) {
      if (pending) clearTimeout(pending);
      if (!this.closed && this.snapshot.connection !== "auth_failed") this.scheduleReconnectRetry();
      return;
    }

    // Recovery is atomic from the UI's point of view: history first, then the
    // executing device's live state, then approvals. Do not advertise a healthy
    // connection while any of those still reflect the pre-drop client snapshot.
    try {
      const session = this.ensureSession();
      const status = await session.getDeviceStatus();
      if (!this.reconciliationIsCurrent(generation, "reconnect_device_status") || this.session !== session) return;
      this.commit(this.applyDeviceStatus(this.project(this.snapshot), status));

      await session.recoverPendingApprovals().catch(() => {});
      if (!this.reconciliationIsCurrent(generation, "reconnect_approvals") || this.session !== session) return;
      if (this.preferredPermissionMode) {
        await session.changeDeviceState({ permissionMode: this.preferredPermissionMode }).catch(() => {});
        if (!this.reconciliationIsCurrent(generation, "reconnect_permission") || this.session !== session) return;
      }
      if (pending) clearTimeout(pending);
      this.clearReconnectRetry();
      this.commit(patch(this.project(this.snapshot), { connection: "connected" }));
      this.startAuthoritativeCatchUp(session, generation);
    } catch (e) {
      if (pending) clearTimeout(pending);
      if (!this.reconciliationIsCurrent(generation, "reconnect_error")) return;
      this.sessionDead = true;
      const authFailure = isAuthError(e);
      this.commit(
        patch(this.snapshot, {
          connection: authFailure ? "auth_failed" : "offline",
          run: preserveRunAcrossTransportLoss(this.snapshot.run),
        }),
      );
      if (!authFailure) this.scheduleReconnectRetry();
    }
  }

  private startAuthoritativeCatchUp(session: LettaCodeSession, reconciliationGeneration: number): void {
    this.cancelAuthoritativeCatchUp();
    const catchUpGeneration = this.authoritativeCatchUpGeneration;
    void this.catchUpAfterReconnect(session, catchUpGeneration, reconciliationGeneration);
  }

  private cancelAuthoritativeCatchUp(): void {
    this.authoritativeCatchUpGeneration += 1;
    if (this.authoritativeCatchUpTimer) clearTimeout(this.authoritativeCatchUpTimer);
    this.authoritativeCatchUpTimer = null;
    this.authoritativeCatchUpWake?.();
    this.authoritativeCatchUpWake = null;
  }

  private waitForAuthoritativeCatchUp(delay: number, catchUpGeneration: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        if (this.authoritativeCatchUpTimer) clearTimeout(this.authoritativeCatchUpTimer);
        this.authoritativeCatchUpTimer = null;
        if (this.authoritativeCatchUpWake === wake) this.authoritativeCatchUpWake = null;
        resolve();
      };
      if (this.closed || catchUpGeneration !== this.authoritativeCatchUpGeneration) return wake();
      this.authoritativeCatchUpWake = wake;
      this.authoritativeCatchUpTimer = setTimeout(wake, delay);
    });
  }

  private hasUnacknowledgedLocalEcho(): boolean {
    return this.unacknowledgedOtids.size > 0;
  }

  private async markAmbiguousOutboxFailed(generation: number): Promise<void> {
    if (!this.reconciliationIsCurrent(generation, "outbox_unknown_before")) return;
    const durable = await loadDurableConversation(this.conn.profile.id, this.conversationId).catch(() => null);
    if (!durable || !this.reconciliationIsCurrent(generation, "outbox_unknown_load")) return;
    const ambiguous = durable.outbox.filter((item) => outboxRecoveryAction(item.state) === "converge");
    for (const item of ambiguous) {
      if (!this.reconciliationIsCurrent(generation, "outbox_unknown_update")) return;
      await updateDurableOutboxState(
        this.conn.profile.id,
        this.conversationId,
        item.otid,
        "failed",
        "Server became idle without a persisted acknowledgement for this OTID.",
      ).catch(() => {});
      this.unacknowledgedOtids.delete(item.otid);
      this.markEcho(item.otid, { pending: false, failed: true });
    }
    if (ambiguous.length > 0 && this.reconciliationIsCurrent(generation, "outbox_unknown_commit")) {
      this.commit(this.project(this.snapshot));
    }
  }

  /**
   * Reconnect persistence convergence is evidence-based: first exhaust the
   * forward `after` cursor immediately, then require canonical history to cover
   * the live accumulator and every submitted OTID to have a persisted user UUID.
   * Backoff controls polling load only; elapsed time is never treated as proof.
   */
  private async catchUpAfterReconnect(
    session: LettaCodeSession,
    catchUpGeneration: number,
    reconciliationGeneration: number,
  ): Promise<void> {
    // Active server work can outlive the viewer socket that initiated it. Do not
    // consume the persistence deadline while Milo is still working; keep this
    // watcher alive until the server reports idle, even if the replacement
    // viewer never receives the original run's terminal `result` event.
    let deadline: number | null = null;
    let attempt = 0;
    try {
      while (this.isAuthoritativeCatchUpCurrent(session, catchUpGeneration, reconciliationGeneration)) {
        const status = await session.getDeviceStatus();
        if (!this.isAuthoritativeCatchUpCurrent(session, catchUpGeneration, reconciliationGeneration)) return;
        this.commit(this.applyDeviceStatus(this.project(this.snapshot), status));
        if (shouldWaitForAuthoritativeIdle(status.isProcessing, this.snapshot.run)) {
          const delay = Math.min(
            AUTHORITATIVE_CATCHUP_BACKOFF_MAX_MS,
            Math.max(1000, AUTHORITATIVE_CATCHUP_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 4)),
          );
          attempt += 1;
          await this.waitForAuthoritativeCatchUp(delay, catchUpGeneration);
          continue;
        }
        if (deadline === null) {
          deadline = Date.now() + AUTHORITATIVE_CATCHUP_MAX_MS;
          attempt = 0;
        }

        if (!(await this.syncForwardHistory(reconciliationGeneration))) return;
        if (!this.isAuthoritativeCatchUpCurrent(session, catchUpGeneration, reconciliationGeneration)) return;

        let reconciled = await this.reconcileAuthoritativeHistoryIfStillIdle(
          session,
          this.loadedHistoryMessages,
          reconciliationGeneration,
        );
        if (!this.isAuthoritativeCatchUpCurrent(session, catchUpGeneration, reconciliationGeneration)) return;

        // Some backends may finalize the newest persisted object in place rather
        // than append a new UUID. The forward cursor remains primary; this tail
        // refresh is only a verification fallback when coverage has not converged.
        if (!reconciled) {
          const latest = await this.fetchAuthoritativeTail();
          if (!this.isAuthoritativeCatchUpCurrent(session, catchUpGeneration, reconciliationGeneration)) return;
          this.observePersistedHistory(latest, reconciliationGeneration, "catchup_tail");
          reconciled = await this.reconcileAuthoritativeHistoryIfStillIdle(
            session,
            latest,
            reconciliationGeneration,
          );
        }

        if (this.snapshot.run !== "idle") return;
        const convergence = syncConvergenceState(reconciled, this.hasUnacknowledgedLocalEcho());
        if (convergence.converged) {
          emitSyncTelemetry({
            kind: "sync_converged",
            conversationId: this.conversationId,
            generation: reconciliationGeneration,
            attempt,
          });
          return;
        }
        if (deadline !== null && Date.now() >= deadline) {
          if (convergence.reason === "awaiting_otid_ack") {
            await this.markAmbiguousOutboxFailed(reconciliationGeneration);
          }
          emitSyncTelemetry({
            kind: "sync_retry",
            conversationId: this.conversationId,
            generation: reconciliationGeneration,
            attempt,
            reason: convergence.reason === "awaiting_otid_ack" ? "otid_ack_timeout" : "persistence_timeout",
          });
          return;
        }

        emitSyncTelemetry({
          kind: "sync_retry",
          conversationId: this.conversationId,
          generation: reconciliationGeneration,
          attempt,
          reason: convergence.reason,
        });
        const delay = Math.min(
          AUTHORITATIVE_CATCHUP_BACKOFF_MAX_MS,
          AUTHORITATIVE_CATCHUP_BACKOFF_BASE_MS * 2 ** attempt,
        );
        attempt += 1;
        await this.waitForAuthoritativeCatchUp(delay, catchUpGeneration);
      }
    } catch {
      // consume() owns transport recovery; a later reconnect starts a fresh pass.
    }
  }

  private isAuthoritativeCatchUpCurrent(
    session: LettaCodeSession,
    catchUpGeneration: number,
    reconciliationGeneration: number,
  ): boolean {
    return (
      isAuthoritativeCatchUpCurrent(
        this.closed,
        this.session,
        session,
        catchUpGeneration,
        this.authoritativeCatchUpGeneration,
      ) &&
      isGenerationCurrent(reconciliationGeneration, this.reconciliationGeneration)
    );
  }

  /**
   * Stop is server-authoritative. Some App Server versions apply abort_message
   * but omit abort_message_response, which leaves the SDK's abort() promise
   * pending forever. After a short acknowledgement window, repeat the same
   * supported protocol command without waiting for an acknowledgement and
   * confirm the device actually became idle.
   */
  async abort(): Promise<void> {
    // With no live session there is no server to confirm the abort, so
    // "aborting" could never retire — nothing runs client-side anyway.
    if (!this.session || this.sessionDead) {
      this.commit(patch(this.snapshot, { run: "idle" }));
      return;
    }
    const session = this.session;
    const previous = this.snapshot.run;
    this.commit(patch(this.snapshot, { run: "aborting" }));
    try {
      const staticInfo = await getConversationStaticDiagnostics(this.conn, this.conversationId);
      const acknowledged = await Promise.race([
        session.abort().then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), ABORT_ACK_TIMEOUT_MS),
        ),
      ]);
      if (!acknowledged) {
        await session.sendCommand({
          type: "abort_message",
          runtime: { agent_id: staticInfo.agentId, conversation_id: this.conversationId },
          run_id: null,
        });
      }

      const deadline = Date.now() + ABORT_CONFIRM_TIMEOUT_MS;
      while (true) {
        const status = await session.getDeviceStatus();
        if (this.closed || this.session !== session) return;
        this.deviceIsProcessing = status.isProcessing;
        this.commit(this.applyDeviceStatus(this.project(this.snapshot), status));
        if (!status.isProcessing) return;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, ABORT_CONFIRM_INTERVAL_MS));
      }
      throw new Error("Stop was sent, but the server still reports this run as active.");
    } catch (e) {
      this.commit(
        patch(this.appendError(this.snapshot, e instanceof Error ? e.message : "Couldn't stop the run."), {
          run: previous,
        }),
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reconciliationGeneration += 1;
    this.streamGeneration += 1;
    this.clearReconnectRetry();
    this.cancelAuthoritativeCatchUp();
    if (this.sendActivityTimer) {
      clearTimeout(this.sendActivityTimer);
      this.sendActivityTimer = null;
    }
    if (retainedChatSessions.get(this.retainedKey) === this) {
      retainedChatSessions.delete(this.retainedKey);
    }
    this.accumulator.reset();
    this.localRows = [];
    this.echoOtids.clear();
    this.unacknowledgedOtids.clear();
    this.cancelledLocalOtids.clear();
    publishActivity(this.conversationId, null);
    this.settleActivityWaiters(new Error("Session closed"));
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingStream = [];
    this.session?.close();
    this.listeners.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private commit(next: ChatSnapshot): void {
    this.snapshot = next;
    publishActivity(
      this.conversationId,
      next.approvals.length > 0
        ? "awaiting_approval"
        : next.run === "running" || next.run === "aborting"
          ? "running"
          : null,
    );
    for (const listener of this.listeners) listener(next);
    // A session retained solely to finish background work can clean itself up as
    // soon as the device/turn reaches a genuine idle state.
    this.maybeDisposeWhenUnobserved();
  }

  private advanceReconciliationGeneration(): number {
    this.reconciliationGeneration += 1;
    return this.reconciliationGeneration;
  }

  private reconciliationIsCurrent(generation: number, reason: string): boolean {
    const current = !this.closed && isGenerationCurrent(generation, this.reconciliationGeneration);
    if (!current && !this.closed) {
      emitSyncTelemetry({
        kind: "sync_stale_discard",
        conversationId: this.conversationId,
        generation,
        reason,
      });
    }
    return current;
  }

  private observePersistedHistory(messages: readonly unknown[], generation: number, source: string): void {
    const observation = inspectPersistedHistory(messages);
    if (observation.missingIdCount > 0) {
      emitSyncTelemetry({
        kind: "protocol_identity_missing",
        conversationId: this.conversationId,
        generation,
        count: observation.missingIdCount,
        reason: `${source}:persisted_id`,
      });
    }
    if (observation.duplicateIdCount > 0) {
      emitSyncTelemetry({
        kind: "protocol_replay",
        conversationId: this.conversationId,
        generation,
        count: observation.duplicateIdCount,
        reason: `${source}:duplicate_persisted_id`,
      });
    }
  }

  private id(prefix: string): string {
    return `${prefix}-${this.counter++}`;
  }

  private async hydrateDurableCache(generation: number): Promise<boolean> {
    if (this.durableHydrated) return this.reconciliationIsCurrent(generation, "durable_cache_existing");
    try {
      const cached = await loadDurableConversation(this.conn.profile.id, this.conversationId);
      if (!this.reconciliationIsCurrent(generation, "durable_cache_load")) return false;
      this.durableHydrated = true;
      this.nextBefore = cached.nextBefore;
      this.forwardAfter = cached.forwardAfter;
      if (cached.messages.length > 0) {
        this.loadedHistoryMessages = cached.messages;
        this.accumulator = rebuildAuthoritativeTranscript(cached.messages);
        this.captureHistoryTimestamps(cached.messages);
      }
      const persistedOtids = new Set(userRowOtids(this.accumulator.rows()));
      this.queuedRecoveryTurns = cached.outbox.filter((item) => outboxRecoveryAction(item.state) === "replay");
      for (const item of cached.outbox) {
        if (persistedOtids.has(item.otid)) {
          this.unacknowledgedOtids.delete(item.otid);
          void removeDurableOutbox(this.conn.profile.id, this.conversationId, item.otid).catch(() => {});
          continue;
        }
        if (item.state !== "failed") this.unacknowledgedOtids.add(item.otid);
        this.echoOtids.add(item.otid);
        if (item.attachments.length > 0) this.pendingAttachments.set(item.otid, item.attachments);
        if (item.state === "queued" || item.state === "sending") {
          void updateDurableOutboxState(
            this.conn.profile.id,
            this.conversationId,
            item.otid,
            "failed",
            "Delivery was interrupted before confirmation.",
          ).catch(() => {});
        }
        this.localRows.push({
          anchor: this.accumulator.rows().length,
          item: {
            kind: "user",
            id: item.otid,
            text: item.text,
            occurredAt: item.createdAt,
            ...(item.attachments.length > 0 ? { images: item.attachments.map((attachment) => attachment.uri) } : {}),
            ...(item.state === "failed" || item.state === "queued" || item.state === "sending"
              ? { failed: true }
              : {}),
          },
        });
      }
      if (cached.messages.length > 0 || cached.outbox.length > 0) {
        this.commit(this.project(this.snapshot));
      }
      return true;
    } catch {
      // Cache failure must not block server hydration; the network path repairs it.
      return this.reconciliationIsCurrent(generation, "durable_cache_error");
    }
  }

  private async persistCanonicalWindow(generation: number): Promise<boolean> {
    if (!this.reconciliationIsCurrent(generation, "persist_before")) return false;
    const forwardAfter = newestDurableMessageId(this.loadedHistoryMessages);
    await saveDurableCanonicalWindow(
      this.conn.profile.id,
      this.conversationId,
      this.loadedHistoryMessages,
      { nextBefore: this.nextBefore, forwardAfter },
      () => !this.closed && isGenerationCurrent(generation, this.reconciliationGeneration),
    );
    if (!this.reconciliationIsCurrent(generation, "persist_after")) return false;
    this.forwardAfter = forwardAfter;
    const retired = await retirePersistedOutboxEchoes(
      this.conn.profile.id,
      this.conversationId,
      this.loadedHistoryMessages,
    );
    if (!this.reconciliationIsCurrent(generation, "persist_retire")) return false;
    for (const otid of retired) {
      this.pendingAttachments.delete(otid);
      this.unacknowledgedOtids.delete(otid);
    }
    return true;
  }

  /**
   * Load existing history before any turn runs.
   *
   * Cloud: over REST — opening a cloud session provisions a sandbox, far too
   * heavy for just reading (SDK-FEEDBACK.md #3).
   * Remote: through the session itself — remote sessions are cheap, and the
   * app-server accepts only ONE control-channel client per process, so using
   * the SDK's management transport here would hold the slot and deadlock the
   * session's own connect (SDK-FEEDBACK.md "Still open" #4).
   */
  private async hydrate(options?: { reconcileDevice?: boolean; applyHistory?: boolean; generation?: number }): Promise<boolean> {
    const generation = options?.generation ?? this.reconciliationGeneration;
    try {
      if (!(await this.hydrateDurableCache(generation))) return false;
      if (this.conn.profile.type === "remote") {
        // Survive React dev double-mounting: the first, immediately-closed
        // instance must not open sockets, or its teardown races the second
        // instance for the app-server's single control slot.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (!this.reconciliationIsCurrent(generation, "hydrate_remote_delay")) return false;
      }
      const hadDurableHistory = this.loadedHistoryMessages.length > 0;
      const durableBefore = this.nextBefore;
      if (hadDurableHistory && this.forwardAfter) {
        if (!(await this.syncForwardHistory(generation))) return false;
      }
      const page = await this.fetchInitialHistory();
      if (!this.reconciliationIsCurrent(generation, "hydrate_initial_history")) return false;
      this.observePersistedHistory(page.messages, generation, "hydrate");
      this.nextBefore = hadDurableHistory ? durableBefore : page.nextBefore;
      this.mergeLatestHistory(page.messages);
      if (!(await this.persistCanonicalWindow(generation))) return false;
      // Initial hydration has no live row. Reconnect hydration deliberately
      // defers this until device status says idle (see performReconnect()).
      if (options?.applyHistory !== false) {
        this.accumulator.rebase({ messages: this.loadedHistoryMessages as never }, { order: "asc" });
      }
      this.captureHistoryTimestamps(page.messages);

      let next = this.project(patch(this.snapshot, { hasMore: page.hasMore }));
      if (options?.reconcileDevice !== false && this.session) {
        // Cold open/reload must establish runtime truth before the UI claims the
        // conversation is ready. The SDK session was created with the saved
        // permission mode, so approval recovery cannot race a later mode restore.
        // A stranded unrestricted tool therefore resumes here instead of being
        // rendered as an idle-looking forever-running card.
        await this.session.recoverPendingApprovals().catch(() => {});
        if (!this.reconciliationIsCurrent(generation, "hydrate_approvals")) return false;
        const status = await this.session.getDeviceStatus().catch(() => null);
        if (!this.reconciliationIsCurrent(generation, "hydrate_device_status")) return false;
        if (status) next = this.applyDeviceStatus(next, status);
      }
      if (!this.reconciliationIsCurrent(generation, "hydrate_commit")) return false;
      this.commit(patch(next, { hydrating: false }));

      const queued = this.queuedRecoveryTurns.filter((item) =>
        this.localRows.some((row) => row.item.kind === "user" && row.item.id === item.otid),
      );
      this.queuedRecoveryTurns = [];
      if (queued.length > 0) {
        queueMicrotask(() => {
          void (async () => {
            for (const item of queued) {
              if (this.closed) return;
              await this.submitDurableTurn({ ...item, updatedAt: Date.now() });
            }
          })();
        });
      } else if (this.session && this.hasUnacknowledgedLocalEcho()) {
        this.startAuthoritativeCatchUp(this.session, generation);
      }
      return true;
    } catch (e) {
      if (!this.reconciliationIsCurrent(generation, "hydrate_error")) return false;
      const detail = e instanceof Error ? e.message : "Couldn't load history.";
      const transportFailure = isTransportError(detail);
      // Connection failures are UI transport state, never transcript content.
      // Keep any in-flight run intact while a replacement socket is retried.
      const base = transportFailure ? this.scrubTransportErrors(this.snapshot) : this.appendError(this.snapshot, detail, true);
      this.commit(
        patch(base, {
          hydrating: false,
          connection: isAuthError(e) ? "auth_failed" : "offline",
          run: transportFailure ? preserveRunAcrossTransportLoss(this.snapshot.run) : this.snapshot.run,
        }),
      );
      return false;
    }
  }

  /**
   * Fetch the next older history page and prepend it — the visual top of the
   * inverted transcript. Server-driven cursor; no-op while one is in flight.
   */
  async loadOlder(): Promise<void> {
    if (this.snapshot.hydrating || this.snapshot.loadingOlder) return;
    if (!this.snapshot.hasMore || !this.nextBefore) return;
    const generation = this.reconciliationGeneration;
    const before = this.nextBefore;
    this.commit(patch(this.snapshot, { loadingOlder: true }));
    try {
      const page = await this.fetchHistoryPage(before);
      if (!this.reconciliationIsCurrent(generation, "load_older_fetch")) return;
      this.observePersistedHistory(page.messages, generation, "older");
      this.nextBefore = page.nextBefore;
      this.mergeOlderHistory(page.messages);
      if (!(await this.persistCanonicalWindow(generation))) return;
      // Rebase the complete loaded history window so later authoritative newest-
      // turn repairs cannot reorder an older page behind the live edge.
      this.accumulator.rebase({ messages: this.loadedHistoryMessages as never }, { order: "asc" });
      this.captureHistoryTimestamps(page.messages);
      this.commit(
        this.project(patch(this.snapshot, { hasMore: page.hasMore, loadingOlder: false })),
      );
    } catch {
      // A failed page is now assumed transient (the cursor itself works), so
      // hasMore stays set and scrolling back to the top retries.
      if (this.reconciliationIsCurrent(generation, "load_older_error")) {
        this.commit(patch(this.snapshot, { loadingOlder: false }));
      }
    }
  }

  private async fetchForwardPage(
    after: string,
    limit = AUTHORITATIVE_PAGE_SIZE,
  ): Promise<{ messages: unknown[]; hasMore: boolean }> {
    if (this.conn.profile.type === "remote") {
      const result = await this.ensureSession().listMessages({ after, order: "asc", limit });
      return { messages: result.messages, hasMore: result.hasMore ?? result.messages.length >= limit };
    }
    const result = await listConversationMessages(this.conn, this.conversationId, { after, order: "asc", limit });
    return { messages: result.messages, hasMore: result.hasMore };
  }

  /** Fill only the missing newer suffix; never reuse the backward paging cursor. */
  private async syncForwardHistory(generation: number): Promise<boolean> {
    let cursor = this.forwardAfter ?? newestDurableMessageId(this.loadedHistoryMessages);
    if (!cursor) return this.reconciliationIsCurrent(generation, "forward_no_cursor");
    for (let count = 0; count < FORWARD_SYNC_MAX_PAGES; count += 1) {
      const page = await this.fetchForwardPage(cursor);
      if (!this.reconciliationIsCurrent(generation, "forward_fetch")) return false;
      this.observePersistedHistory(page.messages, generation, "forward");
      if (page.messages.length === 0) break;
      const next = newestDurableMessageId(page.messages);
      if (!next || next === cursor) {
        if (page.hasMore) {
          emitSyncTelemetry({
            kind: "protocol_gap",
            conversationId: this.conversationId,
            generation,
            reason: "forward_cursor_no_progress",
          });
        }
        break;
      }
      this.loadedHistoryMessages = mergeForwardMessages(this.loadedHistoryMessages, page.messages);
      cursor = next;
      this.forwardAfter = next;
      if (!page.hasMore) break;
    }
    return this.reconciliationIsCurrent(generation, "forward_complete");
  }

  /** One page of history, oldest-first, with the cursor to the next older page. */
  private async fetchHistoryPage(
    before?: string,
    limit = AUTHORITATIVE_PAGE_SIZE,
  ): Promise<{ messages: unknown[]; nextBefore: string | null; hasMore: boolean }> {
    // Both backends page reliably now (letta-cloud#13377 + letta-code#3526), so
    // the first paint stays cheap and older pages arrive on scroll.
    if (this.conn.profile.type === "remote") {
      const result = await this.ensureSession().listMessages({ limit, ...(before ? { before } : {}) });
      const messages = result.messages.slice().reverse();
      const oldestId = (messages[0] as { id?: string } | undefined)?.id ?? null;
      const full = result.messages.length >= limit;
      return {
        messages,
        nextBefore: result.nextBefore ?? (full ? oldestId : null),
        hasMore: result.hasMore ?? full,
      };
    }
    return listConversationMessages(this.conn, this.conversationId, { limit, ...(before ? { before } : {}) });
  }

  /**
   * Initial paint with a complete latest turn and a valid older-history cursor.
   * If the newest page is entirely inside one very tool-heavy turn, page back
   * until its user-message boundary is included. Unlike the lightweight
   * reconciliation tail, keep all fetched rows so scrolling can continue from
   * the oldest page's cursor without a gap.
   */
  private async fetchInitialHistory(): Promise<{ messages: unknown[]; nextBefore: string | null; hasMore: boolean }> {
    let page = await this.fetchHistoryPage();
    let messages = page.messages;
    let nextBefore = page.nextBefore;
    let hasMore = page.hasMore;

    for (
      let count = 1;
      count < AUTHORITATIVE_MAX_PAGES && !containsUserMessage(messages) && hasMore && nextBefore;
      count++
    ) {
      page = await this.fetchHistoryPage(nextBefore);
      messages = [...page.messages, ...messages];
      nextBefore = page.nextBefore;
      hasMore = page.hasMore;
    }

    return { messages, nextBefore, hasMore };
  }

  /**
   * Fetch the complete newest turn rather than trusting an arbitrary page cut.
   * Tool-heavy turns can exceed 50 wire messages; a fixed tail can therefore
   * begin after the user instruction or between a tool call and its return.
   */
  private async fetchAuthoritativeTail(): Promise<unknown[]> {
    let page = await this.fetchHistoryPage();
    let combined = page.messages;
    let cursor = page.nextBefore;

    for (let count = 1; count < AUTHORITATIVE_MAX_PAGES && !containsUserMessage(combined) && page.hasMore && cursor; count++) {
      page = await this.fetchHistoryPage(cursor);
      combined = [...page.messages, ...combined];
      cursor = page.nextBefore;
    }

    for (let i = combined.length - 1; i >= 0; i--) {
      if (isUserHistoryMessage(combined[i])) return combined.slice(i);
    }
    return combined;
  }

  /** Replace the newest persisted suffix while preserving all older loaded rows. */
  private mergeLatestHistory(messages: readonly unknown[]): void {
    if (messages.length === 0) return;
    if (this.loadedHistoryMessages.length === 0) {
      this.loadedHistoryMessages = [...messages];
      return;
    }

    const firstId = historyMessageId(messages[0]);
    if (firstId) {
      const overlap = this.loadedHistoryMessages.findIndex((message) => historyMessageId(message) === firstId);
      if (overlap >= 0) {
        this.loadedHistoryMessages = [...this.loadedHistoryMessages.slice(0, overlap), ...messages];
        return;
      }
    }

    const existing = new Set(this.loadedHistoryMessages.map(historyMessageId).filter(Boolean));
    const additions = messages.filter((message) => {
      const id = historyMessageId(message);
      return !id || !existing.has(id);
    });
    this.loadedHistoryMessages = [...this.loadedHistoryMessages, ...additions];
  }

  /** Prepend an older cursor page without duplicating its overlap boundary. */
  private mergeOlderHistory(messages: readonly unknown[]): void {
    if (messages.length === 0) return;
    const existing = new Set(this.loadedHistoryMessages.map(historyMessageId).filter(Boolean));
    const additions = messages.filter((message) => {
      const id = historyMessageId(message);
      return !id || !existing.has(id);
    });
    this.loadedHistoryMessages = [...additions, ...this.loadedHistoryMessages];
  }

  /**
   * Reconnect/catch-up only: replace ephemeral stream state with the server's
   * canonical history after device status has reported idle. Local optimistic
   * rows are deliberately outside the accumulator, so project() retains them
   * and retires echoed users by OTID.
   */
  private reconcileAuthoritativeHistory(messages: readonly unknown[], generation: number): boolean {
    if (!this.reconciliationIsCurrent(generation, "authoritative_reconcile_before")) return false;
    this.mergeLatestHistory(messages);
    const authoritative = rebuildAuthoritativeTranscript(this.loadedHistoryMessages);
    if (!authoritativeRowsCoverCurrent(this.accumulator.rows(), authoritative.rows())) return false;
    if (!this.reconciliationIsCurrent(generation, "authoritative_reconcile_apply")) return false;
    this.accumulator = authoritative;
    this.captureHistoryTimestamps(this.loadedHistoryMessages);
    this.commit(this.project(this.snapshot));
    return true;
  }

  /**
   * A turn can start while the REST history tail is in flight. Recheck the
   * same live session immediately before replacing the accumulator, or that
   * fresh queued/live state could be erased by an already-stale idle snapshot.
   */
  private async reconcileAuthoritativeHistoryIfStillIdle(
    session: LettaCodeSession,
    messages: readonly unknown[],
    generation: number,
  ): Promise<boolean> {
    if (!this.reconciliationIsCurrent(generation, "authoritative_status_before") || this.session !== session) return false;
    const status = await session.getDeviceStatus();
    if (!this.reconciliationIsCurrent(generation, "authoritative_status_after") || this.session !== session) return false;

    const next = this.applyDeviceStatus(this.project(this.snapshot), status);
    this.commit(next);
    const hasPendingApprovals = (status.pendingControlRequests?.length ?? 0) > 0 || next.approvals.length > 0;
    if (status.isProcessing || hasPendingApprovals || next.run !== "idle") return false;

    if (!this.reconcileAuthoritativeHistory(messages, generation)) return false;
    return this.persistCanonicalWindow(generation);
  }

  // A healthy live turn is never rebuilt or merge-rebased from persisted
  // history. Fresh-accumulator replacement is contained to reconnect catch-up,
  // after the executing device reports idle; bounded retries cover persistence
  // lag without perturbing a healthy live result.

  private async consume(session: LettaCodeSession, streamGeneration: number): Promise<void> {
    try {
      // The SDK stream covers one turn and returns after its result. Open the
      // next stream immediately so later sends use the same live session.
      while (!this.closed && this.session === session && streamGeneration === this.streamGeneration) {
        let received = false;
        for await (const message of session.stream()) {
          if (this.closed || this.session !== session || streamGeneration !== this.streamGeneration) break;
          received = true;
          this.ingest(message as SDKMessage);
        }
        // A stream with no message means the SDK session itself closed. Route
        // that closure through the normal recovery path instead of retaining a
        // session object that no consumer reads.
        if (!received) throw new Error("Session stream closed.");
      }
    } catch (e) {
      // A deliberately replaced transport can finish/error after its successor
      // is already live. Never let that stale callback poison the new session.
      if (this.closed || this.session !== session || streamGeneration !== this.streamGeneration) return;
      this.sessionDead = true;
      const detail = e instanceof Error && e.message ? e.message : "Stream ended unexpectedly.";
      this.settleActivityWaiters(e instanceof Error ? e : new Error(detail));
      const transportFailure = isTransportError(detail);
      // A viewer transport failure is not a run failure. Keep the run and the
      // live row intact until the replacement session asks the device what is
      // actually happening. Only a genuine non-transport stream error marks
      // the current text as interrupted.
      if (!transportFailure) this.interruptedKey = newestTextKey(this.accumulator.rows());
      const swept = this.project(this.drainStreamBuffer(this.snapshot));
      this.commit(
        patch(transportFailure ? swept : this.appendError(swept, detail, true), {
          run: transportFailure ? preserveRunAcrossTransportLoss(this.snapshot.run) : "idle",
          connection: isAuthError(e) ? "auth_failed" : transportFailure ? "reconnecting" : "offline",
        }),
      );
      // App Server heartbeat expiry and transient mobile-network drops are
      // recoverable. Rebuild the SDK session automatically instead of leaving
      // the user stranded on a dead socket until the app is relaunched.
      if (isTransportError(detail) && !isAuthError(e)) {
        this.scheduleReconnectRetry();
      }
    }
  }

  /**
   * Decouple wire cadence from render cadence: text deltas coalesce behind a
   * short flush so a fast model doesn't force a full-list render per chunk,
   * while everything discrete (tool cards, approvals, run phase, queue)
   * commits immediately — interactivity must never wait on the buffer.
   */
  private ingest(message: SDKMessage): void {
    this.streamActivitySerial += 1;
    if (this.sendActivityTimer) {
      clearTimeout(this.sendActivityTimer);
      this.sendActivityTimer = null;
    }
    this.settleActivityWaiters();
    const observation = this.protocolObserver.observe(message);
    for (const event of observation.events) {
      emitSyncTelemetry({ ...event, conversationId: this.conversationId });
    }
    // The observer never replaces SDK replay/accumulation behavior.
    if (message.type === "stream_event") {
      this.pendingStream.push(message);
      if (this.flushTimer) return;
      // Leading edge: the first token after silence paints instantly.
      this.flushStreamBuffer();
      this.armFlushTimer();
      return;
    }
    const next = this.reduce(this.drainStreamBuffer(this.snapshot), message);
    this.commit(next);
    // A terminal run result is the protocol-level signal to converge persisted
    // history. Do not wait for a reconnect or a guessed persistence delay.
    if (
      message.type === "result" &&
      !this.closed &&
      this.session &&
      next.run === "idle" &&
      next.connection !== "reconnecting"
    ) {
      this.startAuthoritativeCatchUp(this.session, this.reconciliationGeneration);
    }
  }

  private armFlushTimer(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pendingStream.length === 0) return;
      this.flushStreamBuffer();
      this.armFlushTimer();
    }, STREAM_FLUSH_MS);
  }

  private flushStreamBuffer(): void {
    if (this.pendingStream.length === 0) return;
    this.commit(this.drainStreamBuffer(this.snapshot));
  }

  /** Reduce all held-back deltas onto `snapshot` without committing. */
  private drainStreamBuffer(snapshot: ChatSnapshot): ChatSnapshot {
    const events = this.pendingStream;
    this.pendingStream = [];
    let next = snapshot;
    for (const event of events) next = this.reduce(next, event);
    return next;
  }

  /**
   * Build the transcript the UI renders: the accumulator's rows in order,
   * projected into this app's vocabulary, followed by rows the server has never
   * seen (an echo still in flight, an error). An echo disappears the moment the
   * accumulator reports the persisted message under the same otid.
   */
  private project(snapshot: ChatSnapshot): ChatSnapshot {
    const rows = this.accumulator.rows();
    const running = snapshot.run === "running" || snapshot.run === "awaiting_approval";
    const liveKey = running ? liveTextKeyAtEdge(rows) : null;
    this.recordTimings(rows, liveKey);

    const state: ProjectionState = {
      liveKey,
      interruptedKey: this.interruptedKey,
      toolStatusOverride: this.toolStatusOverride,
      thinkStartedAt: this.thinkStartedAt,
      thinkSeconds: this.thinkSeconds,
      toolDurationMs: this.toolDurationMs,
      rowOccurredAt: this.rowOccurredAt,
      toolCompletedAt: this.toolCompletedAt,
    };
    const items = projectRows(rows, state);

    // An echo retires the moment the accumulator reports the persisted message
    // under the same otid — identity, not a guess about matching text.
    // The OTID identifies the whole turn on some live rows, not just the user's
    // persisted message. Retire an optimistic bubble only when the accumulator
    // has an actual USER row with that OTID; assistant/reasoning/tool activity
    // must never make the user's just-sent message disappear.
    const seenOtids = userRowOtids(rows);
    const acknowledgedEchoes = new Set<string>();
    this.localRows = this.localRows.filter(({ item }) => {
      const acknowledged = item.kind === "user" && this.echoOtids.has(item.id) && seenOtids.has(item.id);
      if (acknowledged) acknowledgedEchoes.add(item.id);
      return !acknowledged;
    });
    for (const otid of acknowledgedEchoes) this.echoOtids.delete(otid);

    const transcript: TranscriptItem[] = [];
    let placed = 0;
    for (let i = 0; i <= items.length; i++) {
      for (const { anchor, item } of this.localRows) {
        if (anchor === i) transcript.push(item);
      }
      if (i < items.length) transcript.push(items[i]!);
      placed = i;
    }
    // Anchors past the current row count (rows the accumulator later dropped)
    // still belong at the end rather than disappearing.
    for (const { anchor, item } of this.localRows) {
      if (anchor > placed) transcript.push(item);
    }
    return patch(snapshot, { transcript });
  }

  /** Preserve persisted server timestamps when history is merged. */
  private captureHistoryTimestamps(messages: unknown[]): void {
    const byUuid = new Map<string, number>();
    const byOtid = new Map<string, number>();
    const byToolCall = new Map<string, number>();
    const completedTool = new Map<string, number>();

    for (const raw of messages) {
      if (!raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      const date = typeof record.date === "string" ? Date.parse(record.date) : Number.NaN;
      if (!Number.isFinite(date)) continue;
      if (typeof record.id === "string") byUuid.set(record.id, date);
      if (typeof record.otid === "string") byOtid.set(record.otid, date);

      const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      for (const value of calls) {
        if (!value || typeof value !== "object") continue;
        const call = value as Record<string, unknown>;
        const id =
          typeof call.tool_call_id === "string"
            ? call.tool_call_id
            : typeof call.id === "string"
              ? call.id
              : undefined;
        if (id) byToolCall.set(id, date);
      }
      if (typeof record.tool_call_id === "string" && record.message_type === "tool_return_message") {
        completedTool.set(record.tool_call_id, date);
      }
    }

    for (const row of this.accumulator.rows()) {
      const timestamp =
        (row.uuid ? byUuid.get(row.uuid) : undefined) ??
        (row.otid ? byOtid.get(row.otid) : undefined) ??
        (row.kind === "tool_call" ? byToolCall.get(row.toolCallId) : undefined);
      if (timestamp !== undefined) this.rowOccurredAt.set(row.key, timestamp);
      if (row.kind === "tool_call") {
        const completed = completedTool.get(row.toolCallId);
        if (completed !== undefined) this.toolCompletedAt.set(row.toolCallId, completed);
      }
    }
  }

  /**
   * Durations are wall-clock, so they are stamped as rows appear and settle
   * rather than derived from the rows themselves. Live timestamps are captured
   * on first appearance; history later replaces them with server time.
   */
  private recordTimings(rows: readonly TranscriptRow[], liveKey: string | null): void {
    for (const row of rows) {
      if (!this.rowOccurredAt.has(row.key)) this.rowOccurredAt.set(row.key, Date.now());
      if (row.kind === "reasoning") {
        if (!this.thinkStartedAt.has(row.key)) this.thinkStartedAt.set(row.key, Date.now());
        if (row.key !== liveKey && !this.thinkSeconds.has(row.key)) {
          const startedAt = this.thinkStartedAt.get(row.key)!;
          this.thinkSeconds.set(row.key, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        }
      } else if (row.kind === "tool_call") {
        if (!this.toolStartedAt.has(row.toolCallId)) this.toolStartedAt.set(row.toolCallId, Date.now());
        if (row.status === "complete" && !this.toolCompletedAt.has(row.toolCallId)) {
          this.toolCompletedAt.set(row.toolCallId, Date.now());
        }
        if (row.status === "complete" && !this.toolDurationMs.has(row.toolCallId)) {
          const startedAt = this.toolStartedAt.get(row.toolCallId)!;
          // A denied call's elapsed time measures the user deliberating, not work.
          if (this.toolStatusOverride.get(row.toolCallId) !== "denied") {
            this.toolDurationMs.set(row.toolCallId, Date.now() - startedAt);
          }
        }
      }
    }
  }

  /**
   * Approval outcomes are the only tool statuses the stream cannot express:
   * a denied call still returns an error tool_result, and "awaiting approval"
   * has no wire equivalent at all. They are held as an overlay the projection
   * applies over the accumulator's own status.
   */
  private setToolStatus(snapshot: ChatSnapshot, toolCallId: string, status: ToolStatus): ChatSnapshot {
    if (status === "running") this.toolStatusOverride.delete(toolCallId);
    else this.toolStatusOverride.set(toolCallId, status);
    return this.project(snapshot);
  }

  /** Feed a message to the accumulator, then rebuild the transcript from it. */
  private absorb(snapshot: ChatSnapshot, message: SDKMessage): ChatSnapshot {
    this.accumulator.apply(message);
    return this.project(snapshot);
  }

  /** Add an app-only row (echo, error) anchored at the current live edge. */
  private appendLocal(snapshot: ChatSnapshot, item: TranscriptItem): ChatSnapshot {
    this.localRows = [...this.localRows, { anchor: this.accumulator.rows().length, item }];
    return this.project(snapshot);
  }

  /** Remove viewer/transport failures from the transcript. They are connection UI, not chat history. */
  private scrubTransportErrors(snapshot: ChatSnapshot): ChatSnapshot {
    const next = this.localRows.filter(({ item }) => item.kind !== "error" || !isTransportError(item.message));
    if (next.length === this.localRows.length) return snapshot;
    this.localRows = next;
    return this.project(snapshot);
  }

  /** Consecutive identical failures (reconnect loops) must read as one event. */
  private appendError(snapshot: ChatSnapshot, message: string, retryable?: boolean): ChatSnapshot {
    const last = snapshot.transcript[snapshot.transcript.length - 1];
    if (last?.kind === "error" && last.message === message) return snapshot;
    return this.appendLocal(snapshot, {
      kind: "error",
      id: this.id("err"),
      message,
      occurredAt: Date.now(),
      ...(retryable ? { retryable: true } : {}),
    });
  }

  private reduce(snapshot: ChatSnapshot, message: SDKMessage): ChatSnapshot {
    switch (message.type) {
      case "init":
        // Session metadata (agent, model, tools) — NOT a turn starting. Opening
        // a conversation initializes a session for hydration, so treating this
        // as "running" made a freshly-opened chat claim a turn was in flight.
        return snapshot;

      // Identity, delta accumulation and replay suppression all live in the
      // accumulator now — these cases only mark the run as active.
      case "stream_event":
        return this.absorb(snapshot, message);

      case "assistant":
      case "reasoning":
        return this.absorb(snapshot, message);

      case "tool_call":
        this.toolStartedAt.set(message.toolCallId, Date.now());
        return this.absorb(snapshot, message);

      case "tool_result":
        return this.absorb(snapshot, message);

      case "queue_update":
        return patch(snapshot, {
          queue: message.queue.map((item) => ({ id: item.id, text: contentToText(item.content) })),
        });

      case "loop_status": {
        // Server vocabulary is SCREAMING_SNAKE and grows over time. The
        // WAITING_* family means the loop is parked — on the user, or on an
        // approval — not working; treating any non-"idle" string as running is
        // what used to make a freshly-opened chat show a phantom turn, since
        // opening one reports WAITING_ON_INPUT.
        const status = message.status.toUpperCase();
        if (status === "WAITING_ON_APPROVAL") {
          return this.project(patch(snapshot, { run: "awaiting_approval" }));
        }
        if (!status.startsWith("WAITING") && status !== "IDLE") {
          return this.project(patch(snapshot, { run: snapshot.run === "idle" ? "running" : snapshot.run }));
        }
        // Device status is more authoritative than loop bookkeeping. A freshly
        // reattached viewer can report WAITING_ON_INPUT while the executing
        // device is still processing the pre-existing turn. Never let that
        // transient viewer status erase a confirmed active run.
        if (this.deviceIsProcessing) {
          return this.project(patch(snapshot, { run: "running" }));
        }
        // Interruption is `result`'s call — a normal completion also lands here,
        // and marking the last row "Stopped" from this path would libel it.
        return this.project(patch(snapshot, { run: "idle" }));
      }

      case "result": {
        const detail = message.errorDetail ?? message.error ?? "The run failed.";
        if (!message.success && isTransportError(detail)) {
          return patch(this.project(snapshot), {
            run: preserveRunAcrossTransportLoss(snapshot.run),
            connection: "reconnecting",
          });
        }
        this.deviceIsProcessing = false;
        // An aborted turn completes as a result with stopReason "interrupted"
        // and no settled assistant message, so the row it left behind is the
        // only place "Stopped" can be shown.
        const interrupted = !message.success || message.stopReason === "interrupted";
        this.interruptedKey = interrupted ? newestTextKey(this.accumulator.rows()) : null;
        const idle = this.project(patch(snapshot, { run: "idle" }));
        return message.success ? idle : this.appendError(idle, detail);
      }

      case "error": {
        const detail =
          message.message ||
          ((message as { code?: string }).code
            ? `The server rejected the request (${(message as { code?: string }).code}).`
            : "Something went wrong on the server.");
        if (isTransportError(detail)) {
          return patch(this.project(snapshot), {
            run: preserveRunAcrossTransportLoss(snapshot.run),
            connection: "reconnecting",
          });
        }
        this.interruptedKey = newestTextKey(this.accumulator.rows());
        return this.appendError(this.project(snapshot), detail);
      }

      case "retry":
      default:
        return snapshot;
    }
  }
}



/** Restate one tool card's status; no-op when the call isn't in the transcript. */
function historyMessageId(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function isUserHistoryMessage(message: unknown): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      (message as { message_type?: unknown }).message_type === "user_message",
  );
}

function containsUserMessage(messages: readonly unknown[]): boolean {
  return messages.some(isUserHistoryMessage);
}

/**
 * Transport-class failures are the ConnectionBanner's to report — a transcript
 * row would double-report and outlive the outage (remodex filters the same
 * classes out of its persistent footer error slot).
 */
function isTransportError(message: string): boolean {
  return /network|socket|connect|timed?\s?out|closed|unavailable|offline|interrupt|stream ended/i.test(message);
}
