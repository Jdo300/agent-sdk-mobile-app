/**
 * Voice HTTP endpoints share the same public origin/tunnel as the active Letta
 * WebSocket profile. Never pin mobile voice traffic to a LAN address.
 */
export function voiceHttpBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) throw new Error("The Local Milo server URL is unavailable.");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("The Local Milo server URL is invalid.");
  }
  if (parsed.protocol === "wss:") parsed.protocol = "https:";
  else if (parsed.protocol === "ws:") parsed.protocol = "http:";
  else if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The Local Milo server URL must use ws:// or wss://.");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}
