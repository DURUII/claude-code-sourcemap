import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export type BrowserTabInfo = {
  tabGroupId: string;
  tabId: number;
  url: string;
  cwd?: string;
  title?: string;
  status: "open" | "closed";
  createdAt: number;
  updatedAt: number;
};

export type BrowserCommand = {
  id: string;
  tabGroupId: string;
  tabId: number;
  type:
    | "navigate"
    | "read_page"
    | "computer"
    | "javascript_tool"
    | "form_input"
    | "read_console_messages"
    | "read_network_requests";
  payload?: Record<string, unknown>;
  createdAt: number;
};

export type BrowserHostCommand = {
  id: string;
  type: "tabs_create";
  payload?: Record<string, unknown>;
  createdAt: number;
};

const tabs = new Map<string, BrowserTabInfo>();
const commandQueues = new Map<string, BrowserCommand[]>();
const pendingCommands = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();
const hostCommandQueue: BrowserHostCommand[] = [];
const pendingHostCommands = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }
>();

export function browserTabKey(tabGroupId: string, tabId: number) {
  return `${tabGroupId}:${tabId}`;
}

export function registerBrowserTab(tab: Omit<BrowserTabInfo, "status" | "createdAt" | "updatedAt">) {
  const now = Date.now();
  const key = browserTabKey(tab.tabGroupId, tab.tabId);
  const existing = tabs.get(key);
  const info: BrowserTabInfo = {
    ...tab,
    status: "open",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  tabs.set(key, info);
  return info;
}

export function updateBrowserTab(tabGroupId: string, tabId: number, patch: Partial<Pick<BrowserTabInfo, "url" | "title">>) {
  const key = browserTabKey(tabGroupId, tabId);
  const existing = tabs.get(key);
  if (!existing) return undefined;
  const info: BrowserTabInfo = {
    ...existing,
    ...patch,
    updatedAt: Date.now()
  };
  tabs.set(key, info);
  return info;
}

export function closeBrowserTab(tabGroupId: string, tabId: number) {
  const key = browserTabKey(tabGroupId, tabId);
  const existing = tabs.get(key);
  if (!existing) return undefined;
  const info: BrowserTabInfo = { ...existing, status: "closed", updatedAt: Date.now() };
  tabs.set(key, info);
  return info;
}

export function listBrowserTabs(options: { includeClosed?: boolean } = {}) {
  return Array.from(tabs.values())
    .filter((tab) => options.includeClosed || tab.status !== "closed")
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function clearBrowserTabs() {
  tabs.clear();
  commandQueues.clear();
  for (const [id, pending] of pendingCommands) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`Browser command ${id} was cleared.`));
  }
  pendingCommands.clear();
  hostCommandQueue.splice(0);
  for (const [id, pending] of pendingHostCommands) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(`Browser host command ${id} was cleared.`));
  }
  pendingHostCommands.clear();
}

export function enqueueBrowserHostCommand(
  type: BrowserHostCommand["type"],
  payload?: Record<string, unknown>,
  timeoutMs = 10_000
) {
  const command: BrowserHostCommand = {
    id: `browser-host-command-${randomUUID()}`,
    type,
    payload,
    createdAt: Date.now()
  };
  hostCommandQueue.push(command);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingHostCommands.delete(command.id);
      reject(new Error(`Browser host command ${command.id} timed out.`));
    }, timeoutMs);
    pendingHostCommands.set(command.id, { resolve, reject, timeout });
  });
}

export function takeBrowserHostCommands() {
  return hostCommandQueue.splice(0);
}

export function resolveBrowserHostCommand(commandId: string, result: unknown, error?: string) {
  const pending = pendingHostCommands.get(commandId);
  if (!pending) return false;
  pendingHostCommands.delete(commandId);
  clearTimeout(pending.timeout);
  if (error) pending.reject(new Error(error));
  else pending.resolve(result);
  return true;
}

export function enqueueBrowserCommand(
  tabGroupId: string,
  tabId: number,
  type: BrowserCommand["type"],
  payload?: Record<string, unknown>,
  timeoutMs = 10_000
) {
  const tab = tabs.get(browserTabKey(tabGroupId, tabId));
  if (!tab || tab.status !== "open") throw new Error(`Browser tab ${tabGroupId}:${tabId} is not open.`);

  const command: BrowserCommand = {
    id: `browser-command-${randomUUID()}`,
    tabGroupId,
    tabId,
    type,
    payload,
    createdAt: Date.now()
  };
  const key = browserTabKey(tabGroupId, tabId);
  commandQueues.set(key, [...(commandQueues.get(key) ?? []), command]);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(command.id);
      reject(new Error(`Browser command ${command.id} timed out.`));
    }, timeoutMs);
    pendingCommands.set(command.id, { resolve, reject, timeout });
  });
}

