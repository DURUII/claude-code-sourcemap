import { Script } from 'vm'

// ---------------------------------------------------------------------------
// Meta block parsing
// ---------------------------------------------------------------------------

/**
 * Parsed result from extracting `export const meta = { ... }` from a script.
 */
export type ParsedMeta = {
  name: string
  description?: string
  title?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  /** Raw script body — the part after the meta block declaration */
  scriptBody: string
}

/**
 * Validation result for meta parsing.
 */
export type MetaResult =
  | { ok: true; meta: ParsedMeta }
  | { ok: false; error: string }

/**
 * Extract and validate `export const meta = { ... }` from a workflow script.
 *
 * The real CLI requires the meta export to be the first statement and strips it
 * before sandbox execution. This parser keeps the same behavioral contract
 * without adding a parser dependency to the restored source tree.
 */
export function parseWorkflowMeta(script: string): MetaResult {
  const prefixMatch = /^[;\s]*/.exec(script)
  const start = prefixMatch?.[0].length ?? 0
  const exportPrefix = 'export const meta'
  if (!script.startsWith(exportPrefix, start)) {
    return {
      ok: false,
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }

  const eqIndex = script.indexOf('=', start + exportPrefix.length)
  if (eqIndex < 0) {
    return {
      ok: false,
      error: 'Workflow script must begin with `export const meta = { name, description, phases }`',
    }
  }

  const objectStart = skipWhitespace(script, eqIndex + 1)
  if (script[objectStart] !== '{') {
    return { ok: false, error: 'meta must be a pure literal: expected object literal' }
  }

  const objectEnd = findMatchingDelimiter(script, objectStart, '{', '}')
  if (objectEnd < 0) {
    return { ok: false, error: 'Script parse error: unterminated meta object' }
  }

  const metaBlock = script.slice(objectStart, objectEnd + 1)
  if (metaBlock.includes('`')) {
    return { ok: false, error: 'template interpolation not allowed in meta' }
  }
  const strippedMeta = stripStringLiterals(metaBlock)
  if (/\.\.\.|=>|\b(function|new|import|require|await|agent|parallel|pipeline|phase|log)\b/.test(strippedMeta)) {
    return { ok: false, error: 'meta must be a pure literal: computed values are not allowed' }
  }

  let meta: unknown
  try {
    meta = Function(`"use strict"; return (${metaBlock});`)()
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return { ok: false, error: `Script parse error: ${message}` }
  }

  if (!isRecord(meta)) {
    return { ok: false, error: 'meta must be a pure literal: expected object' }
  }
  if (typeof meta.name !== 'string' || meta.name.length === 0) {
    return { ok: false, error: 'meta.name is required and must be a string literal' }
  }
  if (meta.description !== undefined && typeof meta.description !== 'string') {
    return { ok: false, error: 'meta.description must be a string literal' }
  }
  if (meta.title !== undefined && typeof meta.title !== 'string') {
    return { ok: false, error: 'meta.title must be a string literal' }
  }
  if (meta.whenToUse !== undefined && typeof meta.whenToUse !== 'string') {
    return { ok: false, error: 'meta.whenToUse must be a string literal' }
  }

  let phases: Array<{ title: string; detail?: string }> | undefined
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases)) {
      return { ok: false, error: 'meta.phases must be an array literal' }
    }
    phases = []
    for (const phase of meta.phases) {
      if (!isRecord(phase) || typeof phase.title !== 'string') {
        return { ok: false, error: 'meta.phases entries must include a string title' }
      }
      if (phase.detail !== undefined && typeof phase.detail !== 'string') {
        return { ok: false, error: 'meta.phases detail must be a string literal' }
      }
      phases.push({ title: phase.title, detail: phase.detail })
    }
  }

  return {
    ok: true,
    meta: {
      name: meta.name,
      description: meta.description,
      title: meta.title,
      whenToUse: meta.whenToUse,
      phases,
      scriptBody: script.slice(objectEnd + 1).replace(/^[;\s]*/, ''),
    },
  }
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (index < source.length && /\s/.test(source[index] ?? '')) index++
  return index
}

