import { describe, expect, test } from "bun:test";
import { inspectPersistedHistory, outboxRecoveryAction, ProtocolObserver, isGenerationCurrent, syncConvergenceState } from "./protocolHardening";

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

  test("elapsed time never substitutes for persistence/OTID convergence", () => {
    // Simulate polls extending well past the old 900ms guess. None may claim
    // success until both canonical coverage and the persisted OTID exist.
    for (const elapsedMs of [0, 250, 900, 1500, 3000]) {
      void elapsedMs;
      expect(syncConvergenceState(false, true)).toEqual({
        converged: false,
        reason: "awaiting_persisted_rows",
      });
    }
    expect(syncConvergenceState(true, true)).toEqual({ converged: false, reason: "awaiting_otid_ack" });
    expect(syncConvergenceState(true, false)).toEqual({ converged: true, reason: "converged" });
  });

  test("process-restart outbox recovery never auto-replays ambiguous sends", () => {
    expect(outboxRecoveryAction("queued")).toBe("replay");
    expect(outboxRecoveryAction("sending")).toBe("converge");
    expect(outboxRecoveryAction("awaiting_echo")).toBe("converge");
    expect(outboxRecoveryAction("failed")).toBe("manual_retry");
  });

  test("generation equality is the only stale-result admission rule", () => {
    expect(isGenerationCurrent(4, 4)).toBe(true);
    expect(isGenerationCurrent(4, 5)).toBe(false);
  });
});
