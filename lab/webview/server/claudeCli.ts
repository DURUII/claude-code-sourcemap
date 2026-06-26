import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RunClaudeCommand = (args: string[], cwd: string, signal?: AbortSignal) => Promise<unknown>;

export function resolveClaudeCodeExecutable() {
  if (process.env.CLAUDE_CODE_EXECUTABLE) return process.env.CLAUDE_CODE_EXECUTABLE;
  return findRestoredSrcClaudeExecutable() ?? findClaudeOnPath() ?? findClaudeCodeExecutable();
}

export async function runClaudeCommand(args: string[], cwd: string, signal?: AbortSignal): Promise<unknown> {
  const binary = resolveClaudeCodeExecutable();
  if (!binary) throw new Error("Claude binary not available.");
  const result = await runClaudeCommandRaw(args, cwd, signal);
  return JSON.parse(result.stdout) as unknown;
}

export async function runClaudeCommandRaw(args: string[], cwd: string, signal?: AbortSignal) {
  const binary = resolveClaudeCodeExecutable();
  if (!binary) throw new Error("Claude binary not available.");
  try {
    return await execFileAsync(binary, args, {
      cwd,
      env: process.env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Claude CLI request cancelled.");
    }
    if (error && typeof error === "object" && "stderr" in error) {
      const candidate = error as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; syscall?: unknown };
      if (candidate.syscall) throw error;
      const status = candidate.killed
        ? "timed out after 30s"
        : candidate.code != null
          ? `exited with code ${candidate.code}`
          : `killed by ${candidate.signal ?? "signal"}`;
      throw new Error(`Claude CLI ${status}: ${String(candidate.stderr ?? "")}`);
    }
    throw error;
  }
}

export function findClaudeCodeExecutable(extensionRoots = defaultExtensionRoots()) {
  const candidates: string[] = [];
  for (const root of extensionRoots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("anthropic.claude-code-")) continue;
      const candidate = path.join(root, entry.name, "resources", "native-binary", "claude");
      if (existsSync(candidate)) candidates.push(candidate);
    }
  }
  candidates.sort(compareClaudeExtensionPaths);
  return candidates.at(-1);
}

export function findClaudeOnPath(pathValue = process.env.PATH, platform = process.platform) {
  if (!pathValue) return undefined;
  const executableNames = platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const executableName of executableNames) {
      const candidate = path.join(directory, executableName);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep scanning PATH candidates.
      }
    }
  }
  return undefined;
}

export function findRestoredSrcClaudeExecutable(baseDir = path.dirname(fileURLToPath(import.meta.url))) {
  const candidates = [
    path.resolve(process.cwd(), "../../restored-src/bin/claude"),
    path.resolve(process.cwd(), "restored-src/bin/claude"),
    path.resolve(baseDir, "../../../restored-src/bin/claude")
  ];
  return candidates.find(isExecutableFile);
}

function defaultExtensionRoots() {
  const home = homedir();
  return [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
    path.join(home, ".vscode-insiders", "extensions")
  ];
}

function isExecutableFile(candidate: string) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function compareClaudeExtensionPaths(left: string, right: string) {
  return compareVersions(extractClaudeVersion(left), extractClaudeVersion(right)) || left.localeCompare(right);
}

function extractClaudeVersion(candidatePath: string) {
  const match = candidatePath.match(/anthropic\.claude-code-([0-9]+(?:\.[0-9]+)+)/);
  return match?.[1] ?? "0";
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
