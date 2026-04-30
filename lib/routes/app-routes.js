/**
 * Application routes
 *
 * All non-auth HTTP routes: pages, upload/paste, sessions CRUD, session I/O,
 * tmux browser, notes, config, pub/sub. Extracted from lib/routes.js
 * (Tier 3.4).
 *
 * Auth routes live in ./auth-routes.js. Middleware (auth + csrf) lives in
 * ./middleware.js. Image upload helpers live in ./upload.js.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { loadState } from "../auth.js";
import {
  parseCookies, getCsrfToken, escapeAttr, getCspHeaders,
} from "../http-util.js";
import { SessionName } from "../session-name.js";
import { SESSION_ID_PATTERN } from "../id.js";
import { loadShortcuts, saveShortcuts } from "../shortcuts.js";
import { log } from "../log.js";
import { rewriteVendorUrls } from "../static-files.js";
import { captureVisiblePane, tmuxSocketArgs } from "../tmux.js";
import { bridgeClipboardToContainers, bridgePaneContainer } from "../container-detect.js";
import { readRawBody, readBody } from "../request-util.js";
import { transformClaudeEvent, readTranscriptEntries, UUID_RE } from "../claude-event-transform.js";
import { parsePreToolUsePayload } from "../claude-permissions.js";
import { pollForPermissionPrompt } from "../claude-pane-scanner.js";
import { getClaudeHooksStatus, installClaudeHooks } from "../claude-hooks.js";
import {
  MAX_UPLOAD_BYTES, detectImage, imageMimeType, setClipboard,
} from "./upload.js";
import { replayPasteSequence } from "../paste-sequence.js";
import { PRIVATE_META_KEYS, publicMeta } from "../session-meta-filter.js";
import { resolveFilePath } from "../worktree-resolver.js";

// Re-export so existing route tests and callers continue to import these
// from app-routes.js. Source of truth lives in session-meta-filter.js so
// the WS relay in session-manager.js can share the filter without a
// reverse dependency on this module.
export { PRIVATE_META_KEYS, publicMeta };

// Caps applied at the paste entrypoints. 50 tokens accommodates a
// text-heavy reply with several interleaved images without letting an
// authenticated caller queue an unbounded chain of subprocess-spawning
// clipboard ops. 2000 chars matches the /api/claude/respond text cap so
// both entrypoints have a consistent envelope.
const MAX_PASTE_TOKENS = 50;
const MAX_PASTE_TEXT_LEN = 2000;
const PEER_TEST_TIMEOUT_MS = 5000;

/**
 * Validate a hook-provided transcript_path before stamping it into meta.
 *
 * The path is trusted enough to be read later by the narrative processor
 * (arbitrary disk read), so the shape check is strict: must be absolute,
 * must live under `<home>/.claude/projects/<something>/`, must end in
 * `<uuid>.jsonl` where uuid matches the hook's session_id, and must
 * collapse cleanly (no `..` segments survive normalization). A malformed
 * path just drops the enrichment — uuid still stamps via the regular flow.
 *
 * Returns the normalized path on success, `null` on any validation failure.
 */
export function safeTranscriptPath(rawPath, uuid) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return null;
  if (!rawPath.startsWith("/")) return null;
  const norm = normalize(rawPath);
  if (!norm.startsWith("/")) return null;
  if (norm.split("/").includes("..")) return null;
  if (!norm.includes("/.claude/projects/")) return null;
  if (!uuid || !UUID_RE.test(uuid)) return null;
  if (!norm.endsWith(`/${uuid}.jsonl`)) return null;
  return norm;
}

/**
 * Apply a Claude hook payload to `session.meta.claude` via the provided
 * sessionManager. Exported for unit tests — the live /api/claude-events
 * handler is the only production caller.
 *
 * This writer owns `meta.claude.{uuid, startedAt, transcriptPath}` —
 * Claude-specific enrichment needed to resolve the transcript on disk.
 * The pane monitor (lib/claude-session-discovery.js) owns `cwd` in the
 * same namespace: it reads the per-pid Claude session JSON which carries
 * Claude's launch cwd. When the uuid is unchanged, this writer preserves
 * that `cwd` across the replace so a hook event doesn't wipe out the
 * file-link resolver's directory hint.
 *
 * `transcriptPath` is the ground-truth path Claude Code writes to, taken
 * directly from the hook payload. Previously we re-derived it by slugging
 * the live tmux pane cwd — which stalled the feed whenever the shell had
 * cd'd after Claude launched (worktree vs canonical repo, symlinked
 * paths, spaces in path). Stamping the hook value removes the guessing.
 *
 * Returns `"set"` / `"cleared"` / `null` describing what happened. Unknown
 * panes, malformed panes, and unrelated events all return `null`.
 *
 * @param {object} payload - raw hook payload (already JSON-parsed)
 * @param {{ getSessionByPane: (pane: string) => object | undefined }} sessionManager
 * @param {{ warn: Function } | null} [logger]
 * @returns {"set" | "cleared" | null}
 */
