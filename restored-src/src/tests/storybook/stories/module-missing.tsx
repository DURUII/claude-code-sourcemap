/**
 * The card shown for a story whose component was never recovered.
 *
 * Three of the seven launchers in `src/dialogLaunchers.tsx` import modules that
 * do not exist in restored-src. The gallery could have omitted them, but an
 * absent module is a finding, not an absence of one: it says where the
 * extraction stopped. So the entry stays in the manifest and renders this
 * instead, naming the path that is missing and the exports it owes.
 *
 * The argument is the missing path, which is what the worker passes for an entry
 * with no `variant` (`element(meta.variant ?? meta.missingPath)`). The rest of
 * the entry, including the export list, is looked up from the manifest, so no
 * detail is repeated here and the card cannot disagree with the data.
 */
import React from 'react';
import type { StoryModule } from './story-types.js';
import { STORIES } from './manifest.js';

export async function element(missingPath?: string): Promise<React.ReactNode> {
  const [{ Box, Text }, { Dialog }] = await Promise.all([
    import('../../../ink.js'),
    import('../../../components/design-system/Dialog.js'),
  ]);

  const meta = STORIES.find(s => s.missingPath === missingPath);
  if (!meta) {
    // Reached only if the manifest and the worker disagree about what to pass,
    // which would be a bug in this gallery rather than a gap in the restoration.
    throw new Error(
      `module-missing was asked for ${JSON.stringify(missingPath)}, which matches no ` +
        'manifest entry. Check the worker\'s element() argument.',
    );
  }

  return (
    <Dialog
      title="Module not restored"
      color="warning"
      // Escape reaches this, so the card is also a live check that keys are
      // being forwarded at all.
      onCancel={() => console.log('[story] onCancel')}
      // Dialog's default guide offers "Enter to confirm", which this card has
      // nothing to confirm. Suppressing it is more honest than showing a key
      // that does nothing.
      hideInputGuide
    >
      <Box flexDirection="column">
        <Text>
          {meta.launcher} needs <Text bold>{meta.missingPath}</Text>
        </Text>
        <Text dimColor>to export {meta.missingExports?.join(', ') ?? '(unknown)'}</Text>
        <Box marginTop={1}>
          <Text>{meta.description}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Restoring that file turns this card into the real dialog; nothing else in the
            gallery needs to change.
          </Text>
        </Box>
      </Box>
    </Dialog>
  );
}
