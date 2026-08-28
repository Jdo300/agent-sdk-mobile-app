import { describe, expect, test } from "bun:test";

import { isAuthoritativeCatchUpCurrent } from "./authoritativeCatchUp";

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
});
