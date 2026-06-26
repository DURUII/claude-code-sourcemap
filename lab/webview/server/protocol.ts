import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  deleteSession,
  filterEscalatingDefaultMode,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  renameSession,
  resolveSettings,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type ResolvedSettings,
  type Settings,
  type UserDialogResult
} from "@anthropic-ai/claude-agent-sdk";
import {
  addMarketplace,
  installPlugin,
  listMarketplaces,
  listPlugins,
  refreshMarketplace,
  removeMarketplace,
  setPluginEnabled,
  uninstallPlugin
} from "./pluginManager.js";
import { listConfiguredMcpServers } from "./mcpManager.js";
import { TerminalManager } from "./terminalManager.js";

type FileSuggestion = {
  type: "file" | "directory";
  path: string;
  name: string;
};

const MAX_FILE_SUGGESTIONS = 80;
const MAX_SCAN_ENTRIES = 8_000;
const DEFAULT_READ_FILE_BYTES = 1024 * 1024;
const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;
const MAX_WORKTREE_NAME_LENGTH = 64;
const WORKTREE_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;
const AUTH_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"] as const;
const execFileAsync = promisify(execFile);
const defaultTerminalManager = new TerminalManager();
const sessionStates = new Map<string, StoredSessionStateInfo>();
const integrationState: {
  chromeMcpState: Record<string, unknown>;
  debuggerMcpState: Record<string, unknown>;
  jupyterMcpState: Record<string, unknown>;
} = {
  chromeMcpState: { status: "connected", source: "standalone-browser-bridge" },
  debuggerMcpState: { status: "inactive" },
  jupyterMcpState: { status: "inactive" }
};
let standaloneThinkingLevel: "default_on" | "off" = "default_on";
const standaloneCapabilities = {
  auth: "settings-or-env",
  browserBridge: {
    currentSelection: true,
    browserTabs: true,
    fileViewer: true,
    configViewer: true,
    markdownPreview: true,
    editableContent: true,
    editableDiff: true,
    openExternalUrl: true
  },
  extensionHost: {
    speechToText: false,
    chromeMcp: true,
    jupyterMcp: false,
    remoteTeleport: false,
    oauthLogin: false
  }
} as const;
const IGNORED_FILE_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".claude",
  ".codex",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "dist-server",
  "node_modules",
  "out",
  "target"
]);

export type ClientMessage =
  | { type: "bridge_auth"; apiKey: string }
  | { type: "request"; requestId: string; channelId?: string; request: { type: string; [key: string]: unknown } }
  | { type: "response"; requestId: string; response: unknown }
  | { type: "start_speech_to_text"; channelId: string }
  | { type: "stop_speech_to_text"; channelId: string }
  | {
      type: "launch_claude";
      channelId: string;
      cwd?: string;
      resume?: string;
      permissionMode?: string;
      thinkingLevel?: string;
      model?: unknown;
    }
  | { type: "io_message"; channelId: string; message: unknown; done?: boolean }
  | { type: "interrupt_claude"; channelId: string }
  | { type: "cancel_request"; targetRequestId: string };

export type HostMessage =
  | { type: "response"; requestId: string; response: unknown }
  | { type: "request"; requestId: string; channelId?: string; request: { type: string; [key: string]: unknown } }
  | { type: "io_message"; channelId: string; message: unknown }
  | { type: "speech_audio_level"; channelId: string; level: number }
  | { type: "speech_to_text_message"; channelId: string; text: string; done?: boolean }
  | { type: "close_channel"; channelId: string; error?: string };

export type SendHost = (message: HostMessage) => void;

export function ok(requestId: string, response: unknown): HostMessage {
  return { type: "response", requestId, response };
}

export function err(requestId: string, error: unknown): HostMessage {
  const message = error instanceof Error ? error.message : String(error);
  return { type: "response", requestId, response: { type: "error", error: message } };
}

export function extractPromptText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const candidate = message as { message?: { content?: unknown }; content?: unknown };
  const content = candidate.message?.content ?? candidate.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createToolPermissionRequest(
  requestId: string,
  channelId: string,
  toolName: string,
  inputs: unknown,
  suggestions: unknown[] = []
): HostMessage {
  return {
    type: "request",
    channelId,
    requestId,
    request: {
      type: "tool_permission_request",
      toolName,
      inputs,
      suggestions
    }
  };
}

export function createUserDialogRequest(
  requestId: string,
  channelId: string,
  dialogKind: string,
  payload: Record<string, unknown>,
  toolUseID?: string
): HostMessage {
  return {
    type: "request",
    channelId,
    requestId,
    request: {
      type: "user_dialog_request",
      dialogKind,
      payload,
      toolUseID
    }
  };
}