export function applyClaudeMetaFromHook(payload, sessionManager, logger = null) {
  if (!payload || typeof payload !== "object") return null;
  const pane = typeof payload._tmuxPane === "string" ? payload._tmuxPane : null;
  if (!pane || !/^%\d+$/.test(pane)) return null;

  const session = sessionManager.getSessionByPane(pane);
  if (!session) return null;

  const event = payload.hook_event_name;
  if (event === "SessionEnd" || event === "Stop") {
    // Intentionally NOT clearing meta.claude.uuid on session exit. The
    // uuid + startedAt are the pointer that lets the client keep reading
    // the transcript file after Claude quits — the transcript JSONL lives
    // on disk and a watched uuid should keep resolving indefinitely.
    // Whether Claude is currently running is answered by meta.agent.
    return null;
  }

  const current = (session.meta && session.meta.claude) ? session.meta.claude : null;
  // SessionStart always adopts the uuid — that's the explicit new-session
  // signal. Other hook events (UserPromptSubmit, PreToolUse, PostToolUse,
  // …) only adopt when we don't already have one, covering the case where
  // hooks were installed after Claude already started and SessionStart is
  // already in the past. Only SessionStart may replace a known uuid.
  if (event === "SessionStart" || (event && current?.uuid == null)) {
    // Validate UUID shape before writing — the value becomes a topic name
    // prefix (`claude/<uuid>`) on the client, and we don't want a bogus
    // hook payload polluting meta with a non-UUID string.
    const uuid = typeof payload.session_id === "string" ? payload.session_id : null;
    if (!uuid || !UUID_RE.test(uuid)) return null;
    const transcriptPath = safeTranscriptPath(payload.transcript_path, uuid);
    const next = { uuid, startedAt: Date.now() };
    if (transcriptPath) next.transcriptPath = transcriptPath;
    // Preserve the pane monitor's `cwd` across a uuid-stable hook write
    // so file-link resolution doesn't drop to the stale pane shell cwd
    // whenever SessionStart/UserPromptSubmit fires.
    if (current?.uuid === uuid && typeof current?.cwd === "string") {
      next.cwd = current.cwd;
    }
    try {
      session.setMeta("claude", next);
      return "set";
    } catch (err) {
      logger?.warn?.("Failed to set meta.claude from hook", {
        session: session.name, event, error: err.message,
      });
      return null;
    }
  }
  return null;
}

