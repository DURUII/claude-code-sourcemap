const state = {
  events: [],
  selectedSessionId: undefined,
  selectedHandleId: undefined
};

const $ = (id) => document.getElementById(id);
const sidebarStateKey = "claude-code-scope:sidebar-collapsed";
let jsonEditorCounter = 0;
const pendingJsonEditors = new Map();
const mountedJsonEditors = new Map();

function initSidebar() {
  const collapsed = localStorage.getItem(sidebarStateKey) === "1";
  setSidebarCollapsed(collapsed);
  $("rail-toggle").addEventListener("click", () => {
    setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  });
}

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  localStorage.setItem(sidebarStateKey, collapsed ? "1" : "0");
  const toggle = $("rail-toggle");
  if (toggle) {
    toggle.textContent = collapsed ? "›" : "‹";
    toggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    toggle.setAttribute("aria-label", toggle.title);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function selectedPayloadEvent(handle = selectedHandle()) {
  return handle?.events.slice().reverse().find((event) => event.payload?.model || event.type === "api_request") || handle?.latest;
}

function setConnection(status, label) {
  $("connection-dot").className = `dot ${status}`;
  $("connection-label").textContent = label;
}

function render() {
  renderSessionList();
  renderHandleSummary(selectedHandle());
  renderPayload(selectedHandle());
  hydrateJsonEditors();
}

function renderHandleSummary(handle) {
  const node = $("handle-summary");
  if (!handle) {
    node.innerHTML = "No handle selected";
    return;
  }
  const event = selectedPayloadEvent(handle);
  const summary = event?.summary || {};
  node.innerHTML = `
    <strong>${escapeHtml(summary.model || event?.type || "request handle")}</strong>
    <span>${escapeHtml(event?.querySource || "unknown source")} · ${scopeLabel(event)} · ${handle.events.length} stacked events</span>
    <span>${escapeHtml(shortId(event?.sessionId || "sessionless"))} · ${escapeHtml(formatTime(handle.latest.timestamp))}</span>
    <code title="${escapeHtml(handle.id)}">request ${escapeHtml(shortId(handle.id))}</code>
  `;
}

function renderSessionList() {
  const list = $("event-list");
  const all = sessions();
  if (all.length === 0) {
    list.innerHTML = '<div class="empty">No sessions yet. Start this server, then run Claude Code with the Scope endpoint enabled.</div>';
    return;
  }
  list.innerHTML = all
    .map((session) => {
      const selected = selectedSession();
      const sessionActive = session.id === selected?.id ? " active" : "";
      const eventCount = session.handles.reduce((sum, handle) => sum + handle.events.length, 0);
      const agentCount = new Set(session.handles.map((handle) => selectedPayloadEvent(handle)?.agentId).filter(Boolean)).size;
      return `
        <section class="session-group${sessionActive}">
          <button class="session-row" data-session-id="${escapeHtml(session.id)}">
            <div class="event-row-title">
              <span>Session ${escapeHtml(shortId(session.id))}</span>
              <span>${escapeHtml(formatTime(session.latest.timestamp))}</span>
            </div>
            <div class="event-row-meta">${session.handles.length} requests · ${eventCount} events${agentCount ? ` · ${agentCount} subagents` : ""}</div>
          </button>
          <div class="request-list">
            ${session.handles.map(renderHandleRow).join("")}
          </div>
        </section>
      `;
    })
    .join("");
  list.querySelectorAll(".session-row").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSessionId = button.dataset.sessionId;
      state.selectedHandleId = undefined;
      render();
    });
  });
  list.querySelectorAll(".event-row").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSessionId = button.dataset.sessionId;
      state.selectedHandleId = button.dataset.handleId;
      render();
    });
  });
}

