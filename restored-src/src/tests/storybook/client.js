/**
 * The gallery client: render a frame payload as a terminal screen, and turn DOM
 * key events into the bytes a terminal would send.
 *
 * Deliberately dependency-free and unbundled — the server serves this file
 * straight off disk, so it has to run as-is in a browser. That is also why it is
 * `.js` and not `.tsx`: nothing here needs a build step, and adding one would put
 * a toolchain between the story's paint and the pixels.
 *
 * The two halves are independent on purpose:
 *
 *   renderFrame   payload -> absolutely positioned runs on a monospace grid
 *   keyToBytes    key event -> the byte sequence a terminal would emit
 *
 * The second is imported from `keys.ts` rather than defined here, because it is
 * the half a probe can check against the real input parser; see that file.
 * `frame-payload.ts` defines the payload and `worker.tsx` the message set, so
 * all three sides of this come from the code they describe.
 */
import { keyToBytes } from '/keys.js';
import { layoutRows } from '/frame-layout.js';

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const railEl = document.getElementById('stories');
const titleEl = document.getElementById('title');
const descEl = document.getElementById('desc');
const gridEl = document.getElementById('grid');
const screenEl = document.getElementById('screen');
const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const logEl = document.getElementById('logwrap');
const logEmptyEl = document.getElementById('log-empty');
const bannerEl = document.getElementById('banner');
const bannerTextEl = document.getElementById('banner-text');

const restartBtn = document.getElementById('restart');
const repaintBtn = document.getElementById('repaint');
const reconnectBtn = document.getElementById('reconnect');

/**
 * How long to wait after the window stops resizing before telling the worker its
 * new size. Shorter would send a resize per animation frame during a drag, each
 * one making the worker reflow and repaint a screen nobody has finished sizing.
 */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * A resize is only sent when the column or row count moves by at least this
 * much. A classic (non-overlay) scrollbar appearing takes width away, which
 * would shrink the grid, which can remove the scrollbar, which grows it back:
 * without a dead band that pair oscillates. A column or two is not a change
 * worth a reflow anyway.
 */
const RESIZE_HYSTERESIS = 2;

const MAX_LOG_LINES = 300;

// ---------------------------------------------------------------------------
// Terminal defaults
// ---------------------------------------------------------------------------

/**
 * The colours an uncoloured cell renders in, read from the stylesheet so there
 * is one source of truth for them (client.html's `--term-fg` / `--term-bg`,
 * which in turn come from the app's dark theme).
 *
 * `inverse` needs both because it swaps them: a cell with `inverse` but no
 * explicit background paints the terminal's *foreground* as its background.
 */
const termStyle = getComputedStyle(document.documentElement);
const DEFAULT_FG = termStyle.getPropertyValue('--term-fg').trim();
const DEFAULT_BG = termStyle.getPropertyValue('--term-bg').trim();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  /** Manifest entry for the selected story. */
  meta: null,
  socket: null,
  /** Column/row counts the story is designed for; the grid never goes below. */
  minColumns: 80,
  minRows: 24,
  cellWidth: 0,
  cellHeight: 0,
  /** Last size sent to the worker, so an unchanged size is not re-sent. */
  sentColumns: 0,
  sentRows: 0,
  /** Set once the worker reports `ready`; gates every outbound command. */
  ready: false,
  generation: -1,
  seq: 0,
  dropped: 0,
  /** The size of the frame currently on screen, as painted rather than sent. */
  frameColumns: 0,
  frameRows: 0,
  /** Set when a story is selected but its socket has not opened yet. */
  pendingResize: false,
};

let fpsWindowStart = performance.now();
let fpsFrameCount = 0;
let fps = 0;
let resizeTimer = undefined;

// ---------------------------------------------------------------------------
// Log pane
// ---------------------------------------------------------------------------

