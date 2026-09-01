import { describe, expect, test } from "bun:test";
import { inspectPersistedHistory, persistedHistoryFingerprint, ProtocolObserver, isGenerationCurrent } from "./protocolHardening";

describe("protocol hardening", () => {
  test("drops duplicate/out-of-order seq replay and reports gaps", () => {
    const observer = new ProtocolObserver();
    expect(observer.observe({ type: "stream_event", uuid: "wire-1", event: { message_type: "assistant_message", id: "u1", run_id: "r1", seq_id: 1 } }).accept).toBe(true);
    const gap = observer.observe({ type: "stream_event", uuid: "wire-2", event: { message_type: "assistant_message", id: "u2", run_id: "r1", seq_id: 3 } });
    expect(gap.accept).toBe(true);
    expect(gap.events.some((event) => event.kind === "protocol_gap")).toBe(true);
    const replay = observer.observe({ type: "stream_event", uuid: "wire-old", event: { message_type: "assistant_message", id: "u1", run_id: "r1", seq_id: 1 } });
    expect(replay.accept).toBe(true);
    expect(replay.events.some((event) => event.kind === "protocol_replay")).toBe(true);
  });

  test("reports missing run/sequence metadata without dropping the event", () => {
    const result = new ProtocolObserver().observe({ type: "assistant", content: "a", uuid: "u1" });
    expect(result.accept).toBe(true);
    expect(result.events.some((event) => event.kind === "protocol_identity_missing")).toBe(true);
  });

  test("validates persisted stable ids without reading content", () => {
    expect(inspectPersistedHistory([
      { id: "m1", message_type: "user_message", content: "secret-looking-but-ignored" },
      { id: "m1", message_type: "assistant_message", content: "also ignored" },
      { message_type: "tool_return_message", tool_return: "ignored" },
    ])).toEqual({ visibleCount: 3, missingIdCount: 1, duplicateIdCount: 1 });
  });

  test("observes more than 400 wire events without losing the highest cursor", () => {
    const observer = new ProtocolObserver();
    for (let seq = 1; seq <= 500; seq += 1) {
      const result = observer.observe({
        type: "stream_event",
        uuid: `wire-${seq}`,
        event: { message_type: "assistant_message", id: `m-${seq}`, run_id: "large-run", seq_id: seq },
      });
      expect(result.events.some((event) => event.kind === "protocol_gap")).toBe(false);
    }
    const replay = observer.observe({
      type: "stream_event",
      uuid: "wire-replay",
      event: { message_type: "assistant_message", id: "m-250", run_id: "large-run", seq_id: 250 },
    });
    expect(replay.events.some((event) => event.kind === "protocol_replay")).toBe(true);
  });



  test("generation equality is the only stale-result admission rule", () => {
    expect(isGenerationCurrent(4, 4)).toBe(true);
    expect(isGenerationCurrent(4, 5)).toBe(false);
  });
  test("fingerprints persisted identity/order without reading content", () => {
    const a = persistedHistoryFingerprint([
      { id: "m1", content: "first secret" },
      { id: "m2", content: "second secret" },
    ]);
    const sameIdsDifferentContent = persistedHistoryFingerprint([
      { id: "m1", content: "changed" },
      { id: "m2", content: "also changed" },
    ]);
    const reversed = persistedHistoryFingerprint([{ id: "m2" }, { id: "m1" }]);
    expect(a).toBe(sameIdsDifferentContent);
    expect(reversed).not.toBe(a);
  });

});
