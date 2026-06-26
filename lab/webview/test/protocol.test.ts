import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  createClaudeConfig,
  clearSessionState,
  createToolPermissionRequest,
  createUserDialogRequest,
  createWebviewState,
  extractPromptText,
  getSessionStateSnapshot,
  handleRpc,
  normalizeUserDialogResponse,
  normalizeToolPermissionResponse,
  setStandaloneThinkingLevel,
  updateClaudeProjectState
} from "../server/protocol.js";
import {
  installPlugin,
  listMarketplaces,
  listPlugins,
  mapInstalledPlugin,
  mapMarketplace,
  setPluginEnabled,
  uninstallPlugin
} from "../server/pluginManager.js";
import { TerminalManager } from "../server/terminalManager.js";
import {
  findClaudeCodeExecutable,
  findClaudeOnPath,
  findRestoredSrcClaudeExecutable,
  resolveClaudeCodeExecutable
} from "../server/claudeCli.js";
import { listConfiguredMcpServers, parseMcpListOutput } from "../server/mcpManager.js";
import { AgentBridge, getSdkEnv } from "../server/agentBridge.js";
import {
  clearBrowserTabs,
  closeBrowserTab,
  createBrowserMcpServer,
  enqueueBrowserCommand,
  enqueueBrowserHostCommand,
  listBrowserTabs,
  registerBrowserTab,
  resolveBrowserCommand,
  resolveBrowserHostCommand,
  takeBrowserHostCommands,
  takeBrowserCommands
} from "../server/browserBridge.js";

const execFileAsync = promisify(execFile);