function log(kind, text) {
  if (logEmptyEl.parentNode) logEmptyEl.remove();
  const line = document.createElement('div');
  line.className = 'line ' + kind;
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `${stamp} ${text}`;
  // Only auto-scroll when the reader is already at the bottom, so scrolling back
  // to read a stack trace is not undone by the next frame's log line.
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.appendChild(line);
  while (logEl.childElementCount > MAX_LOG_LINES) logEl.removeChild(logEl.firstElementChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
}

// ---------------------------------------------------------------------------
// Cell metrics
// ---------------------------------------------------------------------------

/**
 * Measure one cell from a hidden probe rather than hardcoding it.
 *
 * Absolute positioning per run means a wrong cell width shows up as *drift*
 * across a line: the first run is right, the last is a column or two off, and
 * the symptom looks like a serialization bug. Measuring removes font-metrics
 * (and a proportional fallback font) from the list of suspects.
 */
function measureCell() {
  const widthProbe = document.createElement('span');
  widthProbe.textContent = 'M'.repeat(100);
  widthProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';

  const heightProbe = document.createElement('div');
  heightProbe.className = 'row';
  heightProbe.textContent = 'M';
  heightProbe.style.cssText = 'position:absolute;visibility:hidden';

  gridEl.appendChild(widthProbe);
  gridEl.appendChild(heightProbe);
  state.cellWidth = widthProbe.getBoundingClientRect().width / 100;
  state.cellHeight = heightProbe.getBoundingClientRect().height;
  widthProbe.remove();
  heightProbe.remove();

  if (!(state.cellWidth > 0) || !(state.cellHeight > 0)) {
    log('error', `could not measure the cell: ${state.cellWidth}x${state.cellHeight}px`);
  }
}

/**
 * The grid size this window can show.
 *
 * Never smaller than what the story declares, because the declared size is what
 * the component was laid out for: a dialog that needs 90 columns gets 90 even in
 * a narrower window, and the pane scrolls. Wider than the declaration is used,
 * since a dialog in more space is a legitimate thing to look at.
 */
function computeGridSize() {
  const box = getComputedStyle(screenEl);
  const innerWidth =
    screenEl.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight);
  const innerHeight =
    screenEl.clientHeight - parseFloat(box.paddingTop) - parseFloat(box.paddingBottom);
  return {
    columns: Math.max(state.minColumns, Math.floor(innerWidth / state.cellWidth)),
    rows: Math.max(state.minRows, Math.floor(innerHeight / state.cellHeight)),
  };
}

function maybeSendResize(force) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  if (!state.ready) {
    // The worker's protocol says nothing before `ready`; `onReady` flushes this.
    state.pendingResize = true;
    return;
  }
  const { columns, rows } = computeGridSize();
  const changed =
    Math.abs(columns - state.sentColumns) >= RESIZE_HYSTERESIS ||
    Math.abs(rows - state.sentRows) >= RESIZE_HYSTERESIS;
  if (!force && !changed) return;
  if (columns === state.sentColumns && rows === state.sentRows) return;
  state.sentColumns = columns;
  state.sentRows = rows;
  send({ type: 'resize', columns, rows });
  log('status', `resize ${columns}x${rows}`);
}

// ---------------------------------------------------------------------------
// Frame rendering
// ---------------------------------------------------------------------------

/**
 * Replace the screen with `payload`.
 *
 * The geometry and the styles come from `frame-layout.js`, which is where all
 * the decisions worth testing live; this function is only the DOM plumbing that
 * applies them, and it deliberately decides nothing on its own.
 *
 * Rows are rebuilt rather than diffed. A frame is at most a few hundred runs, so
 * a diff would be optimising the wrong thing, and rebuilding keeps the client
 * stateless between frames, which is what makes a `generation` change safe to
 * handle by simply throwing the previous screen away.
 */
function renderFrame(payload) {
  if (payload.generation !== state.generation) {
    // A respawned worker restarts `seq` from 1 and mounts fresh component state,
    // so nothing about the old frame applies any more.
    state.generation = payload.generation;
    state.seq = 0;
    state.dropped = 0;
  } else if (payload.seq > state.seq + 1) {
    // The worker numbers frames as they paint and drops intermediates when it
    // throttles, so a gap is dropped frames rather than lost socket data.
    state.dropped += payload.seq - state.seq - 1;
  }
  state.seq = Math.max(state.seq, payload.seq);

  state.frameColumns = payload.columns;
  state.frameRows = payload.rows;

  const rows = layoutRows(payload, state.cellWidth, {
    foreground: DEFAULT_FG,
    background: DEFAULT_BG,
  });
  const fragment = document.createDocumentFragment();

  for (const row of rows) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row';
    for (const run of row.runs) {
      const node = document.createElement(run.href ? 'a' : 'span');
      node.className = 'run';
      node.style.left = `${run.left}px`;
      Object.assign(node.style, run.css);
      if (run.href) {
        node.href = run.href;
        node.target = '_blank';
        node.rel = 'noopener noreferrer';
        // What a terminal shows on hover, so a link's target is inspectable
        // without following it.
        node.title = run.href;
      }
      node.textContent = run.text;
      rowEl.appendChild(node);
    }
    fragment.appendChild(rowEl);
  }

  gridEl.replaceChildren(fragment);
  updateStats();
}

