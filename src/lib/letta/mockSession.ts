/**
 * Fixture-driven mock session.
 *
 * Plays a scripted sequence of chat-state mutations on a timer, producing the
 * same `ChatSnapshot` stream the real Agent SDK transport will produce in
 * milestone 6. Components are built and design-reviewed against this before
 * any live turn runs; it also powers the /gallery live-demo section and test
 * fixtures.
 */
import {
  emptyChat,
  type ApprovalRequest,
  type ChatSnapshot,
  type TranscriptItem,
} from "./model";

export interface ScriptStep {
  /** Delay before applying this step, ms. */
  after: number;
  apply: (snapshot: ChatSnapshot) => ChatSnapshot;
}

export type Unsubscribe = () => void;

/** Play a script, emitting a fresh snapshot per step. Returns a stop function. */
export function playScript(
  steps: ScriptStep[],
  onSnapshot: (snapshot: ChatSnapshot) => void,
  { loop = false, loopPauseMs = 2400 }: { loop?: boolean; loopPauseMs?: number } = {},
): Unsubscribe {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = (index: number, snapshot: ChatSnapshot) => {
    if (cancelled) return;
    if (index >= steps.length) {
      if (loop) timer = setTimeout(() => run(0, emptyChat), loopPauseMs);
      return;
    }
    const step = steps[index]!;
    timer = setTimeout(() => {
      if (cancelled) return;
      const next = step.apply(snapshot);
      onSnapshot(next);
      run(index + 1, next);
    }, step.after);
  };

  onSnapshot(emptyChat);
  run(0, emptyChat);
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

// ── Snapshot helpers (shared with the real transport later) ─────────────────

export function upsertItem(snapshot: ChatSnapshot, item: TranscriptItem): ChatSnapshot {
  const index = snapshot.transcript.findIndex((t) => t.id === item.id);
  const transcript =
    index === -1
      ? [...snapshot.transcript, item]
      : snapshot.transcript.map((t, i) => (i === index ? item : t));
  return { ...snapshot, transcript };
}

export function patch(snapshot: ChatSnapshot, changes: Partial<ChatSnapshot>): ChatSnapshot {
  return { ...snapshot, ...changes };
}

// ── The demo script: one full turn with every state ─────────────────────────

const approval: ApprovalRequest = {
  requestId: "req-1",
  toolCallId: "tc-2",
  toolName: "shell",
  summary: "Run shell command",
  input: "npm test -- reconnect",
  permissionSuggestions: [{ id: "ps-1", text: "Always allow npm test in this repo" }],
};

/** A complete streaming turn: send → think → tool → approval → stream → done. */
export const demoTurn: ScriptStep[] = [
  {
    after: 400,
    apply: (s) =>
      patch(upsertItem(s, { kind: "user", id: "u-1", text: "Why does the reconnect banner flicker?" }), {
        run: "running",
      }),
  },
  {
    after: 700,
    apply: (s) =>
      upsertItem(s, { kind: "reasoning", id: "r-1", text: "", seconds: 1, startedAt: Date.now(), streaming: true }),
  },
  {
    after: 800,
    apply: (s) => {
      // The row ticks from the startedAt set when the think began.
      const prev = s.transcript.find((t) => t.id === "r-1");
      return upsertItem(s, {
        kind: "reasoning",
        id: "r-1",
        text: "The banner unmounts between retry attempts;",
        seconds: 2,
        startedAt: prev?.kind === "reasoning" ? prev.startedAt : Date.now(),
        streaming: true,
      });
    },
  },
  {
    after: 600,
    apply: (s) =>
      upsertItem(s, {
        kind: "reasoning",
        id: "r-1",
        text: "The banner unmounts between retry attempts; the timer owner is the component itself.",
        seconds: 3,
      }),
  },
  {
    after: 300,
    apply: (s) =>
      upsertItem(s, {
        kind: "tool",
        id: "t-1",
        toolCallId: "tc-1",
        name: "read_file",
        summary: "src/net/reconnect.ts",
        status: "running",
      }),
  },
  {
    after: 1100,
    apply: (s) =>
      upsertItem(s, {
        kind: "tool",
        id: "t-1",
        toolCallId: "tc-1",
        name: "read_file",
        summary: "src/net/reconnect.ts",
        status: "success",
        durationMs: 800,
      }),
  },
  {
    after: 500,
    apply: (s) =>
      patch(
        upsertItem(s, {
          kind: "tool",
          id: "t-2",
          toolCallId: "tc-2",
          name: "shell",
          summary: "npm test -- reconnect",
          status: "awaiting_approval",
        }),
        { run: "awaiting_approval", approvals: [approval] },
      ),
  },
  {
    after: 2200,
    apply: (s) =>
      patch(
        upsertItem(s, {
          kind: "tool",
          id: "t-2",
          toolCallId: "tc-2",
          name: "shell",
          summary: "npm test -- reconnect · 14 passed",
          status: "success",
          durationMs: 5300,
        }),
        { run: "running", approvals: [] },
      ),
  },
  // Markdown-shaped answer: exercises bold, inline code, a fence (which the
  // block splitter must hold open mid-stream), and a tappable link.
  ...streamText(
    "a-1",
    "The banner flickers because the retry timer is cleared **before** the socket reports its final state. Debounce the `reconciling` phase before showing it:\n\n```ts\nconst settled = debounce(setPhase, 250);\nsocket.on(\"state\", settled);\n```\n\nSee [the Letta docs](https://docs.letta.com) for the reconnect contract.",
  ),
  {
    after: 300,
    apply: (s) => patch(s, { run: "idle" }),
  },
];

/** Expand a string into word-by-word streaming steps. */
function streamText(id: string, text: string): ScriptStep[] {
  const words = text.split(" ");
  const steps: ScriptStep[] = [];
  for (let i = 0; i < words.length; i += 3) {
    const partial = words.slice(0, i + 3).join(" ");
    const done = i + 3 >= words.length;
    steps.push({
      after: 90,
      apply: (s) =>
        upsertItem(s, { kind: "assistant", id, text: partial, streaming: !done }),
    });
  }
  return steps;
}