export function normalizeToolPermissionResponse(response: unknown, fallbackInput: unknown): PermissionResult {
  const candidate = response && typeof response === "object" && "result" in response ? response.result : response;
  if (!candidate || typeof candidate !== "object") {
    return { behavior: "deny", message: "Permission request did not return a decision." };
  }
  const result = candidate as {
    behavior?: unknown;
    updatedInput?: unknown;
    updatedPermissions?: unknown;
    message?: unknown;
  };
  if (result.behavior === "allow") {
    return {
      behavior: "allow",
      updatedInput: asRecord(result.updatedInput) ?? asRecord(fallbackInput),
      updatedPermissions: Array.isArray(result.updatedPermissions)
        ? (result.updatedPermissions as PermissionUpdate[])
        : undefined
    };
  }
  return {
    behavior: "deny",
    message: typeof result.message === "string" ? result.message : "User denied this action."
  };
}

export function normalizeUserDialogResponse(response: unknown): UserDialogResult {
  const candidate = response && typeof response === "object" && "result" in response ? response.result : response;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return { behavior: "cancelled" };
  const result = candidate as { behavior?: unknown; result?: unknown };
  if (result.behavior === "completed") return { behavior: "completed", result: result.result };
  return { behavior: "cancelled" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

type ClaudeSettingsForWebview = ResolvedSettings & {
  applied: Settings;
  errors?: unknown[];
};

type ClaudeState = {
  claudeSettings: ClaudeSettingsForWebview;
  model: string;
  permissionMode: PermissionMode;
  settings: Settings;
  authStatus: AuthStatus;
  account: AccountInfo;
  projectState: ProjectStateInfo | null;
  sourceConfigs: {
    user: Settings;
    project: Settings;
    local: Settings;
  };
};

type ProjectStateInfo = {
  path: string;
  hasTrustDialogAccepted?: boolean;
  hasCompletedProjectOnboarding?: boolean;
  projectOnboardingSeenCount?: number;
  lastSessionId?: string;
  lastSessionModified?: number;
  lastSessionFirstPrompt?: string;
  lastModelUsage?: unknown;
  lastSessionMetrics?: unknown;
  mcpServers?: unknown;
  disabledMcpServers?: unknown;
  disabledMcpjsonServers?: unknown;
  enabledMcpjsonServers?: unknown;
  mcpContextUris?: unknown;
};

type ProjectStatePatch = Partial<
  Pick<
    ProjectStateInfo,
    | "hasTrustDialogAccepted"
    | "hasCompletedProjectOnboarding"
    | "projectOnboardingSeenCount"
    | "lastSessionId"
    | "lastSessionModified"
    | "lastSessionFirstPrompt"
  >
>;

type AuthStatus =
  | { authMethod: "api-key" | "claudeai" | "3p" | "console" | "not-specified"; email?: string; subscriptionType?: string }
  | null;

type AccountInfo = {
  tokenSource: "api-key" | "claudeai" | "3p" | "console" | "not-specified" | "none";
  subscriptionType?: string;
};

type StateOverrides = {
  remoteControlState?: unknown;
};

export type SessionStateInfo = {
  sessionId: string;
  state: SessionRuntimeState;
  title?: string;
};

type SessionRuntimeState = "running" | "waiting_input" | "idle";

type StoredSessionStateInfo = SessionStateInfo & {
  cwd: string;
};

type ClaudeConfigOverrides = {
  initialization?: {
    account?: unknown;
    commands?: unknown;
    agents?: unknown;
    models?: unknown;
    output_style?: unknown;
    available_output_styles?: unknown;
    fast_mode_state?: unknown;
  };
};

async function getClaudeState(cwd: string): Promise<ClaudeState> {
  const resolved = await resolveSettings({ cwd, settingSources: ["user", "project", "local"] });
  const settings = filterEscalatingDefaultMode(resolved);
  const authStatus = getAuthStatus(settings);
  const projectState = await readClaudeProjectState(cwd);
  const safeResolved = redactSecrets(resolved) as ResolvedSettings;
  const safeSettings = redactSecrets(settings) as Settings;
  const sourceConfigs = getSourceConfigs(resolved);
  const safeSourceConfigs = {
    user: redactSecrets(sourceConfigs.user) as Settings,
    project: redactSecrets(sourceConfigs.project) as Settings,
    local: redactSecrets(sourceConfigs.local) as Settings
  };
  return {
    claudeSettings: {
      ...safeResolved,
      effective: safeSettings,
      applied: safeSettings,
      errors: Array.isArray((safeResolved as { errors?: unknown }).errors)
        ? ((safeResolved as { errors?: unknown[] }).errors ?? [])
        : []
    },
    model: getInitialModel(settings),
    permissionMode: getInitialPermissionMode(settings),
    settings: safeSettings,
    authStatus,
    account: getAccountInfo(authStatus),
    projectState,
    sourceConfigs: safeSourceConfigs
  };
}

async function readClaudeProjectState(cwd: string): Promise<ProjectStateInfo | null> {
  const statePath = getClaudeJsonPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.projects)) return null;
  const projectPath = path.resolve(cwd);
  const rawProject = parsed.projects[projectPath];
  if (!isRecord(rawProject)) return null;
  const safeProject = redactSecrets(rawProject) as Record<string, unknown>;
  return {
    path: projectPath,
    hasTrustDialogAccepted:
      typeof safeProject.hasTrustDialogAccepted === "boolean" ? safeProject.hasTrustDialogAccepted : undefined,
    hasCompletedProjectOnboarding:
      typeof safeProject.hasCompletedProjectOnboarding === "boolean" ? safeProject.hasCompletedProjectOnboarding : undefined,
    projectOnboardingSeenCount:
      typeof safeProject.projectOnboardingSeenCount === "number" ? safeProject.projectOnboardingSeenCount : undefined,
    lastSessionId: typeof safeProject.lastSessionId === "string" ? safeProject.lastSessionId : undefined,
    lastSessionModified:
      typeof safeProject.lastSessionModified === "number" ? safeProject.lastSessionModified : undefined,
    lastSessionFirstPrompt:
      typeof safeProject.lastSessionFirstPrompt === "string" ? safeProject.lastSessionFirstPrompt : undefined,
    lastModelUsage: safeProject.lastModelUsage,
    lastSessionMetrics: safeProject.lastSessionMetrics,
    mcpServers: safeProject.mcpServers,
    disabledMcpServers: safeProject.disabledMcpServers,
    disabledMcpjsonServers: safeProject.disabledMcpjsonServers,
    enabledMcpjsonServers: safeProject.enabledMcpjsonServers,
    mcpContextUris: safeProject.mcpContextUris
  };
}

