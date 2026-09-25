/**
 * The contract a story module implements.
 *
 * Two functions rather than one because of a hard ordering rule: `mock.module`
 * from bun:test is process-global and only affects modules imported *after* it
 * runs. So `mocks()` must complete before anything pulls in the component
 * under test, which is why `element()` is where components get imported, and
 * why a story module must not import its component at the top level.
 */
import type { ReactNode } from 'react';

export type StoryModule = {
  /**
   * Replace network calls, repository probes and the like with fixed values.
   *
   * Must spread the real module over the stub (`{...real, fn: stub}`); replacing
   * a module wholesale breaks every other export its consumers rely on. See
   * run-teleport.tsx for a worked example of the three mocks ResumeTask needs.
   *
   * `variant` is the same value `element()` receives, and is needed whenever a
   * component's *data* decides which state it renders rather than its props.
   * TeleportStash is the clear case: `getFileStatus` returning a file list, an
   * empty list, or throwing are three different screens, and a story cannot
   * choose between them from props alone. A worker mounts exactly one story and
   * mocks take effect at import time, so the choice has to be made here.
   */
  mocks?: (variant?: string) => Promise<void>;

  /**
   * Build the element to mount. Import components here, not at module scope.
   *
   * `variant` comes from the manifest entry, so one module can serve several
   * entries that differ only in their props.
   */
  element: (variant?: string) => Promise<ReactNode>;
};
