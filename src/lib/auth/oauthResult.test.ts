import { describe, expect, test } from "bun:test";

import {
  authorizationCodeFromResult,
  OAuthCancelledError,
} from "./oauthResult";

describe("OAuth browser results", () => {
  test("returns an authorization code", () => {
    expect(
      authorizationCodeFromResult({ type: "success", params: { code: "code-synthetic" } }),
    ).toBe("code-synthetic");
  });

  test("reports browser cancellation without exchanging a code", () => {
    expect(() => authorizationCodeFromResult({ type: "cancel" })).toThrow(OAuthCancelledError);
  });

  test("surfaces an OAuth error without exposing request data", () => {
    expect(() =>
      authorizationCodeFromResult({
        type: "error",
        params: {},
        error: { description: "Access denied" },
      }),
    ).toThrow("Access denied");
  });
});