function getClaudeJsonPath() {
  return process.env.CLAUDE_JSON_PATH || path.join(homedir(), ".claude.json");
}

function getUserSettingsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), "settings.json");
}

async function readSettingsFile(settingsPath: string) {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeUserSettings(settings: Record<string, unknown>) {
  const settingsPath = getUserSettingsPath();
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

async function configureApiKey(cwd: string, apiKeyValue: unknown) {
  const apiKey = typeof apiKeyValue === "string" ? apiKeyValue.trim() : "";
  if (!apiKey) throw new Error("API key is required.");

  const settingsPath = getUserSettingsPath();
  const settings = await readSettingsFile(settingsPath);
  const env = isRecord(settings.env) ? { ...settings.env } : {};
  for (const key of AUTH_ENV_KEYS) delete env[key];
  env.ANTHROPIC_API_KEY = apiKey;
  settings.env = env;
  await writeUserSettings(settings);
  return createLoginResponse(cwd);
}

export async function updateClaudeProjectState(cwd: string, patch: ProjectStatePatch) {
  const statePath = getClaudeJsonPath();
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    state = isRecord(parsed) ? parsed : {};
  } catch {
    state = {};
  }

  const projects = isRecord(state.projects) ? { ...state.projects } : {};
  const projectPath = path.resolve(cwd);
  const existing = isRecord(projects[projectPath]) ? { ...(projects[projectPath] as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) existing[key] = value;
  }
  projects[projectPath] = existing;
  state.projects = projects;

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return readClaudeProjectState(projectPath);
}

function getSourceConfigs(resolved: ResolvedSettings) {
  return {
    user: mergeSourceSettings(resolved, "user"),
    project: mergeSourceSettings(resolved, "project"),
    local: mergeSourceSettings(resolved, "local")
  };
}

function mergeSourceSettings(resolved: ResolvedSettings, source: "user" | "project" | "local"): Settings {
  const matchingSources = resolved.sources.filter((entry) => entry.source === source);
  if (matchingSources.length === 0) return {};
  return Object.assign({}, ...matchingSources.map((entry) => entry.settings));
}

async function listProjectFiles(cwd: string, pattern: unknown): Promise<FileSuggestion[]> {
  const query = typeof pattern === "string" ? pattern.trim().replace(/^@/, "").toLowerCase() : "";
  const root = path.resolve(cwd);
  const results: FileSuggestion[] = [];
  let scanned = 0;

  async function visit(dir: string) {
    if (scanned >= MAX_SCAN_ENTRIES || results.length >= MAX_FILE_SUGGESTIONS) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (scanned >= MAX_SCAN_ENTRIES || results.length >= MAX_FILE_SUGGESTIONS) return;
      if (entry.name.startsWith(".") && entry.name !== ".env" && !query.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) continue;
      scanned += 1;

      const normalized = relativePath.split(path.sep).join("/");
      const isDirectory = entry.isDirectory();
      const suggestion: FileSuggestion = {
        type: isDirectory ? "directory" : "file",
        path: normalized,
        name: entry.name
      };
      if (matchesFileQuery(suggestion, query)) results.push(suggestion);
      if (isDirectory && !IGNORED_FILE_DIRS.has(entry.name)) await visit(absolutePath);
    }
  }

  await visit(root);
  return results.sort((a, b) => scoreFileSuggestion(a, query) - scoreFileSuggestion(b, query));
}

