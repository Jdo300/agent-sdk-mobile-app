export const LETTA_OAUTH_BASE_URL = "https://platform.letta.com";
export const LETTA_OAUTH_TOKEN_URL = `${LETTA_OAUTH_BASE_URL}/api/oauth/token`;
export const LETTA_OAUTH_REVOKE_URL = `${LETTA_OAUTH_BASE_URL}/api/oauth/revoke`;
/**
 * General-purpose public client for Letta mobile apps. Public client IDs are
 * identifiers, not secrets, so this value is intentionally distributed with
 * the example. It accepts `letta-mobile://oauth/callback` and requires PKCE.
 */
export const LETTA_MOBILE_OAUTH_CLIENT_ID = "ci-let-94bf2d5e34984a684fb6b18880b6bc7d";

export interface OAuthCredential {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export class OAuthTokenError extends Error {}

export function getOAuthClientId(): string | null {
  return process.env.EXPO_PUBLIC_LETTA_OAUTH_CLIENT_ID?.trim() || LETTA_MOBILE_OAUTH_CLIENT_ID;
}

function tokenError(body: TokenResponseBody): OAuthTokenError {
  return new OAuthTokenError(
    body.error_description || body.error || "Letta Cloud could not complete sign-in.",
  );
}

async function requestTokens(body: Record<string, string>): Promise<TokenResponseBody> {
  const response = await fetch(LETTA_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as TokenResponseBody;
  if (!response.ok) throw tokenError(result);
  return result;
}

export async function exchangeAuthorizationCode(options: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<OAuthCredential> {
  const result = await requestTokens({
    grant_type: "authorization_code",
    client_id: options.clientId,
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
  });
  if (!result.access_token || !result.refresh_token || !result.expires_in) {
    throw new OAuthTokenError("Letta Cloud returned an incomplete sign-in response.");
  }
  return {
    kind: "oauth",
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

export async function refreshOAuthCredential(
  credential: OAuthCredential,
  clientId = getOAuthClientId(),
): Promise<OAuthCredential> {
  if (!clientId) throw new OAuthTokenError("OAuth is not configured in this build.");
  const result = await requestTokens({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: credential.refreshToken,
  });
  if (!result.access_token || !result.expires_in) {
    throw new OAuthTokenError("Letta Cloud returned an incomplete refresh response.");
  }
  return {
    kind: "oauth",
    accessToken: result.access_token,
    refreshToken: result.refresh_token || credential.refreshToken,
    expiresAt: Date.now() + result.expires_in * 1000,
  };
}

export async function revokeOAuthCredential(
  credential: OAuthCredential,
  clientId = getOAuthClientId(),
): Promise<void> {
  if (!clientId) return;
  const response = await fetch(LETTA_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: credential.refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }),
  });
  if (!response.ok) throw new OAuthTokenError("Letta Cloud could not revoke this sign-in.");
}

export function parseOAuthCredential(value: string): OAuthCredential | null {
  try {
    const parsed = JSON.parse(value) as Partial<OAuthCredential>;
    if (
      parsed.kind === "oauth" &&
      typeof parsed.accessToken === "string" &&
      typeof parsed.refreshToken === "string" &&
      typeof parsed.expiresAt === "number"
    ) {
      return parsed as OAuthCredential;
    }
  } catch {
    // API keys are stored as plain strings.
  }
  return null;
}
