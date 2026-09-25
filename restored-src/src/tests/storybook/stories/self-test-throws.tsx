/**
 * A story that deliberately fails, so the gallery's crash isolation is testable
 * rather than assumed.
 *
 * It exists for the same reason the harness keeps its DA1 reply: the behaviour
 * that matters is what happens to everything *else* when one story breaks, and
 * that cannot be checked with a story that works.
 */
import React from 'react';
import type { StoryModule } from './story-types.js';

export async function element(): Promise<React.ReactNode> {
  // Thrown before anything mounts, which is the nastier of the two failure
  // modes: a mount-time throw happens inside React's commit and is easy to
  // swallow, whereas this one has to reach the protocol handler.
  throw new Error('self-test-throws is supposed to fail; if you are reading this in the UI, isolation works');
}