function matchesFileQuery(file: FileSuggestion, query: string) {
  if (!query) return true;
  return file.path.toLowerCase().includes(query) || file.name.toLowerCase().includes(query);
}

function scoreFileSuggestion(file: FileSuggestion, query: string) {
  const pathText = file.path.toLowerCase();
  const nameText = file.name.toLowerCase();
  let score = file.type === "directory" ? 5 : 0;
  if (query) {
    if (nameText === query) score -= 40;
    else if (nameText.startsWith(query)) score -= 25;
    else if (pathText.startsWith(query)) score -= 15;
    else score += pathText.indexOf(query);
  }
  score += file.path.split("/").length;
  return score;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isSecretKey(key) && typeof nestedValue === "string" && nestedValue) {
      redacted[key] = "[redacted]";
    } else {
      redacted[key] = redactSecrets(nestedValue);
    }
  }
  return redacted;
}

function isSecretKey(key: string) {
  return /(TOKEN|API_KEY|AUTH|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getInitialModel(settings: Settings) {
  return typeof settings.model === "string" && settings.model.trim() ? settings.model : "default";
}

function getInitialPermissionMode(settings: Settings): PermissionMode {
  const defaultMode = settings.permissions?.defaultMode;
  if (
    defaultMode === "acceptEdits" ||
    defaultMode === "plan" ||
    defaultMode === "bypassPermissions" ||
    defaultMode === "dontAsk" ||
    defaultMode === "auto" ||
    defaultMode === "default"
  ) {
    return defaultMode;
  }
  return "default";
}

function getAuthStatus(settings: Settings): AuthStatus {
  const env = isRecord(settings.env) ? settings.env : {};
  if (hasNonEmptyEnv("ANTHROPIC_API_KEY", env)) {
    return { authMethod: "api-key", subscriptionType: "api" };
  }
  if (hasNonEmptyEnv("ANTHROPIC_AUTH_TOKEN", env)) {
    return {
      authMethod: usesThirdPartyProvider(env) ? "3p" : "claudeai",
      subscriptionType: usesThirdPartyProvider(env) ? "api" : undefined
    };
  }
  if (usesThirdPartyProvider(env)) return { authMethod: "3p", subscriptionType: "api" };
  if (hasNonEmptyProcessEnv("ANTHROPIC_API_KEY")) {
    return { authMethod: "api-key", subscriptionType: "api" };
  }
  if (hasNonEmptyProcessEnv("ANTHROPIC_AUTH_TOKEN")) {
    return {
      authMethod: usesProcessThirdPartyProvider() ? "3p" : "claudeai",
      subscriptionType: usesProcessThirdPartyProvider() ? "api" : undefined
    };
  }
  if (usesProcessThirdPartyProvider()) return { authMethod: "3p", subscriptionType: "api" };
  return null;
}

function getAccountInfo(authStatus: AuthStatus): AccountInfo {
  if (!authStatus) return { tokenSource: "none" };
  return {
    tokenSource: authStatus.authMethod,
    ...(authStatus.subscriptionType ? { subscriptionType: authStatus.subscriptionType } : {})
  };
}

function hasNonEmptyEnv(key: string, env: Record<string, unknown>) {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyProcessEnv(key: string) {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function usesThirdPartyProvider(env: Record<string, unknown>) {
  return (
    hasNonEmptyEnv("ANTHROPIC_BASE_URL", env) ||
    hasNonEmptyEnv("ANTHROPIC_MODEL", env)
  );
}

function usesProcessThirdPartyProvider() {
  return (
    hasNonEmptyProcessEnv("ANTHROPIC_BASE_URL") ||
    hasNonEmptyProcessEnv("ANTHROPIC_MODEL")
  );
}

export async function handleRpc(
  request: { type: string; [key: string]: unknown },
  cwd: string,
  signal?: AbortSignal,
  terminals: TerminalManager = defaultTerminalManager
) {
  switch (request.type) {
    case "init": {
      return {
        type: "init_response",
        state: await createWebviewState(cwd)
      };
    }

    case "get_claude_state": {
      return {
        type: "get_claude_state_response",
        config: await createClaudeConfig(cwd)
      };
    }

    case "login":
      return createLoginResponse(cwd, request.method);

    case "configure_api_key":
      return configureApiKey(cwd, request.apiKey);

    case "submit_oauth_code":
      throw new Error(
        "OAuth login requires the VSCode extension host. Configure credentials in Claude settings or environment instead."
      );

    case "list_sessions_request": {
      const sessions = await listSessions({ dir: cwd, limit: 50 });
      return {
        type: "list_sessions_response",
        sessions: sessions.map((session) => ({
          id: session.sessionId,
          summary: session.summary || "Untitled",
          customTitle: session.customTitle,
          lastModifiedTime: session.lastModified,
          createdAt: session.createdAt,
          cwd: session.cwd ?? cwd,
          isCurrentWorkspace: true,
          worktree: undefined
        }))
      };
    }

    case "list_remote_sessions":
      return { type: "list_remote_sessions_response", sessions: [], connected: false, reconnecting: false };

    case "teleport_session":
      throw new Error("Remote session teleport is not available in standalone API-key mode.");

    case "get_session_request": {
      const sessionId = String(request.sessionId ?? "");
      const [info, messages] = await Promise.all([
        getSessionInfo(sessionId),
        getSessionMessages(sessionId).catch(() => [])
      ]);
      return {
        type: "get_session_response",
        session: {
          id: sessionId,
          summary: info?.summary || "Untitled",
          messages,
          sessionDiffs: []
        },
        messages,
        sessionDiffs: []
      };
    }

    case "rename_session": {
      const sessionId = String(request.sessionId ?? "");
      const title = String(request.title ?? "Untitled");
      await renameSession(sessionId, title);
      return { type: "rename_session_response", skipped: false };
    }

    case "generate_session_title": {
      const description = String(request.description ?? "").trim();
      return {
        type: "generate_session_title_response",
        title: description ? description.slice(0, 60) : "New chat"
      };
    }

    case "delete_session": {
      const sessionId = String(request.sessionId ?? "");
      await deleteSession(sessionId, { dir: cwd });
      clearSessionState(sessionId);
      return { type: "delete_session_response" };
    }

    case "get_asset_uris":
      return { type: "asset_uris_response", assetUris: {} };

    case "get_current_selection":
      throw new Error("get_current_selection requires the browser webview bridge.");

    case "list_files_request":
      return { type: "list_files_response", files: await listProjectFiles(cwd, request.pattern) };

    case "set_permission_mode":
      return { type: "set_permission_mode_response", success: true };

    case "get_mcp_servers":
      return listConfiguredMcpServers(cwd, undefined, signal);

    case "authenticate_mcp_server":
    case "clear_mcp_server_auth":
    case "submit_mcp_oauth_callback_url":
    case "reconnect_mcp_server":
    case "set_mcp_server_enabled":
      throw new Error(`${request.type} requires a running Claude session.`);

    case "list_plugins":
      return listPlugins(cwd, request.includeAvailable, undefined, signal);

    case "list_marketplaces":
      return listMarketplaces(cwd, undefined, signal);

    case "install_plugin":
      return installPlugin(cwd, request.pluginId, request.scope, signal);

    case "uninstall_plugin":
      return uninstallPlugin(cwd, request.pluginId, signal);

    case "set_plugin_enabled":
      return setPluginEnabled(cwd, request.pluginId, request.enabled, signal);

    case "add_marketplace":
      return addMarketplace(cwd, request.source, signal);

    case "remove_marketplace":
      return removeMarketplace(cwd, request.marketplaceId, signal);

    case "refresh_marketplace":
      return refreshMarketplace(cwd, request.marketplaceId, signal);

    case "show_notification":
      return { type: "show_notification_response", buttonValue: undefined };

    case "get_plan_comments":
      return { type: "get_plan_comments_response", comments: [] };

    case "remove_plan_comment":
      return { type: "remove_plan_comment_response" };

    case "open_content":
    case "open_diff":
    case "open_file_diffs":
    case "open_markdown_preview":
      throw new Error(`${request.type} requires the browser webview bridge.`);

    case "read_file":
      return readWorkspaceFile(cwd, request.path, request.maxBytes ?? request.max_bytes, request.encoding, signal);

    case "check_git_status":
      return checkGitStatus(cwd);

    case "checkout_branch":
      return checkoutBranch(cwd, request.branch, signal);

    case "create_worktree":
      return createWorktree(cwd, request.name, signal);

    case "exec":
      return execCommand(cwd, request.command, request.params, signal);

    case "ensure_chrome_mcp_enabled":
      integrationState.chromeMcpState = {
        status: "connected",
        source: "standalone-browser-bridge"
      };
      return { type: "ensure_chrome_mcp_enabled_response", wasDisabled: false };

    case "disable_chrome_mcp":
      integrationState.chromeMcpState = { status: "disconnected" };
      return { type: "disable_chrome_mcp_response" };

    case "enable_jupyter_mcp":
      integrationState.jupyterMcpState = {
        status: "error",
        error: "Jupyter integration requires the VSCode extension host and is not available in standalone mode.",
        isActiveEditorNotebook: false,
        notebookCount: 0
      };
      return { type: "enable_jupyter_mcp_response" };

    case "disable_jupyter_mcp":
      integrationState.jupyterMcpState = { status: "inactive" };
      return { type: "disable_jupyter_mcp_response" };

    case "create_new_browser_tab":
      throw new Error("create_new_browser_tab requires the browser webview bridge.");

    case "update_skipped_branch":
      return {
        type: "update_skipped_branch_response",
        sessionId: request.sessionId,
        branch: request.branch,
        failed: request.failed === true
      };

    case "fork_conversation":
      throw new Error(
        "Conversation forking requires Claude session-store support that is not exposed by the standalone Agent SDK bridge."
      );

    case "update_session_state": {
      const sessionId = typeof request.sessionId === "string" ? request.sessionId.trim() : "";
      if (!sessionId) throw new Error("update_session_state requires a sessionId.");
      setSessionState(
        sessionId,
        normalizeSessionRuntimeState(request.state),
        typeof request.title === "string" ? request.title : undefined,
        cwd
      );
      return { type: "update_session_state_response", sessionId };
    }

    case "open_terminal":
      return terminals.openTerminal(request, cwd, signal);

    case "open_claude_in_terminal":
      return terminals.openClaudeInTerminal(request, cwd, signal);

    case "get_terminal_contents":
      return terminals.getTerminalContents(request.terminalName);

    case "show_claude_terminal_setting":
    case "dismiss_terminal_banner":
    case "dismiss_review_upsell_banner":
    case "dismiss_onboarding":
      return { type: `${request.type}_response` };

    case "open_url":
      return createOpenUrlResponse(request.type, request.url);

    case "open_help":
      return createOpenUrlResponse(request.type, "https://docs.anthropic.com/en/docs/claude-code");

    case "close_plan_preview":
    case "rename_tab":
    case "log_event":
    case "message_rated":
    case "submit_feedback":
      return { type: `${request.type}_response`, id: randomUUID(), opened: false, content: "" };

    case "new_conversation_tab":
      return createSessionNavigationResponse(cwd, request.type, request.sessionId, request.initialPrompt);

    case "open_in_editor":
      return createSessionNavigationResponse(cwd, request.type, request.sessionId, undefined);

    case "open_folder":
    case "open_folder_in_new_window":
      return createWorkspaceNavigationResponse(cwd, request.type, request.folderPath);

    case "open_file":
      return createOpenFileResponse(cwd, request.filePath ?? request.path, request.location);

    case "open_config":
    case "open_config_file":
      return createOpenConfigResponse(request.type, cwd, request.configType);

    case "open_output_panel":
      return {
        type: "open_output_panel_response",
        id: randomUUID(),
        opened: false,
        content: "Bridge output is available in the terminal running `npm start`."
      };

    default:
      throw new Error(`Unsupported host request: ${request.type}`);
  }
}

export function setSessionState(sessionId: string, state: SessionRuntimeState, title?: string, cwd: string = "") {
  sessionStates.set(sessionId, { sessionId, state, title, cwd: path.resolve(cwd || ".") });
}

export function clearSessionState(sessionId: string) {
  sessionStates.delete(sessionId);
}

export function getSessionStateSnapshot(cwd?: string) {
  const normalizedCwd = cwd ? path.resolve(cwd) : undefined;
  return Array.from(sessionStates.values())
    .filter((session) => !normalizedCwd || session.cwd === normalizedCwd)
    .map(({ sessionId, state, title }) => ({ sessionId, state, title }));
}

export function setStandaloneThinkingLevel(thinkingLevel: unknown) {
  standaloneThinkingLevel = thinkingLevel === "off" ? "off" : "default_on";
  return standaloneThinkingLevel;
}

export function getStandaloneThinkingLevel() {
  return standaloneThinkingLevel;
}

function normalizeSessionRuntimeState(state: unknown): SessionRuntimeState {
  if (state === "running" || state === "waiting_input" || state === "idle") return state;
  throw new Error("update_session_state state must be one of: running, waiting_input, idle.");
}

async function readWorkspaceFile(
  cwd: string,
  requestedPath: unknown,
  maxBytes: unknown,
  encoding: unknown,
  signal?: AbortSignal
) {
  if (signal?.aborted) throw new Error("File read cancelled.");
  const absPath = resolveWorkspaceFilePath(cwd, requestedPath);
  const limit = normalizeReadLimit(maxBytes);
  const file = await open(absPath, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, limit + 1, 0);
    const truncated = bytesRead > limit;
    const contentsBuffer = buffer.subarray(0, Math.min(bytesRead, limit));
    const useBase64 = encoding === "base64";
    return {
      type: "read_file_response",
      file: {
        contents: contentsBuffer.toString(useBase64 ? "base64" : "utf8"),
        absPath,
        ...(truncated ? { truncated: true } : {}),
        ...(useBase64 ? { encoding: "base64" } : {})
      }
    };
  } finally {
    await file.close();
  }
}

function resolveWorkspaceFilePath(cwd: string, requestedPath: unknown) {
  if (typeof requestedPath !== "string" || !requestedPath.trim() || requestedPath.includes("\0")) {
    throw new Error("Invalid file path.");
  }
  const root = path.resolve(cwd);
  const absPath = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(root, requestedPath);
  const relative = path.relative(root, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("File path is outside the current workspace.");
  }
  return absPath;
}

function normalizeReadLimit(maxBytes: unknown) {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) return DEFAULT_READ_FILE_BYTES;
  return Math.min(Math.floor(maxBytes), MAX_READ_FILE_BYTES);
}

function createOpenFileResponse(cwd: string, requestedPath: unknown, location: unknown) {
  const absPath = resolveWorkspaceFilePath(cwd, requestedPath);
  const params = new URLSearchParams({ path: path.relative(cwd, absPath).split(path.sep).join("/"), cwd });
  const line = extractLineNumber(location);
  if (line) params.set("line", String(line));
  return { type: "open_file_response", id: randomUUID(), opened: true, url: `/file?${params.toString()}` };
}

function createOpenConfigResponse(requestType: string, cwd: string, configType: unknown) {
  const type = typeof configType === "string" && configType ? configType : "user";
  const params = new URLSearchParams({ type, cwd });
  return { type: `${requestType}_response`, id: randomUUID(), opened: true, url: `/config?${params.toString()}` };
}

function createOpenUrlResponse(requestType: string, url: unknown) {
  const target = typeof url === "string" ? url : "";
  return { type: `${requestType}_response`, id: randomUUID(), opened: false, url: target, content: "" };
}

function createSessionNavigationResponse(cwd: string, requestType: string, sessionId: unknown, initialPrompt: unknown) {
  const params = new URLSearchParams();
  if (typeof sessionId === "string" && sessionId) params.set("session", sessionId.replace(/^remote:/, ""));
  if (typeof initialPrompt === "string" && initialPrompt) params.set("prompt", initialPrompt);
  params.set("cwd", cwd);
  const query = params.toString();
  return { type: `${requestType}_response`, id: randomUUID(), opened: true, url: query ? `/?${query}` : "/" };
}

function createWorkspaceNavigationResponse(cwd: string, requestType: string, folderPath: unknown) {
  const target = typeof folderPath === "string" && folderPath ? folderPath : cwd;
  const workspace = resolveWorkspaceDirectory(cwd, target);
  const params = new URLSearchParams({ cwd: workspace });
  return { type: `${requestType}_response`, id: randomUUID(), opened: true, url: `/?${params.toString()}` };
}

function resolveWorkspaceDirectory(cwd: string, requestedPath: string) {
  if (requestedPath.includes("\0")) throw new Error("Invalid folder path.");
  const root = path.resolve(cwd);
  const absPath = path.isAbsolute(requestedPath) ? path.normalize(requestedPath) : path.resolve(root, requestedPath);
  const relative = path.relative(root, absPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Folder path is outside the current workspace.");
  }
  return absPath;
}

function extractLineNumber(location: unknown) {
  if (!isRecord(location)) return undefined;
  const candidate = location.line ?? location.startLine ?? location.range;
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) return Math.floor(candidate);
  if (isRecord(candidate)) return extractLineNumber(candidate);
  return undefined;
}

async function checkGitStatus(cwd: string) {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024
    });
    const changedFiles = stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2).trim() || "modified",
        path: line.slice(3).trim()
      }));
    return {
      type: "check_git_status_response",
      isClean: changedFiles.length === 0,
      changedFiles
    };
  } catch {
    return {
      type: "check_git_status_response",
      isClean: true,
      changedFiles: []
    };
  }
}

