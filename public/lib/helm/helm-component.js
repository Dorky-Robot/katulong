/**
 * Helm View Component
 *
 * Renders the helm mode UI — a conversational interface for agentic
 * interactions. Replaces the terminal view when active, but both
 * streams stay alive so the user can toggle freely.
 *
 * State is per-session. Each session can independently have an active
 * helm session (or not). The component re-renders when the active
 * session changes or when new helm events arrive.
 */

/**
 * @param {object} options
 * @param {(session: string, content: string) => void} options.onSendMessage
 * @param {(session: string) => void} options.onAbort
 * @param {() => void} options.onToggleTerminal - switch back to terminal view
 * @returns {object} component API
 */
export function createHelmComponent({ onSendMessage, onAbort, onToggleTerminal }) {
  let container = null;
  let messagesEl = null;
  let inputEl = null;
  let sendBtn = null;
  let statusEl = null;
  let toolbarInfoEl = null;

  // Per-session state: sessionName → { agent, messages[], status }
  const sessions = new Map();
  let activeSession = null;

  function mount(el) {
    container = el;
    container.innerHTML = `
      <div class="helm-toolbar">
        <div class="helm-toolbar-info">
          <span class="helm-agent-badge"></span>
          <span class="helm-status"></span>
        </div>
        <div class="helm-toolbar-actions">
          <button class="helm-btn" title="Switch to terminal" aria-label="Switch to terminal">
            <i class="ph ph-terminal-window"></i>
          </button>
          <button class="helm-btn helm-abort-btn" title="Abort session" aria-label="Abort">
            <i class="ph ph-stop-circle"></i>
          </button>
        </div>
      </div>
      <div class="helm-messages"></div>
      <div class="helm-input-area">
        <textarea class="helm-input" placeholder="Send a message..." rows="1"></textarea>
        <button class="helm-send-btn" disabled>Send</button>
      </div>
    `;

    messagesEl = container.querySelector(".helm-messages");
    inputEl = container.querySelector(".helm-input");
    sendBtn = container.querySelector(".helm-send-btn");
    statusEl = container.querySelector(".helm-status");
    toolbarInfoEl = container.querySelector(".helm-toolbar-info");

    // Terminal toggle
    container.querySelector(".helm-btn[title='Switch to terminal']")
      .addEventListener("click", onToggleTerminal);

    // Abort
    container.querySelector(".helm-abort-btn")
      .addEventListener("click", () => {
        if (activeSession) onAbort(activeSession);
      });

    // Send message
    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // Auto-resize textarea
    inputEl.addEventListener("input", () => {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 128) + "px";
      sendBtn.disabled = !inputEl.value.trim();
    });
  }

  function handleSend() {
    const content = inputEl.value.trim();
    if (!content || !activeSession) return;

    const session = getOrCreateSession(activeSession);
    session.messages.push({ role: "user", content });
    renderMessages(session);

    onSendMessage(activeSession, content);

    inputEl.value = "";
    inputEl.style.height = "auto";
    sendBtn.disabled = true;
    setInputEnabled(false);
  }

  function getOrCreateSession(name) {
    if (!sessions.has(name)) {
      sessions.set(name, { agent: null, messages: [], status: "idle" });
    }
    return sessions.get(name);
  }

  // --- Public API called by app.js when WebSocket messages arrive ---

  function helmStarted(sessionName, { agent, prompt, cwd }) {
    const session = getOrCreateSession(sessionName);
    session.agent = agent;
    session.status = "working";
    session.messages = [];
    if (prompt) {
      session.messages.push({ role: "user", content: prompt });
    }
    if (cwd) {
      session.messages.push({ role: "system", content: `Working directory: ${cwd}` });
    }
    if (activeSession === sessionName) render(session);
  }

  function helmEvent(sessionName, event) {
    const session = getOrCreateSession(sessionName);

    // Interpret common event shapes — agent-agnostic but handle
    // the patterns most agents produce
    if (event.type === "assistant" && event.message?.content) {
      const content = extractTextContent(event.message.content);
      if (content) {
        session.messages.push({ role: "agent", content });
      }
    } else if (event.type === "tool_call" || event.type === "tool_use") {
      const toolName = event.tool || event.name || "tool";
      session.messages.push({
        role: "tool",
        content: toolName,
        input: event.input ? JSON.stringify(event.input, null, 2).slice(0, 500) : null,
      });
    } else if (event.type === "tool_result") {
      // Skip — tool results are verbose
    } else if (event.type === "result") {
      const content = extractTextContent(event.result || event.content || event.message?.content);
      if (content) {
        session.messages.push({ role: "agent", content });
      }
    } else if (event.type === "error") {
      session.messages.push({ role: "system", content: `Error: ${event.error || event.message || "Unknown error"}` });
    }

    if (activeSession === sessionName) renderMessages(session);
  }

  function helmTurnComplete(sessionName) {
    const session = getOrCreateSession(sessionName);
    session.status = "turn-complete";
    if (activeSession === sessionName) {
      setInputEnabled(true);
      updateStatus(session);
    }
  }

  function helmWaitingForInput(sessionName) {
    const session = getOrCreateSession(sessionName);
    session.status = "waiting";
    if (activeSession === sessionName) {
      setInputEnabled(true);
      updateStatus(session);
      inputEl?.focus();
    }
  }

  function helmEnded(sessionName, { result, error }) {
    const session = getOrCreateSession(sessionName);
    session.status = "ended";
    if (error) {
      session.messages.push({ role: "system", content: `Session ended: ${error}` });
    } else {
      session.messages.push({ role: "system", content: `Session ${result || "ended"}` });
    }
    if (activeSession === sessionName) {
      render(session);
      setInputEnabled(false);
    }
  }

  // --- Rendering ---

  function showSession(sessionName) {
    activeSession = sessionName;
    const session = sessions.get(sessionName);
    if (session) {
      render(session);
    } else {
      // No helm state yet — show empty
      if (messagesEl) messagesEl.innerHTML = "";
      updateStatus({ agent: null, status: "idle" });
      setInputEnabled(false);
    }
  }

  function render(session) {
    updateToolbar(session);
    renderMessages(session);
    updateStatus(session);
    setInputEnabled(session.status === "waiting" || session.status === "turn-complete");
  }

  function updateToolbar(session) {
    const badge = container?.querySelector(".helm-agent-badge");
    if (badge) {
      badge.textContent = session.agent || "helm";
    }
  }

  function updateStatus(session) {
    if (!statusEl) return;
    switch (session.status) {
      case "working":
        statusEl.innerHTML = `<span class="helm-waiting"><span class="helm-dot-pulse"><span></span><span></span><span></span></span> Working</span>`;
        break;
      case "waiting":
      case "turn-complete":
        statusEl.textContent = "Waiting for input";
        break;
      case "ended":
        statusEl.textContent = "Session ended";
        break;
      default:
        statusEl.textContent = "";
    }
  }

  function renderMessages(session) {
    if (!messagesEl) return;
    messagesEl.innerHTML = "";

    for (const msg of session.messages) {
      const el = document.createElement("div");
      el.className = `helm-msg ${msg.role}`;

      if (msg.role === "tool") {
        el.innerHTML = `<span class="helm-tool-name">${escapeHtml(msg.content)}</span>`;
        if (msg.input) {
          el.innerHTML += `<pre style="margin:4px 0 0;opacity:0.7;font-size:0.85em;overflow-x:auto">${escapeHtml(msg.input)}</pre>`;
        }
      } else {
        el.textContent = msg.content;
      }

      messagesEl.appendChild(el);
    }

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setInputEnabled(enabled) {
    if (inputEl) inputEl.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled || !inputEl?.value.trim();
    if (enabled && inputEl) {
      inputEl.placeholder = "Send a message...";
    } else if (inputEl) {
      inputEl.placeholder = "Agent is working...";
    }
  }

  function focus() {
    if (inputEl && !inputEl.disabled) inputEl.focus();
  }

  /**
   * Check if a session has any helm state.
   */
  function hasSession(sessionName) {
    const session = sessions.get(sessionName);
    return session && session.status !== "ended";
  }

  function unmount() {
    container = null;
    messagesEl = null;
    inputEl = null;
    sendBtn = null;
    statusEl = null;
  }

  return {
    mount,
    unmount,
    focus,
    showSession,
    hasSession,
    // WebSocket event handlers
    helmStarted,
    helmEvent,
    helmTurnComplete,
    helmWaitingForInput,
    helmEnded,
  };
}

// --- Helpers ---

function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");
  }
  return null;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
