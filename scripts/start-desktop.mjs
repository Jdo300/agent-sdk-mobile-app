#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";

const WEB_HOST = "127.0.0.1";
const WEB_PORT = Number(process.env.BLOOP_WEB_PORT ?? 8082);
const EXPO_PORT = Number(process.env.BLOOP_EXPO_PORT ?? 8083);
const LOCAL_PROFILE_ID = "profile-local-milo-office";
const LOCAL_PROFILE_NAME = process.env.BLOOP_LOCAL_PROFILE_NAME ?? "Local Milo";
const LOCAL_TARGET = process.env.BLOOP_LOCAL_TARGET ?? "ws://10.0.0.128:4610";
const LOCAL_TOKEN_FILE = process.env.BLOOP_LOCAL_TOKEN_FILE ?? `${process.env.HOME}/.config/bloop/local-milo-token`;

function localHttpTarget() {
  const parsed = new URL(LOCAL_TARGET);
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}




function localCapabilityToken() {
  const token = readFileSync(LOCAL_TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error(`Local Milo token file is empty: ${LOCAL_TOKEN_FILE}`);
  return token;
}



let shuttingDown = false;

const LOCAL_VOICE_TARGET = process.env.BLOOP_LOCAL_VOICE_TARGET ?? localHttpTarget();
const localVoiceProxy = httpProxy.createProxyServer({
  target: LOCAL_VOICE_TARGET,
  changeOrigin: false,
});
localVoiceProxy.on("proxyReq", (proxyRequest) => {
  proxyRequest.setHeader("Authorization", `Bearer ${localCapabilityToken()}`);
});
localVoiceProxy.on("error", (_error, _req, response) => {
  if (response && "writeHead" in response && !response.headersSent) {
    response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("Local Milo voice service is unavailable");
  }
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
  if (requestUrl.pathname.startsWith("/__bloop/local-milo/voice/")) {
    // The browser never receives Local Milo's capability token. This loopback-only
    // host proxy injects it server-side and forwards Range headers for seekable audio.
    request.url = `${requestUrl.pathname.replace("/__bloop/local-milo", "")}${requestUrl.search}`;
    localVoiceProxy.web(request, response);
    return;
  }
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

const bridgeScript = fileURLToPath(new URL("./start-ws-bridge.mjs", import.meta.url));
const bridgeProcess = spawn(process.execPath, [bridgeScript], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
});
bridgeProcess.on("exit", (code, signal) => {
  if (shuttingDown) return;
  console.error(`RG Agent Link WebSocket bridge exited unexpectedly (code=${code ?? "none"}, signal=${signal ?? "none"})`);
  shutdown("SIGTERM");
});

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  expo.kill(signal);
  bridgeProcess.kill(signal);
  proxy.close();
  localVoiceProxy.close();
  web.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
expo.on("exit", (code) => {
  bridge.close(() => process.exit(code ?? 0));
});
