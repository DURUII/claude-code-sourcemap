import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8788);
const maxEvents = Number(process.env.HTTP_VISUALIZER_MAX_EVENTS || 200);
const events = [];
const clients = new Set();

export function normalizeEvent(input) {
  const raw = input && typeof input === "object" ? input : {};
  const payload = raw.payload ?? raw;
  const metadata = payload && typeof payload === "object" ? payload.metadata : undefined;
  const parsedUserMetadata = parseUserMetadata(metadata?.user_id);
  const sessionId =
    typeof raw.sessionId === "string"
      ? raw.sessionId
      : typeof raw.session_id === "string"
        ? raw.session_id
        : typeof parsedUserMetadata.session_id === "string"
          ? parsedUserMetadata.session_id
          : "sessionless";
  const agentId =
    typeof raw.agentId === "string"
      ? raw.agentId
      : typeof raw.agent_id === "string"
        ? raw.agent_id
        : inferAgentId(raw.querySource);
  const handleId =
    typeof raw.handleId === "string"
      ? raw.handleId
      : typeof raw.handle === "string"
        ? raw.handle
        : typeof metadata?.http_visualizer_handle === "string"
          ? metadata.http_visualizer_handle
          : typeof raw.requestId === "string"
            ? raw.requestId
            : randomUUID();
  return {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    sessionId,
    agentId,
    handleId,
    type: typeof raw.type === "string" ? raw.type : "event",
    source: typeof raw.source === "string" ? raw.source : "unknown",
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    querySource: typeof raw.querySource === "string" ? raw.querySource : undefined,
    attempt: Number.isFinite(raw.attempt) ? raw.attempt : undefined,
    requestId: typeof raw.requestId === "string" ? raw.requestId : undefined,
    payload
  };
}

function parseUserMetadata(value) {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function inferAgentId(querySource) {
  if (typeof querySource !== "string") return undefined;
  if (!querySource.startsWith("agent:")) return undefined;
  return querySource.slice("agent:".length) || undefined;
}

export function summarizePayload(payload) {
  const system = Array.isArray(payload?.system) ? payload.system : [];
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const tools = Array.isArray(payload?.tools) ? payload.tools : [];
  return {
    model: payload?.model,
    maxTokens: payload?.max_tokens,
    stream: payload?.stream,
    systemBlocks: system.length,
    messages: messages.length,
    tools: tools.length,
    betas: Array.isArray(payload?.betas) ? payload.betas.length : 0,
    thinking: payload?.thinking?.type || "disabled",
    outputConfig: Boolean(payload?.output_config),
    metadataKeys: payload?.metadata && typeof payload.metadata === "object" ? Object.keys(payload.metadata).length : 0
  };
}

export function appendEvent(input) {
  const event = normalizeEvent(input);
  event.summary = summarizePayload(event.payload);
  events.push(event);
  if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
  broadcast(event);
  return event;
}

function broadcast(event) {
  const data = `event: visualizer-event\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) client.write(data);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createVisualizerServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "OPTIONS") {
        sendJson(res, 204, {});
        return;
      }
      if (req.method === "HEAD" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(path.join(__dirname, "index.html"), "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/styles.css") {
        res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        res.end(await readFile(path.join(__dirname, "styles.css"), "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
        res.end(await readFile(path.join(__dirname, "app.js"), "utf8"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        sendJson(res, 200, { events });
        return;
      }
      if (req.method === "POST" && url.pathname === "/clear") {
        events.splice(0);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/ingest") {
        const event = appendEvent(await readJson(req));
        sendJson(res, 200, { ok: true, event });
        return;
      }
      if (req.method === "GET" && url.pathname === "/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*"
        });
        res.write("event: snapshot\n");
        res.write(`data: ${JSON.stringify({ events })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createVisualizerServer().listen(port, "127.0.0.1", () => {
    console.log(`Claude Code Scope listening on http://127.0.0.1:${port}`);
    console.log("Run Claude Code with the Scope endpoint enabled; request events will appear here automatically.");
  });
}
