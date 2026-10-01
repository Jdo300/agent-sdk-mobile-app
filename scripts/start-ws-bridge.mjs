#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BLOOP_BRIDGE_PORT ?? 4612);
const TOKEN_PROTOCOL_PREFIX = "letta-bearer.";
const NO_AUTH_PROTOCOL = "letta-noauth";
const LOCAL_TARGET = process.env.BLOOP_LOCAL_TARGET ?? "ws://10.0.0.128:4610";
const LOCAL_TOKEN_FILE = process.env.BLOOP_LOCAL_TOKEN_FILE ?? `${process.env.HOME}/.config/bloop/local-milo-token`;

function isLoopbackOrigin(origin) {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function normalizedWsTarget(value) {
  const parsed = new URL(value);
  parsed.hash = "";
  return parsed.toString();
}

function localCapabilityToken() {
  const token = readFileSync(LOCAL_TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error(`Local Milo token file is empty: ${LOCAL_TOKEN_FILE}`);
  return token;
}

function isLocalTarget(target) {
  try {
    return normalizedWsTarget(target) === normalizedWsTarget(LOCAL_TARGET);
  } catch {
    return false;
  }
}

const bridge = new WebSocketServer({
  host: BRIDGE_HOST,
  port: BRIDGE_PORT,
  autoPong: true,
  verifyClient: ({ origin }) => isLoopbackOrigin(origin),
  handleProtocols(protocols) {
    for (const protocol of protocols) {
      if (protocol === NO_AUTH_PROTOCOL || protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) return protocol;
    }
    return false;
  },
});

bridge.on("connection", (browser, request) => {
  let target;
  try {
    const requestUrl = new URL(request.url ?? "/", `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    target = new URL(requestUrl.searchParams.get("target") ?? "");
    if (target.protocol !== "ws:" && target.protocol !== "wss:") throw new Error("unsupported target");
  } catch {
    browser.close(1008, "Invalid App Server target");
    return;
  }

  let token = null;
  if (browser.protocol.startsWith(TOKEN_PROTOCOL_PREFIX)) {
    try {
      token = decodeBase64Url(browser.protocol.slice(TOKEN_PROTOCOL_PREFIX.length));
    } catch {
      browser.close(1008, "Invalid authentication token");
      return;
    }
  } else if (browser.protocol === NO_AUTH_PROTOCOL && isLocalTarget(target)) {
    try {
      token = localCapabilityToken();
    } catch {
      browser.close(1011, "Local Milo credential unavailable");
      return;
    }
  } else if (browser.protocol === NO_AUTH_PROTOCOL) {
    browser.close(1008, "Unauthenticated target is not allowlisted");
    return;
  }

  const upstream = new WebSocket(target.toString(), {
    autoPong: true,
    perMessageDeflate: false,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  const queued = [];
  let upstreamPingCount = 0;
  let lastUpstreamPingAt = null;

  browser.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, isBinary]);
  });
  upstream.on("open", () => {
    for (const [data, isBinary] of queued.splice(0)) upstream.send(data, { binary: isBinary });
  });
  upstream.on("ping", () => {
    upstreamPingCount += 1;
    lastUpstreamPingAt = Date.now();
    // ws autoPong is intentionally enabled. Do not send a second manual pong here.
  });
  upstream.on("message", (data, isBinary) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
  });

  const closePeer = (peer, code, reason) => {
    if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) {
      try { peer.close(code, reason); } catch { peer.terminate?.(); }
    }
  };
  browser.on("close", (code, reason) => closePeer(upstream, code || 1000, reason.toString()));
  upstream.on("close", (code, reason) => {
    const pingAge = lastUpstreamPingAt === null ? "none" : String(Date.now() - lastUpstreamPingAt);
    console.warn(`RG Agent Link upstream WebSocket closed code=${code} reason=${reason.toString() || "none"} pings=${upstreamPingCount} lastPingAgeMs=${pingAge}`);
    closePeer(browser, code || 1000, reason.toString());
  });
  browser.on("error", () => closePeer(upstream, 1011, "Browser socket error"));
  upstream.on("error", (error) => {
    console.warn(`RG Agent Link upstream WebSocket error: ${error.message}`);
    closePeer(browser, 1011, "App Server connection error");
  });
});

bridge.on("listening", () => {
  console.log(`RG Agent Link WebSocket bridge listening on ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
});

function shutdown() {
  bridge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
