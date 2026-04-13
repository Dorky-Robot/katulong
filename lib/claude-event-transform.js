/**
 * Claude Event Transform
 *
 * Pure function that translates a Claude Code hook payload into a
 * feed-tile-friendly message (step/status/detail). No server deps,
 * no side effects — easy to test.
 *
 * Claude Code's hook system POSTs JSON on lifecycle events (PostToolUse,
 * Stop, SubagentStart/Stop, etc.). Each payload includes session_id and
 * hook_event_name. This module extracts a human-readable summary suitable
 * for the feed tile's progress rendering strategy.
 */

const MAX_DETAIL_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract a short target description from tool_input.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string}
 */
function extractTarget(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";

  switch (toolName) {
    case "Edit":
    case "Read":
    case "Write":
      if (toolInput.file_path) return basename(toolInput.file_path);
      return "";
    case "Bash":
      if (toolInput.command) return truncate(toolInput.command, 40);
      return "";
    case "Grep":
    case "Glob":
      if (toolInput.pattern) return truncate(toolInput.pattern, 40);
      return "";
    case "Agent":
      if (toolInput.description) return truncate(toolInput.description, 40);
      return "";
    default:
      return "";
  }
}

function basename(filePath) {
  const i = filePath.lastIndexOf("/");
  return i >= 0 ? filePath.substring(i + 1) : filePath;
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.substring(0, max - 1) + "\u2026";
}

/**
 * Extract a readable string from tool_response, which may be a string
 * or a structured object (e.g., Bash gives { stdout, stderr }).
 */
function extractToolResponse(resp) {
  if (!resp) return "";
  if (typeof resp === "string") return resp;
  if (typeof resp === "object") {
    // Bash tool: { stdout, stderr }
    if (resp.stdout) return resp.stdout;
    if (resp.stderr) return resp.stderr;
    // Generic: try common field names
    if (resp.content) return typeof resp.content === "string" ? resp.content : "";
    if (resp.result) return typeof resp.result === "string" ? resp.result : "";
  }
  return "";
}

function truncateDetail(str) {
  if (!str || typeof str !== "string") return "";
  // Take first line only, then truncate
  const firstLine = str.split("\n")[0];
  return truncate(firstLine, MAX_DETAIL_LENGTH);
}

/**
 * Transform a Claude Code hook payload into a feed event.
 *
 * @param {object} payload - Raw hook JSON from Claude Code
 * @returns {{ topic: string, message: object } | null} - null if payload is invalid or unhandled
 */
export function transformClaudeEvent(payload) {
  if (!payload || typeof payload !== "object") return null;

  const sessionId = payload.session_id;
  const event = payload.hook_event_name;
  if (!sessionId || !event) return null;
  if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) return null;

  const topic = `claude/${sessionId}`;
  let step, status, detail;

  switch (event) {
    case "UserPromptSubmit": {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      step = `User: ${truncate(prompt || "(empty)", 60)}`;
      status = "active";
      detail = "";
      break;
    }

    case "PostToolUse": {
      const tool = payload.tool_name || "Unknown";
      const target = extractTarget(tool, payload.tool_input);
      step = target ? `${tool} ${target}` : tool;
      status = "done";
      detail = truncateDetail(extractToolResponse(payload.tool_response));
      break;
    }

    case "Stop": {
      step = "Claude responded";
      status = "done";
      detail = truncateDetail(
        typeof payload.last_assistant_message === "string"
          ? payload.last_assistant_message
          : ""
      );
      break;
    }

    case "SubagentStart": {
      const desc = payload.description || payload.agent_type || "subagent";
      step = `Subagent: ${truncate(desc, 50)}`;
      status = "active";
      detail = payload.agent_type || "";
      break;
    }

    case "SubagentStop": {
      const desc = payload.description || payload.agent_type || "subagent";
      step = `Subagent: ${truncate(desc, 50)}`;
      status = "done";
      detail = "";
      break;
    }

    case "SessionStart": {
      step = "Session started";
      status = "info";
      detail = payload.cwd || "";
      break;
    }

    case "SessionEnd": {
      step = "Session ended";
      status = "info";
      detail = "";
      break;
    }

    default:
      // Unhandled event type — still publish it as a generic log entry
      step = event;
      status = "info";
      detail = "";
      break;
  }

  return {
    topic,
    message: { step, status, detail, event, tool: payload.tool_name || null },
  };
}
