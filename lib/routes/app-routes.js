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

import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
import { readRawBody } from "../request-util.js";
import { transformClaudeEvent, readTranscriptEntries, UUID_RE, UUID_SEARCH_RE } from "../claude-event-transform.js";
import { getClaudeHooksStatus, installClaudeHooks } from "../claude-hooks.js";
import { createNarrativeProcessor } from "../narrative-processor.js";
import {
  MAX_UPLOAD_BYTES, detectImage, imageMimeType, setClipboard,
} from "./upload.js";
import { PRIVATE_META_KEYS, publicMeta } from "../session-meta-filter.js";

// Re-export so existing route tests and callers continue to import these
// from app-routes.js. Source of truth lives in session-meta-filter.js so
// the WS relay in session-manager.js can share the filter without a
// reverse dependency on this module.
export { PRIVATE_META_KEYS, publicMeta };

/**
 * Apply a Claude hook payload to `session.meta.claude` via the provided
 * sessionManager. Exported for unit tests — the live /api/claude-events
 * handler is the only production caller.
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
  const current = (session.meta && session.meta.claude) ? session.meta.claude : null;
  if (event === "SessionStart") {
    // Validate UUID shape before writing — the value becomes a topic name
    // prefix (`claude/<uuid>`) on the client, and we don't want a bogus
    // hook payload polluting meta with a non-UUID string.
    const uuid = typeof payload.session_id === "string" ? payload.session_id : null;
    if (!uuid || !UUID_RE.test(uuid)) return null;
    try {
      // Merge rather than replace so the detection-owned `running` /
      // `detectedAt` keys (written by the pane monitor) survive a hook
      // update. Hooks own `uuid` / `startedAt`; the pane monitor owns
      // `running` / `detectedAt`. Each writer touches only its own keys.
      session.setMeta("claude", {
        ...(current || {}),
        uuid,
        startedAt: Date.now(),
      });
      return "set";
    } catch (err) {
      logger?.warn?.("Failed to set meta.claude on SessionStart", {
        session: session.name, error: err.message,
      });
      return null;
    }
  }
  if (event === "SessionEnd" || event === "Stop") {
    try {
      if (!current) return "cleared";
      const next = { ...current };
      delete next.uuid;
      delete next.startedAt;
      session.setMeta("claude", Object.keys(next).length > 0 ? next : null);
      return "cleared";
    } catch (err) {
      logger?.warn?.("Failed to clear meta.claude", {
        session: session.name, error: err.message,
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
    json, parseJSON, isAuthenticated, sessionManager,
    bridge,
    configManager, __dirname, DATA_DIR, APP_VERSION,
    getDraining, shortcutsPath,
    auth, csrf, topicBroker, getExternalUrl,
  } = ctx;

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

  // Narrative processor — transforms raw Claude events into a running blog-like narrative.
  // It owns all topic creation: topics are created lazily on the first published event
  // (narrative / completion / attention / summary), so sessions that never produce
  // meaningful output never clutter the picker.
  const narrative = topicBroker ? createNarrativeProcessor({
    topicBroker,
    ensureTopicMeta: (topic, payload) => {
      const meta = topicBroker.getMeta(topic);
      if (!meta || !meta.type) {
        const newMeta = {
          type: "progress",
          sessionName: typeof payload.name === "string" ? payload.name.slice(0, 128) : null,
          cwd: typeof payload.cwd === "string" ? payload.cwd.slice(0, 512) : null,
          tmuxPane: typeof payload._tmuxPane === "string" ? payload._tmuxPane : null,
          // Record the transcript path so the on-demand drill-down
          // endpoint (/api/claude-transcript/:id) can read it back.
          // Kept server-side — stripped from the client-facing broadcast
          // and from /api/topics — so absolute host paths don't leak.
          transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : null,
        };
        topicBroker.setMeta(topic, newMeta);
        bridge.relay({ type: "topic-new", topic, meta: publicMeta(newMeta) });
      } else {
        const patch = {};
        if (typeof payload._tmuxPane === "string" && !meta.tmuxPane) patch.tmuxPane = payload._tmuxPane;
        if (typeof payload.transcript_path === "string" && meta.transcriptPath !== payload.transcript_path) {
          patch.transcriptPath = payload.transcript_path;
        }
        if (Object.keys(patch).length > 0) topicBroker.setMeta(topic, patch);
      }
    },
  }) : null;

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
    // Accepts an array of uploaded paths and a session name. For each path,
    // sets the clipboard, bridges to containers, and writes Ctrl+V directly
    // to the tmux session. All done server-side in a single HTTP request to
    // avoid per-file tunnel round-trips.

    { method: "POST", path: "/paste", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const paths = Array.isArray(data.paths) ? data.paths : data.path ? [data.path] : [];
      if (paths.length === 0) return json(res, 400, { error: "Missing paths" });

      const pasteSession = data.session ? SessionName.tryCreate(data.session)?.toString() : null;
      const uploadsDir = join(DATA_DIR, "uploads");
      const PASTE_DELAY_MS = 50;

      // Respond immediately — pastes happen async with WS progress updates
      json(res, 200, { queued: paths.length });

      // Process pastes sequentially in the background
      (async () => {
        for (const p of paths) {
          if (typeof p !== "string") continue;
          const filePath = join(uploadsDir, p.replace(/^\/uploads\//, ""));
          if (!filePath.startsWith(uploadsDir) || !existsSync(filePath)) continue;

          const ext = filePath.split(".").pop();
          const filename = filePath.split("/").pop();
          const mimeType = imageMimeType(ext);

          let clipboard = await setClipboard(filePath, ext, log);
          const bridged = await bridgeClipboardToContainers(filename, mimeType, log);
          if (bridged) clipboard = true;

          // Bridge to docker-exec'd container in this session's pane
          if (!bridged && pasteSession) {
            const paneBridged = await bridgePaneContainer(pasteSession, sessionManager, filePath, mimeType, log);
            if (paneBridged) clipboard = true;
          }

          if (clipboard && pasteSession) {
            const session = sessionManager.getSession(pasteSession);
            if (session?.alive) session.write("\x16");
          }

          // Notify client via WebSocket that this file was pasted
          bridge.relay({ type: "paste-complete", session: data.session, path: p });

          await new Promise(r => setTimeout(r, PASTE_DELAY_MS));
        }
      })();
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

      // Populate `session.meta.claude` from SessionStart / clear on
      // SessionEnd / Stop. `_tmuxPane` is stamped by `katulong relay-hook`
      // from TMUX_PANE and re-validated here against our own pane index
      // — we never trust the payload itself. Unknown panes are a no-op.
      applyClaudeMetaFromHook(payload, sessionManager, log);

      // Thin-event model: raw hook events are NOT published to the topic broker.
      // The narrative processor decides what to publish (narrative / completion /
      // attention / summary) and lazily creates the topic via ensureTopicMeta.
      // Callers that want raw tool-call detail should read the Claude transcript
      // JSONL directly — it's the source of truth, not the pub/sub log.
      if (narrative) {
        narrative.ingest(result.topic, result.message, payload);
      }

      json(res, 200, { ok: true });
    }))},

    // Claude Code hook install status. Cheap — just reads the settings
    // file. Frontend uses this to decide whether to show the Claude icon
    // in install-prompt mode vs. direct-open mode.
    { method: "GET", path: "/api/claude-hooks/status", handler: auth((req, res) => {
      json(res, 200, getClaudeHooksStatus());
    })},

    // Install the katulong relay hook into ~/.claude/settings.local.json.
    // Idempotent and non-destructive. Exposed over HTTP so the frontend
    // can wire up hooks on first click of the Claude icon without
    // requiring the user to drop to a terminal.
    { method: "POST", path: "/api/claude-hooks/install", handler: auth(csrf((req, res) => {
      try {
        const result = installClaudeHooks();
        json(res, 200, result);
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

    // Respond to a Claude session — sends text + Enter to the tmux pane
    // where Claude Code is running (matched by topic CWD → session CWD).
    { method: "POST", path: "/api/claude-respond", handler: auth(csrf(async (req, res) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      let body;
      try { body = await parseJSON(req, 8192); } catch (err) {
        return json(res, 400, { error: err.message });
      }
      const { topic, text } = body;
      if (!topic || typeof topic !== "string") return json(res, 400, { error: "Missing topic" });
      if (!text || typeof text !== "string") return json(res, 400, { error: "Missing text" });
      if (text.length > 2000) return json(res, 400, { error: "Response too long" });

      const meta = topicBroker.getMeta(topic);
      if (!meta?.cwd) return json(res, 404, { error: "Topic has no CWD metadata" });

      // Find the Katulong session whose tmux pane CWD matches the topic CWD
      const allSessions = sessionManager.listSessions().sessions;
      let targetSession = null;
      for (const s of allSessions) {
        if (!s.alive) continue;
        const cwd = await sessionManager.getSessionCwd(s.name);
        if (cwd && (cwd === meta.cwd || meta.cwd.startsWith(cwd + "/"))) {
          targetSession = s.name;
          break;
        }
      }

      if (!targetSession) return json(res, 404, { error: "No matching terminal session found" });

      // Send the response text + Enter to the tmux pane
      const session = sessionManager.getSession(targetSession);
      if (!session?.alive) return json(res, 404, { error: "Session no longer alive" });
      session.write(text + "\n");

      json(res, 200, { ok: true, session: targetSession });
    }))},

    // Find the Claude topic running in a given Katulong session's tmux pane.
    // Strategy: get the pane's shell PID → find child `claude` process →
    // extract session UUID from its open files (lsof) → match to topic.
    { method: "GET", prefix: "/sessions/claude-topic/", handler: auth(async (req, res, sessionName) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      const { execFile } = await import("node:child_process");

      // Get the pane's shell PID
      const session = sessionManager.getSession(sessionName);
      if (!session?.alive) return json(res, 404, { error: "Session not found" });

      const tmuxName = session.tmuxName;
      const panePid = await new Promise(resolve => {
        execFile("tmux", [...tmuxSocketArgs(), "list-panes", "-t", tmuxName, "-F", "#{pane_pid}"],
          { timeout: 3000 },
          (err, stdout) => resolve(err ? null : stdout.trim().split("\n")[0] || null)
        );
      });
      if (!panePid) return json(res, 404, { error: "Could not read pane PID" });

      // Find `claude` child process
      const claudePid = await new Promise(resolve => {
        execFile("pgrep", ["-P", panePid],
          { timeout: 3000 },
          (err, stdout) => {
            if (err || !stdout.trim()) return resolve(null);
            // Could be multiple children — check each
            const pids = stdout.trim().split("\n");
            resolve(pids);
          }
        );
      });
      if (!claudePid) return json(res, 404, { error: "No child process in pane" });

      // Extract Claude session UUID from open files of child processes
      let uuid = null;
      for (const pid of claudePid) {
        const lsofOut = await new Promise(resolve => {
          execFile("lsof", ["-p", pid],
            { timeout: 5000, maxBuffer: 512 * 1024 },
            (err, stdout) => resolve(err ? "" : stdout)
          );
        });
        // Look for .claude/ paths containing a UUID (session directory)
        for (const line of lsofOut.split("\n")) {
          if (!line.includes(".claude/")) continue;
          const m = line.match(UUID_SEARCH_RE);
          if (m) { uuid = m[0]; break; }
        }
        if (uuid) break;
      }

      if (!uuid) return json(res, 404, { error: "No Claude session UUID found in pane" });

      const topicName = `claude/${uuid}`;
      const meta = topicBroker.getMeta(topicName);
      if (!meta) return json(res, 404, { error: `Topic ${topicName} not found` });

      json(res, 200, { topic: topicName, meta: publicMeta(meta) });
    })},

    // --- Sessions ---

    { method: "GET", path: "/sessions", handler: auth((req, res) => {
      const result = sessionManager.listSessions();
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/sessions", handler: auth(csrf(async (req, res) => {
      const { name, copyFrom } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(name);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const copyFromName = copyFrom ? SessionName.tryCreate(copyFrom)?.toString() : null;
      const result = await sessionManager.createSession(sessionName.toString(), 120, 40, copyFromName);
      if (!result.error && req._apiKeyAuth) {
        const session = sessionManager.getSession(result.name);
        if (session) session.setIcon("robot");
      }
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name, id: result.id });
    }))},

    { method: "GET", prefix: "/sessions/cwd/", handler: auth(async (req, res, name) => {
      const cwd = await sessionManager.getSessionCwd(name);
      json(res, cwd ? 200 : 404, cwd ? { cwd } : { error: "Session not found" });
    })},

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
        return json(res, 200, {
          id: session.id,
          name: session.name,
          alive: session.alive,
          hasChildProcesses: session.hasChildProcesses(),
          childCount: session._childCount,
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
    configPutRoute("/api/config/public-url", "publicUrl", (v) => configManager.setPublicUrl(v), () => configManager.getPublicUrl()),

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
