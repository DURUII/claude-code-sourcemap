import { readdir, readFile, stat } from 'fs/promises'
import { readFileSync } from 'fs'
import { join } from 'path'
import { getCwd } from '../../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { getProjectDirsUpToHome } from '../../../utils/markdownConfigLoader.js'
import { isSettingSourceEnabled } from '../../../utils/settings/constants.js'
import { loadAllPluginsCacheOnly } from '../../../utils/plugins/pluginLoader.js'
import { logError } from '../../../utils/log.js'
import { logForDebugging } from '../../../utils/debug.js'
import { MAX_SCRIPT_SIZE } from '../constants.js'
import { parseWorkflowMeta } from '../sandbox.js'

export type WorkflowSource =
  | 'built-in'
  | 'plugin'
  | 'userSettings'
  | 'projectSettings'

export type WorkflowDefinition = {
  name: string
  script: string
  description?: string
  title?: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
  source: WorkflowSource
  filePath?: string
  pluginName?: string
}

const DEEP_RESEARCH_SCRIPT = readFileSync(
  new URL('./deep-research-wf_c708b9e5-187.js', import.meta.url),
  'utf8',
)

const RECONSTRUCTED_DEEP_RESEARCH_SCRIPT = `export const meta = {
  name: 'deep-research',
  description: 'Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.',
  whenToUse: 'When the user wants a deep, multi-source, fact-checked research report on any topic. BEFORE invoking, check if the question is specific enough to research directly — if underspecified (e.g., "what car to buy" without budget/use-case/region), ask 2-3 clarifying questions to narrow scope. Then pass the refined question as args, weaving the answers in.',
  phases: [
    { title: 'Scope', detail: 'Decompose question (from args) into 5 search angles' },
    { title: 'Search', detail: '5 parallel WebSearch agents, one per angle' },
    { title: 'Fetch', detail: 'URL-dedup, fetch top 15 sources, extract falsifiable claims' },
    { title: 'Verify', detail: '3-vote adversarial verification per claim (need 2/3 refutes to kill)' },
    { title: 'Synthesize', detail: 'Merge semantic dupes, rank by confidence, cite sources' },
  ],
}

// deep-research: Scope → pipeline(Search → URL-dedup → Fetch+Extract) → 3-vote Verify → Synthesize
// Ported from bughunter architecture. WebSearch/WebFetch instead of git/grep.
// Question is passed via Workflow({name: 'deep-research', args: '<question>'}).

const VOTES_PER_CLAIM = 3
const REFUTATIONS_REQUIRED = 2
const MAX_FETCH = 15
const MAX_VERIFY_CLAIMS = 25

const SCOPE_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    summary: { type: 'string' },
    angles: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          query: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['label', 'query'],
      },
    },
  },
  required: ['question', 'angles', 'summary'],
}

const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          relevance: { enum: ['high', 'medium', 'low'] },
        },
        required: ['url', 'title', 'relevance'],
      },
    },
  },
  required: ['results'],
}

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    sourceQuality: {
      enum: ['primary', 'secondary', 'blog', 'forum', 'unreliable'],
    },
    publishDate: { type: 'string' },
    claims: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          quote: { type: 'string' },
          importance: {
              enum: ['central', 'supporting', 'tangential'],
            },
        },
        required: ['claim', 'quote', 'importance'],
      },
    },
  },
  required: ['claims', 'sourceQuality'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    evidence: { type: 'string' },
    confidence: { enum: ['high', 'medium', 'low'] },
    counterSource: { type: 'string' },
  },
  required: ['refuted', 'evidence', 'confidence'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low'] },
          sources: { type: 'array', items: { type: 'string' } },
          evidence: { type: 'string' },
          vote: { type: 'string' },
        },
        required: ['claim', 'confidence', 'sources', 'evidence'],
      },
    },
    caveats: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'findings', 'caveats'],
}

const QUESTION = (typeof args === 'string' && args.trim()) || ''
phase('Scope')
if (!QUESTION) {
  return {
    error: "No research question provided. Pass it as args: Workflow({name: 'deep-research', args: '<question>'}).",
  }
}

const scope = await agent(
  'Decompose this research question into complementary search angles.\\n\\n' +
    '## Question\\n' + QUESTION + '\\n\\n' +
    '## Task\\n' +
    'Generate 5 distinct web search queries that together cover the question from different angles. Pick angles that suit the question\\'s domain. Examples:\\n' +
    '- broad/primary  · academic/technical  · recent news  · contrarian/skeptical  · practitioner/implementation\\n' +
    '- For medical: anatomy · common causes · serious differentials · authoritative refs · red flags\\n' +
    '- For tech: state-of-art · benchmarks · limitations · industry adoption · cost/tradeoffs\\n\\n' +
    'Make queries specific enough to surface high-signal results. Avoid redundancy.\\n' +
    'Return: the question (verbatim or lightly normalized), a 1-2 sentence decomposition strategy, and the angles.\\n\\nStructured output only.',
  {
    label: 'scope',
    schema: SCOPE_SCHEMA,
  },
)
if (!scope) {
  return { error: 'Scope agent returned no result — cannot decompose the research question.' }
}
log('Q: ' + QUESTION.slice(0, 80) + (QUESTION.length > 80 ? '…' : ''))
log('Decomposed into ' + scope.angles.length + ' angles: ' + scope.angles.map(a => a.label).join(', '))

const normURL = u => {
  try {
    const p = new URL(u)
    return (p.hostname.replace(/^www\\./, '') + p.pathname.replace(/\\/$/, '')).toLowerCase()
  } catch {
    return u.toLowerCase()
  }
}

const seen = new Map()
const dupes = []
const budgetDropped = []
const relRank = { high: 0, medium: 1, low: 2 }
let fetchSlots = MAX_FETCH

const SEARCH_PROMPT = angle =>
  '## Web Searcher: ' + angle.label + '\\n\\n' +
  'Research question: "' + QUESTION + '"\\n\\n' +
  'Your angle: **' + angle.label + '** — ' + (angle.rationale || '') + '\\n' +
  'Search query: \`' + angle.query + '\`\\n\\n' +
  '## Task\\nUse WebSearch with the query above (or a refined version). Return the top 4-6 most relevant results.\\n' +
  'Rank by relevance to the ORIGINAL question, not just the search query. Skip obvious SEO spam/content farms.\\n' +
  'Include a short snippet capturing why each result is relevant.\\n\\nStructured output only.'

const FETCH_PROMPT = (source, angle) =>
  '## Source Extractor\\n\\n' +
  'Research question: "' + QUESTION + '"\\n\\n' +
  'Fetch and extract key claims from this source:\\n' +
  '**URL:** ' + source.url + '\\n**Title:** ' + source.title + '\\n**Found via:** ' + angle + ' search\\n\\n' +
  '## Task\\n1. Use WebFetch to retrieve the page content.\\n' +
  '2. Assess source quality: primary research/institution? secondary reporting? blog/opinion? forum? unreliable?\\n' +
  '3. Extract 2-5 FALSIFIABLE claims that bear on the research question. Each claim must:\\n' +
  '   - be a concrete, checkable statement (not vague generalities)\\n' +
  '   - include a direct quote from the source as support\\n' +
  '   - be rated central/supporting/tangential to the research question\\n' +
  '4. Note publish date if available.\\n\\n' +
  'If the fetch fails or the page is irrelevant/paywalled, return claims: [] and sourceQuality: "unreliable".\\n\\nStructured output only.'

const VERIFY_PROMPT = (claim, vote) =>
  '## Adversarial Claim Verifier (voter ' + (vote + 1) + '/' + VOTES_PER_CLAIM + ')\\n\\n' +
  'Be SKEPTICAL. Try to REFUTE this claim. ≥' + REFUTATIONS_REQUIRED + '/' + VOTES_PER_CLAIM + ' refutations kill it.\\n\\n' +
  '## Research question\\n' + QUESTION + '\\n\\n' +
  '## Claim under review\\n"' + claim.claim + '"\\n\\n' +
  '**Source:** ' + claim.sourceUrl + ' (' + claim.sourceQuality + ')\\n' +
  '**Supporting quote:** "' + claim.quote + '"\\n\\n' +
  '## Checklist\\n' +
  '1. Is the claim actually supported by the quote, or is it an overreach/misread?\\n' +
  '2. WebSearch for contradicting evidence — does any credible source dispute or heavily qualify this?\\n' +
  '3. Is the source quality sufficient for the claim\\'s strength? (extraordinary claims need primary sources)\\n' +
  '4. Is the claim outdated? (check dates — old claims about fast-moving fields are suspect)\\n' +
  '5. Is this a marketing claim / press release / cherry-picked benchmark / forum speculation?\\n\\n' +
  '**refuted=true** if: unsupported by quote / contradicted / low-quality source for strong claim / outdated / marketing fluff.\\n' +
  '**refuted=false** ONLY if: claim is well-supported, current, and source quality matches claim strength.\\n' +
  'Default to refuted=true if uncertain.\\n\\nStructured output only. Evidence MUST be specific.'

const searchResults = await pipeline(
  scope.angles,
  angle =>
    agent(
      SEARCH_PROMPT(angle),
      {
        label: 'search:' + angle.label,
        phase: 'Search',
        schema: SEARCH_SCHEMA,
      },
    ).then(r => {
      if (!r) return null
      return { angle, results: r.results || [] }
    }),
  searchResult => {
    if (!searchResult) return null
    return searchResult
  },
  searchResult => {
    log('Search ' + searchResult.angle.label + ': ' + searchResult.results.length + ' results')
    return searchResult
  },
  searchResult => {
    const sorted = [...searchResult.results].sort((a, b) =>
      relRank[a.relevance] - relRank[b.relevance],
    )
    const novel = []
    for (const source of sorted) {
      const key = normURL(source.url)
      if (seen.has(key)) {
        dupes.push({ url: source.url, duplicateOf: seen.get(key), angle: searchResult.angle.label })
        continue
      }
      seen.set(key, source.url)
      if (fetchSlots <= 0 && relRank[source.relevance] >= 1) {
        budgetDropped.push({ url: source.url, angle: searchResult.angle.label })
        continue
      }
      fetchSlots--
      novel.push(source)
    }

    return parallel(
      novel.map(source => () => {
        let host = source.url
        try {
          host = new URL(source.url).hostname.replace(/^www\\./, '')
        } catch {}
        return agent(
          FETCH_PROMPT(source, searchResult.angle.label),
          {
            label: 'fetch:' + host,
            phase: 'Fetch',
            schema: EXTRACT_SCHEMA,
          },
        )
          .then(ext => {
            if (!ext) return null
            return {
              url: source.url,
              title: source.title,
              angle: searchResult.angle.label,
              sourceQuality: ext.sourceQuality,
              publishDate: ext.publishDate,
              claims: (ext.claims || []).map(c => ({
                ...c,
                sourceUrl: source.url,
                sourceQuality: ext.sourceQuality,
              })),
            }
          })
          .catch(e => {
            log('Fetch failed for ' + source.url + ': ' + e.message)
            return {
              url: source.url,
              title: source.title,
              angle: searchResult.angle.label,
              sourceQuality: 'unreliable',
              claims: [],
            }
          })
      },
    ),
    )
  },
)

const allSources = searchResults.flat().filter(Boolean)
const allClaims = allSources.flatMap(s => s.claims)
const impRank = { central: 0, supporting: 1, tangential: 2 }
const qualRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 }
const rankedClaims = [...allClaims]
  .sort((a, b) =>
    (impRank[a.importance] ?? 9) - (impRank[b.importance] ?? 9) ||
    (qualRank[a.sourceQuality] ?? 9) - (qualRank[b.sourceQuality] ?? 9),
  )
  .slice(0, MAX_VERIFY_CLAIMS)

log('Fetched ' + allSources.length + ' sources → ' + allClaims.length + ' claims → verifying top ' + rankedClaims.length)

if (rankedClaims.length === 0) {
  return {
    question: QUESTION,
    summary: 'No claims extracted. ' + allSources.length + ' sources fetched, all empty/failed. ' + dupes.length + ' URL dupes, ' + budgetDropped.length + ' budget-dropped.',
    findings: [],
    refuted: [],
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: 0, dupes: dupes.length },
  }
}

// ─── Verify: 3-vote adversarial ───
// Barrier here is intentional — claim pool must be fully assembled before ranking/verification.
phase('Verify')
const voted = (await parallel(
  rankedClaims.map(claim => () =>
    parallel(
      Array.from({ length: VOTES_PER_CLAIM }, (_, v) => () =>
        agent(
          VERIFY_PROMPT(claim, v),
          {
            label: 'v' + v + ':' + claim.claim.slice(0, 40),
            phase: 'Verify',
            schema: VERDICT_SCHEMA,
          },
        ),
      ),
    ).then(verdicts => {
      // A vote can be null (user-skip or agent error) — treat as abstain.
      const valid = verdicts.filter(Boolean)
      const refuted = valid.filter(v => v.refuted).length
      // Survive only if the claim was actually adjudicated: a quorum of
      // valid votes AND fewer than REFUTATIONS_REQUIRED refuting. Too many
      // abstentions = unverified, which must NOT pass into the report
      // (otherwise all-abstain → refuted=0 → false survive).
      const abstained = VOTES_PER_CLAIM - valid.length
      const survives = valid.length >= REFUTATIONS_REQUIRED && refuted < REFUTATIONS_REQUIRED
      log('"' + claim.claim.slice(0, 50) + '…": ' + (valid.length - refuted) + '-' + refuted + (abstained > 0 ? ' (' + abstained + ' abstain)' : '') + ' ' + (survives ? '✓' : '✗'))
      return { ...claim, verdicts: valid, refutedVotes: refuted, survives }
    }),
  ),
)).filter(Boolean)

const confirmed = voted.filter(c => c.survives)
const killed = voted.filter(c => !c.survives)
log('Verify done: ' + voted.length + ' claims → ' + confirmed.length + ' confirmed, ' + killed.length + ' killed')

if (confirmed.length === 0) {
  return {
    question: QUESTION,
    summary: 'All ' + voted.length + ' claims refuted by adversarial verification. Research inconclusive — sources may be low-quality or claims overstated.',
    findings: [],
    refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: allClaims.length, verified: voted.length, confirmed: 0, killed: killed.length },
  }
}

// ─── Synthesize ───
phase('Synthesize')
const confRank = { high: 0, medium: 1, low: 2 }
const block = confirmed.map((c, i) => {
  const best = c.verdicts.filter(v => !v.refuted).sort((a, b) => confRank[a.confidence] - confRank[b.confidence])[0]
  return '### [' + i + '] ' + c.claim + '\\n' +
    'Vote: ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + ' · Source: ' + c.sourceUrl + ' (' + c.sourceQuality + ')\\n' +
    'Quote: "' + c.quote + '"\\nVerifier evidence (' + best.confidence + '): ' + best.evidence + '\\n'
}).join('\\n')

const killedBlock = killed.length > 0
  ? '\\n## Refuted claims (for transparency)\\n' +
    killed.map(c => '- "' + c.claim + '" (' + c.sourceUrl + ', vote ' + (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes + ')').join('\\n')
  : ''

const report = await agent(
  '## Synthesis: research report\\n\\n' +
    '**Question:** ' + QUESTION + '\\n\\n' +
    confirmed.length + ' claims survived ' + VOTES_PER_CLAIM + '-vote adversarial verification. Merge semantic duplicates and synthesize.\\n\\n' +
    '## Confirmed claims\\n' + block + '\\n' + killedBlock + '\\n\\n' +
    '## Instructions\\n' +
    '1. Identify claims that say the same thing — merge them, combine their sources.\\n' +
    '2. Group related claims into coherent findings. Each finding should directly address the research question.\\n' +
    '3. Assign confidence per finding: high (multiple primary sources, unanimous votes), medium (secondary sources or split votes), low (single source or blog-quality).\\n' +
    '4. Write a 3-5 sentence executive summary answering the research question.\\n' +
    '5. Note caveats: what\\'s uncertain, what sources were weak, what time-sensitivity applies.\\n' +
    '6. List 2-4 open questions that emerged but weren\\'t answered.\\n\\nStructured output only.',
  {
    label: 'synthesize',
    schema: REPORT_SCHEMA,
  },
)

if (!report) {
  return {
    question: QUESTION,
    summary: 'Synthesis step was skipped or failed — returning ' + confirmed.length + ' verified claims unmerged.',
    findings: [],
    confirmed: confirmed.map(c => ({ claim: c.claim, source: c.sourceUrl, quote: c.quote, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes })),
    refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
    sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, claimCount: s.claims.length })),
    stats: { angles: scope.angles.length, sources: allSources.length, claims: allClaims.length, verified: voted.length, confirmed: confirmed.length, killed: killed.length, afterSynthesis: 0 },
  }
}

return {
  question: QUESTION,
  ...report,
  refuted: killed.map(c => ({ claim: c.claim, vote: (c.verdicts.length - c.refutedVotes) + '-' + c.refutedVotes, source: c.sourceUrl })),
  sources: allSources.map(s => ({ url: s.url, quality: s.sourceQuality, angle: s.angle, claimCount: s.claims.length })),
  stats: {
    angles: scope.angles.length,
    sourcesFetched: allSources.length,
    claimsExtracted: allClaims.length,
    claimsVerified: voted.length,
    confirmed: confirmed.length,
    killed: killed.length,
    afterSynthesis: report.findings.length,
    urlDupes: dupes.length,
    budgetDropped: budgetDropped.length,
    agentCalls: 1 + scope.angles.length + allSources.length + (voted.length * VOTES_PER_CLAIM) + 1,
  },
}`

