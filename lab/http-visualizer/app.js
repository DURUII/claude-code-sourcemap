const state = {
  events: [],
  selectedSessionId: undefined,
  selectedHandleId: undefined,
  selectedToolName: undefined,
  panelSearch: "",
  searchMatchIndex: -1,
  blockIndexes: {}
};

const views = [
  { id: "system", label: "System", countKey: "system" },
  { id: "messages", label: "Messages", countKey: "messages" },
  { id: "tools", label: "Tools", countKey: "tools" },
  { id: "raw", label: "Request JSON" },
  { id: "output", label: "Output" },
  { id: "delta", label: "Delta" },
  { id: "transport", label: "Transport" }
];

const validViewIds = new Set(views.map((view) => view.id));

const $ = (id) => document.getElementById(id);
let jsonEditorCounter = 0;
const pendingJsonEditors = new Map();
const mountedJsonEditors = new Map();
let initialViewFocusApplied = false;
let renderQueued = false;

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value ?? "")) : String(value ?? "").replace(/["\\]/g, "\\$&");
}

function parseLocationHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
  const [view, ...rest] = raw.split("/");
  return {
    view: validViewIds.has(view) ? view : "system",
    toolName: view === "tools" && rest.length ? rest.join("/") : undefined
  };
}

function writeLocationHash() {
  const view = activeTabName();
  const suffix = view === "tools" && state.selectedToolName ? `/${encodeURIComponent(state.selectedToolName)}` : "";
  const next = `#${view}${suffix}`;
  if (location.hash === next) return;
  history.replaceState(null, "", next);
}

function applyLocationHash() {
  const parsed = parseLocationHash();
  if (parsed.toolName) state.selectedToolName = parsed.toolName;
  activatePayloadTab(parsed.view, true, { syncHash: false });
}


function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}

function handles() {
  const grouped = new Map();
  for (const event of state.events) {
    const key = event.handleId || event.requestId || event.id;
    if (!grouped.has(key)) grouped.set(key, { id: key, events: [], latest: event });
    const handle = grouped.get(key);
    handle.events.push(event);
    handle.latest = event;
  }
  return [...grouped.values()].sort((a, b) => new Date(b.latest.timestamp) - new Date(a.latest.timestamp));
}

function sessions() {
  const grouped = new Map();
  for (const handle of handles()) {
    const sessionId = handle.latest.sessionId || "sessionless";
    if (!grouped.has(sessionId)) grouped.set(sessionId, { id: sessionId, handles: [], latest: handle.latest });
    const session = grouped.get(sessionId);
    session.handles.push(handle);
    if (new Date(handle.latest.timestamp) > new Date(session.latest.timestamp)) session.latest = handle.latest;
  }
  return [...grouped.values()].sort((a, b) => new Date(b.latest.timestamp) - new Date(a.latest.timestamp));
}

function selectedSession() {
  const all = sessions();
  return all.find((session) => session.id === state.selectedSessionId) || all[0];
}

function selectedHandle() {
  const session = selectedSession();
  if (!session) return undefined;
  return session.handles.find((handle) => handle.id === state.selectedHandleId) || session.handles[0];
}

function isRequestPayloadEvent(event) {
  return event?.type === "api_request";
}

function selectedPayloadEvent(handle = selectedHandle()) {
  return handle?.events.slice().reverse().find(isRequestPayloadEvent) || handle?.latest;
}