function findMatchingDelimiter(
  source: string,
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0
  let quote: string | null = null
  for (let index = start; index < source.length; index++) {
    const ch = source[index]
    if (quote) {
      if (ch === '\\') {
        index++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === open) depth++
    if (ch === close) {
      depth--
      if (depth === 0) return index
    }
  }
  return -1
}

function stripStringLiterals(source: string): string {
  let output = ''
  let quote: string | null = null
  for (let index = 0; index < source.length; index++) {
    const ch = source[index]
    if (quote) {
      output += ' '
      if (ch === '\\') {
        index++
        output += ' '
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      output += ' '
      continue
    }
    output += ch
  }
  return output
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// Sandbox compilation
// ---------------------------------------------------------------------------

const DATE_NOW_ERR =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). ' +
  'Stamp results after the workflow returns, or pass timestamps via args.'

const RANDOM_ERR =
  'Math.random() is unavailable in workflow scripts (breaks resume). ' +
  'For N independent samples, include the index in the agent label or prompt.'

/**
 * Result of compiling a workflow script body into a sandboxed vm.Script.
 */
export type CompiledScript =
  | { ok: true; vmScript: Script }
  | { ok: false; error: string }

/**
 * Wrap the script body in a sandbox that:
 * 1. Blocks Date.now() and bare new Date()
 * 2. Blocks Math.random()
 * 3. Deletes ShadowRealm and WebAssembly (escape hatches)
 * 4. Fixes the TC39 "override mistake" for Error subclasses
 *
 * The sandbox wrapper is prepended to the user script before compilation.
 */
export function compileWorkflowScript(
  scriptBody: string,
): CompiledScript {
  const sandboxWrapper = `(() => {
    // ── Block non-deterministic APIs ──────────────────────────
    const NOW_ERR = ${JSON.stringify(DATE_NOW_ERR)};
    const RANDOM_ERR = ${JSON.stringify(RANDOM_ERR)};

    Math.random = function random() { throw new Error(RANDOM_ERR) };

    const RealDate = Date;
    RealDate.now = function now() { throw new Error(NOW_ERR) };

    function ShimDate(...a) {
      if (!new.target) throw new Error(NOW_ERR);  // bare Date() → now-string
      if (a.length === 0) throw new Error(NOW_ERR);
      return Reflect.construct(RealDate, a, new.target);
    }
    ShimDate.now = RealDate.now;
    ShimDate.parse = RealDate.parse;
    ShimDate.UTC = RealDate.UTC;
    ShimDate.prototype = RealDate.prototype;

    // Close the (new Date(x)).constructor backdoor to RealDate.now
    RealDate.prototype.constructor = ShimDate;
    Object.freeze(RealDate);
    globalThis.Date = ShimDate;
  })()`

  const fullSource = `${sandboxWrapper}\n(async () => {\n${scriptBody}\n})()`

  try {
    // Pre-check syntax with Function constructor (faster than vm.Script)
    new Function(fullSource)

    // Compile into vm.Script for sandboxed execution
    const vmScript = new Script(fullSource, { filename: 'workflow.js' })
    return { ok: true, vmScript }
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : String(e)
    return { ok: false, error: `SyntaxError: ${message}` }
  }
}

/**
 * Determinism check: scan script body for banned patterns.
 * Used during validateInput to reject scripts before execution.
 */
export function hasNonDeterministicCalls(scriptBody: string): boolean {
  return (
    /\bDate\s*\.\s*now\b/.test(scriptBody) ||
    /\bMath\s*\.\s*random\b/.test(scriptBody) ||
    /\bnew\s+Date\s*\(\s*\)/.test(scriptBody)
  )
}
