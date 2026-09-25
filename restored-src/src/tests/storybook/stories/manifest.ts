/**
 * The story list, as pure data.
 *
 * This file is deliberately free of React, Ink and component imports, because
 * the HTTP server imports it to answer "what stories exist". If the server
 * loaded the story modules instead, it would pull React and Ink into its own
 * process and, worse, trigger config reads there, which would make the server
 * sensitive to the real `~/.claude` for no reason.
 *
 * Behaviour lives in `stories/<module>.tsx`, which the worker imports by name.
 * Every entry names the launcher it covers so the gallery stays traceable back
 * to `src/dialogLaunchers.tsx`.
 */

/** How a story's screen is produced. */
export type StoryMeta = {
  /** Stable id. Also the worker's argv and the URL fragment. */
  name: string;
  title: string;
  description: string;
  /** Picker group, e.g. "Settings". */
  group: string;
  /**
   * The launcher in src/dialogLaunchers.tsx this story is *about*.
   *
   * A story mounts that launcher's target component directly and supplies its
   * own props; no story calls the launcher. That is a real limitation, not a
   * detail: the launcher's own wiring (which props it passes, in what shape, and
   * what state it reads) is not exercised here, so a defect in
   * `src/dialogLaunchers.tsx` itself would not show up in the gallery. What the
   * gallery does show is the component the app ends up rendering, at the props
   * the story chose. For the three launchers that pass only a couple of props and
   * have a component to render (`launchInvalidSettingsDialog`,
   * `launchTeleportRepoMismatchDialog`, `launchTeleportResumeWrapper`) those
   * choices mirror the call site. A fourth, `launchSnapshotUpdateDialog`, also
   * takes three props, but its component is absent from this extraction, so there
   * is no story in which to mirror them; it appears below as a missing-module
   * card. For `launchResumeChooser`, which passes all of ResumeConversation's
   * props, the story supplies the five required ones and leaves the other
   * thirteen optional ones at their defaults. Those five are what the component
   * destructures for its first screen; the optional thirteen cover flags the
   * CLI only sets when asked (search, PR filter, MCP clients, forking), so the
   * default screen should match, but that is reasoning rather than a check.
   */
  launcher: string;
  columns: number;
  rows: number;
  /** Module under stories/ implementing this story. */
  module: string;
  /**
   * Passed to the module's `element(variant)`. Lets one module serve several
   * entries (a dialog with two error counts, say) without duplicating it.
   */
  variant?: string;
  /**
   * Set when the story cannot render because a module it needs is absent from
   * this restoration. The gallery shows a card naming the path instead of
   * hiding the gap, which is what RESTORATION.md:303-307 asks for: a missing
   * internal module is evidence, and the failure should stay readable.
   */
  missingPath?: string;
  /**
   * The named exports `missingPath` has to provide for its launcher to work,
   * read off the launcher's destructuring in `src/dialogLaunchers.tsx`. Named
   * here rather than in the card so the gap is described next to the path it
   * belongs to, and so anyone implementing the file knows the contract.
   */
  missingExports?: string[];
  /**
   * True for a story that is *supposed* to fail to mount.
   *
   * Declared here rather than special-cased by name in the checker, so the
   * negative control is described by the same data that describes every other
   * story. Without it, a checker has no way to tell "this story is broken" from
   * "this story is the proof that broken stories are contained".
   */
  expectFailure?: boolean;
};

