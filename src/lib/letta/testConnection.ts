/**
 * "Test connection" — a real handshake with a specific verdict, run before a
 * profile can be saved (docs/design-doc.md §4.1).
 *
 * Cloud: an authenticated REST call to the Letta API.
 * Remote: a WebSocket upgrade to the app-server control channel. React
 * Native's WebSocket accepts headers via its third argument, so the
 * capability token rides the upgrade request like the SDK's Node path.
 */
import { createReactNativeWebSocketConstructor } from "@letta-ai/letta-agent-sdk/client";
import { createAppServerClient } from "@letta-ai/letta-code/app-server-client";
import type { ProfileType } from "../profiles/profiles";
import { createBrowserBridgeWebSocketConstructor, isBrowserRuntime } from "./browserWebSocket";

export type TestResult =
  | { ok: true; detail: string }
  | { ok: false; reason: "unauthorized" | "unreachable" | "invalid_url"; detail: string };

const TIMEOUT_MS = 8000;

export async function testConnection(
  type: ProfileType,
  url: string,
  secret: string,
): Promise<TestResult> {
  return type === "cloud" ? testCloud(url, secret) : testRemote(url, secret);
}

async function testCloud(baseUrl: string, apiKey: string): Promise<TestResult> {
  let target: string;
  try {
    target = new URL("/v1/agents/?limit=1", baseUrl).toString();
  } catch {
    return { ok: false, reason: "invalid_url", detail: "That URL doesn't look valid." };
  }
  try {
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized", detail: "Your credentials were rejected." };
    }
    if (!response.ok) {
      return { ok: false, reason: "unreachable", detail: `The server answered ${response.status}.` };
    }
    return { ok: true, detail: "Connected to Letta Cloud." };
  } catch {
    return { ok: false, reason: "unreachable", detail: "Couldn't reach the server." };
  }
}

async function testRemote(wsUrl: string, token: string): Promise<TestResult> {
  let target: URL;
  try {
    target = new URL(wsUrl);
    if (target.protocol === "http:") target.protocol = "ws:";
    if (target.protocol === "https:") target.protocol = "wss:";
    if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      return { ok: false, reason: "invalid_url", detail: "Use a ws:// or wss:// URL." };
    }
  } catch {
    return { ok: false, reason: "invalid_url", detail: "That URL doesn't look valid." };
  }

  const WebSocketCtor = isBrowserRuntime()
    ? createBrowserBridgeWebSocketConstructor(globalThis.WebSocket)
    : createReactNativeWebSocketConstructor(globalThis.WebSocket as never);
  const client = createAppServerClient({
    url: target.toString(),
    ...(token ? { authToken: token } : {}),
    WebSocket: WebSocketCtor as never,
    requestTimeoutMs: TIMEOUT_MS,
  });

  try {
    await client.connect();
    await client.info({ timeoutMs: TIMEOUT_MS });
    return { ok: true, detail: "Connected to the app-server." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|token|credential/i.test(message)) {
      return { ok: false, reason: "unauthorized", detail: "The token was rejected." };
    }
    return { ok: false, reason: "unreachable", detail: "Couldn't reach the server." };
  } finally {
    try {
      client.close();
    } catch {
      // Best-effort cleanup after a failed upgrade.
    }
  }
}