async function checkoutBranch(cwd: string, branch: unknown, signal?: AbortSignal) {
  const branchName = typeof branch === "string" ? branch.trim() : "";
  if (!branchName) throw new Error("Branch name is required.");
  if (branchName.includes("\0") || branchName.startsWith("-")) throw new Error("Invalid branch name.");
  await execGit(["checkout", branchName], cwd, signal);
  return { type: "checkout_branch_response", branch: branchName };
}

async function createWorktree(cwd: string, name: unknown, signal?: AbortSignal) {
  const worktreeName = typeof name === "string" ? name.trim() : "";
  const nameError = validateWorktreeName(worktreeName);
  if (nameError) throw new Error(nameError);

  const repoRoot = await gitRoot(cwd, signal);
  const parent = path.dirname(repoRoot);
  const targetPath = path.resolve(parent, worktreeName);
  if (path.dirname(targetPath) !== parent) throw new Error("Worktree must be created in a sibling directory.");
  await mkdir(parent, { recursive: true });
  await execGit(["worktree", "add", targetPath], repoRoot, signal);
  return {
    type: "create_worktree_response",
    path: targetPath,
    name: worktreeName,
    worktree: { path: targetPath, name: worktreeName }
  };
}

async function execCommand(cwd: string, command: unknown, params: unknown, signal?: AbortSignal) {
  const executable = typeof command === "string" ? command.trim() : "";
  if (!executable) throw new Error("Command is required.");
  if (executable.includes("\0")) throw new Error("Invalid command.");
  const args = Array.isArray(params) ? params.map((value) => String(value)) : [];
  if (args.some((arg) => arg.includes("\0"))) throw new Error("Invalid command argument.");
  const { stdout, stderr } = await execFileAsync(executable, args, {
    cwd,
    encoding: "utf8",
    signal,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
  return { type: "exec_response", stdout, stderr, code: 0 };
}

async function gitRoot(cwd: string, signal?: AbortSignal) {
  const { stdout } = await execGit(["rev-parse", "--show-toplevel"], cwd, signal);
  const root = stdout.trim();
  if (!root) throw new Error("Current workspace is not inside a Git repository.");
  return root;
}

async function execGit(args: string[], cwd: string, signal?: AbortSignal) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    signal,
    timeout: 30_000,
    maxBuffer: 1024 * 1024
  });
}

