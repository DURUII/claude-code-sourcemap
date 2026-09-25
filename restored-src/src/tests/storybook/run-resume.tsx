/** Renders ResumeConversation (the `launchResumeChooser` screen). Reads local logs only. */
import React from 'react';
import { enableConfigs } from '../../utils/config.js';
import { ResumeConversation } from '../../screens/ResumeConversation.js';
import { plain, snapshot } from './harness.js';

enableConfigs();

/** SB_COLOR=1 keeps ANSI SGR so the frame prints in the real theme colours. */
const COLOR = process.env.SB_COLOR === '1';

const frame = await snapshot(
  <ResumeConversation
    commands={[]}
    worktreePaths={[]}
    initialTools={[]}
    debug={false}
    thinkingConfig={{} as never}
  />,
  { columns: 110, settleMs: 5000, tty: false },
);
console.log(plain(frame, { keepColor: COLOR }));
process.exit(0);