// Returns the first private key name found in caller-supplied meta, or null.
// Callers turn a non-null return into a 400. Without this check a client
// could forge `transcriptPath` via POST /pub or POST /api/topics/:topic/meta
// and turn the transcript endpoint into an arbitrary file read.
function hasPrivateKey(meta) {
  if (!meta || typeof meta !== "object") return null;
  for (const k of Object.keys(meta)) {
    if (PRIVATE_META_KEYS.has(k)) return k;
  }
  return null;
}

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, readBody, isAuthenticated, sessionManager,
    bridge,
    configManager, __dirname, DATA_DIR, APP_VERSION,
    getDraining, shortcutsPath,
    auth, csrf, topicBroker, getExternalUrl,
    permissionStore, callOllama,
  } = ctx;

  // Tracks the async pane-scan started by each PreToolUse, keyed by the
  // Claude session uuid. `stop = true` is the signal written by
  // PostToolUse to abort the poll once the tool has run (so an auto-
  // approved tool doesn't waste a few seconds of scanning). Entries are
  // deleted when the poll resolves. Bounded in practice by "one entry
  // per active Claude session" so no unbounded-growth risk.
  const inflightPermissionPolls = new Map();

  // Parse `/sessions/by-id/:id[/suffix]` route params. Returns either:
  //   { session, suffix }       — session found (suffix is null for bare
  //                                /sessions/by-id/:id, or the string after
  //                                the next slash like "exec" / "status")
  //   { error: { status, message } }
  //
  // Validating the id shape here means handlers never see a bogus id and
  // don't need to catch a separate "invalid format" vs "not found" case.
  // Suffix is kept as a raw opaque string; handlers compare it themselves.
  function resolveByIdParam(param) {
    const slash = param.indexOf("/");
    const id = slash === -1 ? param : param.slice(0, slash);
    const suffix = slash === -1 ? null : param.slice(slash + 1);
    if (!SESSION_ID_PATTERN.test(id)) {
      return { error: { status: 400, message: "Invalid session id" } };
    }
    const session = sessionManager.getSessionById(id);
    if (!session) {
      return { error: { status: 404, message: "Session not found" } };
    }
    return { session, suffix };
  }

  function configPutRoute(path, fieldName, setter, getter) {
    return { method: "PUT", path, handler: auth(csrf(async (req, res) => {
      const body = await parseJSON(req);
      const value = body[fieldName];
      try {
        await setter(value);
        log.info(`${fieldName} updated`, { [fieldName]: value });
        json(res, 200, { success: true, [fieldName]: getter() });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    }))};
  }

  return [
    // --- Health ---

    { method: "GET", path: "/health", handler: (req, res) => {
      if (getDraining()) {
        return json(res, 503, { status: "draining" });
      }
      const response = { status: "ok", version: APP_VERSION };
      // Only include diagnostic details for authenticated requests
      if (isAuthenticated(req)) {
        response.pid = process.pid;
        response.uptime = process.uptime();
        // Surface which LLM backend is currently in use (peer-bridge,
        // local-31b, local-cloud) so an operator can see at a glance
        // whether the cascade is hitting the bridge or has fallen back.
        const active = callOllama?.getActiveBackend?.();
        response.llm = active
          ? { backend: active.name, model: active.model }
          : { backend: null };
      }
      json(res, 200, response);
    }},

    // --- Pages ---

    { method: "GET", path: "/", handler: (req, res) => {
      let html = readFileSync(join(__dirname, "public", "index.html"), "utf-8");

      const cookies = parseCookies(req.headers.cookie);
      const sessionToken = cookies.get("katulong_session");
      if (sessionToken) {
        const state = loadState();
        const csrfToken = getCsrfToken(state, sessionToken);
        if (csrfToken) {
          html = html.replace("<head>", `<head>\n    <meta name="csrf-token" content="${escapeAttr(csrfToken)}">`);
        }
      }

      html = html.replace("<body>", `<body data-version="${escapeAttr(APP_VERSION)}">`);

      // Rewrite vendor URLs with content hashes for CDN cache busting
      html = rewriteVendorUrls(html);

      res.writeHead(200, {
        "Content-Type": "text/html",
        ...getCspHeaders()
      });
      res.end(html);
    }},

    { method: "GET", path: "/manifest.json", handler: (req, res) => {
      const manifest = readFileSync(join(__dirname, "public", "manifest.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(manifest);
    }},

    // Service worker — inject version so PWA cache updates on each release
    { method: "GET", path: "/sw.js", handler: (req, res) => {
      try {
        const swContent = readFileSync(join(__dirname, "public", "sw.js"), "utf-8")
          .replace(/__APP_VERSION__/g, APP_VERSION);
        res.writeHead(200, {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(swContent);
      } catch (err) {
        log.error("Failed to serve sw.js", { error: err.message });
        res.writeHead(500);
        res.end();
      }
    }},

    { method: "GET", path: "/login", handler: (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        ...getCspHeaders()
      });
      let loginHtml = readFileSync(join(__dirname, "public", "login.html"), "utf-8");
      loginHtml = rewriteVendorUrls(loginHtml);
      res.end(loginHtml);
    }},

    // --- Upload ---

    { method: "POST", path: "/upload", handler: auth(csrf(async (req, res) => {
      let buf;
      try {
        buf = await readRawBody(req, MAX_UPLOAD_BYTES);
      } catch {
        return json(res, 413, { error: "File too large (max 10 MB)" });
      }
      const ext = detectImage(buf);
      if (!ext) {
        return json(res, 400, { error: "Not a supported image type" });
      }
      const uploadsDir = join(DATA_DIR, "uploads");
      mkdirSync(uploadsDir, { recursive: true });
      const filename = `${randomUUID()}.${ext}`;
      const filePath = join(uploadsDir, filename);
      writeFileSync(filePath, buf);

      // Set clipboard during upload. For multi-file drops, the client
      // queues the Ctrl+V sends sequentially — each upload's /paste call
      // re-sets the clipboard before sending Ctrl+V.
      let clipboard = await setClipboard(filePath, ext, log);
      const mimeType = imageMimeType(ext);
      const containerBridged = await bridgeClipboardToContainers(filename, mimeType, log);
      if (containerBridged) clipboard = true;

      // Bridge to the container the user has docker-exec'd into (if any)
      if (!containerBridged) {
        const sessionHeader = req.headers["x-session"];
        const sessionName = sessionHeader ? SessionName.tryCreate(sessionHeader) : null;
        if (sessionName) {
          const paneBridged = await bridgePaneContainer(sessionName.toString(), sessionManager, filePath, mimeType, log);
          if (paneBridged) clipboard = true;
        }
      }

      json(res, 200, { path: `/uploads/${filename}`, fsPath: filePath, clipboard });
    }))},

    // --- Paste (set clipboard + write Ctrl+V to PTY for each image) ---
    //
    // Accepts one of two request shapes:
    //
    //   { paths: [...], session }            — image-only (xterm clipboard bridge)
    //   { tokens: [...], session, submit }   — interleaved text + image
    //                                           (feed tile reply). Tokens are
    //                                           `{ type: "text", value }` and
    //                                           `{ type: "image", path }` in
    //                                           the order they should land in
    //                                           the pane. `submit: true` appends
    //                                           a real Enter (\r) at the end.
    //
    // Sequencing, clipboard bridging, and pane delivery live in
    // `lib/paste-sequence.js` so both shapes share one implementation.

    { method: "POST", path: "/paste", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const rawTokens = Array.isArray(data.tokens) ? data.tokens : null;
      const rawPaths = Array.isArray(data.paths) ? data.paths : data.path ? [data.path] : [];
      const tokens = rawTokens
        ? rawTokens.filter((t) => t && (t.type === "text" || t.type === "image"))
        : rawPaths.filter((p) => typeof p === "string").map((path) => ({ type: "image", path }));

      if (tokens.length === 0) return json(res, 400, { error: "Missing paths or tokens" });
      // Bound token array so an authenticated caller can't queue an
      // unbounded chain of subprocess-spawning clipboard ops.
      if (tokens.length > MAX_PASTE_TOKENS) return json(res, 400, { error: "Too many tokens" });
      const textTotal = tokens
        .filter((t) => t.type === "text" && typeof t.value === "string")
        .reduce((n, t) => n + t.value.length, 0);
      if (textTotal > MAX_PASTE_TEXT_LEN) return json(res, 400, { error: "Paste text too long" });

      const pasteSession = data.session ? SessionName.tryCreate(data.session)?.toString() : null;
      const session = pasteSession ? sessionManager.getSession(pasteSession) : null;
      // No 404 if session is missing — legacy drag-drop sets the host clipboard
      // without a target session. The replayer skips \x16 / text writes when
      // the session is absent.

      const uploadsDir = join(DATA_DIR, "uploads");
      const submit = data.submit === true;
      const imageCount = tokens.filter((t) => t.type === "image").length;

      // Respond immediately — replay happens async with WS progress updates
      json(res, 200, { queued: imageCount, tokens: tokens.length });

      replayPasteSequence({
        tokens, session, sessionName: pasteSession, sessionManager,
        uploadsDir, submit,
        setClipboard, bridgeClipboardToContainers, bridgePaneContainer, imageMimeType,
        logger: log,
        onImagePasted: (path) => bridge.relay({ type: "paste-complete", session: pasteSession, path }),
      }).catch((err) => {
        log.warn("paste-sequence replay failed", { session: data.session, error: err.message });
      });
    }))},

    // --- Shortcuts ---

    { method: "GET", path: "/shortcuts", handler: auth((req, res) => {
      const result = loadShortcuts(shortcutsPath);
      json(res, 200, result.success ? result.data : []);
    })},

    { method: "PUT", path: "/shortcuts", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const result = saveShortcuts(shortcutsPath, data);
      json(res, result.success ? 200 : 400, result.success ? { ok: true } : { error: result.message });
    }))},

    // --- Attach (open tab in browser, create session if needed) ---

    { method: "POST", path: "/attach", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const sessionName = data.name ? SessionName.tryCreate(data.name) : null;
      if (!sessionName) return json(res, 400, { error: "Invalid session name" });
      const session = sessionManager.getSession(sessionName.toString());
      if (!session) return json(res, 404, { error: "Session not found" });
      bridge.relay({ type: "open-tab", session: sessionName.toString() });
      json(res, 200, { name: sessionName.toString() });
    }))},

    // --- Notify (send native notification to connected browsers) ---

    { method: "POST", path: "/notify", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const message = typeof data.message === "string" ? data.message.slice(0, 1000) : "";
      if (!message) return json(res, 400, { error: "Missing message" });
      const title = typeof data.title === "string" ? data.title.slice(0, 200) : "Katulong";
      bridge.relay({ type: "notification", title, message });
      json(res, 200, { ok: true });
    }))},

    // --- Pub/Sub ---

    { method: "POST", path: "/pub", handler: auth(csrf(async (req, res) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      const data = await parseJSON(req);
      const topic = typeof data.topic === "string" ? data.topic.slice(0, 128) : "";
      const message = typeof data.message === "string" ? data.message.slice(0, 65536) : "";
      if (!topic) return json(res, 400, { error: "Missing topic" });
      if (!message) return json(res, 400, { error: "Missing message" });
      if (!/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic (alphanumeric, dots, dashes, slashes)" });
      // Optional topic metadata — set once or update on publish
      if (data.meta && typeof data.meta === "object") {
        const privateKey = hasPrivateKey(data.meta);
        if (privateKey) return json(res, 400, { error: `Cannot set private key: ${privateKey}` });
        topicBroker.setMeta(topic, data.meta);
      }
      const delivered = topicBroker.publish(topic, message);
      json(res, 200, { ok: true, delivered });
    }))},

    { method: "GET", prefix: "/sub/", handler: auth((req, res, topic) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic" });

      // Parse optional fromSeq query param for replay
      const url = new URL(req.url, "http://localhost");
      const fromSeqParam = url.searchParams.get("fromSeq");
      const lastEventId = req.headers["last-event-id"];
      const parsedParam = fromSeqParam !== null ? parseInt(fromSeqParam, 10) : NaN;
      const parsedLastId = lastEventId ? parseInt(lastEventId, 10) : NaN;
      const fromSeq = Number.isFinite(parsedParam) ? parsedParam
        : Number.isFinite(parsedLastId) ? parsedLastId + 1
        : undefined;

      // SSE stream
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":ok\n\n");

      const unsubscribe = topicBroker.subscribe(topic, (envelope) => {
        res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
      }, { fromSeq });

      req.on("close", unsubscribe);
    })},

    { method: "GET", path: "/api/topics", handler: auth((req, res) => {
      if (!topicBroker) return json(res, 200, []);
      // By default, filter out internal PTY output streams — they're
      // high-volume binary terminal data, not meaningful events for
      // feed tiles. Admin tooling (cleanup, diagnostics) passes
      // ?all=1 to see the full list.
      const url = new URL(req.url, "http://x");
      const includeAll = url.searchParams.get("all") === "1";
      const raw = includeAll
        ? topicBroker.listTopics()
        : topicBroker.listTopics().filter(t => !t.name.endsWith("/output"));
      const topics = raw.map(t => ({ ...t, meta: publicMeta(t.meta) }));
      json(res, 200, topics);
    })},

    { method: "DELETE", prefix: "/api/topics/", handler: auth(csrf((req, res, topic) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic" });
      const existed = topicBroker.deleteTopic(topic);
      json(res, existed ? 200 : 404, { ok: existed });
    }))},

    // GET /api/topics/:topic/stats — message counts grouped by status.
    // Cleanup tooling uses this to classify a topic as noise vs. value
    // without replaying the whole log via SSE.
    { method: "GET", prefix: "/api/topics/", handler: auth((req, res, param) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!param.endsWith("/stats")) return json(res, 404, { error: "Not found" });
      const topic = param.slice(0, -6); // strip "/stats"
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic" });
      json(res, 200, topicBroker.getTopicStats(topic));
    })},

    // Topic names may contain slashes (e.g. "claude/session-abc"), so the
    // param from the prefix route will be "claude/session-abc/meta". We use
    // endsWith("/meta") to match and slice to extract the topic name.
    { method: "POST", prefix: "/api/topics/", handler: auth(csrf(async (req, res, param) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!param.endsWith("/meta")) return json(res, 404, { error: "Not found" });
      const topic = param.slice(0, -5); // strip "/meta"
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic" });
      const data = await parseJSON(req);
      if (!data || typeof data !== "object") return json(res, 400, { error: "Body must be a JSON object" });
      const privateKey = hasPrivateKey(data);
      if (privateKey) return json(res, 400, { error: `Cannot set private key: ${privateKey}` });
      topicBroker.setMeta(topic, data);
      json(res, 200, { ok: true, meta: publicMeta(topicBroker.getMeta(topic)) });
    }))},

    // --- Claude Event Stream ---
    // csrf() is included for consistency with all other write routes.
    // Claude Code hooks arrive from localhost, where csrf() is bypassed
    // automatically by the middleware. Remote callers need a CSRF token.

    { method: "POST", path: "/api/claude-events", handler: auth(csrf(async (req, res) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      let payload;
      try {
        payload = await parseJSON(req, 65536);
      } catch (err) {
        const status = err.message === "Request body too large" ? 413 : 400;
        return json(res, status, { error: err.message });
      }
      const result = transformClaudeEvent(payload);
      if (!result) return json(res, 400, { error: "Missing session_id or hook_event_name" });

      // Populate `session.meta.claude` from SessionStart. `_tmuxPane` is
      // stamped by `katulong relay-hook` from TMUX_PANE and re-validated here
      // against our own pane index — we never trust the payload itself.
      // Unknown panes are a no-op. Narration itself is produced by the
      // watchlist-driven `claude-processor` polling the transcript JSONL;
      // hook events only exist to announce session start so the client can
      // opt in to watching the uuid.
      const verdict = applyClaudeMetaFromHook(payload, sessionManager, log);
      // Persistent operational telemetry — the pane/verdict pair is what
      // makes "hook fired but sparkle didn't light up" debuggable from the
      // log. Claude Code fires only a handful of these per session, so the
      // volume stays bounded.
      //
      // Fields are validated before logging — the raw payload is attacker-
      // influenced (any authed caller can POST /api/claude-events) and an
      // unsanitized value would become a field in the structured log line.
      // We emit literal "invalid" sentinels for anything that doesn't match
      // the expected shape rather than echoing arbitrary bytes to the log.
      const rawPane = typeof payload._tmuxPane === "string" ? payload._tmuxPane : null;
      const rawSid = typeof payload.session_id === "string" ? payload.session_id : null;
      const rawEvent = typeof payload.hook_event_name === "string" ? payload.hook_event_name : null;
      log?.info?.("claude-hook received", {
        event: rawEvent && /^[A-Za-z]+$/.test(rawEvent) ? rawEvent : "invalid",
        pane: rawPane && /^%\d+$/.test(rawPane) ? rawPane : "invalid",
        session_id: rawSid && UUID_RE.test(rawSid) ? rawSid : "invalid",
        verdict,
      });

      // result is computed only to validate payload shape (session_id + hook
      // event name). We intentionally don't use result.topic/result.message
      // — the pub/sub log is filled by the watchlist processor reading the
      // transcript file, not by these thin hook pings.
      void result;

      // PreToolUse: Claude is about to call a tool. Kick off an async
      // pane-scan — if the "Do you want to proceed?" menu shows up
      // within a few seconds, publish a permission-request card. Auto-
      // approved tools never render the menu, so the poll just ages
      // out silently. `inflightPermissionPolls` lets PostToolUse
      // cancel the poll once the tool has run.
      if (permissionStore && topicBroker && payload.hook_event_name === "PreToolUse") {
        const parsed = parsePreToolUsePayload(payload);
        if (parsed && parsed.pane) {
          const { uuid, pane, tool } = parsed;
          inflightPermissionPolls.set(uuid, { stop: false });
          // Fire-and-forget: the HTTP response must not block on tmux
          // polling. Errors are swallowed so a flaky tmux can't take
          // down the hook ingestion path.
          pollForPermissionPrompt(pane, {
            shouldStop: () => inflightPermissionPolls.get(uuid)?.stop === true,
          }).then((hit) => {
            if (!hit) return;
            const record = permissionStore.add({
              uuid, pane, tool, message: hit.question,
            });
            try {
              topicBroker.publish(`claude/${uuid}`, {
                status: "permission-request",
                requestId: record.requestId,
                message: hit.question,
                tool,
              });
            } catch (err) {
              log?.warn?.("claude-events: permission publish failed", {
                uuid, error: err.message,
              });
            }
          }).catch((err) => {
            log?.warn?.("claude-events: permission poll errored", {
              uuid, error: err.message,
            });
          }).finally(() => {
            inflightPermissionPolls.delete(uuid);
          });
        }
      }

      // PostToolUse: the tool has run. Any still-open permission card
      // for this session was answered in the TTY (or was a ghost from
      // a race) — auto-dismiss so the card doesn't linger collecting
      // stale clicks. Also sets the stop signal so an in-flight poll
      // started by PreToolUse can exit early.
      if (permissionStore && topicBroker && payload.hook_event_name === "PostToolUse") {
        const uuid = typeof payload.session_id === "string" ? payload.session_id : null;
        if (uuid) {
          const inflight = inflightPermissionPolls.get(uuid);
          if (inflight) inflight.stop = true;
          for (const req of permissionStore.findByUuid(uuid)) {
            permissionStore.resolve(req.requestId);
            try {
              topicBroker.publish(`claude/${uuid}`, {
                status: "permission-resolved",
                requestId: req.requestId,
                choice: "auto",
              });
            } catch (err) {
              log?.warn?.("claude-events: auto-dismiss publish failed", {
                uuid, error: err.message,
              });
            }
          }
        }
      }

      json(res, 200, { ok: true });
    }))},

    // Claude Code hook install status. Cheap — just reads the settings
    // file. Frontend uses this to decide whether to show the Claude icon
    // in install-prompt mode vs. direct-open mode.
    { method: "GET", path: "/api/claude-hooks/status", handler: auth((req, res) => {
      // `settingsPath` contains an absolute host path (with the user's
      // home dir) and is only used server-side — strip it before
      // crossing the HTTP boundary, matching the publicMeta pattern.
      const { settingsPath: _sp, ...publicStatus } = getClaudeHooksStatus();
      json(res, 200, publicStatus);
    })},

    // Install the katulong relay hook into ~/.claude/settings.local.json.
    // Idempotent and non-destructive. Exposed over HTTP so the frontend
    // can wire up hooks on first click of the Claude icon without
    // requiring the user to drop to a terminal. No body is expected;
    // we still drain the request via readBody to enforce a small size
    // cap consistent with every other mutating route.
    { method: "POST", path: "/api/claude-hooks/install", handler: auth(csrf(async (req, res) => {
      try {
        await readBody(req, 256);
        const { settingsPath: _sp, ...publicResult } = installClaudeHooks();
        json(res, 200, publicResult);
      } catch (err) {
        log.warn("Failed to install Claude hooks via API", { error: err.message });
        json(res, 500, { error: "Failed to install hooks" });
      }
    }))},

    // On-demand transcript-slice drill-down. The pub/sub now carries only
    // synthesized output (narrative / completion / attention / summary);
    // raw tool-call detail lives in the Claude transcript JSONL on disk.
    // This endpoint shields the frontend from the JSONL shape by routing
    // through the shared `readTranscriptEntries` normalizer — same shape
    // the narrative processor itself consumes.
    //
    // Query params:
    //   ?fromLine=N  (default 0) — skip the first N significant lines
    //   ?limit=N     (default 200, max 1000) — cap entries returned
    //
    // Returns { entries, nextCursor, hasMore }.
    { method: "GET", prefix: "/api/claude-transcript/", handler: auth((req, res, sessionId) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!UUID_RE.test(sessionId)) return json(res, 400, { error: "Invalid session_id" });

      const meta = topicBroker.getMeta(`claude/${sessionId}`);
      const transcriptPath = meta && typeof meta.transcriptPath === "string" ? meta.transcriptPath : null;
      if (!transcriptPath) return json(res, 404, { error: "No transcript recorded for session" });

      const url = new URL(req.url, "http://x");
      const fromLine = Math.max(0, parseInt(url.searchParams.get("fromLine") || "0", 10) || 0);
      const limitRaw = parseInt(url.searchParams.get("limit") || "200", 10) || 200;
      const limit = Math.min(1000, Math.max(1, limitRaw));

      json(res, 200, readTranscriptEntries(transcriptPath, fromLine, limit));
    })},

    // Respond to a Claude session by uuid — find the katulong session
    // whose `meta.claude.uuid` matches, write the reply into its pane.
    // This is the feed tile's "send response" path: the user reads a
    // Claude question and types back without leaving the feed.
    //
    // Accepts either `{ text }` (simple text reply, appends Enter) or
    // `{ tokens }` (ordered `text`/`image` sequence for inline-image
    // replies — uploaded via POST /upload first). Both always end with
    // a real Enter; this endpoint is always submit-intent.
    { method: "POST", prefix: "/api/claude/respond/", handler: auth(csrf(async (req, res, uuid) => {
      if (!UUID_RE.test(uuid)) return json(res, 400, { error: "Invalid uuid" });
      let body;
      try { body = await parseJSON(req, 16384); } catch (err) {
        return json(res, 400, { error: err.message });
      }

      const hasTokens = Array.isArray(body?.tokens);
      const text = typeof body?.text === "string" ? body.text : null;
      if (!hasTokens && !text) return json(res, 400, { error: "Missing text or tokens" });
      if (text && text.length > MAX_PASTE_TEXT_LEN) return json(res, 400, { error: "Response too long" });

      let tokens;
      if (hasTokens) {
        tokens = body.tokens.filter((t) => t && (t.type === "text" || t.type === "image"));
        if (tokens.length === 0) return json(res, 400, { error: "Empty tokens" });
        if (tokens.length > MAX_PASTE_TOKENS) return json(res, 400, { error: "Too many tokens" });
        const totalText = tokens
          .filter((t) => t.type === "text" && typeof t.value === "string")
          .reduce((n, t) => n + t.value.length, 0);
        if (totalText > MAX_PASTE_TEXT_LEN) return json(res, 400, { error: "Response too long" });
      } else {
        tokens = [{ type: "text", value: text }];
      }

      const allSessions = sessionManager.listSessions().sessions;
      const target = allSessions.find(
        (s) => s.alive && s.meta?.claude?.uuid === uuid,
      );
      if (!target) return json(res, 404, { error: "No session found for that Claude uuid" });

      const session = sessionManager.getSession(target.name);
      if (!session?.alive) return json(res, 404, { error: "Session no longer alive" });

      // Ack the POST immediately; replay happens async with WS progress.
      json(res, 200, { ok: true, session: target.name, tokens: tokens.length });

      replayPasteSequence({
        tokens, session, sessionName: target.name, sessionManager,
        uploadsDir: join(DATA_DIR, "uploads"),
        submit: true,
        setClipboard, bridgeClipboardToContainers, bridgePaneContainer, imageMimeType,
        logger: log,
        onImagePasted: (path) => bridge.relay({ type: "paste-complete", session: target.name, path }),
      }).catch((err) => {
        log.warn("claude-respond replay failed", { session: target.name, error: err.message });
      });
    }))},

    // Resolve a (possibly relative) file path against a session's cwd with
    // a sibling-worktree fallback. Used by the document/image tile opener
    // so clicking `docs/foo.md` in a Claude that's operating on a worktree
    // lands on the file even when Claude's cwd (from the per-pid session
    // json) is still the main checkout. See `lib/worktree-resolver.js`
    // and `docs/file-link-worktree-resolution.md` for the full diagnosis.
    //
    // Takes an optional `session` name because the path's cwd context
    // comes from session meta; without it we can only handle absolute
    // paths. `auth()` is sufficient — the response only exposes paths
    // the caller could already enumerate by reading session meta.
    { method: "GET", path: "/api/resolve-file", handler: auth(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const sessionName = url.searchParams.get("session");
      const path = url.searchParams.get("path");
      if (!path) return json(res, 400, { error: "Missing path" });
      // Reject traversal segments + null bytes. Matches the frontend's
      // segment-level check — `path.includes("..")` would also reject
      // legitimate filenames like `v2..0.md` that contain `..` as a
      // substring but not as a path segment. `resolveFilePath` joins
      // `path` onto trusted cwd/worktree roots, so a `..` segment
      // could escape upward; null bytes confuse downstream stat/readFile.
      if (path.includes("\0") || path.split("/").some((seg) => seg === "..")) {
        return json(res, 400, { error: "Invalid path" });
      }

      let cwd = null;
      if (sessionName) {
        const session = sessionManager.getSession(sessionName);
        if (session) {
          cwd = session.meta?.claude?.cwd || session.meta?.pane?.cwd || null;
        }
      }

      const result = await resolveFilePath({ path, cwd });
      json(res, 200, result);
    })},

    // --- Sessions ---

    { method: "GET", path: "/sessions", handler: auth((req, res) => {
      const result = sessionManager.listSessions();
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/sessions", handler: auth(csrf(async (req, res) => {
      const { name, copyFrom, cwd } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(name);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const copyFromName = copyFrom ? SessionName.tryCreate(copyFrom)?.toString() : null;

      // `cwd` lets a caller (currently the feed tile's open-terminal
      // button) spawn a shell in a specific directory without first
      // needing a donor session to copyFrom. Strict validation: must
      // be an absolute path string with no null bytes or newlines, and
      // must exist on disk. Passing an unchecked string through to tmux
      // would let a bad cwd kill the spawn silently.
      let resolvedCwd = null;
      if (cwd != null) {
        if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096) {
          return json(res, 400, { error: "Invalid cwd" });
        }
        if (!cwd.startsWith("/")) return json(res, 400, { error: "cwd must be absolute" });
        if (cwd.includes("\0") || /[\r\n]/.test(cwd)) return json(res, 400, { error: "Invalid cwd" });
        try {
          const st = statSync(cwd);
          if (!st.isDirectory()) return json(res, 400, { error: "cwd is not a directory" });
        } catch { return json(res, 400, { error: "cwd does not exist" }); }
        resolvedCwd = cwd;
      }

      const result = await sessionManager.createSession(
        sessionName.toString(), 120, 40, copyFromName, resolvedCwd,
      );
      if (!result.error && req._apiKeyAuth) {
        const session = sessionManager.getSession(result.name);
        if (session) session.setIcon("robot");
      }
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name, id: result.id });
    }))},

    // --- Session I/O (exec, input, status, output) + mutate (DELETE, PUT) ---
    //
    // Keyed on the immutable `id`, never the friendly name — so a rename
    // never invalidates an in-flight CLI call or a client-side pointer.

    { method: "POST", prefix: "/sessions/by-id/", handler: auth(csrf(async (req, res, param) => {
      const { session, suffix, error } = resolveByIdParam(param);
      if (error) return json(res, error.status, { error: error.message });
      if (suffix === "exec") {
        const { input } = await parseJSON(req);
        if (typeof input !== "string") return json(res, 400, { error: "Missing input string" });
        if (input.length > 65536) return json(res, 400, { error: "Input too large (max 64KB)" });
        session.write(input + "\r");
        return json(res, 200, { ok: true });
      }
      if (suffix === "input") {
        let body;
        try {
          body = await parseJSON(req);
        } catch (err) {
          if (/too large/i.test(err.message)) return json(res, 413, { error: "Request body too large" });
          return json(res, 400, { error: "Invalid JSON body" });
        }
        const data = body?.data;
        if (typeof data !== "string") return json(res, 400, { error: "Missing data string" });
        if (data.length === 0) return json(res, 400, { error: "Empty data" });
        session.write(data);
        return json(res, 200, { ok: true, bytes: Buffer.byteLength(data, "utf8") });
      }
      return json(res, 404, { error: "Not found" });
    }))},

    { method: "GET", prefix: "/sessions/by-id/", handler: auth(async (req, res, param) => {
      const { session, suffix, error } = resolveByIdParam(param);
      if (error) return json(res, error.status, { error: error.message });
      if (suffix === "status") {
        const meta = publicMeta(session.meta || {});
        return json(res, 200, {
          id: session.id,
          name: session.name,
          alive: session.alive,
          hasChildProcesses: session.hasChildProcesses(),
          childCount: session._childCount,
          pane: meta.pane || null,
          agent: meta.agent || null,
        });
      }
      if (suffix !== "output") return json(res, 404, { error: "Not found" });

      const url = new URL(req.url, "http://localhost");
      const fromSeq = url.searchParams.get("fromSeq");
      const lines = url.searchParams.get("lines");
      const screen = url.searchParams.get("screen");

      if (screen === "true") {
        const snap = await session.snapshot();
        return json(res, 200, { screen: snap.buffer, seq: snap.seq });
      }
      if (fromSeq !== null) {
        const seq = parseInt(fromSeq, 10);
        if (isNaN(seq) || seq < 0) return json(res, 400, { error: "Invalid fromSeq" });
        const { data, cursor } = session.pullFrom(seq);
        if (data === null) {
          const snap = await session.snapshot();
          return json(res, 200, { screen: snap.buffer, seq: snap.seq, evicted: true });
        }
        return json(res, 200, { data, seq: cursor, alive: session.alive });
      }
      if (lines !== null) {
        const n = parseInt(lines, 10);
        if (isNaN(n) || n < 1 || n > 1000) return json(res, 400, { error: "Invalid lines (1-1000)" });
        const visible = await captureVisiblePane(session.tmuxName);
        const allLines = (visible || "").split("\n");
        const lastN = allLines.slice(-n).join("\n");
        return json(res, 200, { data: lastN, seq: session.cursor });
      }
      const { data, cursor } = session.pullTail(4096);
      json(res, 200, { data, seq: cursor });
    })},

    { method: "DELETE", prefix: "/sessions/by-id/", handler: auth(csrf((req, res, param) => {
      const { session, suffix, error } = resolveByIdParam(param);
      if (error) return json(res, error.status, { error: error.message });
      if (suffix !== null) return json(res, 404, { error: "Not found" });
      const url = new URL(req.url, "http://localhost");
      const detachOnly = url.searchParams.get("action") === "detach";
      const result = sessionManager.deleteSession(session.name, { detachOnly });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true, action: result.action });
    }))},

    { method: "PUT", prefix: "/sessions/by-id/", handler: auth(csrf(async (req, res, param) => {
      const { session, suffix, error } = resolveByIdParam(param);
      if (error) return json(res, error.status, { error: error.message });
      if (suffix !== null) return json(res, 404, { error: "Not found" });
      const { name: newName } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(newName);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await sessionManager.renameSession(session.name, sessionName.toString());
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name, id: result.id });
    }))},

    // --- tmux session browser ---

    { method: "GET", path: "/tmux-sessions", handler: auth(async (req, res) => {
      const result = await sessionManager.listTmuxSessions();
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/tmux-sessions/adopt", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      if (!name || typeof name !== "string") return json(res, 400, { error: "Invalid name" });
      const result = await sessionManager.adoptTmuxSession(name);
      json(res, result.error ? 409 : 201, result);
    }))},

    { method: "DELETE", prefix: "/tmux-sessions/", handler: auth(csrf(async (req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const result = await sessionManager.killTmuxSession(name);
      json(res, result.error ? 400 : 200, result);
    }))},

    // --- Config ---

    { method: "GET", path: "/api/config", handler: auth(async (req, res) => {
      const config = configManager.getConfig();
      json(res, 200, { config });
    })},

    { method: "GET", path: "/api/external-url", handler: auth((req, res) => {
      json(res, 200, { url: getExternalUrl ? getExternalUrl() : null });
    })},

    configPutRoute("/api/config/instance-name", "instanceName", (v) => configManager.setInstanceName(v), () => configManager.getInstanceName()),
    configPutRoute("/api/config/instance-icon", "instanceIcon", (v) => configManager.setInstanceIcon(v), () => configManager.getInstanceIcon()),
    configPutRoute("/api/config/toolbar-color", "toolbarColor", (v) => configManager.setToolbarColor(v), () => configManager.getToolbarColor()),
    configPutRoute("/api/config/port-proxy-enabled", "portProxyEnabled", (v) => configManager.setPortProxyEnabled(v), () => configManager.getPortProxyEnabled()),
    configPutRoute("/api/config/sipag-url", "sipagUrl", (v) => configManager.setSipagUrl(v), () => configManager.getSipagUrl()),
    configPutRoute("/api/config/public-url", "publicUrl", (v) => configManager.setPublicUrl(v), () => configManager.getPublicUrl()),

    // --- Ollama peer (external LLM endpoint) ---
    //
    // The token is treated as a secret: never returned over the wire.
    // GET reports presence (hasToken) so the UI can render an empty
    // input with a "set" indicator. PUT accepts {url, token} where
    // either may be null to clear. POST /test pings the endpoint so
    // the user gets immediate feedback before saving.

    { method: "GET", path: "/api/config/ollama-peer", handler: auth((req, res) => {
      json(res, 200, {
        url: configManager.getOllamaPeerUrl(),
        hasToken: !!configManager.getOllamaPeerToken(),
      });
    })},

    { method: "PUT", path: "/api/config/ollama-peer", handler: auth(csrf(async (req, res) => {
      const body = await parseJSON(req);
      // Allow partial updates: omit a field to leave it untouched,
      // pass null/empty-string to clear.
      // Atomic semantics: capture the existing pair before any write so a
      // bad token doesn't leave a partially-applied URL behind. On failure,
      // restore both to their pre-call values.
      const originalUrl   = configManager.getOllamaPeerUrl();
      const originalToken = configManager.getOllamaPeerToken();
      try {
        if ("url" in body)   await configManager.setOllamaPeerUrl(body.url);
        if ("token" in body) await configManager.setOllamaPeerToken(body.token);
        // Drop the cascade's cached active backend so the next outbound
        // LLM call re-probes with the new url/token. Without this, a
        // rotated token would keep getting passed through the (now-stale)
        // cached entry for up to its 5-min TTL — including the case where
        // the rotation was a response to compromise.
        callOllama?.invalidate?.();
        log.info("ollamaPeer updated", {
          url: configManager.getOllamaPeerUrl(),
          hasToken: !!configManager.getOllamaPeerToken(),
        });
        json(res, 200, {
          success: true,
          url: configManager.getOllamaPeerUrl(),
          hasToken: !!configManager.getOllamaPeerToken(),
        });
      } catch (error) {
        // Rollback: only the field that succeeded could have changed. If
        // the URL update succeeded but the token update failed, we restore
        // the URL to its prior value. The setters tolerate identical-value
        // writes (they just rewrite the file).
        try {
          if (configManager.getOllamaPeerUrl() !== originalUrl) {
            await configManager.setOllamaPeerUrl(originalUrl);
          }
          if (configManager.getOllamaPeerToken() !== originalToken) {
            await configManager.setOllamaPeerToken(originalToken);
          }
        } catch (rollbackErr) {
          log.error("ollamaPeer rollback failed", { error: rollbackErr.message });
        }
        json(res, 400, { error: error.message });
      }
    }))},

    { method: "POST", path: "/api/config/ollama-peer/test", handler: auth(csrf(async (req, res) => {
      // Test against the values already saved — not the request body. The
      // user saves first, then tests. Keeps the token off the wire and
      // off this server's memory beyond what's already in config.
      // Drain (small) body so the connection completes cleanly; we do
      // not parse it because we never read it.
      try { await readBody(req, 256); } catch { /* body absent or empty */ }
      const url = configManager.getOllamaPeerUrl();
      const token = configManager.getOllamaPeerToken();
      if (!url) {
        return json(res, 400, { ok: false, error: "no peer URL configured" });
      }
      try {
        const headers = {};
        if (token) headers.Authorization = `Bearer ${token}`;
        const upstream = await fetch(`${url}/api/tags`, {
          headers,
          signal: AbortSignal.timeout(PEER_TEST_TIMEOUT_MS),
        });
        if (!upstream.ok) {
          return json(res, 200, {
            ok: false,
            status: upstream.status,
            error: upstream.status === 401
              ? "unauthorized — check the token"
              : `upstream returned ${upstream.status}`,
          });
        }
        const data = await upstream.json().catch(() => null);
        const models = Array.isArray(data?.models)
          ? data.models.map((m) => m.name).filter(Boolean)
          : [];
        return json(res, 200, { ok: true, models });
      } catch (err) {
        const code = err.cause?.code || err.code || err.name;
        return json(res, 200, {
          ok: false,
          error: `cannot reach ${url}: ${code || err.message}`,
        });
      }
    }))},

    // --- Notes (per-session markdown) ---

    { method: "GET", prefix: "/api/notes/", handler: auth((req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      try {
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8");
          json(res, 200, { content });
        } else {
          json(res, 200, { content: "" });
        }
      } catch (err) {
        log.error("Failed to read note", { name, error: err.message });
        json(res, 500, { error: "Failed to read note" });
      }
    })},

    { method: "PUT", prefix: "/api/notes/", handler: auth(csrf(async (req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      const { content } = await parseJSON(req);
      if (typeof content !== "string") return json(res, 400, { error: "Invalid content" });
      try {
        mkdirSync(notesDir, { recursive: true });
        writeFileSync(filePath, content, "utf-8");
        json(res, 200, { ok: true });
      } catch (err) {
        log.error("Failed to save note", { name, error: err.message });
        json(res, 500, { error: "Failed to save note" });
      }
    }))},

    { method: "DELETE", prefix: "/api/notes/", handler: auth(csrf((req, res, name) => {
      if (!name) return json(res, 400, { error: "Missing session name" });
      const notesDir = join(DATA_DIR, "notes");
      const filePath = join(notesDir, encodeURIComponent(name) + ".md");
      if (!filePath.startsWith(notesDir)) return json(res, 400, { error: "Invalid name" });
      try {
        if (existsSync(filePath)) {
          unlinkSync(filePath);
        }
        json(res, 200, { ok: true });
      } catch (err) {
        log.error("Failed to delete note", { name, error: err.message });
        json(res, 500, { error: "Failed to delete note" });
      }
    }))},
  ];
}
