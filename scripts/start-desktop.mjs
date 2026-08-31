#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import process from "node:process";
import httpProxy from "http-proxy";
import { WebSocket, WebSocketServer } from "ws";

const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = Number(process.env.BLOOP_BRIDGE_PORT ?? 4612);
const WEB_HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.BLOOP_WEB_PORT ?? 8082);
const EXPO_PORT = Number(process.env.BLOOP_EXPO_PORT ?? 8083);
const TOKEN_PROTOCOL_PREFIX = "letta-bearer.";
const NO_AUTH_PROTOCOL = "letta-noauth";
const LOCAL_PROFILE_ID = "profile-local-milo-office";
const LOCAL_PROFILE_NAME = process.env.BLOOP_LOCAL_PROFILE_NAME ?? "Local Milo";
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
    // Tokenless browser connections are only allowed to the host-configured
    // Local Milo target. This keeps the office bootstrap convenient without
    // turning the loopback bridge into a generic unauthenticated proxy.
    browser.close(1008, "Unauthenticated target is not allowlisted");
    return;
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

const proxy = httpProxy.createProxyServer({
  target: `http://${WEB_HOST}:${EXPO_PORT}`,
  ws: true,
});
proxy.on("proxyRes", (proxyResponse) => {
  proxyResponse.headers["cross-origin-embedder-policy"] = "credentialless";
  proxyResponse.headers["cross-origin-opener-policy"] = "same-origin";
});
proxy.on("error", (_error, _req, response) => {
  if (response && "writeHead" in response && !response.headersSent) {
    response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("Bloop web server is starting");
  }
});
const web = http.createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${WEB_HOST}:${WEB_PORT}`);
  if (requestUrl.pathname === "/__bloop/bootstrap") {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify({
      profile: {
        id: LOCAL_PROFILE_ID,
        type: "remote",
        name: LOCAL_PROFILE_NAME,
        url: LOCAL_TARGET,
        lastTest: "ok",
        createdAt: 1,
      },
    }));
    return;
  }
  // Opening the office browser URL is the login experience. Profile bootstrap
  // happens in the provider before Agents loads; this redirect avoids the
  // generic connection picker on a machine dedicated to Local Milo.
  if (requestUrl.pathname === "/") {
    response.writeHead(302, { Location: "/agents" });
    response.end();
    return;
  }
  proxy.web(request, response);
});
web.on("upgrade", (request, socket, head) => proxy.ws(request, socket, head));
web.listen(WEB_PORT, WEB_HOST, () => {
  console.log(`Bloop desktop web proxy listening on http://${WEB_HOST}:${WEB_PORT}`);
});

const bunx = `${process.env.HOME}/.bun/bin/bunx`;
const expo = spawn(bunx, ["expo", "start", "--web", "--localhost", "--port", String(EXPO_PORT)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: { ...process.env, BROWSER: "none" },
});

function shutdown(signal = "SIGTERM") {
  expo.kill(signal);
  proxy.close();
  web.close();
  bridge.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
expo.on("exit", (code) => {
  bridge.close(() => process.exit(code ?? 0));
});
