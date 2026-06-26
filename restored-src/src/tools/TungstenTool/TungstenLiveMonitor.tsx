/**
 * Restoration stub.
 *
 * The live Tungsten panel depends on the unrecovered Tungsten tmux tool. The
 * primary CLI can render without it, so the local restored runtime exposes a
 * no-op component instead of pretending terminal monitoring works.
 */

import React from 'react'

export function TungstenLiveMonitor(): React.JSX.Element | null {
  return null
}
