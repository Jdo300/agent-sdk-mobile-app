/**
 * The SDK's accumulator owns row identity, delta accumulation and replay
 * suppression, and is tested upstream. What this app still owns is the
 * projection into its render vocabulary — the caret, think durations, and the
 * two tool states that have no wire equivalent. Those are what these pin.
 */
import { describe, expect, it } from "bun:test";

import type { TranscriptRow } from "@letta-ai/letta-agent-sdk/client";
import { newestTextKey, projectRow, projectRows, userRowOtids, type ProjectionState } from "./transcriptProjection";
import type { ToolItem, ToolStatus } from "./model";

const base: ProjectionState = {
  liveKey: null,
  interruptedKey: null,
  toolStatusOverride: new Map<string, ToolStatus>(),
  thinkStartedAt: new Map(),
  thinkSeconds: new Map(),
  toolDurationMs: new Map(),
  rowOccurredAt: new Map(),
  toolCompletedAt: new Map(),
};

function text(kind: "user" | "assistant" | "reasoning", key: string, value: string): TranscriptRow {
  return { kind, key, text: value } as TranscriptRow;
}
function tool(key: string, status: "streaming" | "ready" | "complete", result?: { content: string; isError: boolean }): TranscriptRow {
  return {
    kind: "tool_call",
    key,
    toolCallId: `call-${key}`,
    toolName: "shell",
    toolInput: { command: "npm test" },
    argumentsComplete: true,
    status,
    ...(result ? { result } : {}),
  } as TranscriptRow;
}

describe("transcript projection", () => {
  it("marks only the live row as streaming", () => {
    const rows = [text("assistant", "a1", "older"), text("assistant", "a2", "newer")];
    const items = projectRows(rows, { ...base, liveKey: "a2" });
    expect(items[0]).toMatchObject({ kind: "assistant", text: "older" });
    expect((items[0] as { streaming?: boolean }).streaming).toBeUndefined();
    expect(items[1]).toMatchObject({ streaming: true });
  });

  it("renders an abandoned row as interrupted", () => {
    const item = projectRow(text("assistant", "a1", "half a thought"), { ...base, interruptedKey: "a1" });
    expect(item).toMatchObject({ interrupted: true });
  });

  it("keeps a denial over the error tool_result that follows it", () => {
    const row = tool("t1", "complete", { content: "denied by user", isError: true });
    const state = { ...base, toolStatusOverride: new Map([["call-t1", "denied" as ToolStatus]]) };
    expect((projectRow(row, state) as ToolItem).status).toBe("denied");
  });

  it("maps settled tool outcomes to success and error", () => {
    expect((projectRow(tool("t1", "complete", { content: "ok", isError: false }), base) as ToolItem).status).toBe("success");
    expect((projectRow(tool("t2", "complete", { content: "boom", isError: true }), base) as ToolItem).status).toBe("error");
    expect((projectRow(tool("t3", "streaming"), base) as ToolItem).status).toBe("running");
  });

  it("surfaces a recorded duration and omits it when unknown", () => {
    const withDuration = projectRow(tool("t1", "complete", { content: "ok", isError: false }), {
      ...base,
      toolDurationMs: new Map([["call-t1", 812]]),
    }) as ToolItem;
    expect(withDuration.durationMs).toBe(812);
    expect((projectRow(tool("t2", "complete", { content: "ok", isError: false }), base) as ToolItem).durationMs).toBeUndefined();
  });

  it("reports settled think time and leaves a live think at zero", () => {
    const rows = [text("reasoning", "r1", "thinking…")];
    const settled = projectRows(rows, { ...base, thinkSeconds: new Map([["r1", 3]]) });
    expect(settled[0]).toMatchObject({ seconds: 3 });
    const live = projectRows(rows, { ...base, liveKey: "r1" });
    expect(live[0]).toMatchObject({ seconds: 0, streaming: true });
  });

  it("strips system-reminder wrappers from user rows", () => {
    const item = projectRow(
      text("user", "u1", "<system-reminder>ignore me</system-reminder>Real question?"),
      base,
    );
    expect(item).toMatchObject({ kind: "user", text: "Real question?" });
  });

  it("does not treat assistant/reasoning rows with a turn OTID as the persisted user echo", () => {
    const rows = [
      { ...text("assistant", "a1", "reply"), otid: "turn-1" } as TranscriptRow,
      { ...text("reasoning", "r1", "thinking"), otid: "turn-1" } as TranscriptRow,
    ];
    expect(userRowOtids(rows).has("turn-1")).toBe(false);

    rows.push({ ...text("user", "u1", "question"), otid: "turn-1" } as TranscriptRow);
    expect(userRowOtids(rows).has("turn-1")).toBe(true);
  });

  it("finds the newest text row, ignoring tool rows after it", () => {
    expect(newestTextKey([text("assistant", "a1", "x"), tool("t1", "complete")])).toBe("a1");
    expect(newestTextKey([tool("t1", "complete")])).toBeNull();
  });
});