function updateStats() {
  const size = state.frameColumns ? `${state.frameColumns}x${state.frameRows}` : '--';
  const parts = [
    `gen ${state.generation < 0 ? '--' : state.generation}`,
    `seq ${state.seq}`,
    size,
    `${fps} fps`,
  ];
  // Only shown once nonzero: a permanent "0 dropped" invites the reader to
  // wonder whether the counter works.
  if (state.dropped > 0) parts.push(`${state.dropped} dropped`);
  statsEl.textContent = parts.join('  ·  ');
}

function noteFrameArrival() {
  fpsFrameCount++;
  const now = performance.now();
  const elapsed = now - fpsWindowStart;
  if (elapsed >= 1000) {
    fps = Math.round((fpsFrameCount * 1000) / elapsed);
    fpsFrameCount = 0;
    fpsWindowStart = now;
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

// The table itself is `/keys.js`, transpiled from keys.ts, so that the probe can
// import the same function the browser runs. See that file for what each
// sequence is and why.
window.addEventListener('keydown', event => {
  if (event.defaultPrevented) return;
  const bytes = keyToBytes(event);
  if (bytes === null) return;
  event.preventDefault();
  if (!state.ready) {
    // Worth saying out loud: swallowing the key without sending it would look
    // like the app is ignoring input.
    log('warn', `dropped ${JSON.stringify(bytes)}: story is not ready`);
    return;
  }
  send({ type: 'key', data: bytes });
});

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

function send(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(JSON.stringify(message));
}

function setStatus(status, detail) {
  statusEl.className = status;
  statusEl.textContent = detail ? `${status} (${detail})` : status;
}

function showBanner(text) {
  bannerTextEl.textContent = text;
  bannerEl.classList.add('shown');
}

function hideBanner() {
  bannerEl.classList.remove('shown');
}

function connect(name) {
  if (state.socket) {
    // Detach the handlers first: closing otherwise fires `onclose`, which would
    // report a disconnection for the story being left rather than the one being
    // opened.
    state.socket.onclose = null;
    state.socket.onerror = null;
    state.socket.onmessage = null;
    state.socket.close();
  }
  state.socket = null;
  state.ready = false;
  state.generation = -1;
  state.seq = 0;
  state.dropped = 0;
  state.sentColumns = 0;
  state.sentRows = 0;
  state.frameColumns = 0;
  state.frameRows = 0;
  gridEl.replaceChildren();
  hideBanner();
  setStatus('connecting');
  updateStats();

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws?story=${encodeURIComponent(name)}`);
  state.socket = socket;

  socket.onopen = () => log('status', `socket open for ${name}`);

  socket.onmessage = event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      log('error', `unparseable message from server: ${String(event.data).slice(0, 200)}`);
      return;
    }

    switch (message.type) {
      case 'hello':
        state.minColumns = message.columns ?? 80;
        state.minRows = message.rows ?? 24;
        titleEl.textContent = message.title ?? name;
        descEl.textContent = message.description ?? '';
        document.title = `${message.title ?? name} — Ink gallery`;
        // A story whose module is absent still gets driven through the worker,
        // so the badge is information rather than a warning icon.
        if (message.missingPath) {
          log('warn', `${message.launcher} needs ${message.missingPath} to export its component`);
        }
        break;

      case 'status':
        if (message.status === 'ready') {
          setStatus('ready');
          onReady();
        } else if (message.status === 'starting') {
          state.ready = false;
          setStatus('starting');
        } else if (message.status === 'failed') {
          state.ready = false;
          setStatus('failed');
          log('error', message.message ?? 'worker failed');
        } else if (message.status === 'exited') {
          state.ready = false;
          setStatus('exited');
          // The worker dies with its last viewer by design, but this socket was
          // still open, so an exit here is a crash rather than the normal path.
          const detail = message.stderr ? `: ${message.stderr}` : '';
          log('error', `worker exited (code ${message.code})${detail}`);
        }
        break;

      case 'frame':
        noteFrameArrival();
        // Discarded while a restart is in flight: the replacement worker will
        // paint from scratch, and drawing this stale screen would look like the
        // restart did nothing.
        if (state.socket === socket) renderFrame(message.payload);
        break;

      case 'log':
        log(message.level === 'error' ? 'error' : message.level === 'warn' ? 'warn' : 'plain', message.text);
        break;

      default:
        log('warn', `unknown message from server: ${message.type}`);
    }
  };

  socket.onclose = event => {
    if (state.socket !== socket) return;
    state.ready = false;
    setStatus('disconnected', `code ${event.code}`);
    showBanner('The connection to the gallery server closed.');
  };

  socket.onerror = () => {
    // A failed connect fires `error` then `close`, so the banner is raised once,
    // by `onclose`.
    log('error', 'websocket error');
  };
}

function onReady() {
  state.ready = true;
  // The story's declared size is a starting point; the window decides. Sent
  // unconditionally, because the worker's first paint is at the declared size.
  maybeSendResize(true);
  state.pendingResize = false;
  screenEl.focus();
}

// ---------------------------------------------------------------------------
// Story rail
// ---------------------------------------------------------------------------

function storyButton(meta) {
  const button = document.createElement('button');
  button.className = 'story';
  button.dataset.story = meta.name;

  const label = document.createElement('span');
  label.textContent = meta.title;
  if (meta.missingPath) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'module absent';
    label.appendChild(badge);
  }

  const launcher = document.createElement('span');
  launcher.className = 'launcher';
  launcher.textContent = meta.launcher;

  button.append(label, launcher);
  button.addEventListener('click', () => selectStory(meta.name, true));
  return button;
}

function renderRail(stories) {
  railEl.replaceChildren();
  const byGroup = new Map();
  for (const meta of stories) {
    if (!byGroup.has(meta.group)) byGroup.set(meta.group, []);
    byGroup.get(meta.group).push(meta);
  }
  for (const [group, entries] of byGroup) {
    const heading = document.createElement('div');
    heading.className = 'group-title';
    heading.textContent = group;
    railEl.appendChild(heading);
    for (const meta of entries) railEl.appendChild(storyButton(meta));
  }
}

let stories = [];

function selectStory(name, pushHistory) {
  const meta = stories.find(s => s.name === name);
  if (!meta) {
    log('warn', `no such story: ${name}`);
    return;
  }
  state.meta = meta;
  for (const button of railEl.querySelectorAll('.story')) {
    button.setAttribute('aria-current', String(button.dataset.story === name));
  }
  if (pushHistory && location.hash.slice(1) !== name) {
    // The hash is the selection's home, so a reload lands on the same story.
    location.hash = name;
  }
  logEl.replaceChildren();
  const placeholder = document.createElement('div');
  placeholder.className = 'line empty';
  placeholder.textContent = `Mounting ${name}…`;
  logEl.appendChild(placeholder);
  logEmptyEl.remove();
  connect(name);
}

// ---------------------------------------------------------------------------
// Toolbar and window events
// ---------------------------------------------------------------------------

restartBtn.addEventListener('click', () => {
  if (!state.meta) return;
  setStatus('restarting');
  log('status', 'restart requested');
  send({ type: 'restart' });
});

repaintBtn.addEventListener('click', () => {
  if (!state.meta) return;
  send({ type: 'repaint' });
  log('status', 'repaint requested');
});

reconnectBtn.addEventListener('click', () => {
  if (!state.meta) return;
  log('status', 'reconnecting');
  connect(state.meta.name);
});

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => maybeSendResize(false), RESIZE_DEBOUNCE_MS);
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (name && name !== state.meta?.name) selectStory(name, false);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  measureCell();
  let response;
  try {
    response = await fetch('/api/stories');
  } catch (error) {
    setStatus('offline');
    showBanner(`Could not reach the gallery server: ${String(error)}`);
    return;
  }
  if (!response.ok) {
    setStatus('failed');
    showBanner(`/api/stories returned ${response.status}`);
    return;
  }
  stories = (await response.json()).stories;
  renderRail(stories);
  if (stories.length === 0) {
    setStatus('idle');
    titleEl.textContent = 'No stories';
    descEl.textContent = 'The manifest is empty.';
    return;
  }
  const wanted = location.hash.slice(1);
  const initial = stories.some(s => s.name === wanted) ? wanted : stories[0].name;
  selectStory(initial, true);
}

boot();
