/**
 * Renders the dialogLaunchers.tsx JSX sites to text, so you can see what each
 * one actually looks like without triggering the real flows in the CLI.
 *
 *   bun run src/tests/storybook/run.tsx [name]
 */
import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { InvalidSettingsDialog } from '../../components/InvalidSettingsDialog.js';
import { TeleportRepoMismatchDialog } from '../../components/TeleportRepoMismatchDialog.js';
import { plain, snapshot } from './harness.js';

enableConfigs();

/** SB_COLOR=1 keeps ANSI SGR so the frame prints in the real theme colours. */
const COLOR = process.env.SB_COLOR === '1';

const VARIANTS: Array<[string, React.ReactNode]> = [
  [
    'launchInvalidSettingsDialog',
    <InvalidSettingsDialog
      settingsErrors={
        [
          {
            file: '~/.claude/settings.json',
            path: 'permissions.defaultMode',
            message: 'Invalid enum value',
            expected: "'default' | 'acceptEdits' | 'plan'",
            invalidValue: 'yolo',
            suggestion: "Did you mean 'acceptEdits'?",
          },
          {
            file: '.claude/settings.local.json',
            path: 'env.OPENAI_API_KEY',
            message: 'Expected string, received number',
            invalidValue: 12345,
          },
        ] as never
      }
      onContinue={() => {}}
      onExit={() => {}}
    />,
  ],
  [
    'launchTeleportRepoMismatchDialog (paths found)',
    <TeleportRepoMismatchDialog
      targetRepo="anthropics/claude-code"
      initialPaths={['/Users/durui/code/claude-code', '/Users/durui/code/cc-fork']}
      onSelectPath={() => {}}
      onCancel={() => {}}
    />,
  ],
  [
    'launchTeleportRepoMismatchDialog (no paths)',
    <TeleportRepoMismatchDialog
      targetRepo="anthropics/claude-code"
      initialPaths={[]}
      onSelectPath={() => {}}
      onCancel={() => {}}
    />,
  ],
];

const filter = process.argv[2];
for (const [name, node] of VARIANTS) {
  if (filter && !name.includes(filter)) continue;
  const frame = await snapshot(node, { columns: 96, settleMs: 300, tty: false });
  console.log(`\n=== ${name} ===`);
  console.log(plain(frame, { keepColor: COLOR }));
}
process.exit(0);
