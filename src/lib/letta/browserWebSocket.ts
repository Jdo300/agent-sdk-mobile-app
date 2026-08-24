/**
 * Browser adapter for authenticated remote App Server WebSockets.
 *
 * Browsers cannot set Authorization headers on a WebSocket upgrade. The Linux
 * desktop launcher runs a loopback-only bridge which accepts the bearer token
 * as an opaque WebSocket subprotocol and adds the header on the upstream socket.
 * The token never appears in a URL.
 */

const BRIDGE_URL = "ws://127.0.0.1:4612";
const TOKEN_PROTOCOL_PREFIX = "letta-bearer.";
const NO_AUTH_PROTOCOL = "letta-noauth";

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

export function createBrowserBridgeWebSocketConstructor(
  BrowserWebSocket: typeof globalThis.WebSocket,
): new (url: string, options?: { headers?: Record<string, string> }) => WebSocket {
  class BrowserBridgeWebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      const bridge = new URL(BRIDGE_URL);
      bridge.searchParams.set("target", url);
      const authorization = options?.headers?.Authorization ?? options?.headers?.authorization ?? "";
      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      const protocol = match?.[1]
        ? `${TOKEN_PROTOCOL_PREFIX}${base64UrlEncode(match[1])}`
        : NO_AUTH_PROTOCOL;
      return new BrowserWebSocket(bridge.toString(), protocol);
    }
  }
  return BrowserBridgeWebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> },
  ) => WebSocket;
}
