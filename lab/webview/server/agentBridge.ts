import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  filterEscalatingDefaultMode,
  query,
  resolveSettings,
  type PermissionMode,
  type Query,
  type SDKControlInitializeResponse,
  type SDKUserMessage,
  type Settings,
  type ThinkingConfig,
  type UserDialogRequest,
  type UserDialogResult
} from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeCodeExecutable } from "./claudeCli.js";
import { createBrowserMcpServer } from "./browserBridge.js";
import { AsyncQueue } from "./queue.js";
import {
  createClaudeConfig,
  createWebviewState,
  createToolPermissionRequest,
  createUserDialogRequest,
  clearSessionState,
  extractPromptText,
  getSessionStateSnapshot,
  normalizeToolPermissionResponse,
  normalizeUserDialogResponse,
  setStandaloneThinkingLevel,
  setSessionState,
  updateClaudeProjectState,
  type HostMessage,
  type SendHost
} from "./protocol.js";

type ChannelOptions = {
  apiKey?: string;
  channelId: string;
  cwd: string;
  resume?: string;
  permissionMode?: string;
  thinkingLevel?: string;
  model?: unknown;
  send: SendHost;
};

type RunningChannel = {
  input: AsyncQueue<SDKUserMessage>;
  abort: AbortController;
  cwd: string;
  sessionId: string;
  query?: Query;
  initialization?: SDKControlInitializeResponse;
  firstPrompt?: string;
};

type PendingHostRequest = {
  resolve: (response: unknown) => void;
  reject: (error: Error) => void;
};

type RuntimeQueryControls = Query & {
  mcpAuthenticate(serverName: string, redirectUri?: string): Promise<{
    error?: string;
    authUrl?: string;
    requiresUserAction?: boolean;
  }>;
  mcpClearAuth(serverName: string): Promise<{ error?: string } | undefined>;
  mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<{ error?: string } | undefined>;
  submitFeedback(description: string, options?: { surface?: string }): Promise<{
    feedback_id?: string;
    unavailable_reason?: string;
  }>;
  generateSessionTitle(description: string, options?: { persist?: boolean }): Promise<string>;
  messageRated(message: { messageUuid?: string; sentiment?: string; surface?: string; cleared?: boolean }): Promise<void>;
  enableRemoteControl(enabled: boolean, name?: string): Promise<{ session_url?: string; connect_url?: string }>;
};

const THINKING_TOKEN_BUDGET = 31_999;
const WEBVIEW_CONTEXT_PROMPT = `
# Claude Agent Webview Context

You are running inside a standalone web app that reuses Claude Code's VSCode webview UI.

## Code References in Text
IMPORTANT: When referencing files or code locations, use markdown link syntax to make them clickable:
- For files: [filename.ts](src/filename.ts)
- For specific lines: [filename.ts:42](src/filename.ts#L42)
- For a range of lines: [filename.ts:42-51](src/filename.ts#L42-L51)
- For folders: [src/utils/](src/utils/)
Unless explicitly asked for by the user, DO NOT USE backticks or HTML tags like code for file references - always use markdown [text](link) format.
The URL links should be relative paths from the root of the user's workspace.
`;

export class AgentBridge {
  private channels = new Map<string, RunningChannel>();
  private pendingHostRequests = new Map<string, PendingHostRequest>();

  launch(options: ChannelOptions) {
    if (this.channels.has(options.channelId)) return;
    const cwdError = validateWorkspaceCwd(options.cwd);
    if (cwdError) {
      options.send({ type: "close_channel", channelId: options.channelId, error: cwdError });
      return;
    }

    const input = new AsyncQueue<SDKUserMessage>();
    const abort = new AbortController();
    const sessionId = options.resume ?? options.channelId;
    this.channels.set(options.channelId, { input, abort, cwd: options.cwd, sessionId });
    setSessionState(sessionId, "running", undefined, options.cwd);
    sendSessionStatesUpdate(options.send, options.channelId, sessionId, options.cwd);

    void this.run(options, input, abort).finally(() => {
      const channel = this.channels.get(options.channelId);
      if (channel) clearSessionState(channel.sessionId);
      this.channels.delete(options.channelId);
      sendSessionStatesUpdate(options.send, options.channelId, undefined, options.cwd);
    });
  }

