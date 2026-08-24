#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";
import { WebSocket, WebSocketServer } from "ws";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 4612;
const TOKEN_PROTOCOL_PREFIX = "letta-bearer.";
const NO_AUTH_PROTOCOL = "letta-noauth";

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

const bridge = new WebSocketServer({
  host: BRIDGE_HOST,
  port: BRIDGE_PORT,
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
  }

  const upstream = new WebSocket(target.toString(), {
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  });
  const queued = [];

  browser.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queued.push([data, isBinary]);
  });
  upstream.on("open", () => {
    for (const [data, isBinary] of queued.splice(0)) upstream.send(data, { binary: isBinary });
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
  upstream.on("close", (code, reason) => closePeer(browser, code || 1000, reason.toString()));
  browser.on("error", () => closePeer(upstream, 1011, "Browser socket error"));
  upstream.on("error", () => closePeer(browser, 1011, "App Server connection error"));
});

bridge.on("listening", () => {
  console.log(`Bloop desktop WebSocket bridge listening on ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
});

const bunx = `${process.env.HOME}/.bun/bin/bunx`;
const expo = spawn(bunx, ["expo", "start", "--web", "--localhost", "--port", "8082"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, BROWSER: "none" },
});

function shutdown(signal = "SIGTERM") {
  expo.kill(signal);
  bridge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
expo.on("exit", (code) => {
  bridge.close(() => process.exit(code ?? 0));
});
