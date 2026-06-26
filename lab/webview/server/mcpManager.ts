import { runClaudeCommandRaw } from "./claudeCli.js";

type RawRunner = typeof runClaudeCommandRaw;

type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled";

export async function listConfiguredMcpServers(
  cwd: string,
  runner: RawRunner = runClaudeCommandRaw,
  signal?: AbortSignal
) {
  const result = await runner(["mcp", "list"], cwd, signal);
  return {
    type: "get_mcp_servers_response",
    source: "claude-cli",
    degraded: true,
    mcpServers: parseMcpListOutput(result.stdout)
  };
}

export function parseMcpListOutput(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("…"))
    .map(parseMcpListLine)
    .filter((server): server is NonNullable<ReturnType<typeof parseMcpListLine>> => Boolean(server));
}

function parseMcpListLine(line: string) {
  const separator = line.lastIndexOf(" - ");
  if (separator === -1) return undefined;
  const left = line.slice(0, separator).trim();
  const right = line.slice(separator + 3).trim();
  const nameSeparator = left.indexOf(": ");
  if (nameSeparator === -1) return undefined;
  const name = left.slice(0, nameSeparator).trim();
  const commandText = left.slice(nameSeparator + 2).trim();
  if (!name) return undefined;
  return {
    name,
    status: parseStatus(right),
    serverInfo: undefined,
    error: parseError(right),
    config: parseConfig(commandText),
    scope: parseScope(name),
    tools: []
  };
}

function parseStatus(text: string): McpStatus {
  const normalized = text.toLowerCase();
  if (normalized.includes("disabled")) return "disabled";
  if (normalized.includes("auth")) return "needs-auth";
  if (normalized.includes("pending") || normalized.includes("approval")) return "pending";
  if (normalized.includes("failed") || normalized.includes("error") || normalized.includes("disconnected")) return "failed";
  return "connected";
}

function parseError(text: string) {
  return parseStatus(text) === "failed" ? text : undefined;
}

function parseScope(name: string) {
  if (name.startsWith("plugin:")) return "plugin";
  return "user";
}

function parseConfig(commandText: string) {
  const httpMatch = commandText.match(/https?:\/\/\S+/);
  if (httpMatch) {
    return {
      type: commandText.includes("(SSE)") ? "sse" : "http",
      url: httpMatch[0]
    };
  }
  const parts = commandText.split(/\s+/).filter(Boolean);
  return {
    type: "stdio",
    command: parts[0] ?? commandText,
    args: parts.slice(1)
  };
}
