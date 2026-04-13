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
import { loadShortcuts, saveShortcuts } from "../shortcuts.js";
import { log } from "../log.js";
import { rewriteVendorUrls } from "../static-files.js";
import { captureVisiblePane } from "../tmux.js";
import { bridgeClipboardToContainers, bridgePaneContainer } from "../container-detect.js";
import { readRawBody } from "../request-util.js";
import { transformClaudeEvent, extractNewAssistantText } from "../claude-event-transform.js";
import {
  MAX_UPLOAD_BYTES, detectImage, imageMimeType, setClipboard,
} from "./upload.js";

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated, sessionManager,
    helmSessionManager, bridge,
    configManager, __dirname, DATA_DIR, APP_VERSION,
    getDraining, shortcutsPath,
    auth, csrf, topicBroker, getExternalUrl,
  } = ctx;

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
      json(res, 200, topicBroker.listTopics());
    })},

    { method: "DELETE", prefix: "/api/topics/", handler: auth(csrf((req, res, topic) => {
      if (!topicBroker) return json(res, 503, { error: "Pub/sub not available" });
      if (!topic || !/^[a-zA-Z0-9._\-/]+$/.test(topic) || /(^|\/)\.\.($|\/)/.test(topic)) return json(res, 400, { error: "Invalid topic" });
      const existed = topicBroker.deleteTopic(topic);
      json(res, existed ? 200 : 404, { ok: existed });
    }))},

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
      topicBroker.setMeta(topic, data);
      json(res, 200, { ok: true, meta: topicBroker.getMeta(topic) });
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

      // Set topic meta on first publish so the feed tile uses progress rendering.
      // Also backfill sessionName if it was missing on the initial publish
      // (e.g., older topics created before relay-hook injected tmux_session).
      const meta = topicBroker.getMeta(result.topic);
      const isNewTopic = !meta || !meta.type;
      const tmuxSession = typeof payload.tmux_session === "string" ? payload.tmux_session.slice(0, 128) : null;
      if (isNewTopic) {
        const newMeta = {
          type: "progress",
          sessionName: tmuxSession,
          cwd: typeof payload.cwd === "string" ? payload.cwd.slice(0, 512) : null,
        };
        topicBroker.setMeta(result.topic, newMeta);
        // Notify connected clients so feed tile pickers update live
        bridge.relay({ type: "topic-new", topic: result.topic, meta: newMeta });
      } else if (!meta.sessionName && tmuxSession) {
        // Backfill sessionName for existing topics that were created
        // before the relay hook started injecting tmux_session.
        topicBroker.setMeta(result.topic, { sessionName: tmuxSession });
      }

      // Extract and publish any new assistant text from the transcript
      // before the tool/stop event, so the feed shows reasoning in order.
      const texts = extractNewAssistantText(payload.transcript_path, payload.session_id);
      for (const text of texts) {
        topicBroker.publish(result.topic, JSON.stringify({
          step: text,
          status: "text",
          detail: "",
          event: "AssistantText",
          tool: null,
        }));
      }

      const delivered = topicBroker.publish(result.topic, JSON.stringify(result.message));
      json(res, 200, { ok: true, delivered });
    }))},

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
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
    }))},

    { method: "GET", prefix: "/sessions/cwd/", handler: auth(async (req, res, name) => {
      const cwd = await sessionManager.getSessionCwd(name);
      json(res, cwd ? 200 : 404, cwd ? { cwd } : { error: "Session not found" });
    })},

    // --- Session I/O (exec + output) ---

    { method: "POST", prefix: "/sessions/", handler: auth(csrf(async (req, res, param) => {
      if (param.endsWith("/exec")) {
        const rawName = decodeURIComponent(param.slice(0, param.length - "/exec".length));
        const sessionName = SessionName.tryCreate(rawName);
        if (!sessionName) return json(res, 400, { error: "Invalid session name" });
        const session = sessionManager.getSession(sessionName.toString());
        if (!session || !session.alive) return json(res, 404, { error: "Session not found or not alive" });
        const { input } = await parseJSON(req);
        if (typeof input !== "string") return json(res, 400, { error: "Missing input string" });
        if (input.length > 65536) return json(res, 400, { error: "Input too large (max 64KB)" });
        session.write(input + "\r");
        return json(res, 200, { ok: true });
      }
      if (param.endsWith("/input")) {
        // Raw-byte input route used by `katulong session send`. Unlike /exec,
        // this does NOT append a trailing carriage return — the CLI is
        // responsible for building the exact byte sequence (text + named
        // keys like Enter/C-c). Auth + CSRF are inherited from the wrapping
        // middleware; the 1MB body cap comes from parseJSON's default.
        const rawName = decodeURIComponent(param.slice(0, param.length - "/input".length));
        const sessionName = SessionName.tryCreate(rawName);
        if (!sessionName) return json(res, 400, { error: "Invalid session name" });
        const session = sessionManager.getSession(sessionName.toString());
        if (!session || !session.alive) return json(res, 404, { error: "Session not found or not alive" });
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

    { method: "GET", prefix: "/sessions/", handler: auth(async (req, res, param) => {
      // --- Session status (for orchestrator polling) ---
      if (param.endsWith("/status")) {
        const rawName = decodeURIComponent(param.slice(0, param.length - "/status".length));
        const sessionName = SessionName.tryCreate(rawName);
        if (!sessionName) return json(res, 400, { error: "Invalid session name" });
        const session = sessionManager.getSession(sessionName.toString());
        if (!session) return json(res, 404, { error: "Session not found" });
        return json(res, 200, {
          name: session.name,
          alive: session.alive,
          hasChildProcesses: session.hasChildProcesses(),
          childCount: session._childCount,
        });
      }

      if (!param.endsWith("/output")) return json(res, 404, { error: "Not found" });
      const rawName = decodeURIComponent(param.slice(0, param.length - "/output".length));
      const sessionName = SessionName.tryCreate(rawName);
      if (!sessionName) return json(res, 400, { error: "Invalid session name" });
      const session = sessionManager.getSession(sessionName.toString());
      if (!session) return json(res, 404, { error: "Session not found" });

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

      // Default: last 4KB of raw buffer
      const { data, cursor } = session.pullTail(4096);
      json(res, 200, { data, seq: cursor });
    })},

    { method: "DELETE", prefix: "/sessions/", handler: auth(csrf((req, res, name) => {
      const url = new URL(req.url, "http://localhost");
      const detachOnly = url.searchParams.get("action") === "detach";
      const result = sessionManager.deleteSession(name, { detachOnly });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true, action: result.action });
    }))},

    { method: "PUT", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const { name: newName } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(newName);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await sessionManager.renameSession(name, sessionName.toString());
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
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

    // --- Claude sessions ---

    { method: "GET", path: "/api/helm-sessions", handler: auth((req, res) => {
      json(res, 200, { sessions: helmSessionManager.listSessions() });
    })},

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