export const STORIES: StoryMeta[] = [
  {
    name: 'invalid-settings',
    title: 'Invalid Settings (2 errors)',
    description:
      'What you get when settings.json fails validation and the app has to ask whether to continue.',
    group: 'Settings',
    launcher: 'launchInvalidSettingsDialog',
    columns: 90,
    rows: 24,
    module: 'invalid-settings',
    variant: 'two-errors',
  },
  {
    name: 'invalid-settings-clean',
    title: 'Invalid Settings (0 errors)',
    description:
      'The same dialog with an empty error list. Reachable in the app only through a race, so worth looking at.',
    group: 'Settings',
    launcher: 'launchInvalidSettingsDialog',
    columns: 90,
    rows: 24,
    module: 'invalid-settings',
    variant: 'no-errors',
  },
  // ---------------------------------------------------------------------------
  // Teleport resume. The launcher is launchTeleportResumeWrapper; the three
  // modules below it (ResumeTask, TeleportError, TeleportStash) are mounted
  // directly for the states the wrapper's own flow cannot be parked in.
  // ---------------------------------------------------------------------------
  {
    name: 'resume-task',
    title: 'Resume Task: session list',
    description:
      'The session picker, three sessions in the detected repo. This is what the teleport launcher paints once the precondition gate passes.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'sessions',
  },
  {
    name: 'resume-task-empty',
    title: 'Resume Task: no sessions',
    description:
      'The API returned nothing at all. Byte-identical to the next entry, which is the point: the empty branch only knows the count, so "you have no sessions" and "your sessions are all in another repo" are the same screen.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'empty',
  },
  {
    name: 'resume-task-other-repo',
    title: 'Resume Task: sessions, none for this repo',
    description:
      'The API returned three sessions and the repo filter removed all of them, so the header still names the repo. The screen you get from working in an unfamiliar checkout.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'other-repo',
  },
  {
    name: 'resume-task-no-repo',
    title: 'Resume Task: no repo detected',
    description:
      'Repository detection found nothing, so there is no filter and every session shows, including ones from other projects.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'no-repo',
  },
  {
    name: 'resume-task-error-network',
    title: 'Resume Task: network error',
    description:
      'One of the four error branches, keyed off the thrown message. This one says to check the connection. Ctrl+R retries, Enter leaves the flow.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'error-network',
  },
  {
    name: 'resume-task-error-auth',
    title: 'Resume Task: auth error',
    description:
      'The auth branch, the only one that names a command to run. Worth seeing because teleport requires an account even when the CLI works fine without one.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'error-auth',
  },
  {
    name: 'resume-task-error-api',
    title: 'Resume Task: API error',
    description: 'The rate-limit and 5xx branch. Shortest of the four.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'error-api',
  },
  {
    name: 'resume-task-error-other',
    title: 'Resume Task: unclassified error',
    description:
      'What the other three fall through to when the message matches nothing. The catch-all is the one most likely to be seen in practice.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'resume-task',
    variant: 'error-other',
  },
  {
    name: 'teleport-resume',
    title: 'Teleport Wrapper: session list',
    description:
      'The launcher target itself, wrapping the picker above. Differs from the resume-task entries by owning the two post-selection screens.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'teleport-resume',
    variant: 'list',
  },
  {
    name: 'teleport-resume-resuming',
    title: 'Teleport Wrapper: resuming',
    description:
      'Press Enter on a session and the resume never completes. The title you picked appears under the spinner.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'teleport-resume',
    variant: 'resuming',
  },
  {
    name: 'teleport-resume-error',
    title: 'Teleport Wrapper: resume failed',
    description:
      'Press Enter on a session and the resume throws. The list is replaced rather than returned to; Esc cancels from here.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 100,
    rows: 20,
    module: 'teleport-resume',
    variant: 'error',
  },
  {
    name: 'teleport-error-login',
    title: 'Teleport Gate: login required',
    description:
      'ResumeTask mounts this before it loads anything. Escape here calls gracefulShutdownSync, so the worker really exits; Restart brings it back. The first option starts a real OAuth flow.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-error',
    variant: 'login',
  },
  {
    name: 'teleport-error-stash',
    title: 'Teleport Gate: dirty worktree',
    description:
      'The same gate with a dirty worktree, which hands off to the stash prompt below. This is the route the app actually takes to reach it.',
    group: 'Teleport resume',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-error',
    variant: 'stash',
  },

  // ---------------------------------------------------------------------------
  // The stash prompt. Not a launcher target: TeleportError mounts it. Every
  // variant is a mock, because the component draws from git status.
  // ---------------------------------------------------------------------------
  {
    name: 'teleport-stash-files',
    title: 'Stash: four changed files',
    description: 'Changed files listed one per line, which is what happens up to eight of them.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'files',
  },
  {
    name: 'teleport-stash-many',
    title: 'Stash: twelve changed files',
    description:
      'Past eight files the list collapses to a count. The threshold is hardcoded, not a setting.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'many',
  },
  {
    name: 'teleport-stash-clean',
    title: 'Stash: nothing changed',
    description:
      'A clean tree reaching a prompt that assumes otherwise. Reachable only if git goes clean between the precondition check and this read.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'clean',
  },
  {
    name: 'teleport-stash-loading',
    title: 'Stash: reading git status',
    description:
      'The first thing shown, usually for a few milliseconds. Held open here by a status read that never returns.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'loading',
  },
  {
    name: 'teleport-stash-error-files',
    title: 'Stash: git status failed',
    description:
      'What a non-git directory produces. Only two lines survive and neither offers to stash anything.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'error-files',
  },
  {
    name: 'teleport-stash-stashing',
    title: 'Stash: stashing in progress',
    description:
      'Press Enter on the first option with the stash never completing. The options are replaced by the spinner.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'stashing',
  },
  {
    name: 'teleport-stash-error-stash',
    title: 'Stash: stash failed',
    description:
      'Press Enter on the first option and the stash reports failure. Note that the file list is gone: this screen replaces the prompt.',
    group: 'Teleport stash',
    launcher: 'launchTeleportResumeWrapper',
    columns: 90,
    rows: 24,
    module: 'teleport-stash',
    variant: 'error-stash',
  },

  // ---------------------------------------------------------------------------
  // Repo mismatch. Two variants are visible immediately; the other two need a
  // keypress, because the dialog validates the chosen path before deciding.
  // ---------------------------------------------------------------------------
  {
    name: 'teleport-repo-mismatch',
    title: 'Repo Mismatch: two known paths',
    description:
      'Pick a local checkout of the target repo. The paths are shown through getDisplayPath, so the home directory is rewritten to a tilde.',
    group: 'Teleport repo mismatch',
    launcher: 'launchTeleportRepoMismatchDialog',
    columns: 90,
    rows: 24,
    module: 'teleport-repo-mismatch',
    variant: 'paths',
  },
  {
    name: 'teleport-repo-mismatch-none',
    title: 'Repo Mismatch: no known paths',
    description:
      'No checkouts to offer, so the dialog can only tell you to run claude --teleport from the right repo.',
    group: 'Teleport repo mismatch',
    launcher: 'launchTeleportRepoMismatchDialog',
    columns: 90,
    rows: 24,
    module: 'teleport-repo-mismatch',
    variant: 'none',
  },
  {
    name: 'teleport-repo-mismatch-validating',
    title: 'Repo Mismatch: validating',
    description:
      'Press Enter on a path and the check never settles, so the spinner stays. Only exists while a validation is in flight.',
    group: 'Teleport repo mismatch',
    launcher: 'launchTeleportRepoMismatchDialog',
    columns: 90,
    rows: 24,
    module: 'teleport-repo-mismatch',
    variant: 'validating',
  },
  {
    name: 'teleport-repo-mismatch-invalid',
    title: 'Repo Mismatch: path no longer valid',
    description:
      'Press Enter on a path and validation fails, so the path is dropped from the list and an error appears above the remaining ones.',
    group: 'Teleport repo mismatch',
    launcher: 'launchTeleportRepoMismatchDialog',
    columns: 90,
    rows: 24,
    module: 'teleport-repo-mismatch',
    variant: 'invalid-path',
  },

  // ---------------------------------------------------------------------------
  // Resume chooser. A different screen from the teleport picker: this one reads
  // local session logs rather than asking a server. Note there is no error
  // variant, because the component has no error screen; see the story module.
  // ---------------------------------------------------------------------------
  {
    name: 'resume-conversation',
    title: 'Resume Conversation: log list',
    description:
      'The local conversation picker, five logs including a pair that share a session id, which is what draws the group node.',
    group: 'Resume conversation',
    launcher: 'launchResumeChooser',
    columns: 110,
    rows: 40,
    module: 'resume-conversation',
    variant: 'list',
  },
  {
    name: 'resume-conversation-one',
    title: 'Resume Conversation: one log',
    description:
      'The smallest list that is not the empty state. Useful for seeing the header and footer without scrolling.',
    group: 'Resume conversation',
    launcher: 'launchResumeChooser',
    columns: 110,
    rows: 40,
    module: 'resume-conversation',
    variant: 'one',
  },
  {
    name: 'resume-conversation-empty',
    title: 'Resume Conversation: no logs',
    description:
      'No conversations found. Also exactly what a failed read looks like, since the loader swallows the error and leaves the list as it started.',
    group: 'Resume conversation',
    launcher: 'launchResumeChooser',
    columns: 110,
    rows: 40,
    module: 'resume-conversation',
    variant: 'empty',
  },
  {
    name: 'resume-conversation-sidechains',
    title: 'Resume Conversation: only sidechains',
    description:
      'Every log is a sidechain, so the filter empties the list before the count is taken. An abundant result that still says none were found.',
    group: 'Resume conversation',
    launcher: 'launchResumeChooser',
    columns: 110,
    rows: 40,
    module: 'resume-conversation',
    variant: 'sidechains',
  },
  {
    name: 'resume-conversation-loading',
    title: 'Resume Conversation: loading',
    description:
      'The first paint, held open by a loader that never returns. This is the screen you see while the JSONL files are read.',
    group: 'Resume conversation',
    launcher: 'launchResumeChooser',
    columns: 110,
    rows: 40,
    module: 'resume-conversation',
    variant: 'loading',
  },

  {
    name: 'self-test-throws',
    title: 'Self-test: story that throws',
    description:
      'Deliberately fails on mount. Exists so the gallery can prove that one broken story does not take down the others or the server.',
    group: 'Self-test',
    launcher: '(none)',
    columns: 60,
    rows: 10,
    module: 'self-test-throws',
    expectFailure: true,
  },

  // The three launchers with no renderable target. Their components were never
  // recovered into restored-src, so instead of omitting them the gallery renders
  // a card naming the absent path. RESTORATION.md:303-307 asks for exactly this:
  // a missing internal module is evidence, and its failure should stay readable.
  // The card is a story like any other, so it goes through the worker and cannot
  // drift from the rest of the gallery.
  {
    name: 'missing-snapshot-update',
    title: 'SnapshotUpdateDialog (module absent)',
    description:
      'Agent-memory snapshot update prompt. The launcher and its wiring survive in dialogLaunchers.tsx; the component does not.',
    group: 'Absent modules',
    launcher: 'launchSnapshotUpdateDialog',
    columns: 90,
    rows: 24,
    module: 'module-missing',
    missingPath: 'src/components/agents/SnapshotUpdateDialog.tsx',
    missingExports: ['SnapshotUpdateDialog'],
  },
  {
    name: 'missing-assistant-session-chooser',
    title: 'AssistantSessionChooser (module absent)',
    description:
      'Picker for a bridge session to attach to. The launcher survives; the component does not.',
    group: 'Absent modules',
    launcher: 'launchAssistantSessionChooser',
    columns: 90,
    rows: 24,
    module: 'module-missing',
    missingPath: 'src/assistant/AssistantSessionChooser.tsx',
    missingExports: ['AssistantSessionChooser'],
  },
  {
    name: 'missing-assistant-install-wizard',
    title: 'NewInstallWizard (module absent)',
    description:
      'Install wizard shown when `claude assistant` finds no sessions. The launcher survives; the component does not.',
    group: 'Absent modules',
    launcher: 'launchAssistantInstallWizard',
    columns: 90,
    rows: 24,
    module: 'module-missing',
    missingPath: 'src/commands/assistant/assistant.ts',
    missingExports: ['NewInstallWizard', 'computeDefaultInstallDir'],
  },
];

/** Look up a story by its stable name. */
export function findStory(name: string): StoryMeta | undefined {
  return STORIES.find(s => s.name === name);
}
