import { describe, expect, test } from "bun:test";

import { isAuthoritativeCatchUpCurrent, shouldReconnectSilentSend } from "./authoritativeCatchUp";

describe("authoritative catch-up cancellation guard", () => {
  test("rejects a fetched tail after send invalidates its generation", () => {
    const session = {};

    expect(isAuthoritativeCatchUpCurrent(false, session, session, 3, 4)).toBe(false);
  });

  test("requires the active session to remain open and unchanged", () => {
    const session = {};

    expect(isAuthoritativeCatchUpCurrent(true, session, session, 3, 3)).toBe(false);
    expect(isAuthoritativeCatchUpCurrent(false, {}, session, 3, 3)).toBe(false);
    expect(isAuthoritativeCatchUpCurrent(false, session, session, 3, 3)).toBe(true);
  });


  test("rebuilds a send transport only when accepted send activity stays silent", () => {
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "running", connection: "connected", serverProcessing: false })).toBe(true);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "running", connection: "connected", serverProcessing: true })).toBe(false);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 5, run: "running", connection: "connected", serverProcessing: false })).toBe(false);
    expect(shouldReconnectSilentSend({ closed: false, serialBeforeSend: 4, currentSerial: 4, run: "idle", connection: "connected", serverProcessing: false })).toBe(false);
  });

});
