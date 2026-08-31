import { describe, expect, it } from "bun:test";

import { deliveryRecoveryAction, persistedUserOtids } from "./deliveryJournalCore";

describe("delivery journal core", () => {
  it("acknowledges only persisted user UUIDs", () => {
    expect(persistedUserOtids([
      { id: "m1", message_type: "user_message", otid: "turn-1" },
      { message_type: "user_message", otid: "not-persisted" },
      { id: "a1", message_type: "assistant_message", otid: "assistant-turn" },
      { id: "m1", message_type: "user_message", otid: "turn-1" },
    ])).toEqual(["turn-1"]);
  });

  it("never auto-replays an ambiguous handoff", () => {
    expect(deliveryRecoveryAction("queued")).toBe("replay");
    expect(deliveryRecoveryAction("sending")).toBe("delivery_unknown");
    expect(deliveryRecoveryAction("awaiting_echo")).toBe("delivery_unknown");
    expect(deliveryRecoveryAction("failed")).toBe("manual_retry");
  });
});