function render() {
  renderSessionNavigator();
  renderPayload(selectedHandle());
  updatePanelNavigation();
  hydrateJsonEditors();
  ensureInitialViewFocus();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function renderSessionNavigator() {
  const sessionTabs = $("session-tabs");
  const all = sessions();
  if (all.length === 0) {
    sessionTabs.innerHTML = `
      <div class="session-empty">
        <strong>No sessions yet</strong>
        <span>Run restored Claude Code with <code>CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest</code>.</span>
      </div>
    `;
    return;
  }
  const selected = selectedSession();
  sessionTabs.innerHTML = all.map((session) => renderSessionGroup(session, selected)).join("");
  sessionTabs.querySelectorAll(".request-tab").forEach((button) => {
    button.addEventListener("click", () => {
      selectRequest(button.dataset.sessionId, button.dataset.handleId);
    });
    button.addEventListener("keydown", handleRequestTabKeydown);
  });
}

function renderSessionGroup(session, selected) {
  const event = selectedPayloadEvent(session.handles[0]);
  const summary = event?.summary || {};
  const active = session.id === selected?.id ? " active" : "";
  const eventCount = session.handles.reduce((sum, handle) => sum + handle.events.length, 0);
  const agentCount = new Set(session.handles.map((handle) => selectedPayloadEvent(handle)?.agentId).filter(Boolean)).size;
  return `
    <section class="tab-group${active}">
      <div class="session-label" title="${escapeAttr(session.id)}">
        <span>${escapeHtml(summary.model || shortId(session.id))}</span>
        <small>${session.handles.length} req · ${eventCount} evt${agentCount ? ` · ${agentCount} agent` : ""}</small>
      </div>
      ${session.handles.map(renderRequestTab).join("")}
    </section>
  `;
}

function renderRequestTab(handle) {
  const event = selectedPayloadEvent(handle);
  const summary = event?.summary || {};
  const selected = selectedHandle();
  const active = handle.id === selected?.id ? " active" : "";
  const session = selectedSession();
  const requestIndex = session?.handles.slice().reverse().findIndex((candidate) => candidate.id === handle.id);
  const ordinal = requestIndex >= 0 ? session.handles.length - requestIndex : "";
  return `
    <button class="request-tab${active}" type="button" data-session-id="${escapeAttr(event?.sessionId || "sessionless")}" data-handle-id="${escapeAttr(handle.id)}" aria-current="${active ? "true" : "false"}">
      <span class="request-tab-title">Request ${escapeHtml(ordinal)} · ${escapeHtml(summary.model || event?.type || "request")}</span>
      <span class="request-tab-meta">${escapeHtml(scopeLabel(event))} · ${handle.events.length} evt · ${summary.messages || 0} msg · ${summary.tools || 0} tools</span>
    </button>
  `;
}

function selectRequest(sessionId, handleId, focus = false) {
  state.selectedSessionId = sessionId;
  state.selectedHandleId = handleId;
  render();
  if (!focus) return;
  requestAnimationFrame(() => {
    const selector = `.request-tab[data-session-id="${cssEscape(sessionId)}"][data-handle-id="${cssEscape(handleId)}"]`;
    const button = document.querySelector(selector);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}

function requestTabs() {
  return [...document.querySelectorAll(".request-tab")];
}

function selectAdjacentRequest(direction) {
  const tabs = requestTabs();
  if (!tabs.length) return;
  const current = tabs.findIndex((button) => button.dataset.handleId === selectedHandle()?.id);
  const next = Math.max(0, Math.min(tabs.length - 1, Math.max(0, current) + direction));
  if (next === current) return;
  selectRequest(tabs[next].dataset.sessionId, tabs[next].dataset.handleId, true);
}

function selectEdgeRequest(edge) {
  const tabs = requestTabs();
  const target = edge === "first" ? tabs[0] : tabs[tabs.length - 1];
  if (!target) return;
  selectRequest(target.dataset.sessionId, target.dataset.handleId, true);
}

function handleRequestTabKeydown(event) {
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    if (event.key === "ArrowDown") {
      focusActiveViewTab();
    } else {
      selectAdjacentRequest(1);
    }
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    if (event.key === "ArrowUp") {
    } else {
      selectAdjacentRequest(-1);
    }
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Home") {
    selectEdgeRequest("first");
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "End") {
    selectEdgeRequest("last");
    event.preventDefault();
    event.stopPropagation();
  }
}

function scopeLabel(event) {
  if (!event) return "unknown scope";
  if (event.agentId) return `subagent:${event.agentId}`;
  return event.querySource || "main";
}

function shortId(value) {
  const text = String(value || "");
  if (text === "sessionless") return text;
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text;
}

function renderPayload(handle) {
  const event = selectedPayloadEvent(handle);
  const payload = event?.payload;

  if (!payload) {
    for (const name of ["system", "messages", "tools", "output", "delta", "transport", "raw"]) {
      $(`panel-${name}`).innerHTML = '<div class="empty">No request selected.</div>';
    }
    updateCounts();
    return;
  }

  renderSystem(payload.system || []);
  renderMessages(payload.messages || []);
  renderTools(payload.tools || []);
  renderOutput(handle);
  renderDelta(handle);
  renderTransport(event, handle);
  $("panel-raw").innerHTML = renderJsonEditorCard("Request JSON", payload, { height: "auto", expandAll: true });
  updateCounts(payload);
}

function renderSystem(blocks) {
  const panel = $("panel-system");
  if (!blocks.length) {
    panel.innerHTML = '<div class="empty">No system blocks.</div>';
    return;
  }
  panel.innerHTML = blocks.map((block, index) => renderTextBlock(`System Block #${index + 1}`, block)).join("");
}

function renderMessages(messages) {
  const panel = $("panel-messages");
  if (!messages.length) {
    panel.innerHTML = '<div class="empty">No messages.</div>';
    return;
  }
  panel.innerHTML = groupMessagesIntoTurns(messages).map(renderMessageTurn).join("");
}

function groupMessagesIntoTurns(messages) {
  const turns = [];
  let current;
  messages.forEach((message, index) => {
    const entry = { message, index };
    if (message.role === "user" || !current) {
      current = { user: message.role === "user" ? entry : undefined, responses: [] };
      turns.push(current);
      if (message.role !== "user") current.responses.push(entry);
      return;
    }
    current.responses.push(entry);
  });
  return turns;
}

function renderMessageTurn(turn, turnIndex) {
  const user = turn.user;
  const promptTitle = user ? `user #${user.index + 1}` : `turn #${turnIndex + 1}`;
  const promptContent = user ? user.message.content : [];
  const responses = turn.responses.length
    ? turn.responses.map(({ message, index }) => renderMessageCard(message, index)).join("")
    : '<div class="empty compact">No assistant message in this turn.</div>';
  return `
    <section class="message-turn">
      <aside class="turn-prompt message-card">
        <div class="block-head">
          <div class="block-title">${escapeHtml(promptTitle)}</div>
          <div class="tags"><span class="tag">${Array.isArray(promptContent) ? promptContent.length : 0} blocks</span></div>
        </div>
        <div class="block-body">${renderMessageContent(promptContent)}</div>
      </aside>
      <div class="turn-responses">
        ${responses}
      </div>
    </section>
  `;
}

function renderMessageCard(message, index) {
  const content = Array.isArray(message.content) ? message.content : [];
  return `
    <article class="message-card block-card">
      <div class="block-head">
        <div class="block-title">${escapeHtml(message.role || "message")} #${index + 1}</div>
        <div class="tags"><span class="tag">${content.length} blocks</span></div>
      </div>
      <div class="block-body">${renderMessageContent(content)}</div>
    </article>
  `;
}

function renderMessageContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  if (!blocks.length) return '<div class="empty compact">No content blocks.</div>';
  return blocks.map((block, blockIndex) => renderInlineBlock(block, blockIndex)).join("");
}

function renderTools(tools) {
  const panel = $("panel-tools");
  if (!tools.length) {
    panel.innerHTML = '<div class="empty">No tools defined.</div>';
    return;
  }
  const filteredTools = tools;
  const selectedTool =
    filteredTools.find((tool) => toolName(tool) === state.selectedToolName) ||
    filteredTools[0];
  state.selectedToolName = selectedTool ? toolName(selectedTool) : undefined;

  panel.innerHTML = `
    <div class="tools-layout">
      <aside class="tools-index">
        <div class="tools-list">
          ${
            filteredTools.length
              ? filteredTools.map((tool) => renderToolIndexRow(tool, selectedTool)).join("")
              : '<div class="empty compact">No tools match this search.</div>'
          }
        </div>
      </aside>
      <section class="tool-detail">
        ${selectedTool ? renderToolDetail(selectedTool) : '<div class="empty">No tool selected.</div>'}
      </section>
    </div>
  `;

  panel.querySelectorAll(".tool-row").forEach((button) => {
    button.addEventListener("click", () => {
      selectTool(button.dataset.toolName, tools);
    });
    button.addEventListener("keydown", (event) => handleToolRowKeydown(event, tools));
  });
}

function toolName(tool) {
  return String(tool?.name || "tool");
}

function toolRequiredCount(tool) {
  const required = tool?.input_schema?.required;
  return Array.isArray(required) ? required.length : 0;
}

function toolPropertyCount(tool) {
  const properties = tool?.input_schema?.properties;
  return properties && typeof properties === "object" ? Object.keys(properties).length : 0;
}

function renderToolIndexRow(tool, selectedTool) {
  const name = toolName(tool);
  const active = name === toolName(selectedTool) ? " active" : "";
  const required = toolRequiredCount(tool);
  const properties = toolPropertyCount(tool);
  return `
    <button class="tool-row${active}" type="button" data-tool-name="${escapeAttr(name)}" aria-current="${active ? "true" : "false"}">
      <div class="tool-row-title">${escapeHtml(name)}</div>
      <div class="tool-row-meta">${properties}${required ? `/${required}` : ""}</div>
    </button>
  `;
}

function selectTool(name, tools, focus = false) {
  state.selectedToolName = name;
  renderTools(tools);
  hydrateJsonEditors();
  writeLocationHash();
  if (!focus) return;
  requestAnimationFrame(() => {
    const button = document.querySelector(`.tool-row[data-tool-name="${cssEscape(name)}"]`);
    button?.focus({ preventScroll: true });
    button?.scrollIntoView({ block: "nearest" });
  });
}

function visibleToolRows() {
  return [...document.querySelectorAll(".tool-row")].filter((node) => node.offsetParent !== null);
}

function focusSelectedToolRow() {
  const rows = visibleToolRows();
  const selected = rows.find((row) => row.dataset.toolName === state.selectedToolName) || rows[0];
  if (!selected) return false;
  document.querySelectorAll(".focused-block").forEach((node) => node.classList.remove("focused-block"));
  selected.classList.add("focused-block");
  selected.focus({ preventScroll: true });
  selected.scrollIntoView({ block: "nearest" });
  state.blockIndexes[activeTabName()] = navigableBlocks().indexOf(selected);
  return true;
}

function selectAdjacentTool(direction, tools) {
  const rows = visibleToolRows();
  if (!rows.length) return;
  const current = rows.findIndex((button) => button.dataset.toolName === state.selectedToolName);
  const next = Math.max(0, Math.min(rows.length - 1, Math.max(0, current) + direction));
  if (next === current) {
    if (direction < 0) focusActiveViewTab();
    return;
  }
  selectTool(rows[next].dataset.toolName, tools, true);
}

function selectEdgeTool(edge, tools) {
  const rows = visibleToolRows();
  const target = edge === "first" ? rows[0] : rows[rows.length - 1];
  if (!target) return;
  selectTool(target.dataset.toolName, tools, true);
}

function handleToolRowKeydown(event, tools) {
  if (event.key === "ArrowDown") {
    selectAdjacentTool(1, tools);
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "ArrowUp") {
    selectAdjacentTool(-1, tools);
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Home") {
    selectEdgeTool("first", tools);
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "End") {
    selectEdgeTool("last", tools);
    event.preventDefault();
    event.stopPropagation();
  }
}

function renderToolDetail(tool) {
  const required = toolRequiredCount(tool);
  const properties = toolPropertyCount(tool);
  return `
    <article class="block-card tool-detail-card">
      <div class="block-head">
        <div>
          <div class="block-title">${escapeHtml(toolName(tool))}</div>
          <div class="tool-subtitle">${escapeHtml(tool.type || "tool")}</div>
        </div>
        <div class="tags">
          <span class="tag">${properties} fields</span>
          ${required ? `<span class="tag">${required} required</span>` : ""}
        </div>
      </div>
      <details class="tool-section" open>
        <summary>Description</summary>
        <div class="block-body"><p class="tool-description">${escapeHtml(tool.description || "No description.")}</p></div>
      </details>
      <details class="tool-section" open>
        <summary>Input Schema</summary>
        <div class="block-body">${renderJsonEditorSlot(tool.input_schema || tool, { height: "auto" })}</div>
      </details>
      <details class="tool-section">
        <summary>Raw Tool JSON</summary>
        <div class="block-body">${renderJsonEditorSlot(tool, { height: "auto" })}</div>
      </details>
    </article>
  `;
}

function renderOutput(handle) {
  const outputBlocks = collectOutputBlocks(handle.events);
  $("panel-output").innerHTML = `
    <section class="output-blocks">
      <div class="block-head"><div class="block-title">Response Blocks</div><div class="tags"><span class="tag">${outputBlocks.length} blocks</span></div></div>
      <div class="block-body">${outputBlocks.length ? outputBlocks.map(renderOutputBlock).join("") : '<div class="empty compact">No response blocks captured for this handle.</div>'}</div>
    </section>
  `;
}

function collectOutputBlocks(events) {
  const blocks = new Map();
  for (const event of events) {
    if (!event.type?.startsWith("api_response")) continue;
    const payload = event.payload || {};
    const index = Number.isInteger(payload.index) ? payload.index : blocks.size;
    const current = blocks.get(index) || { type: "unknown" };
    if (payload.block && typeof payload.block === "object") {
      blocks.set(index, { ...current, ...payload.block });
      continue;
    }
    const delta = payload.delta;
    if (!delta || typeof delta !== "object") continue;
    let changed = false;
    if (typeof delta.text === "string") {
      current.text = `${current.text || ""}${delta.text}`;
      changed = true;
    }
    if (typeof delta.thinking === "string") {
      current.thinking = `${current.thinking || ""}${delta.thinking}`;
      changed = true;
    }
    if (typeof delta.connector_text === "string") {
      current.connector_text = `${current.connector_text || ""}${delta.connector_text}`;
      changed = true;
    }
    if (typeof delta.partial_json === "string") {
      current.input = `${current.input || ""}${delta.partial_json}`;
      changed = true;
    }
    if (typeof delta.signature === "string") {
      current.signature = delta.signature;
      changed = true;
    }
    if (delta.type === "citations_delta") {
      current.citations = [...(Array.isArray(current.citations) ? current.citations : []), delta];
      changed = true;
    }
    if (delta.type === "text_delta") current.type = current.type === "unknown" ? "text" : current.type;
    if (delta.type === "thinking_delta") current.type = current.type === "unknown" ? "thinking" : current.type;
    if (delta.type === "connector_text_delta") current.type = current.type === "unknown" ? "connector_text" : current.type;
    if (changed) blocks.set(index, current);
  }
  return [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block);
}

function renderOutputBlock(block, index) {
  if (block.type === "text") return renderTextBlock(`Output Block #${index + 1}`, block);
  if (block.type === "thinking") {
    return renderTextBlock(`Output Block #${index + 1}`, {
      ...block,
      text: block.thinking || JSON.stringify(block, null, 2)
    });
  }
  if (block.type === "connector_text") {
    return renderTextBlock(`Output Block #${index + 1}`, {
      ...block,
      text: block.connector_text || JSON.stringify(block, null, 2)
    });
  }
  if (block.type === "tool_use" || block.type === "server_tool_use") {
    const input = parseJsonMaybe(block.input);
    return `
      <article class="block-card">
        <div class="block-head">
          <div>
            <div class="block-title">Output Block #${index + 1} · ${escapeHtml(block.name || "tool")}</div>
            <div class="tool-subtitle">${escapeHtml(block.id || "")}</div>
          </div>
          <div class="tags"><span class="tag">${escapeHtml(block.type)}</span></div>
        </div>
        <div class="block-body">${renderJsonEditorSlot({ ...block, input }, { height: 360 })}</div>
      </article>
    `;
  }
  return `
    <article class="block-card">
      <div class="block-head">
        <div class="block-title">Output Block #${index + 1}</div>
        <div class="tags"><span class="tag">${escapeHtml(block.type || "unknown")}</span></div>
      </div>
      <div class="block-body">${renderJsonEditorSlot(block, { height: 320 })}</div>
    </article>
  `;
}

function parseJsonMaybe(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function renderDelta(handle) {
  const requestEvents = handle.events.filter(isRequestPayloadEvent);
  if (requestEvents.length < 2) {
    $("panel-delta").innerHTML = '<div class="empty">No retry/delta stack yet. When a handle has multiple request snapshots, changes appear here.</div>';
    return;
  }
  const previous = requestEvents.at(-2).payload;
  const current = requestEvents.at(-1).payload;
  const rows = diffPayloads(previous, current)
    .map((row) => `
      <div class="diff-row">
        <div class="diff-key">${escapeHtml(row.path)}</div>
        <div class="diff-old">${escapeHtml(row.before)}</div>
        <div class="diff-new">${escapeHtml(row.after)}</div>
      </div>
    `)
    .join("");
  $("panel-delta").innerHTML = `
    <article class="block-card">
      <div class="block-head"><div class="block-title">Latest Request Delta</div><div class="tags"><span class="tag">${requestEvents.length} snapshots</span></div></div>
      <div>${rows || '<div class="empty">No structural difference between the latest two request snapshots.</div>'}</div>
    </article>
  `;
}

function diffPayloads(before, after) {
  const paths = [
    ["model", (v) => v?.model],
    ["max_tokens", (v) => v?.max_tokens],
    ["thinking", (v) => JSON.stringify(v?.thinking ?? null)],
    ["system.length", (v) => Array.isArray(v?.system) ? v.system.length : 0],
    ["messages.length", (v) => Array.isArray(v?.messages) ? v.messages.length : 0],
    ["tools.length", (v) => Array.isArray(v?.tools) ? v.tools.length : 0],
    ["betas", (v) => JSON.stringify(v?.betas ?? [])],
    ["output_config", (v) => JSON.stringify(v?.output_config ?? null)],
    ["context_management", (v) => JSON.stringify(v?.context_management ?? null)]
  ];
  return paths
    .map(([path, getter]) => ({ path, before: getter(before), after: getter(after) }))
    .filter((row) => row.before !== row.after);
}

function renderTransport(event, handle) {
  const payload = event.payload || {};
  const transport = {
    handleId: handle.id,
    eventId: event.id,
    source: event.source,
    timestamp: event.timestamp,
    querySource: event.querySource,
    attempt: event.attempt,
    requestId: event.requestId,
    stackedEvents: handle.events.map((item) => ({ id: item.id, type: item.type, attempt: item.attempt, timestamp: item.timestamp })),
    metadata: payload.metadata,
    betas: payload.betas,
    toolChoice: payload.tool_choice,
    contextManagement: payload.context_management,
    outputConfig: payload.output_config,
    speed: payload.speed
  };
  $("panel-transport").innerHTML = renderJsonEditorCard("Transport", transport, { height: 620 });
}

function renderTextBlock(title, block) {
  return `
    <article class="block-card">
      <div class="block-head">
        <div class="block-title">${escapeHtml(title)}</div>
        <div class="tags">
          <span class="tag">${escapeHtml(block.type || "text")}</span>
          ${block.cache_control ? `<span class="tag">cache ${escapeHtml(block.cache_control.type)}</span>` : ""}
        </div>
      </div>
      <div class="block-body">${renderTextSections(block.text || JSON.stringify(block, null, 2))}</div>
    </article>
  `;
}

function renderInlineBlock(block, index) {
  if (block.type === "text") return renderTextBlock(`Block #${index + 1}`, block);
  return `
    <details open>
      <summary>Block #${index + 1} · ${escapeHtml(block.type || "unknown")}</summary>
      <div class="block-body">${renderJsonEditorSlot(block, { height: 260 })}</div>
    </details>
  `;
}

function renderTextSections(text) {
  const sections = splitSections(String(text || ""));
  if (sections.length <= 1) return `<pre>${escapeHtml(text)}</pre>`;
  return sections
    .map((section, index) => `
      <details ${index === 0 ? "open" : ""}>
        <summary>${escapeHtml(section.title)}</summary>
        <div class="block-body"><pre>${escapeHtml(section.body.trim())}</pre></div>
      </details>
    `)
    .join("");
}

function splitSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let current = { title: "General / Preamble", body: [] };
  let sawSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line) || /^<system-reminder>/.test(line) || /^Contents of /.test(line)) {
      if (current.body.length || current.title !== "General / Preamble") sections.push({ title: current.title, body: current.body.join("\n") });
      current = { title: line.trim(), body: [] };
      sawSection = true;
    } else {
      current.body.push(line);
    }
  }
  if (current.body.length || current.title !== "General / Preamble") sections.push({ title: current.title, body: current.body.join("\n") });
  return sawSection ? sections : [{ title: "General / Preamble", body: text }];
}

