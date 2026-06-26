import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentBridge } from "./agentBridge.js";
import {
  closeBrowserTab,
  listBrowserTabs,
  registerBrowserTab,
  resolveBrowserCommand,
  resolveBrowserHostCommand,
  takeBrowserCommands,
  takeBrowserHostCommands,
  updateBrowserTab
} from "./browserBridge.js";
import {
  createClaudeConfig,
  createWebviewState,
  err,
  getSessionStateSnapshot,
  handleRpc,
  ok,
  type ClientMessage,
  type HostMessage
} from "./protocol.js";
import { TerminalManager } from "./terminalManager.js";

const port = Number(process.env.PORT ?? 8787);
const cwd = process.env.CLAUDE_AGENT_CWD ?? process.cwd();
const app = express();
const terminals = new TerminalManager();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../dist");
app.use(express.json({ limit: "1mb" }));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.get("/file", async (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  const startLine = parsePositiveInteger(req.query.line);
  const requestedCwd = typeof req.query.cwd === "string" ? req.query.cwd : cwd;
  const workspaceRoot = resolveWorkspacePath(cwd, requestedCwd);
  const absolutePath = workspaceRoot ? resolveWorkspacePath(workspaceRoot, requestedPath) : undefined;
  if (!workspaceRoot || !absolutePath) {
    res.status(400).type("html").send(renderFileError("Invalid file path.", requestedPath));
    return;
  }

  try {
    const content = await readFile(absolutePath, "utf8");
    res.type("html").send(renderFileViewer(workspaceRoot, absolutePath, content, startLine));
  } catch (error) {
    res
      .status(404)
      .type("html")
      .send(renderFileError(error instanceof Error ? error.message : String(error), requestedPath));
  }
});
app.get("/terminal", (req, res) => {
  const name = typeof req.query.name === "string" ? req.query.name : "";
  const session = terminals.getTerminalSession(name);
  res.type("html").send(renderTerminalViewer(name, session?.command ?? name));
});
app.get("/terminal/content", (req, res) => {
  res.json(terminals.getTerminalContents(req.query.name).content);
});
app.get("/output", (_req, res) => {
  res.type("html").send(renderOutputPanel());
});
app.get("/browser-tab", (req, res) => {
  const tabGroupId = typeof req.query.tabGroupId === "string" ? req.query.tabGroupId : "";
  const tabId = typeof req.query.tabId === "string" ? req.query.tabId : "";
  const initialUrl = typeof req.query.initialUrl === "string" ? req.query.initialUrl : "";
  res.type("html").send(renderBrowserTab(tabGroupId, tabId, initialUrl));
});
app.get("/browser-tabs", (_req, res) => {
  res.json({ tabs: listBrowserTabs({ includeClosed: true }) });
});
app.post("/browser-tabs/state", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const tabGroupId = typeof body.tabGroupId === "string" ? body.tabGroupId : "";
  const tabId = typeof body.tabId === "number" ? body.tabId : Number(body.tabId);
  if (!tabGroupId || !Number.isFinite(tabId) || tabId <= 0) {
    res.status(400).json({ error: "Invalid browser tab state update." });
    return;
  }
  const tab = updateBrowserTab(tabGroupId, Math.floor(tabId), {
    url: typeof body.url === "string" ? body.url : undefined,
    title: typeof body.title === "string" ? body.title : undefined
  });
  res.json({ tab });
});
app.get("/browser-tabs/commands", (req, res) => {
  const tabGroupId = typeof req.query.tabGroupId === "string" ? req.query.tabGroupId : "";
  const tabId = typeof req.query.tabId === "string" ? Number(req.query.tabId) : NaN;
  if (!tabGroupId || !Number.isFinite(tabId) || tabId <= 0) {
    res.status(400).json({ error: "Invalid browser tab command request." });
    return;
  }
  res.json({ commands: takeBrowserCommands(tabGroupId, Math.floor(tabId)) });
});
app.post("/browser-tabs/commands/:commandId/result", (req, res) => {
  const commandId = req.params.commandId;
  const body = isRecord(req.body) ? req.body : {};
  const tab = isRecord(body.tab) ? body.tab : undefined;
  if (tab) {
    const tabGroupId = typeof tab.tabGroupId === "string" ? tab.tabGroupId : "";
    const tabId = typeof tab.tabId === "number" ? tab.tabId : Number(tab.tabId);
    if (tabGroupId && Number.isFinite(tabId) && tabId > 0) {
      updateBrowserTab(tabGroupId, Math.floor(tabId), {
        url: typeof tab.url === "string" ? tab.url : undefined,
        title: typeof tab.title === "string" ? tab.title : undefined
      });
    }
  }
  const error = typeof body.error === "string" ? body.error : undefined;
  const resolved = resolveBrowserCommand(commandId, body.result, error);
  res.json({ resolved });
});
app.get("/browser-host/commands", (_req, res) => {
  res.json({ commands: takeBrowserHostCommands() });
});
app.post("/browser-host/commands/:commandId/result", (req, res) => {
  const body = isRecord(req.body) ? req.body : {};
  const error = typeof body.error === "string" ? body.error : undefined;
  const resolved = resolveBrowserHostCommand(req.params.commandId, body.result, error);
  res.json({ resolved });
});
app.get("/config", async (req, res) => {
  const configType = typeof req.query.type === "string" ? req.query.type : "user";
  const requestedCwd = typeof req.query.cwd === "string" ? req.query.cwd : cwd;
  const configPath = resolveClaudeConfigPath(configType, requestedCwd);
  if (!configPath) {
    res.status(400).type("html").send(renderFileError("Invalid config path.", requestedCwd));
    return;
  }
  try {
    const content = await readFile(configPath, "utf8");
    res.type("html").send(renderFileViewer(path.dirname(configPath), configPath, content, undefined));
  } catch (error) {
    res
      .status(404)
      .type("html")
    .send(renderFileError(error instanceof Error ? error.message : String(error), configPath));
  }
});
app.get("/", async (req, res, next) => {
  try {
    const requestedCwd = typeof req.query.cwd === "string" ? path.resolve(req.query.cwd) : cwd;
    const initialPrompt = typeof req.query.prompt === "string" && req.query.prompt ? req.query.prompt : undefined;
    const initialSession = typeof req.query.session === "string" && req.query.session ? req.query.session : undefined;
    const html = await readFile(path.join(distDir, "index.html"), "utf8");
    res.type("html").send(injectRootDataset(html, { initialPrompt, initialSession }));
  } catch (error) {
    next(error);
  }
});
app.use(express.static(distDir));

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Claude Agent bridge listening on http://127.0.0.1:${port}`);
});

