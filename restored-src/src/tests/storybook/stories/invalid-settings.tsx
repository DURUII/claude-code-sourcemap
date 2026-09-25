/**
 * `launchInvalidSettingsDialog` — the settings validation failure dialog.
 *
 * No mocks: the component takes its errors as a prop, so the story owns the
 * data entirely. That is the ideal shape for a story and the reason this one is
 * wired first.
 */
import React from 'react';
import type { StoryModule } from './story-types.js';

/**
 * Shaped to match what the app actually passes in. The real call site feeds
 * validation results whose extra fields (`expected`, `invalidValue`,
 * `suggestion`) the dialog renders when present, so leaving them out would show
 * a less informative dialog than users see.
 */
const TWO_ERRORS = [
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
] as never;

export function mocks(): Promise<void> {
  return Promise.resolve();
}

export async function element(variant?: string): Promise<React.ReactNode> {
  const { InvalidSettingsDialog } = await import(
    '../../../components/InvalidSettingsDialog.js'
  );

  const settingsErrors = variant === 'no-errors' ? ([] as never) : TWO_ERRORS;

  return (
    <InvalidSettingsDialog
      settingsErrors={settingsErrors}
      // Both are recorded rather than ignored: the gallery is also how you
      // confirm a dialog's callbacks fire on the right key.
      onContinue={() => console.log('[story] onContinue')}
      onExit={() => console.log('[story] onExit')}
    />
  );
}