function renderCard(title, content) {
  return `<article class="block-card"><div class="block-head"><div class="block-title">${escapeHtml(title)}</div></div><div class="block-body"><pre>${escapeHtml(content)}</pre></div></article>`;
}

function renderJsonCard(title, value) {
  return `<article class="block-card"><div class="block-head"><div class="block-title">${escapeHtml(title)}</div></div><div class="block-body">${renderJsonTree(value)}</div></article>`;
}

function renderJsonEditorCard(title, value, options = {}) {
  return `<article class="block-card"><div class="block-head"><div class="block-title">${escapeHtml(title)}</div></div><div class="block-body">${renderJsonEditorSlot(value, options)}</div></article>`;
}

function renderJsonEditorSlot(value, options = {}) {
  const id = `json-editor-${++jsonEditorCounter}`;
  pendingJsonEditors.set(id, { value, options });
  const estimatedHeight = options.height === "auto" ? estimateJsonEditorHeight(value) : Number(options.height || 360);
  return `
    <div class="json-editor-shell${options.height === "auto" ? " auto-height" : ""}" style="height:${estimatedHeight}px">
      <div id="${id}" class="json-editor-slot"></div>
      <noscript>${renderJsonTree(value)}</noscript>
    </div>
  `;
}

function estimateJsonEditorHeight(value) {
  const seen = new WeakSet();
  let rows = 1;
  function visit(node, depth = 0) {
    rows += 1;
    if (!node || typeof node !== "object" || depth > 5) return;
    if (seen.has(node)) return;
    seen.add(node);
    const children = Array.isArray(node) ? node : Object.values(node);
    rows += Math.max(0, children.length - 1);
    for (const child of children) visit(child, depth + 1);
  }
  visit(value);
  return Math.max(140, rows * 20 + 48);
}