const BUNDLED_WORKFLOWS: WorkflowDefinition[] = [
  workflowFromScript(DEEP_RESEARCH_SCRIPT, 'built-in'),
]

const builtInRegistry = new Map<string, WorkflowDefinition>()
const registeredPluginWorkflows = new Map<string, WorkflowDefinition>()

export function initBundledWorkflows(): void {
  for (const workflow of BUNDLED_WORKFLOWS) {
    builtInRegistry.set(workflow.name, workflow)
  }
}

export async function getWorkflowByName(
  name: string,
  cwd = getCwd(),
): Promise<WorkflowDefinition | undefined> {
  const workflows = await getAllWorkflows(cwd)
  return workflows.find(workflow => workflow.name === name)
}

export async function getAllWorkflows(cwd = getCwd()): Promise<WorkflowDefinition[]> {
  if (builtInRegistry.size === 0) initBundledWorkflows()

  const [pluginWorkflows, customWorkflows] = await Promise.all([
    loadPluginWorkflows(),
    loadCustomWorkflows(cwd),
  ])

  const customNames = new Set(customWorkflows.map(workflow => workflow.name))
  const pluginNames = new Set(pluginWorkflows.map(workflow => workflow.name))

  return [
    ...BUNDLED_WORKFLOWS.filter(
      workflow => !customNames.has(workflow.name) && !pluginNames.has(workflow.name),
    ),
    ...pluginWorkflows.filter(workflow => !customNames.has(workflow.name)),
    ...customWorkflows,
  ]
}