function validateWorktreeName(name: string) {
  if (!name) return "Name is required";
  if (name.length > MAX_WORKTREE_NAME_LENGTH) return `Name must be ${MAX_WORKTREE_NAME_LENGTH} characters or fewer`;
  if (!WORKTREE_NAME_PATTERN.test(name)) return "Only letters, numbers, dots, hyphens, and underscores";
  if (name === "." || name === ".." || name.includes("..")) return 'Name cannot be "." or ".." or contain ".."';
  if (name.endsWith(".") || name.endsWith(".lock")) return 'Name cannot end with "." or ".lock"';
  return undefined;
}

export async function createWebviewState(cwd: string, overrides: StateOverrides = {}) {
  const claudeState = await getClaudeState(cwd);
  return {
    authStatus: claudeState.authStatus,
    host: "web",
    defaultCwd: cwd,
    initialPermissionMode: claudeState.permissionMode,
    allowDangerouslySkipPermissions: true,
    claudeSettings: claudeState.claudeSettings,
    projectState: claudeState.projectState,
    currentProjectState: claudeState.projectState,
    lastSessionId: claudeState.projectState?.lastSessionId,
    openNewInTab: false,
    isOnboardingEnabled: false,
    isOnboardingDismissed: true,
    showTerminalBanner: false,
    showReviewUpsellBanner: false,
    browserIntegrationSupported: true,
    speechToTextEnabled: false,
    speechToTextMicDenied: false,
    useCtrlEnterToSend: false,
    platform: process.platform,
    marketplaceType: "standalone",
    chromeMcpState: integrationState.chromeMcpState,
    debuggerMcpState: integrationState.debuggerMcpState,
    jupyterMcpState: integrationState.jupyterMcpState,
    experimentGates: {},
    feedbackSurveyConfig: undefined,
    spinnerVerbsConfig: undefined,
    mcp: { servers: [] },
    settings: claudeState.settings,
    modelSetting: claudeState.model,
    thinkingLevel: getStandaloneThinkingLevel(),
    unavailable_models: [],
    remoteControlState: overrides.remoteControlState ?? { status: "disconnected" },
    standaloneCapabilities
  };
}

