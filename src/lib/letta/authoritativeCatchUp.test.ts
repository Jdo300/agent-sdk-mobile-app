import { describe, expect, test } from "bun:test";

import { shouldReconnectSilentSend } from "./authoritativeCatchUp";

describe("send transport liveness", () => {


  test("rebuilds a send transport only when accepted send activity stays silent", () => {
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "running", connection: "connected", serverProcessing: false })).toBe(true);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "running", connection: "connected", serverProcessing: true })).toBe(false);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 5, run: "running", connection: "connected", serverProcessing: false })).toBe(false);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "idle", connection: "connected", serverProcessing: false })).toBe(false);
  });

});
