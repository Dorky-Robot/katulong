/**
 * Helm View Component
 *
 * Renders the helm mode UI for agentic interactions. Handles the real
 * Claude Code Agent SDK event shapes:
 *
 *   system     — init (tools, session_id, cwd)
 *   assistant  — message with text and/or tool_use content blocks
 *   user       — tool_result content blocks (tool outputs)
 *   result     — final result with summary, cost, duration
 *
 * State is per-session. Each session can independently be in helm mode.
 */

/**
 * @param {object} options
 * @param {(session: string, content: string) => void} options.onSendMessage
 * @param {(session: string) => void} options.onAbort
 * @param {() => void} options.onToggleTerminal
 * @returns {object} component API
 */
export function createHelmComponent({ onSendMessage, onAbort, onToggleTerminal }) {
  let container = null;
  let messagesEl = null;
  let inputEl = null;
  let sendBtn = null;
  let statusEl = null;

  // Per-session: sessionName → { agent, entries[], status, toolUseMap }
  const sessions = new Map();
  let activeSession = null;

  function mount(el) {
    container = el;
    container.innerHTML = `
      <div class="helm-toolbar" data-helm-toolbar>
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

    container.querySelector(".helm-btn[title='Switch to terminal']")
      .addEventListener("click", onToggleTerminal);
    container.querySelector(".helm-abort-btn")
      .addEventListener("click", () => { if (activeSession) onAbort(activeSession); });

    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    });
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
    session.entries.push({ type: "user-input", content });
    appendEntry(session.entries[session.entries.length - 1]);
    onSendMessage(activeSession, content);
    inputEl.value = "";
    inputEl.style.height = "auto";
    sendBtn.disabled = true;
    setInputEnabled(false);
    session.status = "working";
    updateStatus(session);
  }

  function getOrCreateSession(name) {
    if (!sessions.has(name)) {
      sessions.set(name, { agent: null, entries: [], status: "idle", toolUseMap: new Map() });
    }
    return sessions.get(name);
  }

  // --- Public API ---

  function helmStarted(sessionName, { agent, prompt, cwd }) {
    const session = getOrCreateSession(sessionName);
    session.agent = agent;
    session.status = "working";
    session.entries = [];
    session.toolUseMap = new Map();
    if (prompt) session.entries.push({ type: "user-input", content: prompt });
    if (cwd) session.entries.push({ type: "system-info", content: `cwd: ${cwd}` });
    if (activeSession === sessionName) fullRender(session);
  }

  function helmEvent(sessionName, event) {
    const session = getOrCreateSession(sessionName);
    processEvent(session, event);
    if (activeSession === sessionName) {
      // Append only the newest entries instead of full re-render
      const last = session.entries[session.entries.length - 1];
      if (last && !last._rendered) {
        appendEntry(last);
        last._rendered = true;
      }
      // Update any tool entries that got results
      updateToolResults(session);
    }
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
    const msg = error ? `Session ended: ${error}` : `Session ${result || "ended"}`;
    session.entries.push({ type: "system-info", content: msg });
    if (activeSession === sessionName) {
      appendEntry(session.entries[session.entries.length - 1]);
      setInputEnabled(false);
      updateStatus(session);
    }
  }

  // --- Event processing ---

  function processEvent(session, event) {
    switch (event.type) {
      case "system":
        if (event.subtype === "init") {
          session.entries.push({ type: "system-info", content: `Session started (${event.tools?.length || 0} tools available)` });
        }
        break;

      case "assistant":
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              // Merge consecutive text from same assistant turn
              const prev = session.entries[session.entries.length - 1];
              if (prev?.type === "assistant-text" && !prev._sealed) {
                prev.content += block.text;
              } else {
                session.entries.push({ type: "assistant-text", content: block.text });
              }
            } else if (block.type === "tool_use") {
              const entry = {
                type: "tool-use",
                toolId: block.id,
                name: block.name,
                input: block.input,
                result: null,
                _domId: `tool-${block.id}`,
              };
              session.entries.push(entry);
              session.toolUseMap.set(block.id, entry);
              // Seal any previous text block so new text doesn't merge into it
              const prev = session.entries[session.entries.length - 2];
              if (prev?.type === "assistant-text") prev._sealed = true;
            }
          }
        }
        break;

      case "user":
        // Tool results
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              const entry = session.toolUseMap.get(block.tool_use_id);
              if (entry) {
                entry.result = typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content);
              }
            }
          }
        }
        break;

      case "result":
        session.entries.push({
          type: "result",
          content: event.result || "",
          cost: event.total_cost_usd,
          duration: event.duration_ms,
          turns: event.num_turns,
        });
        break;

      // Skip rate_limit_event and other noise
    }
  }

  // --- Rendering ---

  function showSession(sessionName) {
    activeSession = sessionName;
    const session = sessions.get(sessionName);
    if (session) {
      fullRender(session);
    } else {
      if (messagesEl) messagesEl.innerHTML = "";
      updateStatus({ agent: null, status: "idle" });
      setInputEnabled(false);
    }
  }

  function fullRender(session) {
    updateToolbar(session);
    if (messagesEl) {
      messagesEl.innerHTML = "";
      for (const entry of session.entries) {
        appendEntry(entry);
        entry._rendered = true;
      }
    }
    updateStatus(session);
    setInputEnabled(session.status === "waiting" || session.status === "turn-complete");
  }

  function appendEntry(entry) {
    if (!messagesEl) return;
    const el = renderEntry(entry);
    if (el) {
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  function renderEntry(entry) {
    const el = document.createElement("div");

    switch (entry.type) {
      case "user-input":
        el.className = "helm-msg user";
        el.textContent = entry.content;
        break;

      case "assistant-text":
        el.className = "helm-msg agent";
        el.textContent = entry.content;
        break;

      case "tool-use": {
        el.className = "helm-msg tool";
        el.id = entry._domId;
        const header = document.createElement("div");
        header.className = "helm-tool-header";
        header.innerHTML = `<span class="helm-tool-name">${esc(entry.name)}</span>`;
        el.appendChild(header);

        if (entry.input && Object.keys(entry.input).length > 0) {
          const inputEl = document.createElement("pre");
          inputEl.className = "helm-tool-input";
          inputEl.textContent = formatToolInput(entry.name, entry.input);
          el.appendChild(inputEl);
        }

        if (entry.result !== null) {
          const resultEl = document.createElement("pre");
          resultEl.className = "helm-tool-result";
          resultEl.textContent = truncate(entry.result, 2000);
          el.appendChild(resultEl);
        }
        break;
      }

      case "result": {
        el.className = "helm-msg system";
        const parts = [];
        if (entry.duration) parts.push(`${(entry.duration / 1000).toFixed(1)}s`);
        if (entry.turns) parts.push(`${entry.turns} turn${entry.turns > 1 ? "s" : ""}`);
        if (entry.cost) parts.push(`$${entry.cost.toFixed(4)}`);
        el.textContent = parts.length ? `Done (${parts.join(", ")})` : "Done";
        break;
      }

      case "system-info":
        el.className = "helm-msg system";
        el.textContent = entry.content;
        break;

      default:
        return null;
    }

    return el;
  }

  function updateToolResults(session) {
    if (!messagesEl) return;
    for (const entry of session.entries) {
      if (entry.type !== "tool-use" || entry.result === null) continue;
      const el = messagesEl.querySelector(`#${entry._domId}`);
      if (!el) continue;
      // Add result if not already shown
      if (el.querySelector(".helm-tool-result")) continue;
      const resultEl = document.createElement("pre");
      resultEl.className = "helm-tool-result";
      resultEl.textContent = truncate(entry.result, 2000);
      el.appendChild(resultEl);
    }
  }

  function updateToolbar(session) {
    const badge = container?.querySelector(".helm-agent-badge");
    if (badge) badge.textContent = session.agent || "helm";
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

  function setInputEnabled(enabled) {
    if (inputEl) inputEl.disabled = !enabled;
    if (sendBtn) sendBtn.disabled = !enabled || !inputEl?.value.trim();
    if (inputEl) inputEl.placeholder = enabled ? "Send a message..." : "Agent is working...";
  }

  function focus() {
    if (inputEl && !inputEl.disabled) inputEl.focus();
  }

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
    mount, unmount, focus, showSession, hasSession,
    helmStarted, helmEvent, helmTurnComplete, helmWaitingForInput, helmEnded,
  };
}

// --- Helpers ---

function formatToolInput(toolName, input) {
  // Show the most relevant field for common tools
  switch (toolName) {
    case "Read": return input.file_path || JSON.stringify(input);
    case "Write": return input.file_path || JSON.stringify(input);
    case "Edit": return input.file_path ? `${input.file_path}\n−${truncate(input.old_string || "", 200)}\n+${truncate(input.new_string || "", 200)}` : JSON.stringify(input);
    case "Bash": return input.command || JSON.stringify(input);
    case "Glob": return input.pattern || JSON.stringify(input);
    case "Grep": return `${input.pattern || ""}${input.path ? " in " + input.path : ""}`;
    case "WebFetch": return input.url || JSON.stringify(input);
    case "WebSearch": return input.query || JSON.stringify(input);
    default: return JSON.stringify(input, null, 2);
  }
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || "";
  return str.slice(0, max) + `\n... (${str.length - max} more chars)`;
}

function esc(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