  push(channelId: string, message: unknown, done?: boolean) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    const promptText = extractPromptText(message).trim();
    if (promptText && !channel.firstPrompt) channel.firstPrompt = promptText;
    channel.input.push(toSdkUserMessage(message));
    if (done) channel.input.close();
  }

  interrupt(channelId: string) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    void channel.query?.interrupt().catch(() => undefined);
    channel.abort.abort();
    channel.input.close();
  }

  async setPermissionMode(channelId: string | undefined, mode: string | undefined) {
    const permissionMode = normalizePermissionMode(mode);
    await writeUserPermissionMode(permissionMode);
    const query = this.getQuery(channelId);
    if (query) await query.setPermissionMode(permissionMode);
  }

  async setModel(channelId: string | undefined, model: unknown) {
    const value = extractModelValue(model);
    await this.applySettings(channelId, { model: value === "default" ? null : value }, false);
  }

  async setThinkingLevel(channelId: string | undefined, thinkingLevel: string | undefined) {
    setStandaloneThinkingLevel(thinkingLevel);
    if (!channelId) return;
    const channel = this.channels.get(channelId);
    if (!channel?.query) return;
    const thinking = normalizeThinkingConfig(thinkingLevel, await getShowThinkingSummaries(channel.cwd));
    if (thinking?.type === "enabled") {
      await channel.query.setMaxThinkingTokens(thinking.budgetTokens ?? THINKING_TOKEN_BUDGET, thinking.display ?? null);
    } else {
      await channel.query.setMaxThinkingTokens(0);
    }
  }

  async applySettings(channelId: string | undefined, settings: unknown, flagsOnly = false) {
    if (!isRecord(settings)) return;
    const query = this.getQuery(channelId);
    if (!flagsOnly) await writeUserSettings(settings);
    if (!query) return;
    await query.applyFlagSettings(settings as { [K in keyof Settings]?: Settings[K] | null });
  }

  async getMcpServers(channelId: string | undefined) {
    const query = this.getRequiredQuery(channelId);
    return {
      type: "get_mcp_servers_response",
      mcpServers: (await query.mcpServerStatus()).filter((server) => server.name !== "claude-vscode")
    };
  }

  async setMcpServerEnabled(channelId: string | undefined, serverName: unknown, enabled: unknown) {
    const query = this.getRequiredQuery(channelId);
    await query.toggleMcpServer(String(serverName ?? ""), enabled === true);
    return { type: "set_mcp_server_enabled_response" };
  }

  async reconnectMcpServer(channelId: string | undefined, serverName: unknown) {
    const query = this.getRequiredQuery(channelId);
    await query.reconnectMcpServer(String(serverName ?? ""));
    return { type: "reconnect_mcp_server_response" };
  }

  async authenticateMcpServer(channelId: string | undefined, serverName: unknown) {
    const query = this.getRuntimeQuery(channelId);
    const name = String(serverName ?? "");
    const server = (await query.mcpServerStatus()).find((candidate) => candidate.name === name);
    if (!server?.config) throw new Error(`Server "${name}" not found.`);
    const config = server.config as { type?: string };
    if (config.type !== "sse" && config.type !== "http") {
      throw new Error(`Server type "${config.type ?? "unknown"}" does not support authentication.`);
    }

    const response = await query.mcpAuthenticate(name);
    if (response.error) throw new Error(response.error);
    return {
      type: "authenticate_mcp_server",
      authUrl: response.authUrl,
      requiresUserAction: response.requiresUserAction,
      isWebUI: false
    };
  }

  async clearMcpServerAuth(channelId: string | undefined, serverName: unknown) {
    const response = await this.getRuntimeQuery(channelId).mcpClearAuth(String(serverName ?? ""));
    if (response?.error) throw new Error(response.error);
    return { type: "clear_mcp_server_auth" };
  }

  async submitMcpOAuthCallbackUrl(channelId: string | undefined, serverName: unknown, callbackUrl: unknown) {
    const response = await this.getRuntimeQuery(channelId).mcpSubmitOAuthCallbackUrl(
      String(serverName ?? ""),
      String(callbackUrl ?? "")
    );
    if (response?.error) throw new Error(response.error);
    return { type: "submit_mcp_oauth_callback_url" };
  }

  async getContextUsage(channelId: string | undefined) {
    try {
      return {
        type: "get_context_usage_response",
        usage: await this.getRequiredQuery(channelId).getContextUsage()
      };
    } catch (error) {
      return { type: "get_context_usage_response", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getUsage(channelId: string | undefined) {
    try {
      return {
        type: "get_usage_response",
        usage: await this.getRequiredQuery(channelId).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()
      };
    } catch (error) {
      return { type: "get_usage_response", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createUsageUpdate(channelId: string | undefined): Promise<HostMessage> {
    const response = await this.getUsage(channelId);
    return {
      type: "request",
      channelId,
      requestId: randomUUID(),
      request: {
        type: "usage_update",
        utilization: "usage" in response ? response.usage : undefined,
        error: "error" in response ? response.error : undefined
      }
    };
  }

  async rewindCode(channelId: string | undefined, userMessageId: unknown, dryRun: unknown) {
    const result = await this.getRequiredQuery(channelId).rewindFiles(String(userMessageId ?? ""), {
      dryRun: dryRun === true
    });
    if (result.error) throw new Error(result.error);
    return {
      type: "rewind_code_response",
      canRewind: result.canRewind,
      filesChanged: result.filesChanged,
      insertions: result.insertions,
      deletions: result.deletions
    };
  }

  async generateSessionTitle(channelId: string | undefined, description: unknown) {
    return {
      type: "generate_session_title_response",
      title: await this.getRuntimeQuery(channelId).generateSessionTitle(String(description ?? ""), { persist: false })
    };
  }

  async messageRated(
    channelId: string | undefined,
    payload: { messageUuid?: unknown; sentiment?: unknown; surface?: unknown; cleared?: unknown }
  ) {
    await this.getRuntimeQuery(channelId).messageRated({
      messageUuid: typeof payload.messageUuid === "string" ? payload.messageUuid : undefined,
      sentiment: typeof payload.sentiment === "string" ? payload.sentiment : undefined,
      surface: typeof payload.surface === "string" ? payload.surface : undefined,
      cleared: payload.cleared === true
    });
    return { type: "message_rated_response" };
  }

  async submitFeedback(channelId: string | undefined, description: unknown) {
    const response = await this.getRuntimeQuery(channelId).submitFeedback(String(description ?? ""), { surface: "ide" });
    return {
      type: "submit_feedback_response",
      feedbackId: response.feedback_id,
      error: response.unavailable_reason
    };
  }

  async toggleRemoteControl(channelId: string | undefined, enable: unknown) {
    const enabled = enable === true;
    const response = await this.getRuntimeQuery(channelId).enableRemoteControl(enabled);
    if (!enabled) return { type: "toggle_remote_control_response" };
    if (!response.session_url) throw new Error("Bridge did not return a session URL.");
    return {
      type: "toggle_remote_control_response",
      sessionUrl: response.session_url,
      connectUrl: response.connect_url
    };
  }

  async readFile(channelId: string | undefined, filePath: unknown, maxBytes: unknown, encoding: unknown) {
    const response = await this.getRequiredQuery(channelId).readFile(String(filePath ?? ""), {
      maxBytes: typeof maxBytes === "number" ? maxBytes : undefined,
      encoding: encoding === "base64" ? "base64" : "utf-8"
    });
    return { type: "read_file_response", file: response };
  }

  async reloadPlugins(channelId: string | undefined) {
    const channel = this.getRequiredChannel(channelId);
    const response = await channel.query.reloadPlugins();
    channel.initialization = {
      ...(channel.initialization ?? (await channel.query.initializationResult())),
      commands: response.commands,
      agents: response.agents
    };
    return { type: "reload_plugins_response", ...response };
  }

  async reloadSkills(channelId: string | undefined) {
    const channel = this.getRequiredChannel(channelId);
    const response = await channel.query.reloadSkills();
    channel.initialization = {
      ...(channel.initialization ?? (await channel.query.initializationResult())),
      commands: response.skills
    };
    return { type: "reload_skills_response", ...response };
  }

  async getClaudeConfig(channelId: string | undefined, fallbackCwd: string) {
    const channel = channelId ? this.channels.get(channelId) : undefined;
    const initialization =
      channel?.initialization ??
      (channel?.query ? await channel.query.initializationResult().catch(() => undefined) : undefined);
    return createClaudeConfig(channel?.cwd ?? fallbackCwd, { initialization });
  }

  closeAll() {
    for (const channelId of this.channels.keys()) this.interrupt(channelId);
    for (const [requestId, pending] of this.pendingHostRequests) {
      pending.reject(new Error("Bridge closed before the webview answered."));
      this.pendingHostRequests.delete(requestId);
    }
  }

  resolveHostResponse(requestId: string, response: unknown) {
    const pending = this.pendingHostRequests.get(requestId);
    if (!pending) return false;
    this.pendingHostRequests.delete(requestId);
    pending.resolve(response);
    return true;
  }

  hasRunningChannel(channelId: string | undefined) {
    return Boolean(channelId && this.channels.get(channelId)?.query);
  }

  private async run(options: ChannelOptions, input: AsyncQueue<SDKUserMessage>, abort: AbortController) {
    try {
      const permissionMode =
        options.permissionMode === undefined
          ? await getInitialPermissionMode(options.cwd)
          : normalizePermissionMode(options.permissionMode);
      const showThinkingSummaries = await getShowThinkingSummaries(options.cwd);
      const model = normalizeModel(options.model) ?? (await getInitialModel(options.cwd));
      const sdkEnv = await getSdkEnv(options.cwd, options.apiKey);
      const sdkQuery = query({
        prompt: input,
        options: {
          cwd: options.cwd,
          resume: options.resume,
          ...(model ? { model } : {}),
          permissionMode,
          thinking: normalizeThinkingConfig(options.thinkingLevel, showThinkingSummaries),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: WEBVIEW_CONTEXT_PROMPT
          },
          allowDangerouslySkipPermissions: true,
          enableFileCheckpointing: true,
          includePartialMessages: true,
          settingSources: ["user", "project", "local"],
          mcpServers: {
            "claude-in-chrome": createBrowserMcpServer()
          },
          extraArgs: {
            debug: null,
            "debug-to-stderr": null,
            "enable-auth-status": null,
            "replay-user-messages": null
          },
          pathToClaudeCodeExecutable: resolveClaudeCodeExecutable(),
          env: {
            ...sdkEnv,
            MCP_CONNECTION_NONBLOCKING: "true",
            CLAUDE_CODE_ENABLE_TASKS: "0",
            CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
            CLAUDE_AGENT_SDK_CLIENT_APP: "claude-agent-webview"
          },
          canUseTool: async (toolName, toolInput, context) => {
            const response = await this.requestToolPermission({
              channelId: options.channelId,
              toolName,
              toolInput,
              suggestions: context?.suggestions ?? [],
              signal: context?.signal,
              send: options.send
            });
            return normalizeToolPermissionResponse(response, toolInput);
          },
          onUserDialog: async (request, context) =>
            this.requestUserDialog({
              channelId: options.channelId,
              request,
              signal: context.signal,
              send: options.send
            }),
          supportedDialogKinds: ["refusal_fallback_prompt", "fable_overage_consent_prompt"]
        }
      });
      const channel = this.channels.get(options.channelId);
      if (channel) {
        channel.query = sdkQuery;
        void sdkQuery
          .initializationResult()
          .then(async (initialization) => {
            channel.initialization = initialization;
            options.send({
              type: "request",
              channelId: options.channelId,
              requestId: randomUUID(),
              request: {
                type: "update_state",
                state: await createWebviewState(options.cwd),
                config: await createClaudeConfig(options.cwd, { initialization })
              }
            });
          })
          .catch(() => undefined);
      }
      for await (const message of sdkQuery) {
        if (abort.signal.aborted) break;
        this.updateSessionIdFromMessage(options, message);
        options.send({ type: "io_message", channelId: options.channelId, message });
      }
      await this.persistProjectSessionState(options.channelId);
      options.send({ type: "close_channel", channelId: options.channelId });
    } catch (error) {
      options.send({
        type: "close_channel",
        channelId: options.channelId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private updateSessionIdFromMessage(options: ChannelOptions, message: unknown) {
    const sessionId = extractSessionId(message);
    if (!sessionId) return;
    const channel = this.channels.get(options.channelId);
    if (!channel || channel.sessionId === sessionId) return;
    clearSessionState(channel.sessionId);
    channel.sessionId = sessionId;
    setSessionState(sessionId, "running", undefined, channel.cwd);
    void this.persistProjectSessionState(options.channelId);
    sendSessionStatesUpdate(options.send, options.channelId, sessionId, channel.cwd);
  }

  private async persistProjectSessionState(channelId: string) {
    const channel = this.channels.get(channelId);
    if (!channel?.sessionId) return;
    await updateClaudeProjectState(channel.cwd, {
      lastSessionId: channel.sessionId,
      lastSessionModified: Date.now(),
      lastSessionFirstPrompt: channel.firstPrompt
    }).catch(() => undefined);
  }

  private requestToolPermission({
    channelId,
    toolName,
    toolInput,
    suggestions,
    signal,
    send
  }: {
    channelId: string;
    toolName: string;
    toolInput: unknown;
    suggestions: unknown[];
    signal: AbortSignal | undefined;
    send: SendHost;
  }) {
    return this.requestHostResponse({
      signal,
      send,
      createMessage: (requestId) => createToolPermissionRequest(requestId, channelId, toolName, toolInput, suggestions)
    });
  }

  private async requestUserDialog({
    channelId,
    request,
    signal,
    send
  }: {
    channelId: string;
    request: UserDialogRequest;
    signal: AbortSignal;
    send: SendHost;
  }): Promise<UserDialogResult> {
    const response = await this.requestHostResponse({
      signal,
      send,
      createMessage: (requestId) =>
        createUserDialogRequest(requestId, channelId, request.dialogKind, request.payload, request.toolUseID)
    });
    return normalizeUserDialogResponse(response);
  }

  private requestHostResponse({
    send,
    signal,
    createMessage
  }: {
    send: SendHost;
    signal: AbortSignal | undefined;
    createMessage: (requestId: string) => HostMessage;
  }) {
    const requestId = randomUUID();
    send(createMessage(requestId));

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        this.pendingHostRequests.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Host request aborted."));
      };
      this.pendingHostRequests.set(requestId, {
        resolve: (response) => {
          cleanup();
          resolve(response);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private getQuery(channelId: string | undefined) {
    if (!channelId) return undefined;
    return this.channels.get(channelId)?.query;
  }

  private getRequiredQuery(channelId: string | undefined) {
    return this.getRequiredChannel(channelId).query;
  }

  private getRequiredChannel(channelId: string | undefined): RunningChannel & { query: Query } {
    const channel = channelId ? this.channels.get(channelId) : undefined;
    if (!channel?.query) throw new Error("Claude session is not running for this request.");
    return channel as RunningChannel & { query: Query };
  }

  private getRuntimeQuery(channelId: string | undefined) {
    return this.getRequiredQuery(channelId) as RuntimeQueryControls;
  }
}

function sendSessionStatesUpdate(
  send: SendHost,
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

function extractSessionId(message: unknown) {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { session_id?: unknown; sessionId?: unknown; message?: { session_id?: unknown } };
  if (typeof candidate.session_id === "string") return candidate.session_id;
  if (typeof candidate.sessionId === "string") return candidate.sessionId;
  if (typeof candidate.message?.session_id === "string") return candidate.message.session_id;
  return undefined;
}

function normalizePermissionMode(mode: string | undefined): PermissionMode {
  if (
    mode === "acceptEdits" ||
    mode === "plan" ||
    mode === "bypassPermissions" ||
    mode === "dontAsk" ||
    mode === "auto" ||
    mode === "default"
  ) {
    return mode;
  }
  return "default";
}

function validateWorkspaceCwd(cwd: string) {
  const resolved = path.resolve(cwd);
  try {
    const stat = statSync(resolved);
    if (stat.isDirectory()) return undefined;
    return `Workspace path is not a directory: ${resolved}`;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return `Workspace directory does not exist: ${resolved}`;
    return `Workspace directory cannot be accessed: ${resolved}`;
  }
}

function normalizeThinkingConfig(thinkingLevel: string | undefined, showThinkingSummaries: boolean | undefined): ThinkingConfig {
  if (thinkingLevel === "off") return { type: "disabled" };
  return {
    type: "enabled",
    budgetTokens: THINKING_TOKEN_BUDGET,
    display: showThinkingSummaries ? "summarized" : undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function extractModelValue(model: unknown) {
  if (typeof model === "string") return model;
  if (isRecord(model) && typeof model.value === "string") return model.value;
  return "default";
}

function normalizeModel(model: unknown) {
  const value = extractModelValue(model).trim();
  if (!value || value === "default") return undefined;
  return value;
}

const AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL"
] as const;

export async function getSdkEnv(cwd: string, apiKey: string | undefined) {
  const env: Record<string, string | undefined> = { ...process.env };
  if (apiKey) {
    for (const key of AUTH_ENV_KEYS) delete env[key];
    env.ANTHROPIC_API_KEY = apiKey;
    return env;
  }

  const resolved = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
  const settingsEnv = isRecord(resolved.effective.env) ? resolved.effective.env : {};
  const hasSettingsAuth = AUTH_ENV_KEYS.some((key) => typeof settingsEnv[key] === "string" && settingsEnv[key].trim());
  if (!hasSettingsAuth) return env;

  for (const key of AUTH_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(settingsEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

async function writeUserSettings(settings: Record<string, unknown>) {
  const settingsPath = getUserSettingsPath();
  const current = await readUserSettings(settingsPath);
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) delete current[key];
    else current[key] = value;
  }
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
}

async function writeUserPermissionMode(permissionMode: PermissionMode) {
  const settingsPath = getUserSettingsPath();
  const current = await readUserSettings(settingsPath);
  const permissions = isRecord(current.permissions) ? { ...current.permissions } : {};
  permissions.defaultMode = permissionMode;
  current.permissions = permissions;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
}

async function readUserSettings(settingsPath: string) {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getUserSettingsPath() {
  const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "settings.json");
  return settingsPath;
}

async function getInitialModel(cwd: string) {
  try {
    const resolved = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
    return normalizeModel(resolved.effective.model);
  } catch {
    return undefined;
  }
}

async function getInitialPermissionMode(cwd: string): Promise<PermissionMode> {
  try {
    const resolved = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
    return normalizePermissionMode(filterEscalatingDefaultMode(resolved).permissions?.defaultMode);
  } catch {
    return "default";
  }
}

async function getShowThinkingSummaries(cwd: string) {
  try {
    const resolved = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
    const value = resolved.effective.showThinkingSummaries;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function toSdkUserMessage(message: unknown): SDKUserMessage {
  if (isSdkUserMessage(message)) return message;
  return {
    type: "user",
    message: {
      role: "user",
      content: extractPromptText(message)
    },
    parent_tool_use_id: null
  };
}

function isSdkUserMessage(message: unknown): message is SDKUserMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { type?: unknown; message?: { role?: unknown; content?: unknown } };
  return candidate.type === "user" && candidate.message?.role === "user" && candidate.message.content !== undefined;
}

export function wrapForBrowser(message: HostMessage) {
  return JSON.stringify({ type: "from-extension", message });
}
