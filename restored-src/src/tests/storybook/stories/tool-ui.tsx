/**
 * A visual inventory of the actual Tool UI callbacks. The sample values below
 * are display fixtures: this story never calls a tool or reads a user file.
 */
import React from 'react';
import { z } from 'zod/v4';
import { Box, Text } from '../../../ink.js';
import type { StoryModule } from './story-types.js';

type ToolView = Record<string, any>;
type Schema = Record<string, any>;

const INPUTS: Record<string, Record<string, unknown>> = {
  Agent: { description: 'Inspect parser', prompt: 'Find the parser entry point', subagent_type: 'Explore' },
  TaskOutput: { task_id: 'task_123', block: false },
  Bash: { command: 'bun test', description: 'Run tests' },
  Glob: { pattern: '**/*.ts', path: '/project' },
  Grep: { pattern: 'runToolUse', path: '/project/src', output_mode: 'content' },
  ExitPlanMode: { plan: 'Implement the change' },
  Read: { file_path: '/project/src/main.tsx', offset: 10, limit: 20 },
  Edit: { file_path: '/project/src/main.tsx', old_string: 'before', new_string: 'after' },
  Write: { file_path: '/project/src/example.ts', content: 'export const answer = 42\n' },
  NotebookEdit: { notebook_path: '/project/example.ipynb', new_source: 'print(42)', cell_id: 'cell-1' },
  WebFetch: { url: 'https://example.com/docs', prompt: 'Summarize this page' },
  TodoWrite: { todos: [{ content: 'Read the source', status: 'completed', activeForm: 'Reading the source' }] },
  WebSearch: { query: 'TypeScript async generator' },
  TaskStop: { task_id: 'task_123' },
  AskUserQuestion: { questions: [{ question: 'Which option?', header: 'Choice', options: [{ label: 'A', description: 'First option' }], multiSelect: false }] },
  Skill: { skill: 'review' },
  EnterPlanMode: {},
  EnterWorktree: { name: 'example' },
  ExitWorktree: {},
  SendMessage: { to: 'teammate', message: 'Please review this file' },
  SendUserMessage: { message: 'I am working on the request.' },
  ListMcpResourcesTool: {},
  ReadMcpResourceTool: { server: 'demo', uri: 'demo://resource' },
};

const OUTPUTS: Record<string, unknown> = {
  Read: { type: 'text', file: { filePath: '/project/src/main.tsx', content: 'const x = 1\n', numLines: 1, startLine: 10, totalLines: 60 } },
  Edit: {
    filePath: '/project/src/main.tsx', oldString: 'before', newString: 'after',
    originalFile: 'before\n', userModified: false, replaceAll: false,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-before', '+after'] }],
  },
  Write: {
    type: 'create', filePath: '/project/src/example.ts', content: 'export const answer = 42\n',
    structuredPatch: [], originalFile: null,
  },
  TaskStop: { message: 'Task stopped', task_id: 'task_123', task_type: 'shell' },
  WebFetch: { bytes: 1200, code: 200, codeText: 'OK', result: 'Example summary', durationMs: 85, url: 'https://example.com/docs' },
};

const PROGRESS: Record<string, Record<string, unknown>> = {
  Bash: { fullOutput: 'Running tests…', output: 'Running tests…', elapsedTimeSeconds: 2, totalLines: 1, totalBytes: 16, timeoutMs: 120000 },
  WebSearch: { type: 'query_update', query: 'TypeScript async generator' },
  WebFetch: { type: 'progress', message: 'Fetching example.com' },
};

function sampleString(key: string): string {
  if (/url/i.test(key)) return 'https://example.com/docs';
  if (/path|file/i.test(key)) return '/project/src/example.ts';
  if (/command/i.test(key)) return 'bun test';
  if (/pattern|query/i.test(key)) return 'example';
  if (/status/i.test(key)) return 'completed';
  if (/id/i.test(key)) return 'task_123';
  return 'Example';
}

function fromSchema(schema: Schema, key = '', root: Schema = schema, depth = 0): unknown {
  if (depth > 7) return null;
  if ('$ref' in schema) {
    const ref = String(schema.$ref).split('/').slice(1);
    let resolved: any = root;
    for (const part of ref) resolved = resolved?.[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    return resolved ? fromSchema(resolved, key, root, depth + 1) : null;
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return fromSchema(schema.anyOf[0], key, root, depth + 1);
  if (Array.isArray(schema.oneOf)) return fromSchema(schema.oneOf[0], key, root, depth + 1);
  if (Array.isArray(schema.allOf)) return fromSchema(schema.allOf[0], key, root, depth + 1);
  if (schema.type === 'array') return schema.items ? [fromSchema(schema.items, key, root, depth + 1)] : [];
  if (schema.type === 'object' || schema.properties) {
    const value: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      value[name] = fromSchema(child as Schema, name, root, depth + 1);
    }
    return value;
  }
  if (schema.type === 'number' || schema.type === 'integer') return 1;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'null') return null;
  return sampleString(key);
}

function sampleOutput(tool: ToolView): unknown {
  if (tool.name in OUTPUTS) return OUTPUTS[tool.name];
  try {
    if (tool.outputSchema) return fromSchema(z.toJSONSchema(tool.outputSchema));
  } catch {
    // Some tool schemas cannot be converted to JSON Schema. Show the absence.
  }
  return undefined;
}

class RenderBoundary extends React.Component<{ children: React.ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() { return this.state.error ? <Text color="red">Renderer error: {this.state.error}</Text> : this.props.children; }
}