export function takeBrowserCommands(tabGroupId: string, tabId: number) {
  const key = browserTabKey(tabGroupId, tabId);
  const commands = commandQueues.get(key) ?? [];
  commandQueues.delete(key);
  return commands;
}

export function resolveBrowserCommand(commandId: string, result: unknown, error?: string) {
  const pending = pendingCommands.get(commandId);
  if (!pending) return false;
  pendingCommands.delete(commandId);
  clearTimeout(pending.timeout);
  if (error) pending.reject(new Error(error));
  else pending.resolve(result);
  return true;
}

export function createBrowserMcpServer(): McpServerConfig {
  return createSdkMcpServer({
    name: "claude-in-chrome",
    version: "0.1.0",
    instructions:
      "Standalone implementation of the Claude-in-Chrome browser bridge. Use these tools with browser tabGroupId/tabId values created by the webview host.",
    tools: [
      tool(
        "tabs_context_mcp",
        "List browser tabs created by the standalone Claude Agent Webview host.",
        {
          includeClosed: z.boolean().optional().describe("Include tabs that have been closed.")
        },
        async ({ includeClosed }) => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({ tabs: listBrowserTabs({ includeClosed }) }, null, 2)
            }
          ]
        }),
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
          },
          alwaysLoad: true
        }
      ),
      tool(
        "tabs_create_mcp",
        "Create a standalone browser tab through the webview host.",
        {
          tabGroupId: z.string().min(1).optional(),
          url: z.string().url().optional()
        },
        async ({ tabGroupId, url }) => {
          const result = await enqueueBrowserHostCommand("tabs_create", { tabGroupId, url });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      ),
      tool(
        "navigate",
        "Navigate a standalone browser tab to a URL.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          url: z.string().url()
        },
        async ({ tabGroupId, tabId, url }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "navigate", { url });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      ),
      tool(
        "read_page",
        "Read the current state and accessible page text from a standalone browser tab.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive()
        },
        async ({ tabGroupId, tabId }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "read_page");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
          },
          alwaysLoad: true
        }
      ),
      tool(
        "javascript_tool",
        "Run JavaScript in a standalone browser tab when the iframe page is same-origin and script execution is permitted.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          script: z.string().min(1)
        },
        async ({ tabGroupId, tabId, script }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "javascript_tool", { script });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      ),
      tool(
        "form_input",
        "Set a form control value in a standalone browser tab when the iframe page is same-origin.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          selector: z.string().min(1).optional(),
          ref: z.string().min(1).optional(),
          value: z.string()
        },
        async ({ tabGroupId, tabId, selector, ref, value }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "form_input", { selector, ref, value });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      ),
      tool(
        "read_console_messages",
        "Read console messages captured from a standalone browser tab when the iframe page is same-origin.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          onlyErrors: z.boolean().optional(),
          pattern: z.string().optional(),
          limit: z.number().int().positive().max(200).optional()
        },
        async ({ tabGroupId, tabId, onlyErrors, pattern, limit }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "read_console_messages", {
            onlyErrors,
            pattern,
            limit
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
          },
          alwaysLoad: true
        }
      ),
      tool(
        "read_network_requests",
        "Read fetch/XHR requests captured from a standalone browser tab when the iframe page is same-origin.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          urlPattern: z.string().optional(),
          onlyErrors: z.boolean().optional(),
          limit: z.number().int().positive().max(200).optional()
        },
        async ({ tabGroupId, tabId, urlPattern, onlyErrors, limit }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "read_network_requests", {
            urlPattern,
            onlyErrors,
            limit
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      ),
      tool(
        "computer",
        "Perform a browser interaction against a standalone browser tab.",
        {
          tabGroupId: z.string().min(1),
          tabId: z.number().int().positive(),
          action: z.enum(["screenshot", "left_click", "double_click", "right_click", "type", "key", "scroll", "wait"]),
          coordinate: z.tuple([z.number(), z.number()]).optional(),
          ref: z.string().optional(),
          text: z.string().optional(),
          scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
          duration: z.number().positive().optional()
        },
        async ({ tabGroupId, tabId, ...payload }) => {
          const result = await enqueueBrowserCommand(tabGroupId, tabId, "computer", payload);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        },
        {
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true
          },
          alwaysLoad: true
        }
      )
    ],
    alwaysLoad: true
  });
}