function renderHandleRow(handle) {
  const event = selectedPayloadEvent(handle);
  const summary = event?.summary || {};
  const active = handle.id === selectedHandle()?.id ? " active" : "";
  const requestIndex = selectedSession()?.handles.slice().reverse().findIndex((candidate) => candidate.id === handle.id);
  const ordinal = requestIndex >= 0 ? selectedSession().handles.length - requestIndex : "";
  return `
    <button class="event-row${active}" data-session-id="${escapeHtml(event?.sessionId || "sessionless")}" data-handle-id="${escapeHtml(handle.id)}">
      <div class="event-row-title">
        <span>Request ${escapeHtml(ordinal)} · ${escapeHtml(summary.model || event?.type || "request")}</span>
        <span>${escapeHtml(formatTime(handle.latest.timestamp))}</span>
      </div>
      <div class="event-row-meta">${escapeHtml(scopeLabel(event))} · ${handle.events.length} events · ${summary.messages || 0} msg · ${summary.tools || 0} tools</div>
      <div class="event-stack">${handle.events.map((stackEvent) => `<span class="stack-dot ${stackClass(stackEvent)}" title="${escapeHtml(stackEvent.type)}"></span>`).join("")}</div>
    </button>
  `;
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

function stackClass(event) {
  if (event.type.includes("error")) return "error";
  if (event.type.includes("delta") || event.type.includes("stream")) return "delta";
  return "";
}

function renderPayload(handle) {
  const event = selectedPayloadEvent(handle);
  const payload = event?.payload;
  $("request-title").textContent = handle
    ? `${event?.summary?.model || "request"} · ${scopeLabel(event)} · ${handle.events.length} stacked events`
    : "Waiting for Claude Code";

  if (!payload) {
    $("overview-grid").innerHTML = "";
    for (const name of ["system", "messages", "tools", "output", "delta", "transport", "raw"]) {
      $(`panel-${name}`).innerHTML = '<div class="empty">No request selected.</div>';
    }
    updateCounts();
    return;
  }

  renderOverview(event, handle);
  renderSystem(payload.system || []);
  renderMessages(payload.messages || []);
  renderTools(payload.tools || []);
  renderOutput(handle);
  renderDelta(handle);
  renderTransport(event, handle);
  $("panel-raw").innerHTML = renderJsonEditorCard("Raw event stack", handle.events, { height: 760, expandAll: true });
  updateCounts(payload);
}

function renderOverview(event, handle) {
  const summary = event.summary || {};
  const metrics = [
    ["Model", summary.model || "-"],
    ["Max Tokens", summary.maxTokens ?? "-"],
    ["System Blocks", summary.systemBlocks ?? 0],
    ["Messages", summary.messages ?? 0],
    ["Tools", summary.tools ?? 0],
    ["Betas", summary.betas ?? 0],
    ["Thinking", summary.thinking || "disabled"],
    ["Events", handle.events.length]
  ];
  $("overview-grid").innerHTML = metrics
    .map(([label, value]) => `
      <div class="metric">
        <div class="metric-label">${escapeHtml(label)}</div>
        <div class="metric-value" title="${escapeHtml(value)}">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");
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
  panel.innerHTML = messages
    .map((message, index) => {
      const content = Array.isArray(message.content) ? message.content : [];
      return `
        <article class="block-card">
          <div class="block-head">
            <div class="block-title">${escapeHtml(message.role || "message")} #${index + 1}</div>
            <div class="tags"><span class="tag">${content.length} blocks</span></div>
          </div>
          <div class="block-body">${content.map((block, blockIndex) => renderInlineBlock(block, blockIndex)).join("")}</div>
        </article>
      `;
    })
    .join("");
}

function renderTools(tools) {
  const panel = $("panel-tools");
  if (!tools.length) {
    panel.innerHTML = '<div class="empty">No tools defined.</div>';
    return;
  }
  panel.innerHTML = `<div class="tool-grid">${tools
    .map((tool) => `
      <article class="block-card">
        <div class="block-head">
          <div class="block-title">${escapeHtml(tool.name || "tool")}</div>
          <div class="tags"><span class="tag">${escapeHtml(tool.type || "tool")}</span></div>
        </div>
        <div class="block-body">
          <p class="muted">${escapeHtml(tool.description || "")}</p>
          <details>
            <summary>Input Schema</summary>
            <div class="block-body">${renderJsonEditorSlot(tool.input_schema || tool, { height: 280 })}</div>
          </details>
        </div>
      </article>
    `)
    .join("")}</div>`;
}

function renderOutput(handle) {
  const rows = handle.events.map((event) => `
    <div class="timeline-row">
      <div class="timeline-time">${escapeHtml(formatTime(event.timestamp))}</div>
      <div>
        <div class="block-title">${escapeHtml(event.type)}${event.attempt ? ` · attempt ${escapeHtml(event.attempt)}` : ""}</div>
        <div class="muted">${escapeHtml(event.requestId || event.id)}</div>
      </div>
    </div>
  `).join("");
  const extracted = extractOutput(handle.events);
  $("panel-output").innerHTML = `
    <div class="split-grid">
      <article class="block-card">
        <div class="block-head"><div class="block-title">Timeline & Events</div></div>
        <div class="block-body"><div class="timeline">${rows}</div></div>
      </article>
      <article class="block-card">
        <div class="block-head"><div class="block-title">Extracted Content</div></div>
        <div class="block-body">
          <p class="muted">Thinking</p>
          <pre>${escapeHtml(extracted.thinking || "No thinking delta captured yet.")}</pre>
          <p class="muted" style="margin-top:14px;">Text Response</p>
          <pre>${escapeHtml(extracted.text || "No response delta captured yet.")}</pre>
        </div>
      </article>
    </div>
  `;
}

function extractOutput(events) {
  const result = { thinking: "", text: "" };
  for (const event of events) {
    const payload = event.payload;
    const deltas = [payload?.delta, payload?.event?.delta, payload?.message?.delta].filter(Boolean);
    for (const delta of deltas) {
      if (typeof delta.text === "string") result.text += delta.text;
      if (typeof delta.thinking === "string") result.thinking += delta.thinking;
    }
    if (typeof payload?.text === "string" && event.type !== "api_request") result.text += payload.text;
    if (typeof payload?.thinking === "string") result.thinking += payload.thinking;
  }
  return result;
}

function renderDelta(handle) {
  const requestEvents = handle.events.filter((event) => event.payload?.model || event.type === "api_request");
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
  return `
    <div class="json-editor-shell" style="height:${Number(options.height || 360)}px">
      <div id="${id}" class="json-editor-slot"></div>
      <noscript>${renderJsonTree(value)}</noscript>
    </div>
  `;
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

    for (const [id, { value, options }] of pendingJsonEditors) {
      const node = document.getElementById(id);
      if (!node || mountedJsonEditors.has(id)) continue;
      if (!window.JSONEditor) {
        node.outerHTML = renderJsonTree(value);
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
    }
    pendingJsonEditors.clear();
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
  $("count-system").textContent = Array.isArray(payload.system) ? payload.system.length : 0;
  $("count-messages").textContent = Array.isArray(payload.messages) ? payload.messages.length : 0;
  $("count-tools").textContent = Array.isArray(payload.tools) ? payload.tools.length : 0;
}

function connectStream() {
  const source = new EventSource("/stream");
  source.addEventListener("open", () => setConnection("live", "Live"));
  source.addEventListener("error", () => setConnection("dead", "Disconnected"));
  source.addEventListener("snapshot", (event) => {
    const data = JSON.parse(event.data);
    state.events = data.events || [];
    state.selectedSessionId ||= sessions()[0]?.id;
    state.selectedHandleId ||= selectedSession()?.handles[0]?.id;
    render();
  });
  source.addEventListener("visualizer-event", (event) => {
    const next = JSON.parse(event.data);
    state.events.push(next);
    state.selectedSessionId = next.sessionId || "sessionless";
    state.selectedHandleId = next.handleId || next.requestId || next.id;
    render();
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((node) => node.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((node) => node.classList.remove("active"));
    tab.classList.add("active");
    $(`panel-${tab.dataset.tab}`).classList.add("active");
  });
});

$("clear-events").addEventListener("click", async () => {
  await fetch("/clear", { method: "POST" });
  state.events = [];
  state.selectedSessionId = undefined;
  state.selectedHandleId = undefined;
  render();
});

$("copy-env").addEventListener("click", async () => {
  await navigator.clipboard.writeText("CLAUDE_CODE_HTTP_VISUALIZER_ENDPOINT=http://127.0.0.1:8788/ingest").catch(() => undefined);
});

connectStream();
initSidebar();
render();
