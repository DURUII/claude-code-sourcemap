/**
 * Renders ResumeTask (what launchTeleportResumeWrapper actually paints once a
 * session list arrives) without hitting the sessions API.
 */
import { mock } from 'bun:test';
import React from 'react';
import { enableConfigs } from '../../utils/config.js';

enableConfigs();

/** SB_COLOR=1 keeps ANSI SGR so the frame prints in the real theme colours. */
const COLOR = process.env.SB_COLOR === '1';

const SESSIONS = [
  {
    id: 'sess_01',
    title: 'Fix flaky TokenBucket test',
    description: 'test flake',
    status: 'idle',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 60e3).toISOString(),
  },
  {
    id: 'sess_02',
    title: 'Add teleport retry backoff',
    description: 'retry',
    status: 'working',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 3 * 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 3600e3).toISOString(),
  },
  {
    id: 'sess_03',
    title: 'Investigate session GC leak',
    description: 'gc',
    status: 'completed',
    repo: { name: 'claude-code', owner: { login: 'anthropics' } },
    turns: [],
    created_at: new Date(Date.now() - 7 * 86400e3).toISOString(),
    updated_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
  },
];

// Replace only the network call; keep every other export this module has.
const api = await import('src/utils/teleport/api.js');
mock.module('src/utils/teleport/api.js', () => ({
  ...api,
  fetchCodeSessionsFromSessionsAPI: async () => SESSIONS,
}));
const repo = await import('src/utils/detectRepository.js');
mock.module('src/utils/detectRepository.js', () => ({
  ...repo,
  detectCurrentRepository: async () => 'anthropics/claude-code',
}));
// TeleportError preflights login + a clean worktree and short-circuits to
// TeleportStash when the repo is dirty. Force both to pass.
const preconditions = await import('src/utils/background/remote/preconditions.js');
mock.module('src/utils/background/remote/preconditions.js', () => ({
  ...preconditions,
  checkNeedsClaudeAiLogin: async () => false,
  checkIsGitClean: async () => true,
}));

const { ResumeTask } = await import('../../components/ResumeTask.js');
const { plain, snapshot } = await import('./harness.js');

const frame = await snapshot(
  <ResumeTask onSelect={() => {}} onCancel={() => {}} />,
  { columns: 96, settleMs: 600, tty: false },
);
console.log(plain(frame, { keepColor: COLOR }));
process.exit(0);