export function getWorkflowByNameSync(name: string): WorkflowDefinition | undefined {
  if (builtInRegistry.size === 0) initBundledWorkflows()
  return builtInRegistry.get(name) ?? registeredPluginWorkflows.get(name)
}

export function registerPluginWorkflow(workflow: WorkflowDefinition): void {
  registeredPluginWorkflows.set(workflow.name, workflow)
}

export async function listWorkflowNames(cwd = getCwd()): Promise<string[]> {
  return (await getAllWorkflows(cwd)).map(workflow => workflow.name)
}

export function clearPluginWorkflowCache(): void {
  registeredPluginWorkflows.clear()
}

async function loadPluginWorkflows(): Promise<WorkflowDefinition[]> {
  const result: WorkflowDefinition[] = [...registeredPluginWorkflows.values()]
  try {
    const { enabled } = await loadAllPluginsCacheOnly()
    for (const plugin of enabled) {
      const dirs = [
        plugin.workflowsPath,
        ...(plugin.workflowsPaths ?? []),
      ].filter((dir): dir is string => Boolean(dir))
      for (const dir of dirs) {
        const workflows = await loadWorkflowPath(dir, 'plugin', plugin.name)
        result.push(...workflows)
      }
    }
  } catch (e: unknown) {
    logError(e)
  }
  return dedupeByName(result)
}

