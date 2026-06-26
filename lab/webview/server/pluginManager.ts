import { runClaudeCommand, runClaudeCommandRaw, type RunClaudeCommand } from "./claudeCli.js";

type RecordLike = Record<string, unknown>;
type RunClaudeCommandRaw = typeof runClaudeCommandRaw;

function asRecord(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown) {
  return value === true;
}

export function mapInstalledPlugin(value: unknown) {
  const plugin = asRecord(value);
  const id = asString(plugin.id);
  const version = asString(plugin.version, "unknown");
  return {
    name: id,
    manifest: { name: id, version },
    path: asString(plugin.installPath),
    source: id,
    enabled: asBoolean(plugin.enabled),
    mcpServers: plugin.mcpServers
  };
}

export function mapAvailablePlugin(value: unknown) {
  const plugin = asRecord(value);
  return {
    entry: {
      name: asString(plugin.name),
      description: asString(plugin.description)
    },
    marketplaceName: asString(plugin.marketplaceName),
    pluginId: asString(plugin.pluginId),
    isInstalled: false,
    source: asString(plugin.source),
    installCount: typeof plugin.installCount === "number" ? plugin.installCount : undefined
  };
}

export function mapMarketplace(value: unknown) {
  const marketplace = asRecord(value);
  return {
    name: asString(marketplace.name),
    config: {
      source: buildMarketplaceSource(marketplace),
      installLocation: asString(marketplace.installLocation)
    },
    pluginCount: 0,
    installedCount: 0
  };
}

function buildMarketplaceSource(marketplace: RecordLike) {
  switch (marketplace.source) {
    case "github":
      return { source: "github", repo: asString(marketplace.repo) };
    case "git":
      return { source: "git", url: asString(marketplace.url) };
    case "url":
      return { source: "url", url: asString(marketplace.url) };
    case "directory":
      return { source: "directory", path: asString(marketplace.path) };
    case "file":
      return { source: "file", path: asString(marketplace.path) };
    case "npm":
      return { source: "npm", package: asString(marketplace.package) };
    default:
      return { source: "url", url: "" };
  }
}

export async function listPlugins(
  cwd: string,
  includeAvailable: unknown,
  runner: RunClaudeCommand = runClaudeCommand,
  signal?: AbortSignal
) {
  const args = ["plugin", "list", "--json"];
  if (includeAvailable === true) args.push("--available");

  const result = await runner(args, cwd, signal);
  if (includeAvailable === true) {
    const payload = asRecord(result);
    return {
      type: "list_plugins_response",
      available: asArray(payload.available).map(mapAvailablePlugin),
      installed: asArray(payload.installed).map(mapInstalledPlugin),
      errors: []
    };
  }

  return {
    type: "list_plugins_response",
    available: [],
    installed: asArray(result).map(mapInstalledPlugin),
    errors: []
  };
}

export async function listMarketplaces(cwd: string, runner: RunClaudeCommand = runClaudeCommand, signal?: AbortSignal) {
  return {
    type: "list_marketplaces_response",
    marketplaces: asArray(await runner(["plugin", "marketplace", "list", "--json"], cwd, signal)).map(mapMarketplace)
  };
}

export async function installPlugin(
  cwd: string,
  pluginId: unknown,
  scope: unknown,
  signal?: AbortSignal,
  runner: RunClaudeCommandRaw = runClaudeCommandRaw
) {
  await runner(["plugin", "install", normalizePluginId(pluginId), "--scope", normalizeScope(scope)], cwd, signal);
  return { type: "install_plugin_response", needsRestart: true };
}

export async function uninstallPlugin(
  cwd: string,
  pluginId: unknown,
  signal?: AbortSignal,
  runner: RunClaudeCommandRaw = runClaudeCommandRaw
) {
  await runner(["plugin", "uninstall", normalizePluginId(pluginId)], cwd, signal);
  return { type: "uninstall_plugin_response", needsRestart: true };
}

export async function setPluginEnabled(
  cwd: string,
  pluginId: unknown,
  enabled: unknown,
  signal?: AbortSignal,
  runner: RunClaudeCommandRaw = runClaudeCommandRaw
) {
  await runner(["plugin", enabled === true ? "enable" : "disable", normalizePluginId(pluginId)], cwd, signal);
  return { type: "set_plugin_enabled_response", needsRestart: true };
}

export async function addMarketplace(cwd: string, source: unknown, signal?: AbortSignal) {
  await runClaudeCommandRaw(["plugin", "marketplace", "add", String(source ?? "")], cwd, signal);
  return { type: "add_marketplace_response" };
}

export async function removeMarketplace(cwd: string, marketplaceId: unknown, signal?: AbortSignal) {
  await runClaudeCommandRaw(["plugin", "marketplace", "remove", String(marketplaceId ?? "")], cwd, signal);
  return { type: "remove_marketplace_response" };
}

export async function refreshMarketplace(cwd: string, marketplaceId: unknown, signal?: AbortSignal) {
  await runClaudeCommandRaw(["plugin", "marketplace", "update", String(marketplaceId ?? "")], cwd, signal);
  return { type: "refresh_marketplace_response" };
}

function normalizePluginId(pluginId: unknown) {
  if (typeof pluginId !== "string" || !pluginId.trim()) throw new Error("Plugin id is required.");
  return pluginId.trim();
}

function normalizeScope(scope: unknown) {
  return scope === "project" || scope === "local" || scope === "user" ? scope : "user";
}