function fitJsonEditorToContent(slot) {
  const shell = slot.closest(".json-editor-shell.auto-height");
  if (!shell || shell.offsetParent === null) return;
  const editorRoot = slot.querySelector(".jsoneditor");
  const tree = slot.querySelector(".jsoneditor-tree");
  const menu = slot.querySelector(".jsoneditor-menu");
  const navigation = slot.querySelector(".jsoneditor-navigation-bar");
  const status = slot.querySelector(".jsoneditor-statusbar");
  const contentHeight = Math.max(tree?.scrollHeight || 0, tree?.offsetHeight || 0);
  const chromeHeight = (menu?.offsetHeight || 0) + (navigation?.offsetHeight || 0) + (status?.offsetHeight || 0);
  const measured = contentHeight + chromeHeight + 10;
  if (measured > 40) {
    shell.style.height = `${Math.ceil(measured)}px`;
    editorRoot?.style.setProperty("height", "100%");
  }
}

function hydrateJsonEditors() {
  requestAnimationFrame(() => {
    const liveIds = new Set([...document.querySelectorAll(".json-editor-slot")].map((node) => node.id));
    for (const [id, editor] of mountedJsonEditors) {
      if (!liveIds.has(id)) {
        editor.destroy?.();
        mountedJsonEditors.delete(id);
      }
    }

    for (const id of pendingJsonEditors.keys()) {
      if (!liveIds.has(id)) pendingJsonEditors.delete(id);
    }

    for (const [id, { value, options }] of pendingJsonEditors) {
      const node = document.getElementById(id);
      if (!node || mountedJsonEditors.has(id)) continue;
      const inactivePanel = node.closest(".panel:not(.active)");
      if (inactivePanel) continue;
      const closedDetails = node.closest("details:not([open])");
      if (closedDetails) {
        if (!closedDetails.dataset.jsonHydrateBound) {
          closedDetails.dataset.jsonHydrateBound = "true";
          closedDetails.addEventListener("toggle", () => {
            if (closedDetails.open) hydrateJsonEditors();
          });
        }
        continue;
      }
      if (!window.JSONEditor) {
        node.outerHTML = renderJsonTree(value);
        pendingJsonEditors.delete(id);
        continue;
      }
      const editor = new window.JSONEditor(node, {
        mode: "view",
        navigationBar: false,
        mainMenuBar: options.mainMenuBar === true,
        statusBar: false,
        search: true
      });
      editor.set(value);
      if (options.expandAll !== false) editor.expandAll();
      mountedJsonEditors.set(id, editor);
      pendingJsonEditors.delete(id);
      if (options.height === "auto") {
        requestAnimationFrame(() => fitJsonEditorToContent(node));
        const details = node.closest("details");
        details?.addEventListener("toggle", () => {
          if (details.open) requestAnimationFrame(() => fitJsonEditorToContent(node));
        }, { once: false });
      }
    }
  });
}