async function loadCustomWorkflows(cwd: string): Promise<WorkflowDefinition[]> {
  const workflows = new Map<string, WorkflowDefinition>()

  if (isSettingSourceEnabled('userSettings')) {
    for (const workflow of await loadWorkflowFilesFromDir(
      join(getClaudeConfigHomeDir(), 'workflows'),
      'userSettings',
    )) {
      workflows.set(workflow.name, workflow)
    }
  }

  if (isSettingSourceEnabled('projectSettings')) {
    const projectDirs = getProjectDirsUpToHome('workflows', cwd).reverse()
    for (const dir of projectDirs) {
      for (const workflow of await loadWorkflowFilesFromDir(dir, 'projectSettings')) {
        workflows.set(workflow.name, workflow)
      }
    }
  }

  return [...workflows.values()]
}

async function loadWorkflowPath(
  path: string,
  source: WorkflowSource,
  pluginName?: string,
): Promise<WorkflowDefinition[]> {
  let pathStat
  try {
    pathStat = await stat(path)
  } catch {
    return []
  }

  if (pathStat.isDirectory()) {
    return loadWorkflowFilesFromDir(path, source, pluginName)
  }
  if (!path.endsWith('.js') || pathStat.size > MAX_SCRIPT_SIZE) {
    return []
  }

  try {
    const script = await readFile(path, 'utf8')
    return [workflowFromScript(script, source, path, pluginName)]
  } catch (e: unknown) {
    logForDebugging(`Failed to load workflow ${path}: ${e}`, { level: 'error' })
    logError(e)
    return []
  }
}