export async function createClaudeConfig(cwd: string, overrides: ClaudeConfigOverrides = {}) {
  const claudeState = await getClaudeState(cwd);
  const initialization = overrides.initialization;
  return {
    account: initialization?.account ?? claudeState.account,
    allowDangerouslySkipPermissions: true,
    claudeSettings: claudeState.claudeSettings,
    commands: Array.isArray(initialization?.commands) ? initialization.commands : [],
    currentProjectConfig: claudeState.sourceConfigs.project,
    currentProjectState: claudeState.projectState,
    projectState: claudeState.projectState,
    currentUserConfig: claudeState.sourceConfigs.user,
    currentLocalConfig: claudeState.sourceConfigs.local,
    currentRepo: null,
    experimentGates: {},
    feedbackSurveyConfig: undefined,
    spinnerVerbsConfig: undefined,
    mcpServers: [],
    model: claudeState.model,
    models: Array.isArray(initialization?.models) ? initialization.models : [],
    permissionMode: claudeState.permissionMode,
    settings: claudeState.settings,
    agents: Array.isArray(initialization?.agents) ? initialization.agents : [],
    output_style: typeof initialization?.output_style === "string" ? initialization.output_style : undefined,
    available_output_styles: Array.isArray(initialization?.available_output_styles)
      ? initialization.available_output_styles
      : [],
    fast_mode_state: initialization?.fast_mode_state,
    slashCommands: Array.isArray(initialization?.commands) ? initialization.commands : []
  };
}

async function createLoginResponse(cwd: string, method?: unknown) {
  if (method === "claudeai") {
    throw new Error(
      "Claude.ai OAuth requires the VSCode extension host. Use Anthropic Console with an API key in standalone mode."
    );
  }
  const claudeState = await getClaudeState(cwd);
  if (method === "console" && claudeState.authStatus?.authMethod !== "api-key") {
    throw new Error("Anthropic Console login requires an API key. Use configure_api_key first.");
  }
  if (!claudeState.authStatus) {
    throw new Error("No Claude credentials found in settings or environment.");
  }
  return {
    type: "login_response",
    auth: claudeState.authStatus,
    account: claudeState.account
  };
}
