import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  exchangeAuthorizationCode,
  parseOAuthCredential,
  refreshOAuthCredential,
  revokeOAuthCredential,
  type OAuthCredential,
} from "./oauthTokens";

const realFetch = globalThis.fetch;
const realNow = Date.now;

beforeEach(() => {
  Date.now = () => 1_000_000;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

describe("OAuth token exchange", () => {
  test("exchanges a PKCE authorization code", async () => {
    let requestBody: Record<string, string> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json({
        access_token: "access-synthetic",
        refresh_token: "refresh-synthetic",
        expires_in: 3600,
      });
    }) as typeof fetch;

    const credential = await exchangeAuthorizationCode({
      clientId: "client-public",
      code: "code-synthetic",
      codeVerifier: "verifier-synthetic",
      redirectUri: "letta-mobile://oauth/callback",
    });

    expect(requestBody).toEqual({
      grant_type: "authorization_code",
      client_id: "client-public",
      code: "code-synthetic",
      code_verifier: "verifier-synthetic",
      redirect_uri: "letta-mobile://oauth/callback",
    });
    expect(credential).toEqual({
      kind: "oauth",
      accessToken: "access-synthetic",
      refreshToken: "refresh-synthetic",
      expiresAt: 4_600_000,
    });
  });

  test("rejects an incomplete token response", async () => {
    globalThis.fetch = (async () => Response.json({ access_token: "access-only" })) as typeof fetch;

    await expect(
      exchangeAuthorizationCode({
        clientId: "client-public",
        code: "code-synthetic",
        codeVerifier: "verifier-synthetic",
        redirectUri: "letta-mobile://oauth/callback",
      }),
    ).rejects.toThrow("incomplete sign-in response");
  });
});

describe("OAuth token refresh", () => {
  const oldCredential: OAuthCredential = {
    kind: "oauth",
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: 900_000,
  };

  test("preserves the refresh token when the server does not rotate it", async () => {
    globalThis.fetch = (async () =>
      Response.json({ access_token: "access-new", expires_in: 7200 })) as typeof fetch;

    const refreshed = await refreshOAuthCredential(oldCredential, "client-public");

    expect(refreshed).toEqual({
      kind: "oauth",
      accessToken: "access-new",
      refreshToken: "refresh-old",
      expiresAt: 8_200_000,
    });
  });
});

describe("OAuth token revocation", () => {
  test("revokes the refresh token for the public client", async () => {
    let requestBody: Record<string, string> | null = null;
    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, string>;
      return Response.json({ success: true });
    }) as typeof fetch;

    await revokeOAuthCredential(
      {
        kind: "oauth",
        accessToken: "access-synthetic",
        refreshToken: "refresh-synthetic",
        expiresAt: 123,
      },
      "client-public",
    );

    expect(requestBody).toEqual({
      token: "refresh-synthetic",
      token_type_hint: "refresh_token",
      client_id: "client-public",
    });
  });
});

describe("stored OAuth credentials", () => {
  test("distinguishes OAuth credentials from API keys", () => {
    const credential: OAuthCredential = {
      kind: "oauth",
      accessToken: "access-synthetic",
      refreshToken: "refresh-synthetic",
      expiresAt: 123,
    };

    expect(parseOAuthCredential(JSON.stringify(credential))).toEqual(credential);
    expect(parseOAuthCredential("sk-synthetic")).toBeNull();
  });
});