function Section({ label, render }: { label: string; render: () => React.ReactNode }) {
  let content: React.ReactNode;
  try { content = render(); }
  catch (error) { content = <Text color="red">Renderer error: {String(error)}</Text>; }
  const empty = content === null || content === undefined || content === '';
  if (typeof content === 'string' || typeof content === 'number') content = <Text>{content}</Text>;
  return <Box flexDirection="column" marginBottom={1}>
    <Text bold color="cyan">{label}</Text>
    <RenderBoundary>{empty ? <Text dimColor>(renders nothing)</Text> : content}</RenderBoundary>
  </Box>;
}

function ToolGallery({ tool, inputOverride, outputOverride }: { tool: ToolView; inputOverride?: Record<string, unknown>; outputOverride?: unknown }) {
  const input = inputOverride ?? INPUTS[tool.name] ?? {};
  const output = outputOverride ?? sampleOutput(tool);
  const options = { theme: 'dark', verbose: false, tools: [tool], isTranscriptMode: false };
  const progress = [{ type: 'progress', toolUseID: 'toolu_story', data: PROGRESS[tool.name] ?? { type: 'progress', message: 'Working…', content: 'Working…' } }];
  const sections: Array<[string, (() => React.ReactNode) | undefined]> = [
    ['renderToolUseMessage(input)', () => tool.renderToolUseMessage(input, options)],
    ['renderToolUseTag(input)', tool.renderToolUseTag && (() => tool.renderToolUseTag(input))],
    ['renderToolUseQueuedMessage()', tool.renderToolUseQueuedMessage && (() => tool.renderToolUseQueuedMessage())],
    ['renderToolUseProgressMessage(progress)', tool.renderToolUseProgressMessage && (() => tool.renderToolUseProgressMessage(progress, options))],
    ['renderToolResultMessage(output)', tool.renderToolResultMessage && output !== undefined && (() => tool.renderToolResultMessage(output, progress, { ...options, input }))],
    ['renderToolUseRejectedMessage(input)', tool.renderToolUseRejectedMessage && (() => tool.renderToolUseRejectedMessage(input, { ...options, columns: 110, messages: [], progressMessagesForMessage: progress }))],
    ['renderToolUseErrorMessage(error)', tool.renderToolUseErrorMessage && (() => tool.renderToolUseErrorMessage('<tool_use_error>Example failure</tool_use_error>', { ...options, progressMessagesForMessage: progress }))],
    ['renderGroupedToolUse(...)', tool.renderGroupedToolUse && (() => tool.renderGroupedToolUse([{ param: { type: 'tool_use', id: 'toolu_story', name: tool.name, input }, isResolved: true, isError: false, isInProgress: false, progressMessages: progress, result: { param: { type: 'tool_result', tool_use_id: 'toolu_story', content: 'Example' }, output } }], { shouldAnimate: false, tools: [tool] }))],
  ];
  return <Box flexDirection="column" paddingX={1}>
    <Text bold>{tool.name} — tool UI callback gallery</Text>
    <Text dimColor>Sample only. No tool call, file read, network request, or permission prompt.</Text>
    <Text dimColor>Only callbacks implemented by this tool appear below; absent callbacks may render nothing or use a fallback.</Text>
    <Text dimColor>input: {JSON.stringify(input)}</Text>
    <Text dimColor>output fixture: {output === undefined ? 'unavailable' : outputOverride !== undefined || tool.name in OUTPUTS ? 'handwritten example' : 'generated from outputSchema'}</Text>
    <Box marginTop={1} flexDirection="column">
      <Section label="userFacingName(input)" render={() => <Text>{tool.userFacingName(input)}</Text>} />
      {tool.getToolUseSummary && <Section label="getToolUseSummary(input)" render={() => <Text>{tool.getToolUseSummary(input) ?? '(null)'}</Text>} />}
      {tool.getActivityDescription && <Section label="getActivityDescription(input)" render={() => <Text>{tool.getActivityDescription(input) ?? '(null)'}</Text>} />}
      {sections.map(([label, render]) => render && <Section key={label} label={label} render={render} />)}
    </Box>
  </Box>;
}

export async function element(name?: string): Promise<React.ReactNode> {
  const { getAllBaseTools } = await import('../../../tools.js');
  const [toolName, variant] = (name ?? '').split(':');
  const tool = getAllBaseTools().find(t => t.name === toolName);
  if (!tool) return <Text color="yellow">{name} is unavailable in this build.</Text>;
  if (toolName === 'Read' && variant === 'agent-output') {
    const { getTaskOutputDir } = await import('../../../utils/task/diskOutput.js');
    return <ToolGallery tool={tool} inputOverride={{ file_path: `${getTaskOutputDir()}/task123.output` }} />;
  }
  if (toolName === 'Read' && variant === 'image') {
    return <ToolGallery tool={tool} inputOverride={{ file_path: '/project/screenshot.png' }} outputOverride={{ type: 'image', file: { filePath: '/project/screenshot.png', base64: '', type: 'image/png', originalSize: 1024 } }} />;
  }
  if (toolName === 'Read' && variant === 'pdf') {
    return <ToolGallery tool={tool} inputOverride={{ file_path: '/project/report.pdf', pages: '1-2' }} outputOverride={{ type: 'pdf', file: { filePath: '/project/report.pdf', base64: '', originalSize: 4096 } }} />;
  }
  if (toolName === 'Read' && variant === 'unchanged') {
    return <ToolGallery tool={tool} outputOverride={{ type: 'file_unchanged', file: { filePath: '/project/src/main.tsx' } }} />;
  }
  return <ToolGallery tool={tool} />;
}

export const mocks: StoryModule['mocks'] = async () => {};
