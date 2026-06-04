/**
 * WorkflowTool — constants
 *
 * Centralized string constants and numeric limits.
 * Kept in a separate file to avoid circular imports between
 * WorkflowTool.tsx, prompts.ts, and the bundled workflow loader.
 */

export const WORKFLOW_TOOL_NAME = 'Workflow'

/** Max script size in characters */
export const MAX_SCRIPT_SIZE = 200_000

/** Max description slice length for built-in workflows */
export const MAX_DESC_SLICE = 200

/** Run ID prefix */
export const RUN_ID_PREFIX = 'wf_'

/** Regex for valid run IDs: wf_ + 6+ alphanumeric+dash chars */
export const RUN_ID_REGEX = /^wf_[a-z0-9-]{6,}$/

/** Hard cap on total agent() calls across a workflow's lifetime */
export const MAX_TOTAL_AGENTS = 1000

/** Max concurrent agent() calls per workflow */
export const MAX_CONCURRENT_AGENTS_DEFAULT = 16

/** Progress event batch interval (ms) */
export const PROGRESS_BATCH_INTERVAL_MS = 16

/** vm.Script timeout (ms) — 5 minutes */
export const VM_SCRIPT_TIMEOUT_MS = 300_000
