import { spawn } from "node:child_process";
import path from "node:path";
import { resolveClaudeCodeExecutable } from "./claudeCli.js";

type TerminalSession = {
  name: string;
  command: string;
  cwd: string;
  content: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
};

const MAX_TERMINAL_BUFFER = 256 * 1024;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private nextId = 1;

  openTerminal(request: Record<string, unknown>, workspaceCwd: string, signal?: AbortSignal) {
    const executable = typeof request.executable === "string" && request.executable ? request.executable : process.env.SHELL || "sh";
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
    const cwd = resolveTerminalCwd(workspaceCwd, request.cwd);
    return this.startSession(executable, args, cwd, signal);
  }

  openClaudeInTerminal(request: Record<string, unknown>, workspaceCwd: string, signal?: AbortSignal) {
    const executable = resolveClaudeCodeExecutable() ?? "claude";
    const args = Array.isArray(request.args) ? request.args.map(String) : [];
    const prompt = typeof request.prompt === "string" && request.prompt.trim() ? request.prompt.trim() : undefined;
    if (prompt) args.push(prompt);
    return this.startSession(executable, args, workspaceCwd, signal, "claude");
  }

  getTerminalContents(name: unknown) {
    const session = typeof name === "string" ? this.sessions.get(name) : undefined;
    return {
      type: "get_terminal_contents_response",
      content: session ? formatTerminalContent(session) : ""
    };
  }

  getTerminalSession(name: unknown) {
    return typeof name === "string" ? this.sessions.get(name) : undefined;
  }

  private startSession(executable: string, args: string[], cwd: string, signal?: AbortSignal, namePrefix = "terminal") {
    const name = `${namePrefix}-${this.nextId++}`;
    const command = [executable, ...args].join(" ");
    const session: TerminalSession = {
      name,
      command,
      cwd,
      content: `$ ${command}\n`
    };
    this.sessions.set(name, session);

    try {
      const child = spawn(executable, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        signal
      });
      child.stdout.on("data", (chunk) => appendOutput(session, chunk));
      child.stderr.on("data", (chunk) => appendOutput(session, chunk));
      child.on("error", (error) => {
        session.error = error.message;
        appendOutput(session, `\n[error] ${error.message}\n`);
      });
      child.on("close", (code, closeSignal) => {
        session.exitCode = code;
        session.signal = closeSignal;
        appendOutput(session, `\n[process exited ${closeSignal ? `with signal ${closeSignal}` : `with code ${code ?? "unknown"}`}]\n`);
      });
    } catch (error) {
      session.error = error instanceof Error ? error.message : String(error);
      appendOutput(session, `\n[error] ${session.error}\n`);
    }

    return {
      type: "open_terminal_response",
      opened: true,
      terminalName: name,
      name
    };
  }
}

function appendOutput(session: TerminalSession, chunk: unknown) {
  session.content += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  if (session.content.length > MAX_TERMINAL_BUFFER) {
    session.content = session.content.slice(session.content.length - MAX_TERMINAL_BUFFER);
  }
}

function formatTerminalContent(session: TerminalSession) {
  return session.content;
}

function resolveTerminalCwd(workspaceCwd: string, requestedCwd: unknown) {
  if (typeof requestedCwd !== "string" || !requestedCwd) return workspaceCwd;
  const absolutePath = path.isAbsolute(requestedCwd) ? path.normalize(requestedCwd) : path.resolve(workspaceCwd, requestedCwd);
  const relativePath = path.relative(workspaceCwd, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return workspaceCwd;
  return absolutePath;
}