function renderJsonTree(value, depth = 0, key = undefined) {
  const prefix = key === undefined ? "" : `<span class="json-key">${escapeHtml(key)}</span><span class="json-punc">: </span>`;
  if (Array.isArray(value)) {
    const summary = `<span class="json-kind">Array</span><span class="json-count">${value.length}</span>`;
    if (value.length === 0) return `<div class="json-line">${prefix}<span class="json-punc">[]</span></div>`;
    return `
      <details class="json-node" ${depth < 2 ? "open" : ""}>
        <summary>${prefix}${summary}</summary>
        <div class="json-children">${value.map((item, index) => renderJsonTree(item, depth + 1, String(index))).join("")}</div>
      </details>
    `;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const summary = `<span class="json-kind">Object</span><span class="json-count">${entries.length}</span>`;
    if (entries.length === 0) return `<div class="json-line">${prefix}<span class="json-punc">{}</span></div>`;
    return `
      <details class="json-node" ${depth < 2 ? "open" : ""}>
        <summary>${prefix}${summary}</summary>
        <div class="json-children">${entries.map(([childKey, childValue]) => renderJsonTree(childValue, depth + 1, childKey)).join("")}</div>
      </details>
    `;
  }
  return `<div class="json-line">${prefix}${renderJsonScalar(value)}</div>`;
}

