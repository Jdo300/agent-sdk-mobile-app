import { describe, expect, it } from "bun:test";

import { coalesceReasoningRuns, groupToolRuns, type ToolGroupItem } from "./grouping";
import type { ToolItem, TranscriptItem } from "./model";

function tool(id: string, status: ToolItem["status"] = "success", name = "shell"): ToolItem {
  return { kind: "tool", id, toolCallId: id, name, summary: id, status };
}
const prose: TranscriptItem = { kind: "assistant", id: "a1", text: "done" };
const none = new Set<string>();

describe("groupToolRuns", () => {

  it("coalesces adjacent reasoning slices from the same run", () => {
    const rows = coalesceReasoningRuns([
      { kind: "reasoning", id: "r1", runId: "run-1", text: "first", seconds: 1, startedAt: 1000 },
      { kind: "reasoning", id: "r2", runId: "run-1", text: "second", seconds: 0, startedAt: 2000, streaming: true },
      prose,
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "reasoning",
      id: "r1",
      runId: "run-1",
      text: "first\nsecond",
      startedAt: 1000,
      streaming: true,
    });
  });

  it("does not merge reasoning across different runs", () => {
    const rows = coalesceReasoningRuns([
      { kind: "reasoning", id: "r1", runId: "run-1", text: "first", seconds: 1 },
      { kind: "reasoning", id: "r2", runId: "run-2", text: "second", seconds: 1 },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("leaves short runs as individual cards", () => {
    const rows = groupToolRuns([tool("t1"), tool("t2"), prose], none);
    expect(rows.map((r) => r.kind)).toEqual(["tool", "tool", "assistant"]);
  });

  it("collapses three or more consecutive settled calls", () => {
    const rows = groupToolRuns([tool("t1"), tool("t2"), tool("t3"), prose], none);
    expect(rows.map((r) => r.kind)).toEqual(["toolGroup", "assistant"]);
    const group = rows[0] as ToolGroupItem;
    expect(group.tools).toHaveLength(3);
    expect(group.id).toBe("toolgroup-t1");
  });

  it("counts failures so the row can justify expanding", () => {
    const rows = groupToolRuns([tool("t1"), tool("t2", "error"), tool("t3", "denied")], none);
    expect((rows[0] as ToolGroupItem).failed).toBe(2);
  });

  it("re-inlines members when expanded, keeping ids unique", () => {
    const rows = groupToolRuns(
      [tool("t1"), tool("t2"), tool("t3")],
      new Set(["toolgroup-t1"]),
    );
    expect(rows.map((r) => r.kind)).toEqual(["toolGroup", "tool", "tool", "tool"]);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps a live call standalone so a running turn stays legible", () => {
    const rows = groupToolRuns(
      [tool("t1"), tool("t2"), tool("t3"), tool("t4", "running")],
      none,
    );
    expect(rows.map((r) => r.kind)).toEqual(["toolGroup", "tool"]);
    expect((rows[1] as ToolItem).status).toBe("running");
  });

  it("splits runs separated by prose instead of merging across it", () => {
    const rows = groupToolRuns(
      [tool("t1"), tool("t2"), tool("t3"), prose, tool("t4"), tool("t5"), tool("t6")],
      none,
    );
    expect(rows.map((r) => r.kind)).toEqual(["toolGroup", "assistant", "toolGroup"]);
  });

  it("passes a transcript with no tools through untouched", () => {
    const rows = groupToolRuns([prose], none);
    expect(rows).toEqual([prose]);
  });
});