describe("protocol adapter", () => {
  it("extracts text from SDK user messages", () => {
    expect(
      extractPromptText({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" }
          ]
        }
      })
    ).toBe("hello\nworld");
  });

  it("returns enough init state for the detached webview", async () => {
    const response = await handleRpc({ type: "init" }, "/tmp");
    expect(response).toMatchObject({
      type: "init_response",
      state: {
        defaultCwd: "/tmp",
        allowDangerouslySkipPermissions: true,
        browserIntegrationSupported: true,
        chromeMcpState: { status: "connected", source: "standalone-browser-bridge" },
        jupyterMcpState: { status: "inactive" },
        showReviewUpsellBanner: false,
        speechToTextEnabled: false,
        speechToTextMicDenied: false,
        useCtrlEnterToSend: false,
        platform: process.platform,
        marketplaceType: "standalone",
        thinkingLevel: "default_on",
        unavailable_models: [],
        standaloneCapabilities: {
          browserBridge: {
            currentSelection: true,
            browserTabs: true
          },
          extensionHost: {
            speechToText: false,
            chromeMcp: true,
            oauthLogin: false
          }
        }
      }
    });
  });

  it("tracks standalone browser tabs for the SDK MCP bridge", () => {
    clearBrowserTabs();
    const opened = registerBrowserTab({
      tabGroupId: "group-1",
      tabId: 1,
      url: "/browser-tab?tabGroupId=group-1&tabId=1",
      cwd: "/tmp",
      title: "Claude Browser Tab"
    });
    expect(opened).toMatchObject({ tabGroupId: "group-1", tabId: 1, status: "open" });
    expect(listBrowserTabs()).toHaveLength(1);

    closeBrowserTab("group-1", 1);
    expect(listBrowserTabs()).toHaveLength(0);
    expect(listBrowserTabs({ includeClosed: true })).toMatchObject([{ status: "closed" }]);
    clearBrowserTabs();
  });

  it("creates the in-process browser MCP server used by SDK sessions", () => {
    const server = createBrowserMcpServer();
    expect(server).toMatchObject({
      type: "sdk",
      name: "claude-in-chrome",
      instance: expect.any(Object)
    });
  });

  it("queues standalone browser commands and resolves browser tab responses", async () => {
    clearBrowserTabs();
    registerBrowserTab({
      tabGroupId: "group-1",
      tabId: 1,
      url: "about:blank",
      cwd: "/tmp",
      title: "Claude Browser Tab"
    });

    const pending = enqueueBrowserCommand("group-1", 1, "navigate", { url: "https://example.test" }, 1000);
    const commands = takeBrowserCommands("group-1", 1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      tabGroupId: "group-1",
      tabId: 1,
      type: "navigate",
      payload: { url: "https://example.test" }
    });

    expect(resolveBrowserCommand(commands[0].id, { url: "https://example.test", navigated: true })).toBe(true);
    await expect(pending).resolves.toMatchObject({ url: "https://example.test", navigated: true });
    clearBrowserTabs();
  });

  it("queues official browser javascript and form commands", async () => {
    clearBrowserTabs();
    registerBrowserTab({
      tabGroupId: "group-1",
      tabId: 1,
      url: "about:blank",
      cwd: "/tmp",
      title: "Claude Browser Tab"
    });

    const javascript = enqueueBrowserCommand("group-1", 1, "javascript_tool", { script: "return document.title;" }, 1000);
    const formInput = enqueueBrowserCommand("group-1", 1, "form_input", { selector: "#name", value: "Claude" }, 1000);
    const commands = takeBrowserCommands("group-1", 1);
    expect(commands).toMatchObject([
      { type: "javascript_tool", payload: { script: "return document.title;" } },
      { type: "form_input", payload: { selector: "#name", value: "Claude" } }
    ]);

    expect(resolveBrowserCommand(commands[0].id, { result: "Example" })).toBe(true);
    expect(resolveBrowserCommand(commands[1].id, { filled: true })).toBe(true);
    await expect(javascript).resolves.toMatchObject({ result: "Example" });
    await expect(formInput).resolves.toMatchObject({ filled: true });
    clearBrowserTabs();
  });

  it("queues official browser console and network read commands", async () => {
    clearBrowserTabs();
    registerBrowserTab({
      tabGroupId: "group-1",
      tabId: 1,
      url: "about:blank",
      cwd: "/tmp",
      title: "Claude Browser Tab"
    });

    const consoleRead = enqueueBrowserCommand(
      "group-1",
      1,
      "read_console_messages",
      { onlyErrors: true, pattern: "failed", limit: 20 },
      1000
    );
    const networkRead = enqueueBrowserCommand(
      "group-1",
      1,
      "read_network_requests",
      { onlyErrors: true, urlPattern: "/api/", limit: 20 },
      1000
    );
    const commands = takeBrowserCommands("group-1", 1);
    expect(commands).toMatchObject([
      { type: "read_console_messages", payload: { onlyErrors: true, pattern: "failed", limit: 20 } },
      { type: "read_network_requests", payload: { onlyErrors: true, urlPattern: "/api/", limit: 20 } }
    ]);

    expect(resolveBrowserCommand(commands[0].id, { messages: [{ level: "error", text: "failed" }] })).toBe(true);
    expect(resolveBrowserCommand(commands[1].id, { requests: [{ url: "/api/test", ok: false }] })).toBe(true);
    await expect(consoleRead).resolves.toMatchObject({ messages: [{ level: "error", text: "failed" }] });
    await expect(networkRead).resolves.toMatchObject({ requests: [{ url: "/api/test", ok: false }] });
    clearBrowserTabs();
  });

  it("queues browser host commands used by tabs_create_mcp", async () => {
    clearBrowserTabs();
    const pending = enqueueBrowserHostCommand("tabs_create", { url: "https://example.test" }, 1000);
    const commands = takeBrowserHostCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "tabs_create",
      payload: { url: "https://example.test" }
    });

    expect(
      resolveBrowserHostCommand(commands[0].id, {
        tabGroupId: "group-1",
        tabId: 1,
        url: "https://example.test",
        opened: true
      })
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({ tabId: 1, opened: true });
    clearBrowserTabs();
  });

  it("redacts secret settings before sending state to the browser", async () => {
    const response = await handleRpc({ type: "init" }, "/tmp");
    const env = (response as { state?: { settings?: { env?: Record<string, unknown> } } }).state?.settings?.env ?? {};
    if ("ANTHROPIC_AUTH_TOKEN" in env) expect(env.ANTHROPIC_AUTH_TOKEN).toBe("[redacted]");
    if ("ANTHROPIC_API_KEY" in env) expect(env.ANTHROPIC_API_KEY).toBe("[redacted]");
  });

  it("derives auth status from loaded Claude settings instead of hard-coding API key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-auth-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: "secret-token",
            ANTHROPIC_BASE_URL: "https://example.test",
            ANTHROPIC_MODEL: "minimax-m3"
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const state = await createWebviewState(workspace);
      const config = await createClaudeConfig(workspace);
      expect(state.authStatus).toMatchObject({ authMethod: "3p", subscriptionType: "api" });
      expect(config.account).toMatchObject({ tokenSource: "3p", subscriptionType: "api" });
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets explicit Claude settings auth override a process API key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-auth-priority-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: "settings-token",
            ANTHROPIC_BASE_URL: "https://settings-provider.test",
            ANTHROPIC_MODEL: "settings-model"
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    process.env.ANTHROPIC_API_KEY = "process-api-key";
    try {
      const state = await createWebviewState(workspace);
      const config = await createClaudeConfig(workspace);
      expect(state.authStatus).toMatchObject({ authMethod: "3p", subscriptionType: "api" });
      expect(config.account).toMatchObject({ tokenSource: "3p", subscriptionType: "api" });
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("builds SDK env from Claude settings before falling back to process auth env", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-sdk-env-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: "settings-token",
            ANTHROPIC_BASE_URL: "https://settings-provider.test",
            ANTHROPIC_MODEL: "settings-model",
            SAFE_SETTING: "visible"
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    process.env.ANTHROPIC_API_KEY = "process-api-key";
    process.env.ANTHROPIC_BASE_URL = "https://process-provider.test";
    try {
      const settingsEnv = await getSdkEnv(workspace, undefined);
      expect(settingsEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe("settings-token");
      expect(settingsEnv.ANTHROPIC_BASE_URL).toBe("https://settings-provider.test");
      expect(settingsEnv.ANTHROPIC_MODEL).toBe("settings-model");
      expect(settingsEnv.SAFE_SETTING).toBe("visible");

      const explicitApiKeyEnv = await getSdkEnv(workspace, "explicit-api-key");
      expect(explicitApiKeyEnv.ANTHROPIC_API_KEY).toBe("explicit-api-key");
      expect(explicitApiKeyEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(explicitApiKeyEnv.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(explicitApiKeyEnv.ANTHROPIC_MODEL).toBeUndefined();
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses loaded Claude settings for login responses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-login-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify(
        {
          env: {
            ANTHROPIC_AUTH_TOKEN: "secret-token",
            ANTHROPIC_BASE_URL: "https://example.test"
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const response = await handleRpc({ type: "login" }, workspace);
      expect(response).toMatchObject({
        type: "login_response",
        auth: { authMethod: "3p", subscriptionType: "api" },
        account: { tokenSource: "3p", subscriptionType: "api" }
      });
      await expect(handleRpc({ type: "login", method: "console" }, workspace)).rejects.toThrow(
        "Anthropic Console login requires an API key."
      );
      await expect(handleRpc({ type: "login", method: "claudeai" }, workspace)).rejects.toThrow(
        "Claude.ai OAuth requires the VSCode extension host."
      );
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails login clearly when no Claude credentials are configured", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-no-login-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      await expect(handleRpc({ type: "login" }, workspace)).rejects.toThrow(
        "No Claude credentials found in settings or environment."
      );
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a standalone API key login into user settings without dropping permission modes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-api-key-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    const settingsPath = path.join(userConfigDir, "settings.json");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          env: {
            SAFE_SETTING: "visible",
            ANTHROPIC_AUTH_TOKEN: "old-token",
            ANTHROPIC_BASE_URL: "https://old-provider.test",
            ANTHROPIC_MODEL: "old-model"
          },
          permissions: {
            defaultMode: "bypassPermissions",
            allow: ["Bash(echo *)"]
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousAuthEnv = cleanAuthEnv();
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const response = await handleRpc({ type: "configure_api_key", apiKey: " sk-test-key " }, workspace);
      expect(response).toMatchObject({
        type: "login_response",
        auth: { authMethod: "api-key", subscriptionType: "api" },
        account: { tokenSource: "api-key", subscriptionType: "api" }
      });
      await expect(handleRpc({ type: "login", method: "console" }, workspace)).resolves.toMatchObject({
        type: "login_response",
        auth: { authMethod: "api-key", subscriptionType: "api" },
        account: { tokenSource: "api-key", subscriptionType: "api" }
      });
      const saved = JSON.parse(await readFile(settingsPath, "utf8"));
      expect(saved).toMatchObject({
        env: {
          SAFE_SETTING: "visible",
          ANTHROPIC_API_KEY: "sk-test-key"
        },
        permissions: {
          defaultMode: "bypassPermissions",
          allow: ["Bash(echo *)"]
        }
      });
      expect(saved.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(saved.env).not.toHaveProperty("ANTHROPIC_BASE_URL");
      expect(saved.env).not.toHaveProperty("ANTHROPIC_MODEL");
    } finally {
      restoreAuthEnv(previousAuthEnv);
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exposes bypass permissions capability in Claude config", async () => {
    const response = await handleRpc({ type: "get_claude_state" }, "/tmp");
    expect(response).toMatchObject({
      type: "get_claude_state_response",
      config: {
        allowDangerouslySkipPermissions: true,
        claudeSettings: {
          effective: {
            permissions: {}
          }
        }
      }
    });
  });

  it("merges SDK initialization data into Claude config and webview state", async () => {
    const state = await createWebviewState("/tmp");
    expect(typeof state.modelSetting).toBe("string");

    const config = await createClaudeConfig("/tmp", {
      initialization: {
        account: { tokenSource: "api_key", subscriptionType: "api", email: "dev@example.test" },
        commands: [{ name: "context", description: "Show context" }],
        agents: [{ name: "reviewer", description: "Review code" }],
        models: [{ value: "claude-opus-4-5", displayName: "Opus" }],
        output_style: "default",
        available_output_styles: ["default"],
        fast_mode_state: { available: false }
      }
    });

    expect(config).toMatchObject({
      account: { email: "dev@example.test" },
      commands: [{ name: "context" }],
      slashCommands: [{ name: "context" }],
      agents: [{ name: "reviewer" }],
      models: [{ value: "claude-opus-4-5" }],
      output_style: "default",
      available_output_styles: ["default"],
      fast_mode_state: { available: false }
    });
  });

  it("exposes redacted per-source Claude settings in webview config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-settings-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(path.join(userConfigDir), { recursive: true });
    await mkdir(path.join(workspace, ".claude"), { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify(
        {
          env: { ANTHROPIC_API_KEY: "secret-key", SAFE_SETTING: "visible" },
          model: "claude-sonnet-4-5"
        },
        null,
        2
      )
    );
    await writeFile(
      path.join(workspace, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(echo *)"] } }, null, 2)
    );
    await writeFile(
      path.join(workspace, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }, null, 2)
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const config = await createClaudeConfig(workspace);
      expect(config.claudeSettings.applied).toEqual(config.claudeSettings.effective);
      expect(config.currentUserConfig).toMatchObject({
        env: { ANTHROPIC_API_KEY: "[redacted]", SAFE_SETTING: "visible" },
        model: "claude-sonnet-4-5"
      });
      expect(config.currentProjectConfig).toMatchObject({ permissions: { allow: ["Bash(echo *)"] } });
      expect(config.currentLocalConfig).toMatchObject({ permissions: { defaultMode: "acceptEdits" } });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads current project state from .claude.json without merging it into settings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-claude-json-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    const otherWorkspace = path.join(root, "other");
    const claudeJsonPath = path.join(root, ".claude.json");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(userConfigDir, "settings.json"), JSON.stringify({ model: "opus" }, null, 2));
    await writeFile(
      claudeJsonPath,
      JSON.stringify(
        {
          projects: {
            [workspace]: {
              hasTrustDialogAccepted: true,
              hasCompletedProjectOnboarding: true,
              projectOnboardingSeenCount: 3,
              lastSessionId: "session-123",
              lastSessionModified: 1700000000000,
              lastSessionFirstPrompt: "hello from prior session",
              customApiKeyResponses: "secret-response",
              lastSessionMetrics: { totalCost: 1.23 },
              mcpServers: { local: { command: "node" } }
            },
            [otherWorkspace]: {
              lastSessionId: "wrong-session"
            }
          }
        },
        null,
        2
      )
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const previousClaudeJsonPath = process.env.CLAUDE_JSON_PATH;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    process.env.CLAUDE_JSON_PATH = claudeJsonPath;
    try {
      const state = await createWebviewState(workspace);
      const config = await createClaudeConfig(workspace);
      expect(state.lastSessionId).toBe("session-123");
      expect(state.currentProjectState).toMatchObject({
        path: workspace,
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
        projectOnboardingSeenCount: 3,
        lastSessionId: "session-123",
        lastSessionFirstPrompt: "hello from prior session"
      });
      expect(config.currentProjectState).toMatchObject({
        lastSessionId: "session-123",
        lastSessionMetrics: { totalCost: 1.23 },
        mcpServers: { local: { command: "node" } }
      });
      expect(config.settings).toMatchObject({ model: "opus" });
      expect(config.settings).not.toHaveProperty("projects");
      expect(JSON.stringify(config.currentProjectState)).not.toContain("secret-response");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      if (previousClaudeJsonPath === undefined) delete process.env.CLAUDE_JSON_PATH;
      else process.env.CLAUDE_JSON_PATH = previousClaudeJsonPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists current project session state into .claude.json without replacing other projects", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-project-state-write-"));
    const workspace = path.join(root, "workspace");
    const otherWorkspace = path.join(root, "other");
    const claudeJsonPath = path.join(root, ".claude.json");
    await mkdir(workspace, { recursive: true });
    await writeFile(
      claudeJsonPath,
      JSON.stringify(
        {
          numStartups: 7,
          projects: {
            [workspace]: {
              hasTrustDialogAccepted: true,
              lastSessionId: "old-session"
            },
            [otherWorkspace]: {
              lastSessionId: "other-session"
            }
          }
        },
        null,
        2
      )
    );

    const previousClaudeJsonPath = process.env.CLAUDE_JSON_PATH;
    process.env.CLAUDE_JSON_PATH = claudeJsonPath;
    try {
      const updated = await updateClaudeProjectState(workspace, {
        lastSessionId: "new-session",
        lastSessionModified: 1700000001234,
        lastSessionFirstPrompt: "hello"
      });
      const saved = JSON.parse(await readFile(claudeJsonPath, "utf8")) as {
        numStartups: number;
        projects: Record<string, Record<string, unknown>>;
      };
      expect(updated).toMatchObject({
        path: workspace,
        hasTrustDialogAccepted: true,
        lastSessionId: "new-session",
        lastSessionModified: 1700000001234,
        lastSessionFirstPrompt: "hello"
      });
      expect(saved.numStartups).toBe(7);
      expect(saved.projects[otherWorkspace]).toMatchObject({ lastSessionId: "other-session" });
      expect(saved.projects[workspace]).toMatchObject({
        hasTrustDialogAccepted: true,
        lastSessionId: "new-session"
      });
    } finally {
      if (previousClaudeJsonPath === undefined) delete process.env.CLAUDE_JSON_PATH;
      else process.env.CLAUDE_JSON_PATH = previousClaudeJsonPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists settings changes even when no Claude channel is running", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-apply-settings-"));
    const userConfigDir = path.join(root, "user-config");
    await mkdir(userConfigDir, { recursive: true });

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const bridge = new AgentBridge();
      await bridge.applySettings(undefined, { model: "claude-sonnet-4-5", switchModelsOnFlag: true }, false);
      const settings = JSON.parse(await readFile(path.join(userConfigDir, "settings.json"), "utf8")) as Record<
        string,
        unknown
      >;
      expect(settings).toMatchObject({ model: "claude-sonnet-4-5", switchModelsOnFlag: true });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns a shaped usage error instead of fabricating usage without a running channel", async () => {
    const bridge = new AgentBridge();
    await expect(bridge.getUsage(undefined)).resolves.toMatchObject({
      type: "get_usage_response",
      error: expect.any(String)
    });
    await expect(bridge.createUsageUpdate(undefined)).resolves.toMatchObject({
      type: "request",
      channelId: undefined,
      request: {
        type: "usage_update",
        utilization: undefined,
        error: expect.any(String)
      }
    });
  });

  it("rejects missing workspace directories before launching the SDK", async () => {
    const bridge = new AgentBridge();
    const missingCwd = path.join(tmpdir(), "claude-agent-webview-missing-workspace");
    const sent: unknown[] = [];
    bridge.launch({
      channelId: "missing-workspace",
      cwd: missingCwd,
      send: (message) => sent.push(message)
    });

    expect(sent).toEqual([
      {
        type: "close_channel",
        channelId: "missing-workspace",
        error: `Workspace directory does not exist: ${missingCwd}`
      }
    ]);
  });

  it("persists permission mode changes without dropping existing permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-permission-mode-"));
    const userConfigDir = path.join(root, "user-config");
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(echo *)"] } }, null, 2)
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const bridge = new AgentBridge();
      await bridge.setPermissionMode(undefined, "bypassPermissions");
      const settings = JSON.parse(await readFile(path.join(userConfigDir, "settings.json"), "utf8")) as Record<
        string,
        { allow?: string[]; defaultMode?: string }
      >;
      expect(settings.permissions).toEqual({
        allow: ["Bash(echo *)"],
        defaultMode: "bypassPermissions"
      });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists standalone thinking level when no Claude channel is running", async () => {
    const bridge = new AgentBridge();
    try {
      await bridge.setThinkingLevel(undefined, "off");
      await expect(createWebviewState("/tmp")).resolves.toMatchObject({ thinkingLevel: "off" });

      await bridge.setThinkingLevel(undefined, "default_on");
      await expect(createWebviewState("/tmp")).resolves.toMatchObject({ thinkingLevel: "default_on" });
    } finally {
      setStandaloneThinkingLevel("default_on");
    }
  });

  it("preserves user bypass permission mode in the initial webview state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-user-bypass-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(userConfigDir, "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2)
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const state = await createWebviewState(workspace);
      const config = await createClaudeConfig(workspace);
      expect(state.initialPermissionMode).toBe("bypassPermissions");
      expect(config.permissionMode).toBe("bypassPermissions");
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("filters project-committed escalating permission mode from the initial webview state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-project-bypass-"));
    const userConfigDir = path.join(root, "user-config");
    const workspace = path.join(root, "workspace");
    await mkdir(userConfigDir, { recursive: true });
    await mkdir(path.join(workspace, ".claude"), { recursive: true });
    await writeFile(
      path.join(workspace, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2)
    );

    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userConfigDir;
    try {
      const state = await createWebviewState(workspace);
      const config = await createClaudeConfig(workspace);
      expect(state.initialPermissionMode).toBe("default");
      expect(config.permissionMode).toBe("default");
      expect(config.currentProjectConfig).toMatchObject({ permissions: { defaultMode: "bypassPermissions" } });
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns project file suggestions for @ mention search", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "agentBridge.ts"), "");
    await writeFile(path.join(root, "README.md"), "");

    const response = await handleRpc({ type: "list_files_request", pattern: "agent" }, root);

    expect(response).toMatchObject({
      type: "list_files_response",
      files: [
        {
          type: "file",
          path: "src/agentBridge.ts",
          name: "agentBridge.ts"
        }
      ]
    });
  });

  it("lists MCP servers offline but rejects live-only MCP management actions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-mcp-"));
    await mkdir(path.join(root, ".vscode", "extensions"), { recursive: true });
    await expect(
      listConfiguredMcpServers(root, async () => ({
        stdout: "Checking MCP server health…\nfigma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected\nlocal: node server.js --flag - ✘ Failed to connect\n",
        stderr: ""
      }))
    ).resolves.toEqual({
      type: "get_mcp_servers_response",
      source: "claude-cli",
      degraded: true,
      mcpServers: [
        {
          name: "figma",
          status: "connected",
          serverInfo: undefined,
          error: undefined,
          config: { type: "http", url: "https://mcp.figma.com/mcp" },
          scope: "user",
          tools: []
        },
        {
          name: "local",
          status: "failed",
          serverInfo: undefined,
          error: "✘ Failed to connect",
          config: { type: "stdio", command: "node", args: ["server.js", "--flag"] },
          scope: "user",
          tools: []
        }
      ]
    });
    await expect(handleRpc({ type: "set_mcp_server_enabled", serverName: "demo", enabled: false }, "/tmp")).rejects.toThrow(
      "set_mcp_server_enabled requires a running Claude session."
    );
    await expect(handleRpc({ type: "reconnect_mcp_server", serverName: "demo" }, "/tmp")).rejects.toThrow(
      "reconnect_mcp_server requires a running Claude session."
    );
    await expect(handleRpc({ type: "authenticate_mcp_server", serverName: "demo" }, "/tmp")).rejects.toThrow(
      "authenticate_mcp_server requires a running Claude session."
    );
    await expect(handleRpc({ type: "clear_mcp_server_auth", serverName: "demo" }, "/tmp")).rejects.toThrow(
      "clear_mcp_server_auth requires a running Claude session."
    );
    await expect(
      handleRpc({ type: "submit_mcp_oauth_callback_url", serverName: "demo", callbackUrl: "http://127.0.0.1" }, "/tmp")
    ).rejects.toThrow("submit_mcp_oauth_callback_url requires a running Claude session.");
  });

  it("parses Claude MCP list output into MCP server status objects", () => {
    expect(
      parseMcpListOutput(
        "Checking MCP server health…\nplugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected\nMiniMax: uvx minimax-coding-plan-mcp -y - ✔ Connected\n"
      )
    ).toMatchObject([
      {
        name: "plugin:figma:figma",
        status: "connected",
        scope: "plugin",
        config: { type: "http", url: "https://mcp.figma.com/mcp" }
      },
      {
        name: "MiniMax",
        status: "connected",
        scope: "user",
        config: { type: "stdio", command: "uvx", args: ["minimax-coding-plan-mcp", "-y"] }
      }
    ]);
  });

  it("returns official-shaped no-op responses for editor-only host affordances", async () => {
    await expect(handleRpc({ type: "get_plan_comments" }, "/tmp")).resolves.toEqual({
      type: "get_plan_comments_response",
      comments: []
    });
    await expect(handleRpc({ type: "remove_plan_comment", commentId: "comment-1" }, "/tmp")).resolves.toEqual({
      type: "remove_plan_comment_response"
    });
    await expect(handleRpc({ type: "dismiss_onboarding", dismissType: "done" }, "/tmp")).resolves.toEqual({
      type: "dismiss_onboarding_response"
    });
    await expect(handleRpc({ type: "dismiss_review_upsell_banner", metadata: {} }, "/tmp")).resolves.toEqual({
      type: "dismiss_review_upsell_banner_response"
    });
    await expect(handleRpc({ type: "open_output_panel" }, "/tmp")).resolves.toMatchObject({
      type: "open_output_panel_response",
      opened: false,
      content: expect.stringContaining("npm start")
    });
  });

  it("uses official host response names for supported noninteractive editor-adjacent requests", async () => {
    await expect(handleRpc({ type: "get_asset_uris" }, "/tmp")).resolves.toEqual({
      type: "asset_uris_response",
      assetUris: {}
    });
  });

  it("rejects interactive editor affordances when the browser bridge shim is bypassed", async () => {
    await expect(handleRpc({ type: "get_current_selection" }, "/tmp")).rejects.toThrow(
      "get_current_selection requires the browser webview bridge."
    );
    await expect(handleRpc({ type: "open_content", content: "draft" }, "/tmp")).rejects.toThrow(
      "open_content requires the browser webview bridge."
    );
    await expect(handleRpc({ type: "open_diff", edits: [{ oldText: "a", newText: "b" }] }, "/tmp")).rejects.toThrow(
      "open_diff requires the browser webview bridge."
    );
    await expect(handleRpc({ type: "open_file_diffs", fileDiffs: [] }, "/tmp")).rejects.toThrow(
      "open_file_diffs requires the browser webview bridge."
    );
  });

  it("reads workspace files without requiring a running Claude session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-read-file-"));
    await writeFile(path.join(root, "hello.txt"), "hello world");

    try {
      await expect(handleRpc({ type: "read_file", path: "hello.txt" }, root)).resolves.toMatchObject({
        type: "read_file_response",
        file: {
          contents: "hello world",
          absPath: path.join(root, "hello.txt")
        }
      });
      await expect(handleRpc({ type: "read_file", path: "hello.txt", maxBytes: 5 }, root)).resolves.toMatchObject({
        type: "read_file_response",
        file: {
          contents: "hello",
          truncated: true
        }
      });
      await expect(handleRpc({ type: "read_file", path: "hello.txt", encoding: "base64" }, root)).resolves.toMatchObject({
        type: "read_file_response",
        file: {
          contents: Buffer.from("hello world").toString("base64"),
          encoding: "base64"
        }
      });
      await expect(handleRpc({ type: "read_file", path: "../outside.txt" }, root)).rejects.toThrow(
        "File path is outside the current workspace."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns browser viewer URLs for file and config host requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-open-file-"));
    await writeFile(path.join(root, "hello.txt"), "hello");

    try {
      await expect(handleRpc({ type: "open_file", filePath: "hello.txt", location: { line: 3 } }, root)).resolves.toMatchObject({
        type: "open_file_response",
        opened: true,
        url: `/file?path=hello.txt&cwd=${encodeURIComponent(root)}&line=3`
      });
      await expect(handleRpc({ type: "open_config_file", configType: "project" }, root)).resolves.toMatchObject({
        type: "open_config_file_response",
        opened: true,
        url: `/config?type=project&cwd=${encodeURIComponent(root)}`
      });
      await expect(handleRpc({ type: "open_file", filePath: "../outside.txt" }, root)).rejects.toThrow(
        "File path is outside the current workspace."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns URL targets for browser-open requests when the shim is bypassed", async () => {
    await expect(handleRpc({ type: "open_url", url: "https://example.test/docs" }, "/tmp")).resolves.toMatchObject({
      type: "open_url_response",
      opened: false,
      url: "https://example.test/docs"
    });
    await expect(handleRpc({ type: "open_help" }, "/tmp")).resolves.toMatchObject({
      type: "open_help_response",
      opened: false,
      url: "https://docs.anthropic.com/en/docs/claude-code"
    });
  });

  it("returns web app navigation URLs for session and workspace host requests", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-navigation-"));
    await mkdir(path.join(root, "subdir"), { recursive: true });

    try {
      await expect(
        handleRpc({ type: "new_conversation_tab", sessionId: "session-1", initialPrompt: "hello world" }, root)
      ).resolves.toMatchObject({
        type: "new_conversation_tab_response",
        opened: true,
        url: `/?session=session-1&prompt=hello+world&cwd=${encodeURIComponent(root)}`
      });
      await expect(handleRpc({ type: "open_in_editor", sessionId: "remote:session-2" }, root)).resolves.toMatchObject({
        type: "open_in_editor_response",
        opened: true,
        url: `/?session=session-2&cwd=${encodeURIComponent(root)}`
      });
      await expect(handleRpc({ type: "open_folder_in_new_window", folderPath: "subdir" }, root)).resolves.toMatchObject({
        type: "open_folder_in_new_window_response",
        opened: true,
        url: `/?cwd=${encodeURIComponent(path.join(root, "subdir"))}`
      });
      await expect(handleRpc({ type: "open_folder", folderPath: "../outside" }, root)).rejects.toThrow(
        "Folder path is outside the current workspace."
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails remote teleport explicitly in standalone API-key mode", async () => {
    await expect(handleRpc({ type: "list_remote_sessions" }, "/tmp")).resolves.toEqual({
      type: "list_remote_sessions_response",
      sessions: [],
      connected: false,
      reconnecting: false
    });
    await expect(handleRpc({ type: "teleport_session", sessionId: "remote-session" }, "/tmp")).rejects.toThrow(
      "Remote session teleport is not available in standalone API-key mode."
    );
  });

  it("fails conversation forking explicitly instead of creating a fake session", async () => {
    await expect(
      handleRpc(
        { type: "fork_conversation", forkedFromSession: "session-1", resumeSessionAt: "message-1" },
        "/tmp"
      )
    ).rejects.toThrow("Conversation forking requires Claude session-store support");
  });

  it("returns real git status for branch safety dialogs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-git-"));
    await execFileAsync("git", ["init"], { cwd: root });
    await writeFile(path.join(root, "dirty.txt"), "changed");

    await expect(handleRpc({ type: "check_git_status" }, root)).resolves.toEqual({
      type: "check_git_status_response",
      isClean: false,
      changedFiles: [{ status: "??", path: "dirty.txt" }]
    });
  });

  it("checks out an existing git branch for teleport branch dialogs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-checkout-"));
    await initTestRepo(root);
    await execFileAsync("git", ["branch", "feature-branch"], { cwd: root });

    await expect(handleRpc({ type: "checkout_branch", branch: "feature-branch" }, root)).resolves.toEqual({
      type: "checkout_branch_response",
      branch: "feature-branch"
    });
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" });
    expect(stdout.trim()).toBe("feature-branch");
  });

  it("creates git worktrees in sibling directories with official name validation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-worktree-"));
    await initTestRepo(root);
    const worktreeName = `feature-${path.basename(root).slice(-8)}`;
    const response = await handleRpc({ type: "create_worktree", name: worktreeName }, root);
    const targetPath = (response as { path: string }).path;

    expect(response).toMatchObject({
      type: "create_worktree_response",
      name: worktreeName,
      path: targetPath,
      worktree: { path: targetPath, name: worktreeName }
    });
    expect(path.basename(targetPath)).toBe(worktreeName);
    await expect(execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: targetPath, encoding: "utf8" })).resolves
      .toMatchObject({ stdout: "true\n" });

    await expect(handleRpc({ type: "create_worktree", name: "../escape" }, root)).rejects.toThrow(
      "Only letters, numbers, dots, hyphens, and underscores"
    );
    await rm(targetPath, { recursive: true, force: true });
  });

  it("runs explicit host exec requests with stdout and stderr", async () => {
    await expect(
      handleRpc({ type: "exec", command: process.execPath, params: ["-e", "console.log('exec-ok')"] }, "/tmp")
    ).resolves.toMatchObject({
      type: "exec_response",
      stdout: "exec-ok\n",
      stderr: "",
      code: 0
    });
  });

  it("returns official-shaped standalone integration responses", async () => {
    await expect(handleRpc({ type: "ensure_chrome_mcp_enabled" }, "/tmp")).resolves.toEqual({
      type: "ensure_chrome_mcp_enabled_response",
      wasDisabled: false
    });
    await expect(handleRpc({ type: "init" }, "/tmp")).resolves.toMatchObject({
      state: {
        chromeMcpState: { status: "connected", source: "standalone-browser-bridge" }
      }
    });
    await expect(handleRpc({ type: "create_new_browser_tab" }, "/tmp")).rejects.toThrow(
      "create_new_browser_tab requires the browser webview bridge."
    );
    await expect(handleRpc({ type: "disable_chrome_mcp" }, "/tmp")).resolves.toEqual({
      type: "disable_chrome_mcp_response"
    });
    await expect(handleRpc({ type: "enable_jupyter_mcp" }, "/tmp")).resolves.toEqual({
      type: "enable_jupyter_mcp_response"
    });
    await expect(handleRpc({ type: "disable_jupyter_mcp" }, "/tmp")).resolves.toEqual({
      type: "disable_jupyter_mcp_response"
    });
  });

  it("tracks session state updates in the official session-list shape", async () => {
    await expect(
      handleRpc({ type: "update_session_state", sessionId: "session-state-test", state: "running", title: "Working" }, "/tmp")
    ).resolves.toEqual({
      type: "update_session_state_response",
      sessionId: "session-state-test"
    });
    expect(getSessionStateSnapshot()).toContainEqual({
      sessionId: "session-state-test",
      state: "running",
      title: "Working"
    });
    clearSessionState("session-state-test");
  });

  it("rejects invalid session state updates instead of creating ghost sessions", async () => {
    await expect(handleRpc({ type: "update_session_state", state: "running" }, "/tmp")).rejects.toThrow(
      "update_session_state requires a sessionId."
    );
    await expect(
      handleRpc({ type: "update_session_state", sessionId: "session-state-invalid", state: "busy" }, "/tmp")
    ).rejects.toThrow("update_session_state state must be one of: running, waiting_input, idle.");
  });

  it("fails fast for unsupported host requests instead of fabricating success", async () => {
    await expect(handleRpc({ type: "missing_extension_host_capability" }, "/tmp")).rejects.toThrow(
      "Unsupported host request: missing_extension_host_capability"
    );
  });

  it("scopes session state snapshots to the current workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-session-scope-"));
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");
    await mkdir(workspaceA, { recursive: true });
    await mkdir(workspaceB, { recursive: true });

    try {
      await handleRpc({ type: "update_session_state", sessionId: "session-a", state: "running" }, workspaceA);
      await handleRpc({ type: "update_session_state", sessionId: "session-b", state: "waiting_input" }, workspaceB);

      expect(getSessionStateSnapshot(workspaceA)).toEqual([{ sessionId: "session-a", state: "running", title: undefined }]);
      expect(getSessionStateSnapshot(workspaceB)).toEqual([
        { sessionId: "session-b", state: "waiting_input", title: undefined }
      ]);
    } finally {
      clearSessionState("session-a");
      clearSessionState("session-b");
      await rm(root, { recursive: true, force: true });
    }
  });

  it("captures standalone terminal output", async () => {
    const terminals = new TerminalManager();
    const response = terminals.openTerminal(
      { executable: process.execPath, args: ["-e", "console.log('terminal-ok')"] },
      "/tmp"
    );
    expect(response).toMatchObject({
      type: "open_terminal_response",
      opened: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(terminals.getTerminalContents(response.terminalName).content).toContain("terminal-ok");
  });

  it("routes terminal RPCs through handleRpc", async () => {
    const terminals = new TerminalManager();
    const response = await handleRpc(
      { type: "open_terminal", executable: process.execPath, args: ["-e", "console.log('rpc-terminal-ok')"] },
      "/tmp",
      undefined,
      terminals
    );
    expect(response).toMatchObject({
      type: "open_terminal_response",
      opened: true
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const terminalName = (response as { terminalName: string }).terminalName;
    await expect(handleRpc({ type: "get_terminal_contents", terminalName }, "/tmp", undefined, terminals)).resolves.toMatchObject({
      type: "get_terminal_contents_response",
      content: expect.stringContaining("rpc-terminal-ok")
    });
  });

  it("maps Claude CLI plugin output to the official webview shape", async () => {
    expect(
      mapInstalledPlugin({
        id: "figma@claude-plugins-official",
        version: "2.2.12",
        installPath: "/tmp/figma",
        enabled: true,
        mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } }
      })
    ).toEqual({
      name: "figma@claude-plugins-official",
      manifest: { name: "figma@claude-plugins-official", version: "2.2.12" },
      path: "/tmp/figma",
      source: "figma@claude-plugins-official",
      enabled: true,
      mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } }
    });

    expect(
      mapMarketplace({
        name: "claude-plugins-official",
        source: "github",
        repo: "anthropics/claude-plugins-official",
        installLocation: "/tmp/marketplace"
      })
    ).toEqual({
      name: "claude-plugins-official",
      config: {
        source: { source: "github", repo: "anthropics/claude-plugins-official" },
        installLocation: "/tmp/marketplace"
      },
      pluginCount: 0,
      installedCount: 0
    });
  });

  it("uses the official Claude plugin CLI commands", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      if (args.includes("marketplace")) return [];
      return [{ id: "codex@openai-codex", version: "1.0.2", installPath: "/tmp/codex", enabled: true }];
    };

    await expect(listPlugins("/tmp", false, runner)).resolves.toMatchObject({
      type: "list_plugins_response",
      installed: [{ name: "codex@openai-codex" }]
    });
    await expect(listMarketplaces("/tmp", runner)).resolves.toEqual({
      type: "list_marketplaces_response",
      marketplaces: []
    });
    expect(calls).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"]
    ]);
  });

  it("uses official Claude plugin write commands and rejects empty plugin ids", async () => {
    const calls: string[][] = [];
    const runner = async (args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };

    await expect(installPlugin("/tmp", "figma@claude-plugins-official", "project", undefined, runner)).resolves.toEqual({
      type: "install_plugin_response",
      needsRestart: true
    });
    await expect(uninstallPlugin("/tmp", "figma@claude-plugins-official", undefined, runner)).resolves.toEqual({
      type: "uninstall_plugin_response",
      needsRestart: true
    });
    await expect(setPluginEnabled("/tmp", "figma@claude-plugins-official", false, undefined, runner)).resolves.toEqual({
      type: "set_plugin_enabled_response",
      needsRestart: true
    });
    await expect(installPlugin("/tmp", "   ", "user", undefined, runner)).rejects.toThrow("Plugin id is required.");

    expect(calls).toEqual([
      ["plugin", "install", "figma@claude-plugins-official", "--scope", "project"],
      ["plugin", "uninstall", "figma@claude-plugins-official"],
      ["plugin", "disable", "figma@claude-plugins-official"]
    ]);
  });

  it("discovers the newest VSCode Claude native binary instead of hardcoding one extension version", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-extensions-"));
    const oldBinary = path.join(root, "anthropic.claude-code-2.1.184-darwin-arm64", "resources", "native-binary", "claude");
    const newBinary = path.join(root, "anthropic.claude-code-2.1.185-darwin-arm64", "resources", "native-binary", "claude");
    await mkdir(path.dirname(oldBinary), { recursive: true });
    await mkdir(path.dirname(newBinary), { recursive: true });
    await writeFile(oldBinary, "");
    await writeFile(newBinary, "");

    expect(findClaudeCodeExecutable([root])).toBe(newBinary);
  });

  it("discovers standalone Claude executables from PATH and still honors explicit overrides", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-path-"));
    const binDir = path.join(root, "bin");
    const pathClaude = path.join(binDir, "claude");
    await mkdir(binDir, { recursive: true });
    await writeFile(pathClaude, "#!/bin/sh\n");
    await execFileAsync("chmod", ["755", pathClaude]);

    expect(findClaudeOnPath(binDir)).toBe(pathClaude);

    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    process.chdir(root);
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    try {
      process.env.CLAUDE_CODE_EXECUTABLE = "/explicit/claude";
      expect(resolveClaudeCodeExecutable()).toBe("/explicit/claude");
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers a neighboring restored-src Claude executable before PATH", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claude-agent-webview-restored-src-"));
    const webviewDir = path.join(root, "lab", "webview");
    const restoredClaude = path.join(root, "restored-src", "bin", "claude");
    const pathClaude = path.join(root, "bin", "claude");
    await mkdir(webviewDir, { recursive: true });
    await mkdir(path.dirname(restoredClaude), { recursive: true });
    await mkdir(path.dirname(pathClaude), { recursive: true });
    await writeFile(restoredClaude, "#!/bin/sh\n");
    await writeFile(pathClaude, "#!/bin/sh\n");
    await execFileAsync("chmod", ["755", restoredClaude]);
    await execFileAsync("chmod", ["755", pathClaude]);

    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    process.chdir(webviewDir);
    process.env.PATH = `${path.dirname(pathClaude)}${path.delimiter}${previousPath ?? ""}`;
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    try {
      const realRestoredClaude = await realpath(restoredClaude);
      expect(await realpath(findRestoredSrcClaudeExecutable("/missing/server") ?? "")).toBe(realRestoredClaude);
      expect(await realpath(resolveClaudeCodeExecutable() ?? "")).toBe(realRestoredClaude);
      process.env.CLAUDE_CODE_EXECUTABLE = "/explicit/claude";
      expect(resolveClaudeCodeExecutable()).toBe("/explicit/claude");
    } finally {
      process.chdir(previousCwd);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
      else process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates the same tool permission request shape consumed by the webview", () => {
    expect(createToolPermissionRequest("req-1", "chan-1", "Bash", { command: "pwd" })).toMatchObject({
      type: "request",
      requestId: "req-1",
      channelId: "chan-1",
      request: {
        type: "tool_permission_request",
        toolName: "Bash",
        inputs: { command: "pwd" },
        suggestions: []
      }
    });
  });

  it("creates and normalizes official user dialog requests for SDK blocking dialogs", () => {
    expect(
      createUserDialogRequest(
        "dialog-1",
        "chan-1",
        "refusal_fallback_prompt",
        { originalModel: "opus", fallbackModel: "sonnet" },
        "toolu_1"
      )
    ).toEqual({
      type: "request",
      requestId: "dialog-1",
      channelId: "chan-1",
      request: {
        type: "user_dialog_request",
        dialogKind: "refusal_fallback_prompt",
        payload: { originalModel: "opus", fallbackModel: "sonnet" },
        toolUseID: "toolu_1"
      }
    });

    expect(
      normalizeUserDialogResponse({
        type: "user_dialog_response",
        result: { behavior: "completed", result: { choice: "retry" } }
      })
    ).toEqual({ behavior: "completed", result: { choice: "retry" } });
    expect(normalizeUserDialogResponse({ type: "user_dialog_response", result: { behavior: "cancelled" } })).toEqual({
      behavior: "cancelled"
    });
    expect(normalizeUserDialogResponse({})).toEqual({ behavior: "cancelled" });
  });

  it("normalizes webview permission responses for canUseTool", () => {
    expect(
      normalizeToolPermissionResponse(
        {
          type: "tool_permission_response",
          result: { behavior: "allow", updatedInput: { command: "pwd" }, updatedPermissions: [] }
        },
        { command: "ls" }
      )
    ).toEqual({ behavior: "allow", updatedInput: { command: "pwd" }, updatedPermissions: [] });

    expect(normalizeToolPermissionResponse({ result: { behavior: "deny", message: "no" } }, {})).toEqual({
      behavior: "deny",
      message: "no"
    });
  });
});

async function initTestRepo(root: string) {
  await execFileAsync("git", ["init"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "test\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
    cwd: root
  });
}

function cleanAuthEnv() {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"] as const;
  const previous: Record<string, string | undefined> = {};
  for (const key of keys) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  return previous;
}

function restoreAuthEnv(previous: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
