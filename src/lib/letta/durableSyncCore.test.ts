import { describe, expect, test } from "bun:test";
import {
  deriveDurableCursors,
  mergeBackwardMessages,
  mergeForwardMessages,
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

  test("extracts only persisted user OTIDs", () => {
    expect(persistedUserOtids([
      { message_type: "user_message", otid: "turn-1" },
      { message_type: "assistant_message", otid: "turn-2" },
      { message_type: "user_message", otid: "turn-1" },
    ])).toEqual(["turn-1"]);
  });
});
