(function () {
  const stateKey = "claude-agent-webview:vscode-state";
  const selectionStateKey = "claude-agent-webview:current-selection";

  let socket;
  let socketReady;
  const pendingMessages = [];
  const terminalRequests = new Set();
  const previewWindows = new Map();
  const interactiveWindows = new Map();
  const browserTabs = new Map();
  const pendingHostResponses = new Map();
  let browserTabCounter = 0;
  let hostCommandPolling = false;

  window.IS_SIDEBAR = false;
  window.IS_FULL_EDITOR = true;
  window.IS_SESSION_LIST_ONLY = false;
  window.IS_ANT = false;

  function readState() {
    const raw = localStorage.getItem(stateKey);
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function writeState(state) {
    localStorage.setItem(stateKey, JSON.stringify(state));
  }

  function websocketUrl() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const cwd = currentCwd();
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    return `${protocol}//${window.location.host}/bridge${query}`;
  }

  function dispatchToWebview(message) {
    window.postMessage({ type: "from-extension", message }, window.location.origin);
  }

  function showError(message) {
    const errorNode = document.querySelector("#claude-error");
    if (errorNode) errorNode.textContent = message;
  }

  function connect() {
    if (socketReady) return socketReady;
    socketReady = new Promise((resolve, reject) => {
      socket = new WebSocket(websocketUrl());

      socket.addEventListener("open", () => {
        while (pendingMessages.length > 0) socket.send(JSON.stringify(pendingMessages.shift()));
        resolve();
      });

      socket.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data);
        if (envelope.type === "bridge_ready") return;
        if (envelope.type === "bridge_error") {
          showError(envelope.error);
          return;
        }
        if (resolvePendingHostResponse(envelope.message)) return;
        handleTerminalResponse(envelope.message);
        dispatchToWebview(envelope.message);
      });

      socket.addEventListener("close", () => {
        socket = undefined;
        socketReady = undefined;
        showError("Bridge disconnected. Refresh after restarting the backend.");
      });

      socket.addEventListener("error", () => reject(new Error("Unable to connect to the Claude Agent bridge.")));
    });
    return socketReady;
  }

  window.addEventListener("storage", (event) => {
    if (event.key !== selectionStateKey) return;
    dispatchSelectionChanged(readCurrentSelection());
  });

  window.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "claude-agent-webview:plan-comment") return;
    if (typeof data.channelId !== "string" || !data.channelId) return;
    if (!data.comment || typeof data.comment !== "object") return;
    dispatchToWebview({
      type: "plan_comment",
      channelId: data.channelId,
      comment: normalizePlanComment(data.comment)
    });
  });

  function postToHost(message) {
    if (handleLocalRequest(message)) return;
    applyUrlContext(message);
    trackTerminalRequest(message);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    pendingMessages.push(message);
    connect().catch((error) => showError(error instanceof Error ? error.message : String(error)));
  }

  function trackTerminalRequest(message) {
    if (
      message?.type === "request" &&
      (message.request?.type === "open_terminal" || message.request?.type === "open_claude_in_terminal")
    ) {
      terminalRequests.add(message.requestId);
    }
  }

  function handleTerminalResponse(message) {
    if (message?.type !== "response" || !terminalRequests.delete(message.requestId)) return;
    const terminalName = message.response?.terminalName || message.response?.name;
    if (!terminalName) return;
    window.open(`/terminal?name=${encodeURIComponent(terminalName)}`, "_blank", "noopener,noreferrer");
  }

  function handleLocalRequest(message) {
    if (message?.type !== "request") return false;
    if (message.request?.type === "login") {
      configureApiKeyOnLogin(message);
      return true;
    }
    if (message.request?.type === "show_notification") {
      showHostNotification(message);
      return true;
    }
    if (message.request?.type === "open_url") {
      return respondWithWindowOpen(message, typeof message.request.url === "string" ? message.request.url : "");
    }
    if (message.request?.type === "get_current_selection") {
      return respondWithResponse(message, {
        type: "get_current_selection_response",
        selection: readCurrentSelection()
      });
    }
    if (message.request?.type === "open_file") {
      const filePath = typeof message.request.filePath === "string" ? message.request.filePath : "";
      const url = buildFileViewerUrl(filePath, message.request.location, currentCwd());
      return respondWithWindowOpen(message, url);
    }
    if (message.request?.type === "open_config_file") {
      const configType = typeof message.request.configType === "string" ? message.request.configType : "user";
      return respondWithWindowOpen(message, buildConfigViewerUrl(configType, currentCwd()));
    }
    if (message.request?.type === "open_config") {
      return respondWithWindowOpen(message, buildConfigViewerUrl("user", currentCwd()));
    }
    if (message.request?.type === "open_help") {
      return respondWithWindowOpen(message, "https://docs.anthropic.com/en/docs/claude-code");
    }
    if (message.request?.type === "open_output_panel") {
      return respondWithWindowOpen(message, "/output");
    }
    if (message.request?.type === "create_new_browser_tab") {
      const result = createBrowserTab(
        typeof message.request.tabGroupId === "string" ? message.request.tabGroupId : undefined,
        typeof message.request.url === "string" ? message.request.url : undefined
      );
      return respondWithResponse(message, {
        type: "create_new_browser_tab_response",
        ...result
      });
    }
    if (message.request?.type === "open_content") {
      const content = typeof message.request.content === "string" ? message.request.content : "";
      const title = typeof message.request.fileName === "string" ? message.request.fileName : "Content";
      return respondWithInteractiveWindow(message, renderContentDocument(message.requestId, title, content), {
        updatedContent: content
      });
    }
    if (message.request?.type === "open_markdown_preview") {
      const content = typeof message.request.content === "string" ? message.request.content : "";
      const title = typeof message.request.title === "string" ? message.request.title : "Markdown Preview";
      const channelId = typeof message.request.channelId === "string" ? message.request.channelId : "_default";
      const enableComments = message.request.enableComments === true;
      return respondWithHtmlWindow(message, renderMarkdownDocument(title, content, channelId, enableComments), {}, channelId);
    }
    if (message.request?.type === "close_plan_preview") {
      const channelId = typeof message.request.channelId === "string" ? message.request.channelId : "_default";
      const preview = previewWindows.get(channelId);
      if (preview && !preview.closed) preview.close();
      previewWindows.delete(channelId);
      return respondWithResponse(message, { type: "close_plan_preview_response", closed: Boolean(preview) });
    }
    if (message.request?.type === "open_diff") {
      const edits = Array.isArray(message.request.edits) ? message.request.edits : [];
      return respondWithInteractiveWindow(message, renderDiffDocument(message.requestId, "Diff", [{ ...message.request, edits }]), {
        newEdits: undefined
      });
    }
    if (message.request?.type === "open_file_diffs") {
      const fileDiffs = Array.isArray(message.request.fileDiffs) ? message.request.fileDiffs : [];
      return respondWithHtmlWindow(message, renderReadonlyDiffDocument("File Diffs", fileDiffs), {
        opened: true
      });
    }
    if (message.request?.type === "open_in_editor") {
      return respondWithNavigation(message, buildSessionUrl(message.request.sessionId, undefined, currentCwd()), false);
    }
    if (message.request?.type === "new_conversation_tab") {
      return respondWithNavigation(
        message,
        buildSessionUrl(message.request.sessionId, message.request.initialPrompt, currentCwd()),
        true
      );
    }
    if (message.request?.type === "open_folder" || message.request?.type === "open_folder_in_new_window") {
      const folderPath = typeof message.request.folderPath === "string" ? message.request.folderPath : currentCwd();
      return respondWithNavigation(message, buildWorkspaceUrl(folderPath), true);
    }
    return false;
  }

  function respondWithWindowOpen(message, url) {
    let opened = false;
    if (url) {
      const target = window.open(url, "_blank", "noopener,noreferrer");
      opened = Boolean(target);
    }
    dispatchToWebview({
      type: "response",
      requestId: message.requestId,
      response: { type: `${message.request.type}_response`, opened }
    });
    return true;
  }

  function respondWithHtmlWindow(message, html, extraResponse, previewKey) {
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const target = window.open(url, "_blank");
    if (previewKey && target) previewWindows.set(previewKey, target);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return respondWithResponse(message, {
      type: `${message.request.type}_response`,
      opened: Boolean(target),
      ...extraResponse
    });
  }

  function respondWithInteractiveWindow(message, html, fallbackResponse) {
    if (!document.body) {
      return respondWithResponse(message, {
        type: `${message.request.type}_response`,
        opened: false,
        ...fallbackResponse
      });
    }

    const requestId = message.requestId;
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.background = "rgba(0, 0, 0, 0.55)";
    overlay.style.display = "grid";
    overlay.style.placeItems = "center";
    overlay.style.padding = "24px";

    const iframe = document.createElement("iframe");
    iframe.title = message.request.type === "open_diff" ? "Diff" : "Content";
    iframe.style.width = "min(1120px, 100%)";
    iframe.style.height = "min(780px, 100%)";
    iframe.style.border = "1px solid #3a3a3a";
    iframe.style.boxShadow = "0 24px 80px rgba(0, 0, 0, 0.45)";
    iframe.style.background = "#101010";
    iframe.setAttribute("sandbox", "allow-scripts");
    overlay.appendChild(iframe);
    document.body.appendChild(overlay);
    iframe.srcdoc = html;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      interactiveWindows.delete(requestId);
    };
    const finish = (extraResponse) => {
      cleanup();
      respondWithResponse(message, {
        type: `${message.request.type}_response`,
        opened: true,
        ...extraResponse
      });
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data || {};
      if (data.type !== "claude-agent-webview:interactive-response" || data.requestId !== requestId) return;
      finish(data.response || fallbackResponse);
    };
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(fallbackResponse);
    };
    interactiveWindows.set(requestId, overlay);
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onKeyDown);
    return true;
  }

  function respondWithResponse(message, response) {
    dispatchToWebview({
      type: "response",
      requestId: message.requestId,
      response
    });
    return true;
  }

  function respondWithError(message, error) {
    return respondWithResponse(message, {
      type: "error",
      error: error instanceof Error ? error.message : String(error)
    });
  }

  async function showHostNotification(message) {
    try {
      if (message.request?.onlyIfNotVisible === true && document.visibilityState === "visible") {
        respondWithResponse(message, { type: "show_notification_response", buttonValue: undefined });
        return;
      }

      const buttonValue = await renderHostNotification({
        message: typeof message.request?.message === "string" ? message.request.message : "",
        severity: typeof message.request?.severity === "string" ? message.request.severity : "info",
        buttons: Array.isArray(message.request?.buttons)
          ? message.request.buttons.filter((button) => typeof button === "string")
          : []
      });
      respondWithResponse(message, { type: "show_notification_response", buttonValue });
    } catch (error) {
      respondWithError(message, error);
    }
  }

  function renderHostNotification({ message, severity, buttons }) {
    return new Promise((resolve) => {
      if (!document.body) {
        resolve(undefined);
        return;
      }

      const toast = document.createElement("section");
      toast.className = `claude-notification claude-notification-${normalizeSeverity(severity)}`;
      toast.setAttribute("role", severity === "error" ? "alert" : "status");

      const text = document.createElement("div");
      text.className = "claude-notification-message";
      text.textContent = message || "Claude Code";

      const actions = document.createElement("div");
      actions.className = "claude-notification-actions";

      let timeout;
      let resolved = false;
      const cleanup = (value) => {
        if (resolved) return;
        resolved = true;
        window.clearTimeout(timeout);
        toast.remove();
        resolve(value);
      };

      for (const button of buttons) {
        const action = document.createElement("button");
        action.className = "claude-notification-button";
        action.type = "button";
        action.textContent = button;
        action.addEventListener("click", () => cleanup(button));
        actions.appendChild(action);
      }

      const closeButton = document.createElement("button");
      closeButton.className = "claude-notification-close";
      closeButton.type = "button";
      closeButton.setAttribute("aria-label", "Dismiss notification");
      closeButton.textContent = "x";
      closeButton.addEventListener("click", () => cleanup(undefined));

      toast.append(text);
      if (buttons.length > 0) toast.append(actions);
      toast.append(closeButton);
      document.body.appendChild(toast);

      if (buttons.length === 0) timeout = window.setTimeout(() => cleanup(undefined), 4500);
    });
  }

  function normalizeSeverity(severity) {
    if (severity === "warning" || severity === "error" || severity === "info") return severity;
    return "info";
  }

  async function configureApiKeyOnLogin(message) {
    try {
      const method = typeof message.request?.method === "string" ? message.request.method : undefined;
      if (method === "claudeai") {
        respondWithError(message, "Claude.ai OAuth requires the VSCode extension host. Use Anthropic Console with an API key in standalone mode.");
        return;
      }

      const forceApiKeyPrompt = method === "console";
      const existingLogin = await requestHost("login", {});
      if (!forceApiKeyPrompt && existingLogin?.type !== "error") {
        respondWithResponse(message, existingLogin);
        return;
      }

      const apiKey = await promptForApiKey();
      if (!apiKey || !apiKey.trim()) {
        respondWithResponse(message, existingLogin);
        return;
      }

      const response = await requestHost("configure_api_key", { apiKey: apiKey.trim() });
      if (response?.type !== "error" && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "bridge_auth", apiKey: apiKey.trim() }));
      }
      respondWithResponse(message, response);
    } catch (error) {
      respondWithError(message, error);
    }
  }

  function promptForApiKey() {
    return new Promise((resolve) => {
      if (!document.body) {
        resolve(undefined);
        return;
      }

      const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const overlay = document.createElement("div");
      overlay.className = "claude-api-key-overlay";

      const dialog = document.createElement("div");
      dialog.className = "claude-api-key-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "claude-api-key-title");

      const title = document.createElement("h2");
      title.id = "claude-api-key-title";
      title.className = "claude-api-key-title";
      title.textContent = "Anthropic Console API key";

      const form = document.createElement("form");
      form.className = "claude-api-key-form";

      const label = document.createElement("label");
      label.className = "claude-api-key-label";
      label.setAttribute("for", "claude-api-key-input");
      label.textContent = "API key";

      const input = document.createElement("input");
      input.id = "claude-api-key-input";
      input.className = "claude-api-key-input";
      input.type = "password";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "sk-ant-...";

      const hint = document.createElement("div");
      hint.className = "claude-api-key-hint";
      hint.textContent = "Stored in the selected Claude settings source.";

      const actions = document.createElement("div");
      actions.className = "claude-api-key-actions";

      const cancelButton = document.createElement("button");
      cancelButton.className = "claude-api-key-button claude-api-key-button-secondary";
      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";

      const continueButton = document.createElement("button");
      continueButton.className = "claude-api-key-button claude-api-key-button-primary";
      continueButton.type = "submit";
      continueButton.textContent = "Continue";

      actions.append(cancelButton, continueButton);
      form.append(label, input, hint, actions);
      dialog.append(title, form);
      overlay.append(dialog);
      document.body.appendChild(overlay);

      let resolved = false;
      const cleanup = (value) => {
        if (resolved) return;
        resolved = true;
        window.removeEventListener("keydown", onKeyDown);
        input.value = "";
        overlay.remove();
        if (previousActiveElement && document.contains(previousActiveElement)) previousActiveElement.focus();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        cleanup(undefined);
      };

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        cleanup(value);
      });
      cancelButton.addEventListener("click", () => cleanup(undefined));
      overlay.addEventListener("mousedown", (event) => {
        if (event.target === overlay) cleanup(undefined);
      });
      window.addEventListener("keydown", onKeyDown);

      requestAnimationFrame(() => input.focus());
    });
  }

  function dispatchSelectionChanged(selection) {
    dispatchToWebview({
      type: "request",
      requestId: randomId("selection"),
      request: {
        type: "selection_changed",
        selection
      }
    });
  }

  function normalizePlanComment(comment) {
    return {
      id: typeof comment.id === "string" && comment.id ? comment.id : randomId("plan-comment"),
      selectedText: typeof comment.selectedText === "string" ? comment.selectedText : "",
      comment: typeof comment.comment === "string" ? comment.comment : "",
      createdAt: typeof comment.createdAt === "number" ? comment.createdAt : Date.now()
    };
  }

  function readCurrentSelection() {
    const raw = localStorage.getItem(selectionStateKey);
    if (!raw) return undefined;
    try {
      const selection = JSON.parse(raw);
      return normalizeSelection(selection);
    } catch {
      return undefined;
    }
  }

  function normalizeSelection(selection) {
    if (!selection || typeof selection !== "object" || typeof selection.filePath !== "string") return undefined;
    const normalized = { filePath: selection.filePath };
    for (const key of ["startLine", "endLine", "startColumn", "endColumn"]) {
      if (Number.isFinite(selection[key])) normalized[key] = Math.max(1, Math.floor(selection[key]));
    }
    if (typeof selection.selectedText === "string") normalized.selectedText = selection.selectedText;
    return normalized;
  }

  function respondWithNavigation(message, url, newWindow) {
    let opened = false;
    if (url) {
      if (newWindow) {
        opened = Boolean(window.open(url, "_blank", "noopener,noreferrer"));
      } else {
        opened = true;
        window.location.assign(url);
      }
    }
    dispatchToWebview({
      type: "response",
      requestId: message.requestId,
      response: { type: `${message.request.type}_response`, opened }
    });
    return true;
  }

  function buildFileViewerUrl(filePath, location, cwd) {
    if (!filePath) return "";
    const params = new URLSearchParams({ path: filePath });
    const startLine = location && typeof location.startLine === "number" ? location.startLine : undefined;
    if (startLine) params.set("line", String(startLine));
    if (cwd) params.set("cwd", cwd);
    return `/file?${params.toString()}`;
  }

  function buildSessionUrl(sessionId, initialPrompt, cwd) {
    const params = new URLSearchParams();
    if (typeof sessionId === "string" && sessionId) params.set("session", sessionId.replace(/^remote:/, ""));
    if (typeof initialPrompt === "string" && initialPrompt) params.set("prompt", initialPrompt);
    if (cwd) params.set("cwd", cwd);
    const query = params.toString();
    return query ? `/?${query}` : "/";
  }

  function buildWorkspaceUrl(cwd) {
    const params = new URLSearchParams();
    if (cwd) params.set("cwd", cwd);
    const query = params.toString();
    return query ? `/?${query}` : "/";
  }

  function buildConfigViewerUrl(configType, cwd) {
    const params = new URLSearchParams({ type: configType || "user" });
    if (cwd) params.set("cwd", cwd);
    return `/config?${params.toString()}`;
  }

  function buildBrowserTabUrl(tabGroupId, tabId, initialUrl) {
    const params = new URLSearchParams({ tabGroupId, tabId: String(tabId) });
    const cwd = currentCwd();
    if (cwd) params.set("cwd", cwd);
    if (initialUrl) params.set("initialUrl", initialUrl);
    return `/browser-tab?${params.toString()}`;
  }

  function browserTabKey(tabGroupId, tabId) {
    return `${tabGroupId}:${tabId}`;
  }

  function createBrowserTab(requestedTabGroupId, requestedUrl) {
    const tabGroupId = requestedTabGroupId || randomId("browser-group");
    const tabId = ++browserTabCounter;
    const tabPageUrl = buildBrowserTabUrl(tabGroupId, tabId, requestedUrl);
    const target = window.open(tabPageUrl, "_blank");
    const opened = Boolean(target);
    if (target) registerBrowserTab(tabGroupId, tabId, target, requestedUrl || "about:blank");
    return {
      tabGroupId,
      tabId,
      url: requestedUrl || "about:blank",
      opened
    };
  }

  function registerBrowserTab(tabGroupId, tabId, target, currentUrl) {
    const key = browserTabKey(tabGroupId, tabId);
    browserTabs.set(key, { tabGroupId, tabId, target, url: currentUrl, createdAt: Date.now() });
    sendHostOnlyRequest("register_browser_tab", {
      tabGroupId,
      tabId,
      url: currentUrl,
      cwd: currentCwd(),
      title: "Claude Browser Tab"
    });
    const interval = window.setInterval(() => {
      const tab = browserTabs.get(key);
      if (!tab || !tab.target.closed) return;
      window.clearInterval(interval);
      browserTabs.delete(key);
      sendHostOnlyRequest("close_browser_tab", { tabGroupId, tabId });
    }, 1000);
  }

  function sendHostOnlyRequest(type, request) {
    const message = {
      type: "request",
      requestId: randomId(type),
      request: { type, ...request }
    };
    applyUrlContext(message);
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      return;
    }
    pendingMessages.push(message);
    connect().catch((error) => showError(error instanceof Error ? error.message : String(error)));
  }

  async function requestHost(type, request) {
    const message = {
      type: "request",
      requestId: randomId(type),
      request: { type, ...request }
    };
    applyUrlContext(message);
    await connect();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingHostResponses.delete(message.requestId);
        reject(new Error(`${type} timed out.`));
      }, 30_000);
      pendingHostResponses.set(message.requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify(message));
    });
  }

  function resolvePendingHostResponse(message) {
    if (message?.type !== "response") return false;
    const pending = pendingHostResponses.get(message.requestId);
    if (!pending) return false;
    window.clearTimeout(pending.timeout);
    pendingHostResponses.delete(message.requestId);
    pending.resolve(message.response);
    return true;
  }

  async function pollBrowserHostCommands() {
    if (hostCommandPolling) return;
    hostCommandPolling = true;
    try {
      const response = await fetch("/browser-host/commands", { cache: "no-store" });
      const payload = await response.json();
      const commands = Array.isArray(payload.commands) ? payload.commands : [];
      for (const command of commands) await handleBrowserHostCommand(command);
    } catch {
      // The websocket path surfaces bridge failures. Polling should stay quiet while the server restarts.
    } finally {
      hostCommandPolling = false;
    }
  }

  async function handleBrowserHostCommand(command) {
    let result;
    let error;
    try {
      if (command.type === "tabs_create") {
        result = createBrowserTab(
          typeof command.payload?.tabGroupId === "string" ? command.payload.tabGroupId : undefined,
          typeof command.payload?.url === "string" ? command.payload.url : undefined
        );
      } else {
        throw new Error(`Unknown browser host command: ${command.type}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    await fetch("/browser-host/commands/" + encodeURIComponent(command.id) + "/result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result, error })
    });
  }

  function randomId(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function renderContentDocument(requestId, title, content) {
    return renderDocument(
      title,
      `<main class="content-review">
        <textarea id="content" spellcheck="false">${escapeHtml(content)}</textarea>
        <footer>
          <button id="cancel" type="button">Cancel</button>
          <button id="accept" type="button">Accept</button>
        </footer>
      </main>
      <script>
        const requestId = ${JSON.stringify(requestId)};
        const textarea = document.getElementById("content");
        function send(response) {
          (window.opener || window.parent)?.postMessage({ type: "claude-agent-webview:interactive-response", requestId, response }, "*");
          window.close();
        }
        document.getElementById("accept").addEventListener("click", () => send({ updatedContent: textarea.value }));
        document.getElementById("cancel").addEventListener("click", () => send({ updatedContent: ${JSON.stringify(content)} }));
        textarea.focus();
      </script>`,
      contentStyles()
    );
  }

  function renderMarkdownDocument(title, content, channelId, enableComments) {
    return renderDocument(
      title,
      `<main class="markdown ${enableComments ? "comments-enabled" : ""}">
        <pre id="plan-content">${escapeHtml(content)}</pre>
        ${
          enableComments
            ? `<aside class="comment-panel" aria-label="Plan comments">
                <div class="comment-title">Plan comments</div>
                <div id="selected-text" class="selected-text">Select text in the plan.</div>
                <textarea id="comment-input" placeholder="Comment" rows="3"></textarea>
                <div class="comment-actions">
                  <button id="add-comment" type="button">Add comment</button>
                </div>
                <div id="comment-status" class="comment-status" role="status"></div>
              </aside>
              <script>
                const channelId = ${JSON.stringify(channelId)};
                const selectedTextNode = document.getElementById("selected-text");
                const commentInput = document.getElementById("comment-input");
                const addButton = document.getElementById("add-comment");
                const statusNode = document.getElementById("comment-status");
                let selectedText = "";
                function updateSelection() {
                  const selection = window.getSelection();
                  const text = selection ? selection.toString().replace(/\\s+/g, " ").trim() : "";
                  selectedText = text.slice(0, 500);
                  selectedTextNode.textContent = selectedText || "Select text in the plan.";
                }
                document.addEventListener("selectionchange", updateSelection);
                addButton.addEventListener("click", () => {
                  const comment = commentInput.value.trim();
                  if (!selectedText) {
                    statusNode.textContent = "Select text first.";
                    return;
                  }
                  if (!comment) {
                    commentInput.focus();
                    statusNode.textContent = "Add a comment.";
                    return;
                  }
                  const payload = {
                    type: "claude-agent-webview:plan-comment",
                    channelId,
                    comment: {
                      id: "plan-comment-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)),
                      selectedText,
                      comment,
                      createdAt: Date.now()
                    }
                  };
                  window.opener?.postMessage(payload, window.location.origin);
                  commentInput.value = "";
                  statusNode.textContent = "Comment added.";
                });
              </script>`
            : ""
        }
      </main>`,
      `main { max-width: 880px; margin: 0 auto; padding: 24px; } pre { white-space: pre-wrap; word-break: break-word; line-height: 1.55; } .comments-enabled { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 20px; max-width: 1180px; } .comment-panel { position: sticky; top: 58px; align-self: start; display: grid; gap: 8px; padding: 12px; background: #1b1b1b; border: 1px solid #333; } .comment-title { font-weight: 600; } .selected-text { color: #b7b7b7; font-size: 12px; line-height: 1.4; max-height: 90px; overflow: auto; } textarea { box-sizing: border-box; width: 100%; resize: vertical; min-height: 72px; background: #101010; color: #e6e6e6; border: 1px solid #454545; padding: 8px; font: inherit; } .comment-actions { display: flex; justify-content: flex-end; } button { border: 1px solid #454545; background: #2b2b2b; color: #e6e6e6; padding: 6px 10px; border-radius: 4px; font: inherit; cursor: pointer; } .comment-status { min-height: 18px; color: #b7b7b7; font-size: 12px; } @media (max-width: 760px) { .comments-enabled { grid-template-columns: 1fr; } .comment-panel { position: static; } }`
    );
  }

  function renderDiffDocument(requestId, title, fileDiffs) {
    const sections = fileDiffs
      .map((fileDiff, index) => {
        const originalPath = fileDiff.originalFilePath || fileDiff.oldFilePath || fileDiff.filePath || `diff-${index + 1}`;
        const newPath = fileDiff.newFilePath || fileDiff.filePath || originalPath;
        const edits = Array.isArray(fileDiff.edits) ? fileDiff.edits : [];
        const rows = edits.length
          ? edits
              .map((edit, editIndex) => {
                const oldText = edit.oldString ?? edit.oldText ?? "";
                const newText = edit.newString ?? edit.newText ?? "";
                const replaceAll = Boolean(edit.replaceAll ?? edit.replace_all);
                const inputId = `diff-edit-${index}-${editIndex}`;
                return `<div class="edit" data-edit-index="${editIndex}" data-old-string="${escapeAttr(String(oldText))}" data-replace-all="${replaceAll ? "true" : "false"}"><div class="edit-title">Edit ${editIndex + 1}</div><div class="cols"><pre class="old">${escapeHtml(String(oldText))}</pre><textarea id="${inputId}" name="${inputId}" class="new" spellcheck="false">${escapeHtml(String(newText))}</textarea></div></div>`;
              })
              .join("")
          : `<div class="empty">No inline edits were provided for this diff.</div>`;
        return `<section><h2>${escapeHtml(String(originalPath))}${newPath !== originalPath ? ` -> ${escapeHtml(String(newPath))}` : ""}</h2>${rows}</section>`;
      })
      .join("");
    return renderDocument(
      title,
      `<main>${sections || '<div class="empty">No diffs.</div>'}</main>
      <footer>
        <button id="cancel" type="button">Cancel</button>
        <button id="accept" type="button">Accept</button>
      </footer>
      <script>
        const requestId = ${JSON.stringify(requestId)};
        function collectEdits() {
          return Array.from(document.querySelectorAll(".edit")).map((node) => {
            const oldString = node.dataset.oldString || "";
            const newString = node.querySelector("textarea.new")?.value || "";
            const replaceAll = node.dataset.replaceAll === "true";
            return { oldString, newString, oldText: oldString, newText: newString, replaceAll };
          });
        }
        function send(response) {
          (window.opener || window.parent)?.postMessage({ type: "claude-agent-webview:interactive-response", requestId, response }, "*");
          window.close();
        }
        document.getElementById("accept").addEventListener("click", () => send({ newEdits: collectEdits() }));
        document.getElementById("cancel").addEventListener("click", () => send({ newEdits: undefined }));
        document.querySelector("textarea.new")?.focus();
      </script>`,
      diffStyles()
    );
  }

  function renderReadonlyDiffDocument(title, fileDiffs) {
    const sections = fileDiffs
      .map((fileDiff, index) => {
        const originalPath = fileDiff.originalFilePath || fileDiff.oldFilePath || fileDiff.filePath || `diff-${index + 1}`;
        const newPath = fileDiff.newFilePath || fileDiff.filePath || originalPath;
        const edits = Array.isArray(fileDiff.edits) ? fileDiff.edits : [];
        const rows = edits.length
          ? edits
              .map((edit, editIndex) => {
                const oldText = edit.oldString ?? edit.oldText ?? "";
                const newText = edit.newString ?? edit.newText ?? "";
                return `<div class="edit"><div class="edit-title">Edit ${editIndex + 1}</div><div class="cols"><pre class="old">${escapeHtml(String(oldText))}</pre><pre class="new">${escapeHtml(String(newText))}</pre></div></div>`;
              })
              .join("")
          : `<div class="empty">No inline edits were provided for this diff.</div>`;
        return `<section><h2>${escapeHtml(String(originalPath))}${newPath !== originalPath ? ` -> ${escapeHtml(String(newPath))}` : ""}</h2>${rows}</section>`;
      })
      .join("");
    return renderDocument(title, `<main>${sections || '<div class="empty">No diffs.</div>'}</main>`, readonlyDiffStyles());
  }

  function renderDocument(title, body, extraStyles) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #101010; color: #e6e6e6; font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { position: sticky; top: 0; z-index: 1; padding: 10px 14px; background: #1f1f1f; border-bottom: 1px solid #333; }
    ${extraStyles}
  </style>
</head>
<body>
  <header>${escapeHtml(title)}</header>
  ${body}
</body>
</html>`;
  }

  function contentStyles() {
    return `main.content-review { height: calc(100vh - 41px); display: grid; grid-template-rows: minmax(0, 1fr) auto; } textarea { box-sizing: border-box; width: 100%; min-height: 100%; padding: 14px; border: 0; outline: 0; resize: none; background: #101010; color: #e6e6e6; font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 20px; } footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; background: #1b1b1b; border-top: 1px solid #333; } button { border: 1px solid #454545; background: #2b2b2b; color: #e6e6e6; padding: 6px 12px; border-radius: 4px; font: inherit; } button#accept { background: #2563eb; border-color: #2563eb; }`;
  }

  function diffStyles() {
    return `main { padding: 16px 16px 72px; } section { margin-bottom: 24px; border: 1px solid #333; } h2 { margin: 0; padding: 10px 12px; background: #1b1b1b; font-size: 13px; font-weight: 600; } .edit { border-top: 1px solid #333; } .edit-title { padding: 8px 12px; color: #b7b7b7; background: #151515; } .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } pre, textarea.new { box-sizing: border-box; width: 100%; min-height: 160px; margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 18px; border: 0; outline: 0; resize: vertical; color: #e6e6e6; } .old { background: #241616; } textarea.new { background: #162416; } .empty { padding: 14px; color: #b7b7b7; } footer { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 10px 12px; background: #1b1b1b; border-top: 1px solid #333; } button { border: 1px solid #454545; background: #2b2b2b; color: #e6e6e6; padding: 6px 12px; border-radius: 4px; font: inherit; } button#accept { background: #2563eb; border-color: #2563eb; } @media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }`;
  }

  function readonlyDiffStyles() {
    return `main { padding: 16px; } section { margin-bottom: 24px; border: 1px solid #333; } h2 { margin: 0; padding: 10px 12px; background: #1b1b1b; font-size: 13px; font-weight: 600; } .edit { border-top: 1px solid #333; } .edit-title { padding: 8px 12px; color: #b7b7b7; background: #151515; } .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 18px; } .old { background: #241616; } .new { background: #162416; } .empty { padding: 14px; color: #b7b7b7; } @media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("\n", "&#10;").replaceAll("\r", "&#13;");
  }

  function currentCwd() {
    const params = new URLSearchParams(window.location.search);
    return params.get("cwd") || "";
  }

  function applyUrlContext(message) {
    const cwd = currentCwd();
    if (cwd && message?.type === "launch_claude" && !message.cwd) message.cwd = cwd;
  }

  window.acquireVsCodeApi = () => ({
    postMessage: postToHost,
    getState: readState,
    setState: writeState
  });

  connect();
  pollBrowserHostCommands();
  setInterval(pollBrowserHostCommands, 700);
})();
