import { describe, expect, test } from "bun:test";
import {
  deriveDurableCursors,
  mergeBackwardMessages,
  mergeForwardMessages,
  normalizeDurableMessages,
  persistedUserAcknowledgements,
  persistedUserOtids,
} from "./durableSyncCore";

describe("durable sync core", () => {
  test("tracks backward and forward cursors independently", () => {
    expect(deriveDurableCursors([{ id: "m1" }, { id: "m2" }, { id: "m3" }], "older-than-m1")).toEqual({
      nextBefore: "older-than-m1",
      forwardAfter: "m3",
    });
    expect(deriveDurableCursors([], null)).toEqual({ nextBefore: null, forwardAfter: null });
  });

  test("appends forward pages and removes overlap by server id", () => {
    expect(mergeForwardMessages([{ id: "m1" }, { id: "m2" }], [{ id: "m2" }, { id: "m3" }])).toEqual([
      { id: "m1" }, { id: "m2" }, { id: "m3" },
    ]);
  });

  test("prepends older pages without disturbing current order", () => {
    expect(mergeBackwardMessages([{ id: "m3" }, { id: "m4" }], [{ id: "m1" }, { id: "m2" }, { id: "m3" }])).toEqual([
      { id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" },
    ]);
  });

  test("normalizes duplicate durable identities before SQLite persistence", () => {
    const older = { id: "m2", message_type: "assistant_message", content: "partial" };
    const newer = { id: "m2", message_type: "assistant_message", content: "final" };
    expect(normalizeDurableMessages([
      { id: "m1" }, older, { otid: "turn-3", content: "old" }, newer, { otid: "turn-3", content: "new" }, { content: "anonymous" },
    ])).toEqual([
      { id: "m1" },
      newer,
      { otid: "turn-3", content: "new" },
      { content: "anonymous" },
    ]);
  });

  test("concurrent older-page and forward catch-up converge to the same canonical window", () => {
    const base = [{ id: "m3" }, { id: "m4" }];
    const older = [{ id: "m1" }, { id: "m2" }, { id: "m3" }];
    const newer = [{ id: "m4" }, { id: "m5" }, { id: "m6" }];
    const olderThenForward = mergeForwardMessages(mergeBackwardMessages(base, older), newer);
    const forwardThenOlder = mergeBackwardMessages(mergeForwardMessages(base, newer), older);
    expect(olderThenForward).toEqual(forwardThenOlder);
    expect(olderThenForward.map((message: any) => message.id)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  test("extracts only persisted user OTIDs", () => {
    expect(persistedUserOtids([
      { id: "m1", message_type: "user_message", otid: "turn-1" },
      { message_type: "assistant_message", otid: "turn-2" },
      { id: "m1", message_type: "user_message", otid: "turn-1" },
    ])).toEqual(["turn-1"]);
  });
  test("requires persisted UUID before an OTID counts as acknowledged", () => {
    const messages = [
      { message_type: "user_message", otid: "turn-unpersisted" },
      { id: "msg-persisted", message_type: "user_message", otid: "turn-persisted" },
    ];
    expect(persistedUserOtids(messages)).toEqual(["turn-persisted"]);
    expect(persistedUserAcknowledgements(messages).get("turn-persisted")).toBe("msg-persisted");
  });

});