async function loadWorkflowFilesFromDir(
  dir: string,
  source: WorkflowSource,
  pluginName?: string,
): Promise<WorkflowDefinition[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const workflows: WorkflowDefinition[] = []
  for (const entry of entries.filter(name => name.endsWith('.js')).sort()) {
    const filePath = join(dir, entry)
    try {
      const fileStat = await stat(filePath)
      if (fileStat.size > MAX_SCRIPT_SIZE) continue
      const script = await readFile(filePath, 'utf8')
      const workflow = workflowFromScript(script, source, filePath, pluginName)
      workflows.push(workflow)
    } catch (e: unknown) {
      logForDebugging(`Failed to load workflow ${filePath}: ${e}`, { level: 'error' })
      logError(e)
    }
  }
  return workflows
}

function workflowFromScript(
  script: string,
  source: WorkflowSource,
  filePath?: string,
  pluginName?: string,
): WorkflowDefinition {
  const parsed = parseWorkflowMeta(script)
  if (!parsed.ok) {
    throw new Error(`Invalid workflow script${filePath ? ` ${filePath}` : ''}: ${parsed.error}`)
  }
  const { meta } = parsed
  return {
    name: source === 'plugin' && pluginName ? `${pluginName}:${meta.name}` : meta.name,
    script,
    description: meta.description,
    title: meta.title,
    whenToUse: meta.whenToUse,
    phases: meta.phases,
    source,
    filePath,
    pluginName,
  }
}

function dedupeByName(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
  const seen = new Set<string>()
  const result: WorkflowDefinition[] = []
  for (const workflow of workflows) {
    if (seen.has(workflow.name)) continue
    seen.add(workflow.name)
    result.push(workflow)
  }
  return result
}