function renderJsonScalar(value) {
  if (typeof value === "string") return `<span class="json-string">"${escapeHtml(value)}"</span>`;
  if (typeof value === "number") return `<span class="json-number">${escapeHtml(value)}</span>`;
  if (typeof value === "boolean") return `<span class="json-boolean">${value}</span>`;
  if (value === null) return `<span class="json-null">null</span>`;
  return `<span class="json-null">${escapeHtml(String(value))}</span>`;
}

function updateCounts(payload = {}) {
  const counts = {
    system: Array.isArray(payload.system) ? payload.system.length : 0,
    messages: Array.isArray(payload.messages) ? payload.messages.length : 0,
    tools: Array.isArray(payload.tools) ? payload.tools.length : 0
  };
  for (const view of views) {
    const option = $(`view-${view.id}`);
    if (!option) continue;
    const count = view.countKey ? counts[view.countKey] : undefined;
    option.textContent = count === undefined ? view.label : `${view.label} (${count})`;
  }
}

function connectStream() {
  const source = new EventSource("/stream");
  source.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    state.events = data.events || [];
    state.selectedSessionId ||= sessions()[0]?.id;
    state.selectedHandleId ||= selectedSession()?.handles[0]?.id;
    scheduleRender();
  });
  source.addEventListener("visualizer-event", (event) => {
    const next = JSON.parse(event.data);
    state.events.push(next);
    state.selectedSessionId = next.sessionId || "sessionless";
    state.selectedHandleId = next.handleId || next.requestId || next.id;
    scheduleRender();
  });
}

document.querySelectorAll(".view-tab").forEach((button) => {
  button.addEventListener("click", () => {
    activateViewTab(button.dataset.view);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") {
      activateAdjacentView(1, false);
      requestAnimationFrame(() => focusActiveViewTab());
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "ArrowLeft") {
      activateAdjacentView(-1, false);
      requestAnimationFrame(() => focusActiveViewTab());
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Home") {
      activateViewTab(views[0].id);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "End") {
      activateViewTab(views[views.length - 1].id);
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "ArrowUp") {
      focusActiveRequestTab();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "ArrowDown") {
      focusFirstContentBlock("first");
      event.preventDefault();
      event.stopPropagation();
    }
  });
});

