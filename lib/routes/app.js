/**
 * App routes: pages, sessions, config, shortcuts, upload, SSH, and health.
 *
 * Exports a factory that receives a shared context and returns route objects.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadState } from "../auth.js";
import { parseCookies, getCsrfToken, escapeAttr, getCspHeaders } from "../http-util.js";
import { SessionName } from "../session-name.js";

// --- Image upload helpers (inlined from lib/upload.js) ---

const IMAGE_SIGNATURES = [
  { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47]), ext: "png" },
  { magic: Buffer.from([0xff, 0xd8, 0xff]),        ext: "jpg" },
  { magic: Buffer.from("GIF8"),                     ext: "gif" },
];

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

export function detectImage(buf) {
  for (const sig of IMAGE_SIGNATURES) {
    if (buf.length >= sig.magic.length && buf.subarray(0, sig.magic.length).equals(sig.magic)) {
      return sig.ext;
    }
  }
  if (buf.length >= 12 && buf.subarray(0, 4).equals(Buffer.from("RIFF")) && buf.subarray(8, 12).equals(Buffer.from("WEBP"))) {
    return "webp";
  }
  return null;
}

export function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("Body too large"));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
import { log } from "../log.js";

export function createAppRoutes(ctx) {
  const {
    json, parseJSON, isAuthenticated, daemonRPC,
    configManager, __dirname, DATA_DIR, SSH_PASSWORD, SSH_PORT, SSH_HOST, APP_VERSION,
    getDraining, getDaemonConnected,
    auth, csrf,
  } = ctx;

  return [
    // --- Health ---

    { method: "GET", path: "/health", handler: (req, res) => {
      if (getDraining()) {
        return json(res, 503, { status: "draining", pid: process.pid });
      }
      json(res, 200, {
        status: "ok",
        pid: process.pid,
        uptime: process.uptime(),
        daemonConnected: getDaemonConnected(),
      });
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

      res.writeHead(200, {
        "Content-Type": "text/html",
        ...getCspHeaders(false, req)
      });
      res.end(html);
    }},

    { method: "GET", path: "/manifest.json", handler: (req, res) => {
      const manifest = readFileSync(join(__dirname, "public", "manifest.json"), "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json" });
      res.end(manifest);
    }},

    { method: "GET", path: "/login", handler: (req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        "Pragma": "no-cache",
        "Expires": "0",
        ...getCspHeaders(false, req)
      });
      res.end(readFileSync(join(__dirname, "public", "login.html"), "utf-8"));
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
      json(res, 200, { path: `/uploads/${filename}`, absolutePath: filePath });
    }))},

    // --- SSH / Connect ---

    { method: "GET", path: "/ssh/password", handler: auth((req, res) => {
      json(res, 200, { password: SSH_PASSWORD });
    })},

    { method: "GET", path: "/connect/info", handler: auth((req, res) => {
      json(res, 200, {
        sshPort: SSH_PORT,
        sshHost: SSH_HOST
      });
    })},

    // --- Shortcuts ---

    { method: "GET", path: "/shortcuts", handler: auth(async (req, res) => {
      const result = await daemonRPC({ type: "get-shortcuts" });
      json(res, 200, result.shortcuts);
    })},

    { method: "PUT", path: "/shortcuts", handler: auth(csrf(async (req, res) => {
      const data = await parseJSON(req);
      const result = await daemonRPC({ type: "set-shortcuts", data });
      json(res, result.error ? 400 : 200, result.error ? { error: result.error } : { ok: true });
    }))},

    // --- Sessions ---

    { method: "GET", path: "/sessions", handler: auth(async (req, res) => {
      const result = await daemonRPC({ type: "list-sessions" });
      json(res, 200, result.sessions);
    })},

    { method: "POST", path: "/sessions", handler: auth(csrf(async (req, res) => {
      const { name } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(name);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await daemonRPC({ type: "create-session", name: sessionName.toString() });
      json(res, result.error ? 409 : 201, result.error ? { error: result.error } : { name: result.name });
    }))},

    { method: "DELETE", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const result = await daemonRPC({ type: "delete-session", name });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { ok: true });
    }))},

    { method: "PUT", prefix: "/sessions/", handler: auth(csrf(async (req, res, name) => {
      const { name: newName } = await parseJSON(req);
      const sessionName = SessionName.tryCreate(newName);
      if (!sessionName) return json(res, 400, { error: "Invalid name" });
      const result = await daemonRPC({ type: "rename-session", oldName: name, newName: sessionName.toString() });
      json(res, result.error ? 404 : 200, result.error ? { error: result.error } : { name: result.name });
    }))},

    // --- Config ---

    { method: "GET", path: "/api/config", handler: auth(async (req, res) => {
      const config = configManager.getConfig();
      json(res, 200, { config });
    })},

    { method: "PUT", path: "/api/config/instance-name", handler: auth(csrf(async (req, res) => {
      const { instanceName } = await parseJSON(req);
      try {
        configManager.setInstanceName(instanceName);
        log.info("Instance name updated", { instanceName });
        json(res, 200, { success: true, instanceName: configManager.getInstanceName() });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    }))},

    { method: "PUT", path: "/api/config/instance-icon", handler: auth(csrf(async (req, res) => {
      const { instanceIcon } = await parseJSON(req);
      try {
        configManager.setInstanceIcon(instanceIcon);
        log.info("Instance icon updated", { instanceIcon });
        json(res, 200, { success: true, instanceIcon: configManager.getInstanceIcon() });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    }))},

    { method: "PUT", path: "/api/config/toolbar-color", handler: auth(csrf(async (req, res) => {
      const { toolbarColor } = await parseJSON(req);
      try {
        configManager.setToolbarColor(toolbarColor);
        log.info("Toolbar color updated", { toolbarColor });
        json(res, 200, { success: true, toolbarColor: configManager.getToolbarColor() });
      } catch (error) {
        json(res, 400, { error: error.message });
      }
    }))},
  ];
}
