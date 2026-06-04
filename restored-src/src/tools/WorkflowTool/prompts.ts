// ---------------------------------------------------------------------------
// WorkflowTool — System prompt and descriptions
// ---------------------------------------------------------------------------

export const WORKFLOW_TOOL_NAME = 'Workflow'

/**
 * The main system prompt for the Workflow tool.
 * Shown to the model when the tool is available.
 */
export const WORKFLOW_PROMPT = `Execute a workflow script that orchestrates multiple subagents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when it completes. Use /workflows to watch live progress.

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), or to take on scale one context can't hold (migrations, audits, broad sweeps). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

## When to use

ONLY call this tool when the user has explicitly opted into multi-agent orchestration, named an available workflow, asked for a dynamic workflow, or requested work that clearly requires broad parallel decomposition with verification. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.

## Script format

Pass the script inline via \`script\` — do not Write it to a file first. Every invocation automatically persists its script to a file under the session directory and returns the path in the tool result. To iterate on a workflow, edit that file with Write/Edit and re-invoke Workflow with \`{scriptPath: "<path>"}\` instead of resending the full script.

Every script must begin with a \`meta\` block:

\`\`\`javascript
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
// script body starts here — use agent()/parallel()/pipeline()/phase()/log()
\`\`\`

The \`meta\` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation. Required fields: \`name\`, \`description\`. Optional: \`whenToUse\`, \`phases\`. Use the SAME phase titles in meta.phases as in phase() calls.

## Runtime API

- \`agent(prompt: string, opts?: {label?, phase?, schema?, model?, isolation?, agentType?})\`: Promise<any> — spawn a subagent. Without schema, returns its final text as a string. With schema (a JSON Schema), the subagent is forced to call a StructuredOutput tool and agent() returns the validated object.

- \`parallel(thunks: Array<() => Promise<any>>)\`: Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks before returning. A thunk that throws resolves to \`null\` — the call itself never rejects, so \`.filter(Boolean)\` before using the results.

- \`pipeline(items, stage1, stage2, ...)\`: Promise<any[]> — run each item through all stages independently, NO barrier between stages. Item A can be in stage 3 while item B is still in stage 1. A stage that throws drops that item to \`null\` and skips its remaining stages.

- \`phase(title: string)\`: void — start a new phase; subsequent agent() calls are grouped under this title in the progress display.

- \`log(message: string)\`: void — emit a progress message to the user.

- \`args\`: any — the value passed as Workflow's \`args\` input, verbatim.

- \`budget: {total: number|null, spent(): number, remaining(): number}\` — the turn's token target. \`budget.total\` is null if no target was set. The target is a HARD ceiling: once \`spent()\` reaches \`total\`, further \`agent()\` calls throw.

## Concurrency

Concurrent agent() calls are capped at min(16, cpu cores - 2) per workflow — excess calls queue and run as slots free up. Total agent count across a workflow's lifetime is capped at 1000.

## Resume

The tool result includes a runId. To resume after a pause, kill, or script edit, relaunch with Workflow({scriptPath, resumeFromRunId}) — completed agent() calls with unchanged (prompt, opts) return their cached results instantly; only edited or new calls re-run. Same script + same args → 100% cache hit.

Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable in scripts (they would break this) — stamp results after the workflow returns, or pass timestamps via args.`

export const DESCRIPTION =
  'orchestrate subagents with deterministic JavaScript workflow'