function activatePayloadTab(tabName, focus = false, options = {}) {
  const nextPanel = $(`panel-${tabName}`);
  if (!nextPanel) return;
  document.body.dataset.activeView = tabName;
  state.blockIndexes[tabName] = -1;
  document.querySelectorAll(".view-tab").forEach((button) => {
    const active = button.dataset.view === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((node) => node.classList.remove("active"));
  nextPanel.classList.add("active");
  updatePanelNavigation();
  hydrateJsonEditors();
  if (options.syncHash !== false) writeLocationHash();
  if (focus) {
    focusActiveViewTab();
  }
}

function activeTabName() {
  return document.querySelector(".view-tab.active")?.dataset.view || "system";
}

function activateAdjacentView(direction, focus = false) {
  const current = currentPayloadTabIndex();
  const next = Math.max(0, Math.min(views.length - 1, current + direction));
  if (next === current) return;
  activatePayloadTab(views[next].id, focus);
}

function activePanel() {
  return document.querySelector(".panel.active");
}

function navigableBlocks() {
  const panel = activePanel();
  if (!panel) return [];
  return [...panel.querySelectorAll(".block-card, .message-card, .timeline-row, .diff-row, .tool-row, .tool-section")]
    .filter((node) => node.offsetParent !== null)
    .filter((node) => !(activeTabName() === "tools" && node.classList.contains("tool-detail-card")));
}

function focusBlock(direction) {
  const blocks = navigableBlocks();
  if (!blocks.length) return;
  const tabName = activeTabName();
  const current = Number.isInteger(state.blockIndexes[tabName])
    ? state.blockIndexes[tabName]
    : direction > 0
      ? -1
      : 0;
  const next = Math.max(0, Math.min(blocks.length - 1, current + direction));
  if (next === current) return;
  document.querySelectorAll(".focused-block").forEach((node) => node.classList.remove("focused-block"));
  blocks[next].classList.add("focused-block");
  if (!blocks[next].hasAttribute("tabindex")) blocks[next].setAttribute("tabindex", "-1");
  blocks[next].focus({ preventScroll: true });
  blocks[next].scrollIntoView({ block: "center", behavior: "smooth" });
  state.blockIndexes[tabName] = next;
}

function currentNavigableBlock(blocks) {
  const active = document.activeElement?.closest?.(".block-card, .message-card, .timeline-row, .diff-row, .tool-row, .tool-section");
  if (active && blocks.includes(active)) return active;
  const focused = document.querySelector(".focused-block");
  return focused && blocks.includes(focused) ? focused : undefined;
}

function blockCenter(node) {
  const rect = node.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height
  };
}

function directionalCandidate(blocks, current, key) {
  const origin = blockCenter(current);
  const candidates = blocks
    .filter((node) => node !== current)
    .map((node) => ({ node, center: blockCenter(node) }))
    .filter(({ center }) => {
      if (key === "ArrowRight") return center.x > origin.x + Math.min(24, origin.width / 4);
      if (key === "ArrowLeft") return center.x < origin.x - Math.min(24, origin.width / 4);
      if (key === "ArrowDown") return center.y > origin.y + Math.min(24, origin.height / 4);
      if (key === "ArrowUp") return center.y < origin.y - Math.min(24, origin.height / 4);
      return false;
    });
  if (!candidates.length) return undefined;
  const horizontal = key === "ArrowRight" || key === "ArrowLeft";
  candidates.sort((a, b) => {
    const aPrimary = horizontal ? Math.abs(a.center.x - origin.x) : Math.abs(a.center.y - origin.y);
    const bPrimary = horizontal ? Math.abs(b.center.x - origin.x) : Math.abs(b.center.y - origin.y);
    const aCross = horizontal ? Math.abs(a.center.y - origin.y) : Math.abs(a.center.x - origin.x);
    const bCross = horizontal ? Math.abs(b.center.y - origin.y) : Math.abs(b.center.x - origin.x);
    return aCross * 3 + aPrimary - (bCross * 3 + bPrimary);
  });
  return candidates[0].node;
}

function focusSpecificBlock(block, blocks) {
  document.querySelectorAll(".focused-block").forEach((node) => node.classList.remove("focused-block"));
  block.classList.add("focused-block");
  if (!block.hasAttribute("tabindex")) block.setAttribute("tabindex", "-1");
  block.focus({ preventScroll: true });
  block.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  const index = blocks.indexOf(block);
  state.blockIndexes[activeTabName()] = index;
}

function activeViewTab() {
  return document.querySelector(".view-tab.active");
}

function ensureInitialViewFocus() {
  if (initialViewFocusApplied) return;
  if (document.activeElement && document.activeElement !== document.body) return;
  requestAnimationFrame(() => {
    if (initialViewFocusApplied) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    initialViewFocusApplied = focusActiveViewTab();
  });
}

function activeRequestTab() {
  return document.querySelector(`.request-tab[data-handle-id="${cssEscape(selectedHandle()?.id)}"]`);
}

function focusActiveViewTab() {
  const tab = activeViewTab();
  if (!tab) return false;
  tab.focus({ preventScroll: true });
  tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function activateViewTab(tabName) {
  activatePayloadTab(tabName, false);
  requestAnimationFrame(() => focusActiveViewTab());
}

function focusActiveRequestTab() {
  const tab = activeRequestTab();
  if (!tab) return false;
  tab.focus({ preventScroll: true });
  tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function focusFirstContentBlock(edge = "first") {
  const blocks = navigableBlocks();
  if (!blocks.length) return false;
  focusSpecificBlock(edge === "last" ? blocks[blocks.length - 1] : blocks[0], blocks);
  return true;
}

function focusFirstToolSection() {
  const sections = [...document.querySelectorAll(".tool-section")].filter((node) => node.offsetParent !== null);
  if (!sections.length) return false;
  focusSpecificBlock(sections[0], navigableBlocks());
  return true;
}

function focusBlockByArrow(key) {
  const blocks = navigableBlocks();
  if (!blocks.length) return;
  const current = currentNavigableBlock(blocks);
  if (key === "ArrowLeft" && current?.classList.contains("tool-section") && focusSelectedToolRow()) return;
  if (key === "ArrowRight" && current?.classList.contains("tool-row") && current.dataset.toolName === state.selectedToolName && focusFirstToolSection()) return;
  if (!current) {
    if (key === "ArrowUp") {
      focusActiveViewTab();
    } else if (key === "ArrowDown") {
      focusSpecificBlock(blocks[0], blocks);
    } else {
      focusSpecificBlock(key === "ArrowLeft" ? blocks[blocks.length - 1] : blocks[0], blocks);
    }
    return;
  }
  const next = directionalCandidate(blocks, current, key);
  if (next) {
    focusSpecificBlock(next, blocks);
    return;
  }
  if (key === "ArrowUp") {
    focusActiveViewTab();
    return;
  }
  if (key === "ArrowDown") {
    return;
  }
  if (key === "ArrowRight" || key === "ArrowLeft") return;
}

function clearSearchHighlights(root = document) {
  root.querySelectorAll("mark.search-hit").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent || ""));
  });
}