const wss = new WebSocketServer({ server, path: "/bridge" });

wss.on("connection", (socket, request) => {
  const bridge = new AgentBridge();
  const requestControllers = new Map<string, AbortController>();
  const workspaceCwd = getConnectionCwd(request.url);
  let apiKey: string | undefined;

  const send = (message: HostMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: "from-extension", message }));
    }
  };

  socket.send(JSON.stringify({ type: "bridge_ready" }));

  socket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch (error) {
      sendBridgeError(socket, `Invalid bridge JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (message.type === "bridge_auth") {
      apiKey = message.apiKey;
      return;
    }

    if (message.type === "request") {
      const requestAbort = new AbortController();
      requestControllers.set(message.requestId, requestAbort);
      try {
        if (message.request.type === "get_claude_state") {
          send(
            ok(message.requestId, {
              type: "get_claude_state_response",
              config: await bridge.getClaudeConfig(getRequestChannelId(message), workspaceCwd)
            })
          );
          return;
        }
        if (message.request.type === "set_permission_mode") {
          const channelId = getRequestChannelId(message);
          await bridge.setPermissionMode(
            channelId,
            typeof message.request.mode === "string" ? message.request.mode : undefined
          );
          await sendStateUpdate(send, channelId, workspaceCwd, bridge);
          send(ok(message.requestId, { type: "set_permission_mode_response", success: true }));
          return;
        }
        if (message.request.type === "set_model") {
          const channelId = getRequestChannelId(message);
          await bridge.setModel(channelId, message.request.model);
          await sendStateUpdate(send, channelId, workspaceCwd, bridge);
          send(ok(message.requestId, { type: "set_model_response", success: true }));
          return;
        }
        if (message.request.type === "set_thinking_level") {
          await bridge.setThinkingLevel(
            message.channelId ?? (typeof message.request.channelId === "string" ? message.request.channelId : undefined),
            typeof message.request.thinkingLevel === "string" ? message.request.thinkingLevel : undefined
          );
          send(ok(message.requestId, { type: "set_thinking_level_response", success: true }));
          return;
        }
        if (message.request.type === "apply_settings") {
          const channelId = getRequestChannelId(message);
          await bridge.applySettings(channelId, message.request.settings, message.request.flagsOnly === true);
          await sendStateUpdate(send, channelId, workspaceCwd, bridge);
          send(ok(message.requestId, { type: "apply_settings_response", success: true }));
          return;
        }
        if (message.request.type === "get_mcp_servers") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(ok(message.requestId, await bridge.getMcpServers(channelId)));
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "register_browser_tab") {
          const tabGroupId = typeof message.request.tabGroupId === "string" ? message.request.tabGroupId : "";
          const tabId = typeof message.request.tabId === "number" ? message.request.tabId : Number(message.request.tabId);
          const url = typeof message.request.url === "string" ? message.request.url : "";
          if (!tabGroupId || !Number.isFinite(tabId) || tabId <= 0) throw new Error("Invalid browser tab registration.");
          const tab = registerBrowserTab({
            tabGroupId,
            tabId: Math.floor(tabId),
            url,
            cwd: typeof message.request.cwd === "string" ? message.request.cwd : undefined,
            title: typeof message.request.title === "string" ? message.request.title : undefined
          });
          send(ok(message.requestId, { type: "register_browser_tab_response", tab }));
          return;
        }
        if (message.request.type === "close_browser_tab") {
          const tabGroupId = typeof message.request.tabGroupId === "string" ? message.request.tabGroupId : "";
          const tabId = typeof message.request.tabId === "number" ? message.request.tabId : Number(message.request.tabId);
          if (!tabGroupId || !Number.isFinite(tabId) || tabId <= 0) throw new Error("Invalid browser tab close request.");
          const tab = closeBrowserTab(tabGroupId, Math.floor(tabId));
          send(ok(message.requestId, { type: "close_browser_tab_response", tab }));
          return;
        }
        if (message.request.type === "set_mcp_server_enabled") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(ok(message.requestId, await bridge.setMcpServerEnabled(channelId, message.request.serverName, message.request.enabled)));
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "reconnect_mcp_server") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(ok(message.requestId, await bridge.reconnectMcpServer(channelId, message.request.serverName)));
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "authenticate_mcp_server") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(ok(message.requestId, await bridge.authenticateMcpServer(channelId, message.request.serverName)));
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "clear_mcp_server_auth") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(ok(message.requestId, await bridge.clearMcpServerAuth(channelId, message.request.serverName)));
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "submit_mcp_oauth_callback_url") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(
              ok(
                message.requestId,
                await bridge.submitMcpOAuthCallbackUrl(channelId, message.request.serverName, message.request.callbackUrl)
              )
            );
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "get_context_usage") {
          send(ok(message.requestId, await bridge.getContextUsage(message.channelId)));
          return;
        }
        if (message.request.type === "get_usage") {
          send(ok(message.requestId, await bridge.getUsage(message.channelId)));
          return;
        }
        if (message.request.type === "rewind_code") {
          send(
            ok(
              message.requestId,
              await bridge.rewindCode(message.channelId, message.request.userMessageId, message.request.dryRun)
            )
          );
          return;
        }
        if (message.request.type === "generate_session_title") {
          send(
            ok(
              message.requestId,
              await bridge.generateSessionTitle(getRequestChannelId(message), message.request.description)
            )
          );
          return;
        }
        if (message.request.type === "message_rated") {
          send(
            ok(
              message.requestId,
              await bridge.messageRated(getRequestChannelId(message), {
                messageUuid: message.request.messageUuid,
                sentiment: message.request.sentiment,
                surface: message.request.surface,
                cleared: message.request.cleared
              })
            )
          );
          return;
        }
        if (message.request.type === "submit_feedback") {
          send(ok(message.requestId, await bridge.submitFeedback(getRequestChannelId(message), message.request.description)));
          return;
        }
        if (message.request.type === "request_usage_update") {
          send(await bridge.createUsageUpdate(getRequestChannelId(message)));
          send(ok(message.requestId, { type: "request_usage_update_response" }));
          return;
        }
        if (message.request.type === "toggle_remote_control") {
          const channelId = getRequestChannelId(message);
          const response = await bridge.toggleRemoteControl(channelId, message.request.enable);
          const remoteControlState =
            message.request.enable === true && "sessionUrl" in response
              ? { status: "connected", sessionUrl: response.sessionUrl, connectUrl: response.connectUrl }
              : { status: "disconnected" };
          send({
            type: "request",
            channelId,
            requestId: randomUUID(),
            request: {
              type: "update_state",
              state: await createWebviewState(workspaceCwd, { remoteControlState }),
              config: await bridge.getClaudeConfig(channelId, workspaceCwd)
            }
          });
          send(ok(message.requestId, response));
          return;
        }
        if (message.request.type === "read_file") {
          const channelId = getRequestChannelId(message);
          if (bridge.hasRunningChannel(channelId)) {
            send(
              ok(
                message.requestId,
                await bridge.readFile(
                  channelId,
                  message.request.path,
                  message.request.maxBytes ?? message.request.max_bytes,
                  message.request.encoding
                )
              )
            );
          } else {
            send(ok(message.requestId, await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals)));
          }
          return;
        }
        if (message.request.type === "reload_plugins") {
          const channelId = getRequestChannelId(message);
          const response = await bridge.reloadPlugins(channelId);
          await sendStateUpdate(send, channelId, workspaceCwd, bridge);
          send(ok(message.requestId, response));
          return;
        }
        if (message.request.type === "reload_skills") {
          const channelId = getRequestChannelId(message);
          const response = await bridge.reloadSkills(channelId);
          await sendStateUpdate(send, channelId, workspaceCwd, bridge);
          send(ok(message.requestId, response));
          return;
        }
        if (message.request.type === "open_terminal") {
          send(ok(message.requestId, terminals.openTerminal(message.request, workspaceCwd, requestAbort.signal)));
          return;
        }
        if (message.request.type === "open_claude_in_terminal") {
          send(ok(message.requestId, terminals.openClaudeInTerminal(message.request, workspaceCwd, requestAbort.signal)));
          return;
        }
        if (message.request.type === "get_terminal_contents") {
          send(ok(message.requestId, terminals.getTerminalContents(message.request.terminalName)));
          return;
        }
        if (
          message.request.type === "show_claude_terminal_setting" ||
          message.request.type === "dismiss_terminal_banner"
        ) {
          send(ok(message.requestId, { type: `${message.request.type}_response` }));
          return;
        }
        const response = await handleRpc(message.request, workspaceCwd, requestAbort.signal, terminals);
        send(ok(message.requestId, response));
        if (message.request.type === "update_session_state") {
          sendSessionStatesUpdate(send, getRequestChannelId(message), getResponseSessionId(response), workspaceCwd);
        }
        if (message.request.type === "delete_session") {
          sendSessionStatesUpdate(send, getRequestChannelId(message), undefined, workspaceCwd);
        }
        if (isIntegrationStateRequest(message.request.type)) {
          await sendStateUpdate(send, getRequestChannelId(message), workspaceCwd, bridge);
        }
        if (isPluginStateRequest(message.request.type)) {
          await sendStateUpdate(send, getRequestChannelId(message), workspaceCwd, bridge);
        }
      } catch (error) {
        send(err(message.requestId, error));
      } finally {
        requestControllers.delete(message.requestId);
      }
      return;
    }

    if (message.type === "response") {
      bridge.resolveHostResponse(message.requestId, message.response);
      return;
    }

    if (message.type === "start_speech_to_text") {
      send({ type: "speech_audio_level", channelId: message.channelId, level: 0 });
      send({
        type: "close_channel",
        channelId: message.channelId,
        error: "Speech-to-text requires the VSCode extension host and Claude.ai OAuth; it is not available in standalone API-key mode."
      });
      return;
    }

    if (message.type === "stop_speech_to_text") {
      send({ type: "speech_audio_level", channelId: message.channelId, level: 0 });
      send({ type: "close_channel", channelId: message.channelId });
      return;
    }

    if (message.type === "launch_claude") {
      bridge.launch({
        apiKey,
        channelId: message.channelId,
        cwd: message.cwd || workspaceCwd,
        resume: message.resume,
        permissionMode: message.permissionMode,
        thinkingLevel: message.thinkingLevel,
        model: message.model,
        send
      });
      return;
    }

    if (message.type === "io_message") {
      bridge.push(message.channelId, message.message, message.done);
      return;
    }

    if (message.type === "interrupt_claude") {
      bridge.interrupt(message.channelId);
      return;
    }

    if (message.type === "cancel_request") {
      requestControllers.get(message.targetRequestId)?.abort();
    }
  });

  socket.on("close", () => {
    for (const controller of requestControllers.values()) controller.abort();
    requestControllers.clear();
    bridge.closeAll();
  });
});

function sendBridgeError(socket: WebSocket, error: string) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "bridge_error", error }));
}

function getRequestChannelId(message: Extract<ClientMessage, { type: "request" }>) {
  return message.channelId ?? (typeof message.request.channelId === "string" ? message.request.channelId : undefined);
}

function getConnectionCwd(requestUrl: string | undefined) {
  if (!requestUrl) return cwd;
  try {
    const url = new URL(requestUrl, "http://127.0.0.1");
    const requestedCwd = url.searchParams.get("cwd");
    return requestedCwd ? path.resolve(requestedCwd) : cwd;
  } catch {
    return cwd;
  }
}

async function sendStateUpdate(send: (message: HostMessage) => void, channelId: string | undefined, cwd: string, bridge: AgentBridge) {
  send({
    type: "request",
    channelId,
    requestId: randomUUID(),
    request: {
      type: "update_state",
      state: await createWebviewState(cwd),
      config: await bridge.getClaudeConfig(channelId, cwd)
    }
  });
}

function sendSessionStatesUpdate(
  send: (message: HostMessage) => void,
  channelId: string | undefined,
  activeSessionId: string | undefined,
  cwd: string
) {
  send({
    type: "request",
    channelId,
    requestId: randomUUID(),
    request: {
      type: "session_states_update",
      sessions: getSessionStateSnapshot(cwd),
      activeSessionId
    }
  });
}

function getResponseSessionId(response: unknown) {
  if (!isRecord(response)) return undefined;
  return typeof response.sessionId === "string" ? response.sessionId : undefined;
}

function isIntegrationStateRequest(type: string) {
  return (
    type === "ensure_chrome_mcp_enabled" ||
    type === "disable_chrome_mcp" ||
    type === "enable_jupyter_mcp" ||
    type === "disable_jupyter_mcp"
  );
}

function isPluginStateRequest(type: string) {
  return (
    type === "install_plugin" ||
    type === "uninstall_plugin" ||
    type === "set_plugin_enabled" ||
    type === "add_marketplace" ||
    type === "remove_marketplace" ||
    type === "refresh_marketplace"
  );
}

function injectRootDataset(
  html: string,
  data: {
    initialPrompt?: string;
    initialSession?: string;
  }
) {
  const attributes = [
    data.initialPrompt ? `data-initial-prompt="${escapeHtml(data.initialPrompt)}"` : "",
    data.initialSession ? `data-initial-session="${escapeHtml(data.initialSession)}"` : ""
  ]
    .filter(Boolean)
    .join(" ");
  if (!attributes) return html;
  return html.replace(/<div id="root"([^>]*)>/, `<div id="root"$1 ${attributes}>`);
}

function resolveWorkspacePath(root: string, requestedPath: string) {
  if (!requestedPath || requestedPath.includes("\0")) return undefined;
  const absolutePath = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(root, requestedPath);
  const relativePath = path.relative(root, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
  return absolutePath;
}

function resolveClaudeConfigPath(configType: string, workspaceCwd: string) {
  const normalized = configType.toLowerCase();
  if (normalized.includes("local")) {
    const root = resolveWorkspacePath(cwd, workspaceCwd);
    return root ? path.join(root, ".claude", "settings.local.json") : undefined;
  }
  if (normalized.includes("project")) {
    const root = resolveWorkspacePath(cwd, workspaceCwd);
    return root ? path.join(root, ".claude", "settings.json") : undefined;
  }
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "settings.json");
}

function parsePositiveInteger(value: unknown) {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderFileViewer(root: string, absolutePath: string, content: string, startLine: number | undefined) {
  const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
  const lines = content.split(/\r?\n/);
  const lineHtml = lines
    .map((line, index) => {
      const lineNumber = index + 1;
      const activeClass = startLine === lineNumber ? " active" : "";
      return `<tr id="L${lineNumber}" class="line${activeClass}" data-line="${lineNumber}"><td class="ln"><a href="#L${lineNumber}">${lineNumber}</a></td><td class="code"><pre>${escapeHtml(line)}</pre></td></tr>`;
    })
    .join("");
  const selectionScript = `
  <script>
    const selectionStateKey = "claude-agent-webview:current-selection";
    const filePath = ${JSON.stringify(relativePath)};
    const fileLabel = ${JSON.stringify(path.basename(relativePath))};

    function lineFromNode(node) {
      if (!node) return undefined;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      const row = element?.closest?.("tr[data-line]");
      const line = Number(row?.dataset.line);
      return Number.isFinite(line) && line > 0 ? line : undefined;
    }

    function publishSelection() {
      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      if (!selection || selection.rangeCount === 0 || !text.trim()) return;
      const range = selection.getRangeAt(0);
      const startLine = lineFromNode(range.startContainer);
      const endLine = lineFromNode(range.endContainer);
      if (!startLine || !endLine) return;
      const firstLine = Math.min(startLine, endLine);
      const lastLine = Math.max(startLine, endLine);
      localStorage.setItem(selectionStateKey, JSON.stringify({
        type: "ideSelection",
        label: lastLine === firstLine ? fileLabel + ":" + firstLine : fileLabel + ":" + firstLine + "-" + lastLine,
        filePath,
        startLine: firstLine,
        endLine: lastLine,
        text,
        selectedText: text,
        timestamp: Date.now()
      }));
    }

    document.addEventListener("mouseup", () => setTimeout(publishSelection, 0));
    document.addEventListener("keyup", (event) => {
      if (event.key.startsWith("Arrow") || event.key === "Shift" || event.key === "Home" || event.key === "End") {
        setTimeout(publishSelection, 0);
      }
    });
  </script>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(relativePath)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #101010; color: #e6e6e6; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    header { position: sticky; top: 0; z-index: 1; padding: 10px 14px; background: #1f1f1f; border-bottom: 1px solid #333; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    table { border-collapse: collapse; width: 100%; }
    td { vertical-align: top; }
    .ln { width: 1%; min-width: 48px; padding: 0 10px; text-align: right; color: #858585; background: #171717; user-select: none; border-right: 1px solid #2b2b2b; }
    .ln a { color: inherit; text-decoration: none; }
    .code { padding: 0 14px; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; line-height: 20px; }
    tr.active .ln, tr.active .code { background: #2a2618; }
  </style>
</head>
<body>
  <header>${escapeHtml(relativePath)}</header>
  <table>${lineHtml}</table>
  ${startLine ? `<script>location.hash = "L${startLine}";</script>` : ""}
  ${selectionScript}
</body>
</html>`;
}

function renderFileError(message: string, requestedPath: string) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Unable to open file</title></head>
<body style="font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px;">
  <h1>Unable to open file</h1>
  <p><code>${escapeHtml(requestedPath)}</code></p>
  <pre>${escapeHtml(message)}</pre>
</body>
</html>`;
}

function renderTerminalViewer(name: string, title: string) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(name || "Terminal")}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #101010; color: #e6e6e6; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    header { position: sticky; top: 0; z-index: 1; padding: 10px 14px; background: #1f1f1f; border-bottom: 1px solid #333; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    pre { margin: 0; padding: 14px; white-space: pre-wrap; word-break: break-word; line-height: 20px; }
  </style>
</head>
<body>
  <header>${escapeHtml(title || name || "Terminal")}</header>
  <pre id="output">Loading...</pre>
  <script>
    const name = ${JSON.stringify(name)};
    const output = document.getElementById("output");
    async function refresh() {
      const response = await fetch("/terminal/content?name=" + encodeURIComponent(name), { cache: "no-store" });
      output.textContent = await response.json();
      window.scrollTo(0, document.body.scrollHeight);
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

function renderOutputPanel() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Agent Bridge Output</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #101010; color: #e6e6e6; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { padding: 12px 16px; background: #1f1f1f; border-bottom: 1px solid #333; font-weight: 600; }
    main { max-width: 760px; padding: 18px 16px; line-height: 1.55; }
    code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #1f1f1f; padding: 2px 5px; border-radius: 4px; }
  </style>
</head>
<body>
  <header>Claude Agent Bridge Output</header>
  <main>
    <p>This standalone host writes bridge logs to the terminal process running <code>npm start</code>.</p>
    <p>VSCode's output panel has no direct browser equivalent, so this page keeps the official command visible without pretending to expose an editor-only panel.</p>
  </main>
</body>
</html>`;
}

function renderBrowserTab(tabGroupId: string, tabId: string, initialUrl: string) {
  const parsedTabId = Number.parseInt(tabId, 10);
  const safeTabId = Number.isFinite(parsedTabId) && parsedTabId > 0 ? parsedTabId : 0;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Browser Tab ${escapeHtml(tabId || "")}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; display: grid; grid-template-rows: auto minmax(0, 1fr); background: #101010; color: #e6e6e6; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px 10px; background: #1f1f1f; border-bottom: 1px solid #333; }
    .identity { color: #a6a6a6; white-space: nowrap; }
    .url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #d7d7d7; }
    .status { color: #a6a6a6; white-space: nowrap; }
    iframe { width: 100%; height: 100%; border: 0; background: white; }
    .empty { display: grid; place-items: center; height: 100%; color: #a6a6a6; }
  </style>
</head>
<body>
  <header>
    <div class="identity">${escapeHtml(tabGroupId || "(missing)")}:${escapeHtml(tabId || "(missing)")}</div>
    <div id="url" class="url">about:blank</div>
    <div id="status" class="status">ready</div>
  </header>
  <main id="main"><div class="empty">Waiting for browser commands.</div></main>
  <script>
    const tabGroupId = ${JSON.stringify(tabGroupId)};
    const tabId = ${JSON.stringify(safeTabId)};
    const urlNode = document.getElementById("url");
    const statusNode = document.getElementById("status");
    const mainNode = document.getElementById("main");
    let iframe;
    const initialUrl = ${JSON.stringify(initialUrl)};
    let currentUrl = initialUrl || "about:blank";
    let currentTitle = "Claude Browser Tab";
    let busy = false;
    const consoleMessages = [];
    const networkRequests = [];

    function setStatus(status) {
      statusNode.textContent = status;
    }

    function ensureFrame() {
      if (iframe) return iframe;
      iframe = document.createElement("iframe");
      iframe.title = "Claude Browser Content";
      iframe.addEventListener("load", () => {
        try {
          currentTitle = iframe.contentDocument?.title || currentTitle;
          installInstrumentation();
        } catch {}
        postTabState();
      });
      mainNode.replaceChildren(iframe);
      return iframe;
    }

    function getFrameDocument() {
      const frame = ensureFrame();
      const doc = frame.contentDocument;
      if (!doc) throw new Error("iframe document is unavailable or cross-origin.");
      return doc;
    }

    function serializeValue(value) {
      try {
        if (typeof value === "string") return value;
        if (value instanceof Error) return value.stack || value.message;
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }

    function pushLimited(list, entry) {
      list.push(entry);
      if (list.length > 500) list.splice(0, list.length - 500);
    }

    function installInstrumentation() {
      const frame = ensureFrame();
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      if (!win || !doc || win.__claudeAgentInstrumented) return;
      win.__claudeAgentInstrumented = true;
      for (const level of ["debug", "info", "log", "warn", "error"]) {
        const original = typeof win.console?.[level] === "function" ? win.console[level].bind(win.console) : undefined;
        win.console[level] = (...args) => {
          pushLimited(consoleMessages, {
            level,
            text: args.map(serializeValue).join(" "),
            args: args.map(serializeValue),
            url: currentUrl,
            timestamp: Date.now()
          });
          original?.(...args);
        };
      }
      win.addEventListener("error", (event) => {
        pushLimited(consoleMessages, {
          level: "error",
          text: event.message || "Uncaught error",
          url: event.filename || currentUrl,
          line: event.lineno || undefined,
          column: event.colno || undefined,
          timestamp: Date.now()
        });
      });
      win.addEventListener("unhandledrejection", (event) => {
        pushLimited(consoleMessages, {
          level: "error",
          text: "Unhandled rejection: " + serializeValue(event.reason),
          url: currentUrl,
          timestamp: Date.now()
        });
      });
      if (typeof win.fetch === "function") {
        const originalFetch = win.fetch.bind(win);
        win.fetch = async (...args) => {
          const startedAt = Date.now();
          const requestUrl = String(args[0]?.url || args[0] || "");
          try {
            const response = await originalFetch(...args);
            pushLimited(networkRequests, {
              type: "fetch",
              url: requestUrl,
              method: String(args[1]?.method || args[0]?.method || "GET").toUpperCase(),
              status: response.status,
              ok: response.ok,
              durationMs: Date.now() - startedAt,
              timestamp: startedAt
            });
            return response;
          } catch (error) {
            pushLimited(networkRequests, {
              type: "fetch",
              url: requestUrl,
              method: String(args[1]?.method || args[0]?.method || "GET").toUpperCase(),
              error: error instanceof Error ? error.message : String(error),
              ok: false,
              durationMs: Date.now() - startedAt,
              timestamp: startedAt
            });
            throw error;
          }
        };
      }
      if (typeof win.XMLHttpRequest === "function") {
        const OriginalXHR = win.XMLHttpRequest;
        win.XMLHttpRequest = function InstrumentedXMLHttpRequest() {
          const xhr = new OriginalXHR();
          let method = "GET";
          let requestUrl = "";
          let startedAt = 0;
          const originalOpen = xhr.open;
          xhr.open = function open(nextMethod, nextUrl, ...rest) {
            method = String(nextMethod || "GET").toUpperCase();
            requestUrl = String(nextUrl || "");
            return originalOpen.call(xhr, nextMethod, nextUrl, ...rest);
          };
          const originalSend = xhr.send;
          xhr.send = function send(...args) {
            startedAt = Date.now();
            xhr.addEventListener("loadend", () => {
              pushLimited(networkRequests, {
                type: "xhr",
                url: requestUrl,
                method,
                status: xhr.status,
                ok: xhr.status >= 200 && xhr.status < 400,
                durationMs: Date.now() - startedAt,
                timestamp: startedAt
              });
            });
            return originalSend.apply(xhr, args);
          };
          return xhr;
        };
      }
    }

    function controls(doc) {
      return Array.from(doc.querySelectorAll("a[href], input, textarea, select, button, [role='button'], [contenteditable='true'], [contenteditable='plaintext-only']"));
    }

    function resolveTarget(doc, payload) {
      if (typeof payload?.selector === "string" && payload.selector) return doc.querySelector(payload.selector);
      if (typeof payload?.ref === "string" && payload.ref) {
        const match = payload.ref.match(/^(?:control|link)-(\\d+)$/);
        if (match) return controls(doc)[Number(match[1]) - 1] || null;
      }
      const coordinate = Array.isArray(payload?.coordinate) ? payload.coordinate : undefined;
      if (coordinate && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1])) {
        const frame = ensureFrame();
        const rect = frame.getBoundingClientRect();
        return doc.elementFromPoint(Number(coordinate[0]) - rect.left, Number(coordinate[1]) - rect.top);
      }
      return null;
    }

    function tabState(extra) {
      return {
        tabGroupId,
        tabId,
        url: currentUrl,
        title: currentTitle,
        status: "open",
        ...extra
      };
    }

    async function postTabState() {
      await fetch("/browser-tabs/state", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tabState())
      }).catch(() => {});
    }

    function readAccessiblePage() {
      const frame = ensureFrame();
      try {
        const doc = frame.contentDocument;
        if (!doc) return { accessible: false, text: "", reason: "iframe document is unavailable" };
        currentTitle = doc.title || currentTitle;
        const text = (doc.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 20000);
        const links = Array.from(doc.querySelectorAll("a[href]")).slice(0, 50).map((node, index) => ({
          ref: "link-" + (index + 1),
          text: (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
          href: node.href
        }));
        const inputs = controls(doc).slice(0, 50).map((node, index) => ({
          ref: "control-" + (index + 1),
          tag: node.tagName.toLowerCase(),
          type: node.getAttribute("type") || undefined,
          text: (node.getAttribute("aria-label") || node.textContent || node.getAttribute("placeholder") || "").trim().slice(0, 200)
        }));
        return { accessible: true, text, links, inputs };
      } catch (error) {
        return {
          accessible: false,
          text: "",
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }

    async function respond(command, result, error) {
      await fetch("/browser-tabs/commands/" + encodeURIComponent(command.id) + "/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ result, error, tab: tabState() })
      });
    }

    async function handleCommand(command) {
      setStatus(command.type);
      if (command.type === "navigate") {
        const targetUrl = command.payload?.url;
        if (typeof targetUrl !== "string" || !targetUrl) {
          await respond(command, undefined, "navigate requires a URL.");
          return;
        }
        currentUrl = targetUrl;
        urlNode.textContent = currentUrl;
        ensureFrame().src = targetUrl;
        await respond(command, { ...tabState(), navigated: true });
        return;
      }
      if (command.type === "read_page") {
        const page = readAccessiblePage();
        await respond(command, { ...tabState(), page });
        return;
      }
      if (command.type === "javascript_tool") {
        try {
          const frame = ensureFrame();
          getFrameDocument();
          const script = String(command.payload?.script || "");
          const value = await frame.contentWindow.eval("(async () => { " + script + "\\n })()");
          await respond(command, { ...tabState(), result: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
        } catch (error) {
          await respond(command, undefined, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (command.type === "form_input") {
        try {
          const doc = getFrameDocument();
          const target = resolveTarget(doc, command.payload);
          if (!target) throw new Error("No matching form control found.");
          const value = String(command.payload?.value ?? "");
          if ("value" in target) target.value = value;
          else target.textContent = value;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
          await respond(command, { ...tabState(), filled: true, ref: command.payload?.ref, selector: command.payload?.selector });
        } catch (error) {
          await respond(command, undefined, error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (command.type === "read_console_messages") {
        const pattern = typeof command.payload?.pattern === "string" && command.payload.pattern ? new RegExp(command.payload.pattern, "i") : undefined;
        const onlyErrors = command.payload?.onlyErrors === true;
        const limit = Math.max(1, Math.min(200, Number(command.payload?.limit) || 100));
        let messages = consoleMessages;
        if (onlyErrors) messages = messages.filter((entry) => entry.level === "error");
        if (pattern) messages = messages.filter((entry) => pattern.test(entry.text || ""));
        await respond(command, {
          ...tabState(),
          messages: messages.slice(-limit),
          instrumentation: "same-origin iframe console wrapper"
        });
        return;
      }
      if (command.type === "read_network_requests") {
        const pattern = typeof command.payload?.urlPattern === "string" && command.payload.urlPattern ? new RegExp(command.payload.urlPattern, "i") : undefined;
        const onlyErrors = command.payload?.onlyErrors === true;
        const limit = Math.max(1, Math.min(200, Number(command.payload?.limit) || 100));
        let requests = networkRequests;
        if (onlyErrors) requests = requests.filter((entry) => entry.ok === false);
        if (pattern) requests = requests.filter((entry) => pattern.test(entry.url || ""));
        await respond(command, {
          ...tabState(),
          requests: requests.slice(-limit),
          instrumentation: "same-origin iframe fetch/xhr wrapper"
        });
        return;
      }
      if (command.type === "computer") {
        const frame = ensureFrame();
        const action = command.payload?.action;
        if (action === "wait") {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(command.payload?.duration) || 1000)));
          await respond(command, { ...tabState(), waited: true });
          return;
        }
        if (action === "scroll") {
          const direction = command.payload?.scroll_direction === "up" ? -1 : 1;
          try {
            frame.contentWindow?.scrollBy({ top: direction * 600, behavior: "smooth" });
            await respond(command, { ...tabState(), scrolled: true });
          } catch (error) {
            await respond(command, undefined, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        if (action === "left_click" || action === "double_click" || action === "right_click") {
          try {
            const doc = getFrameDocument();
            const target = resolveTarget(doc, command.payload);
            if (!target) throw new Error("No clickable target found.");
            const eventOptions = { bubbles: true, cancelable: true, view: frame.contentWindow };
            if (action === "right_click") target.dispatchEvent(new MouseEvent("contextmenu", eventOptions));
            else if (action === "double_click") target.dispatchEvent(new MouseEvent("dblclick", eventOptions));
            else target.dispatchEvent(new MouseEvent("click", eventOptions));
            await respond(command, { ...tabState(), clicked: true, action });
          } catch (error) {
            await respond(command, undefined, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        if (action === "type") {
          try {
            const doc = getFrameDocument();
            const target = resolveTarget(doc, command.payload) || doc.activeElement;
            if (!target) throw new Error("No target is focused.");
            const text = String(command.payload?.text ?? "");
            if ("value" in target) target.value = String(target.value || "") + text;
            else target.textContent = String(target.textContent || "") + text;
            target.dispatchEvent(new Event("input", { bubbles: true }));
            await respond(command, { ...tabState(), typed: true });
          } catch (error) {
            await respond(command, undefined, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        if (action === "key") {
          try {
            const doc = getFrameDocument();
            const target = resolveTarget(doc, command.payload) || doc.activeElement || doc.body;
            const key = String(command.payload?.text || "");
            target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
            target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
            await respond(command, { ...tabState(), key });
          } catch (error) {
            await respond(command, undefined, error instanceof Error ? error.message : String(error));
          }
          return;
        }
        if (action === "screenshot") {
          await respond(command, {
            ...tabState(),
            screenshot: null,
            note: "Standalone iframe bridge cannot capture cross-origin pixels; use read_page for accessible DOM text."
          });
          return;
        }
        await respond(command, undefined, "computer action is not supported by the standalone iframe bridge yet.");
        return;
      }
      await respond(command, undefined, "Unknown browser command: " + command.type);
    }

    async function poll() {
      if (!tabGroupId || !tabId || busy) return;
      busy = true;
      try {
        const response = await fetch("/browser-tabs/commands?tabGroupId=" + encodeURIComponent(tabGroupId) + "&tabId=" + encodeURIComponent(String(tabId)), { cache: "no-store" });
        const payload = await response.json();
        const commands = Array.isArray(payload.commands) ? payload.commands : [];
        for (const command of commands) await handleCommand(command);
        setStatus("ready");
      } catch (error) {
        setStatus("disconnected");
      } finally {
        busy = false;
      }
    }

    urlNode.textContent = currentUrl;
    if (initialUrl) ensureFrame().src = initialUrl;
    postTabState();
    poll();
    setInterval(poll, 700);
  </script>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
