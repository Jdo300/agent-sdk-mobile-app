import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "./model";

// Mirror the deliberately shallow visible-field equality used by ChatSession's
// projection cache. Nested payload objects are not projected into transcript
// rows; tool input/result are already formatted strings.
function sameTranscriptItem(a: TranscriptItem, b: TranscriptItem): boolean {
  if (a.kind !== b.kind || a.id !== b.id) return false;
  const aa = a as unknown as Record<string, unknown>;
  const bb = b as unknown as Record<string, unknown>;
  const keys = Object.keys(aa);
  if (keys.length !== Object.keys(bb).length) return false;
  return keys.every((key) => Object.is(aa[key], bb[key]));
}

describe("projected transcript identity", () => {
  test("unchanged visible rows are reusable across stream projections", () => {
    const a: TranscriptItem = { kind: "assistant", id: "a", text: "done", occurredAt: 123 };
    const b: TranscriptItem = { kind: "assistant", id: "a", text: "done", occurredAt: 123 };
    expect(sameTranscriptItem(a, b)).toBe(true);
  });

  test("a streaming text change invalidates only that row", () => {
    const a: TranscriptItem = { kind: "assistant", id: "a", text: "hel", streaming: true };
    const b: TranscriptItem = { kind: "assistant", id: "a", text: "hello", streaming: true };
    expect(sameTranscriptItem(a, b)).toBe(false);
  });

  test("tool status/output changes invalidate the tool row", () => {
    const a: TranscriptItem = { kind: "tool", id: "t", toolCallId: "c", name: "Bash", summary: "Run tests", status: "running" };
    const b: TranscriptItem = { kind: "tool", id: "t", toolCallId: "c", name: "Bash", summary: "Run tests", status: "success", result: "ok" };
    expect(sameTranscriptItem(a, b)).toBe(false);
  });
});