function textNodeAllowed(node) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (!node.nodeValue?.trim()) return false;
  return !parent.closest("mark, script, style, input, textarea, select, .jsoneditor, .view-toolbar");
}

function highlightTextNode(node, query) {
  const text = node.nodeValue || "";
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  let match = lower.indexOf(needle, index);
  if (match < 0) return;
  const fragment = document.createDocumentFragment();
  while (match >= 0) {
    if (match > index) fragment.append(document.createTextNode(text.slice(index, match)));
    const mark = document.createElement("mark");
    mark.className = "search-hit";
    mark.textContent = text.slice(match, match + query.length);
    fragment.append(mark);
    index = match + query.length;
    match = lower.indexOf(needle, index);
  }
  if (index < text.length) fragment.append(document.createTextNode(text.slice(index)));
  node.replaceWith(fragment);
}

function applyPanelSearch() {
  const panel = activePanel();
  if (!panel) return [];
  clearSearchHighlights(panel);
  const query = state.panelSearch.trim();
  if (!query) return [];
  const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => textNodeAllowed(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => highlightTextNode(node, query));
  return [...panel.querySelectorAll("mark.search-hit")];
}

function updateSearchCount(matches) {
  const count = $("search-count");
  if (!count) return;
  count.textContent = matches.length ? `${state.searchMatchIndex + 1}/${matches.length}` : "0/0";
}

function focusSearchMatch(direction) {
  const matches = applyPanelSearch();
  if (!matches.length) {
    state.searchMatchIndex = -1;
    updateSearchCount(matches);
    return;
  }
  const current = state.searchMatchIndex < 0 ? (direction > 0 ? -1 : matches.length) : state.searchMatchIndex;
  state.searchMatchIndex = Math.max(0, Math.min(matches.length - 1, current + direction));
  matches.forEach((mark) => mark.classList.remove("current"));
  matches[state.searchMatchIndex].classList.add("current");
  matches[state.searchMatchIndex].scrollIntoView({ block: "center", behavior: "smooth" });
  updateSearchCount(matches);
}

function updatePanelNavigation() {
  const search = $("panel-search");
  if (search && search.value !== state.panelSearch) search.value = state.panelSearch;
  state.searchMatchIndex = -1;
  const matches = applyPanelSearch();
  updateSearchCount(matches);
  document.querySelectorAll(".focused-block").forEach((node) => node.classList.remove("focused-block"));
}

function focusPanelSearch() {
  const search = $("panel-search");
  search?.focus();
  search?.select();
}

function clearOrBlurPanelSearch() {
  const search = $("panel-search");
  if (!search) return;
  if (state.panelSearch) {
    state.panelSearch = "";
    search.value = "";
    state.searchMatchIndex = -1;
    const matches = applyPanelSearch();
    updateSearchCount(matches);
  } else {
    search.blur();
  }
}

function currentPayloadTabIndex() {
  const active = activeTabName();
  return Math.max(0, views.findIndex((view) => view.id === active));
}

function isTypingTarget(target) {
  const element = target instanceof Element ? target : undefined;
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true'], .jsoneditor"));
}

document.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
  const activeToolSection = document.activeElement?.closest?.(".tool-section");
  if (activeToolSection && (event.key === "Enter" || event.key === " ")) {
    activeToolSection.open = !activeToolSection.open;
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const focusedNavigator = document.activeElement?.closest?.(".request-tab, .view-tab");
    if (!focusedNavigator && (!document.activeElement || document.activeElement === document.body)) {
      focusActiveViewTab();
      event.preventDefault();
      return;
    }
    focusBlockByArrow(event.key);
    event.preventDefault();
  }
});

$("previous-match").addEventListener("click", () => focusSearchMatch(-1));
$("next-match").addEventListener("click", () => focusSearchMatch(1));
$("panel-search").addEventListener("input", (event) => {
  state.panelSearch = event.target.value;
  state.searchMatchIndex = -1;
  const matches = applyPanelSearch();
  updateSearchCount(matches);
});
$("panel-search").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    focusSearchMatch(event.shiftKey ? -1 : 1);
    event.preventDefault();
  } else if (event.key === "Escape") {
    clearOrBlurPanelSearch();
    event.preventDefault();
  }
});

document.addEventListener("keydown", (event) => {
  if (isTypingTarget(event.target) || event.altKey || event.metaKey || event.ctrlKey) return;
  const numericView = Number(event.key);
  if (Number.isInteger(numericView) && numericView >= 1 && numericView <= views.length) {
    activatePayloadTab(views[numericView - 1].id, true);
    event.preventDefault();
  } else if (event.key === "/") {
    focusPanelSearch();
    event.preventDefault();
  } else if (event.key === "]" || event.key === "j") {
    focusBlock(1);
    event.preventDefault();
  }
  if (event.key === "[" || event.key === "k") {
    focusBlock(-1);
    event.preventDefault();
  }
});

$("clear-events").addEventListener("click", async () => {
  await fetch("/clear", { method: "POST" });
  state.events = [];
  state.selectedSessionId = undefined;
  state.selectedHandleId = undefined;
  render();
});

$("export-events").addEventListener("click", () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), events: state.events }, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `claude-code-scope-${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

window.addEventListener("hashchange", applyLocationHash);

const initialHashState = parseLocationHash();
if (initialHashState.toolName) state.selectedToolName = initialHashState.toolName;

connectStream();
activatePayloadTab(initialHashState.view, true, { syncHash: false });
render();
