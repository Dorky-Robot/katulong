/**
 * Dispatch Routes
 *
 * API endpoints for the dispatch feature queue and orchestration system.
 * Manages the raw → refined → active pipeline for feature requests
 * across all diwa-indexed projects.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";

const VALID_STATUSES = new Set(["raw", "refining", "refined", "grouped", "needs-info", "queued", "active", "done", "failed", "cancelled", "dismissed"]);

// Cache diwa project list (refreshed every 5 minutes)
let projectCache = null;
let projectCacheTime = 0;
const PROJECT_CACHE_TTL = 5 * 60 * 1000;

async function getProjects() {
  if (projectCache && Date.now() - projectCacheTime < PROJECT_CACHE_TTL) return projectCache;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile("diwa", ["ls"], { timeout: 15000 }, (err, out, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(out);
      });
    });
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
    projectCache = clean.trim().split("\n")
      .filter((line) => line.trim() && !line.includes("repos indexed") && !line.includes("diwa v"))
      .map((line) => {
        const parts = line.trim().split(/\s{2,}/);
        const name = parts[0] || "";
        const pathMatch = parts.find((p) => p.startsWith("~") || p.startsWith("/"));
        return { name, slug: name.split("/").pop(), path: pathMatch || "" };
      });
    projectCacheTime = Date.now();
  } catch {
    projectCache = projectCache || [];
  }
  return projectCache;
}

// Eagerly load on startup
getProjects();

/**
 * Run a command and return stdout as a string.
 */
function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/**
 * Create dispatch route definitions.
 * @param {object} ctx - Route context
 * @param {object} ctx.store - Dispatch store instance
 * @param {Function} ctx.json - JSON response helper
 * @param {Function} ctx.parseJSON - JSON body parser
 * @param {Function} ctx.auth - Auth middleware wrapper
 * @param {Function} ctx.csrf - CSRF middleware wrapper
 * @returns {Array} Route definition objects
 */
export function createDispatchRoutes(ctx) {
  const { store, refiner, executor, json, parseJSON, auth, csrf } = ctx;

  // --- SSE clients ---
  const sseClients = new Set();

  function broadcast(data) {
    const msg = `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(msg); } catch { sseClients.delete(client); }
    }
  }

  // --- Active refine sessions ---
  // Tracked here (not in the store) because they're ephemeral process state
  // that only matters while the subprocess is alive. Included in the SSE
  // snapshot so a reconnecting client rehydrates the activity panel without
  // needing to have been connected when refine-started fired.
  //
  // Shape: Map<sessionTag, { sessionTag, featureIds, count, startedAt, bullets: [{text, ts}], status }>
  // bullets is capped at MAX_SESSION_BULLETS to bound memory if a single
  // session goes wild (long runs, stream-json chatter). The client only
  // renders the last 5 anyway.
  const activeRefines = new Map();
  const MAX_SESSION_BULLETS = 200;

  function startRefineSession(featureIds) {
    const sessionTag = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      sessionTag,
      featureIds: [...featureIds],
      count: featureIds.length,
      startedAt: new Date().toISOString(),
      bullets: [],
      status: "running",
    };
    activeRefines.set(sessionTag, session);
    broadcast({ type: "refine-started", session });
    return session;
  }

  function appendRefineBullet(session, text) {
    const entry = { text, ts: new Date().toISOString() };
    session.bullets.push(entry);
    if (session.bullets.length > MAX_SESSION_BULLETS) {
      session.bullets.splice(0, session.bullets.length - MAX_SESSION_BULLETS);
    }
    broadcast({ type: "refine-progress", sessionTag: session.sessionTag, bullet: entry });
  }

  function finishRefineSession(session, outcome, detail) {
    session.status = outcome; // "completed" | "failed"
    if (detail) session.detail = detail;
    broadcast({
      type: outcome === "completed" ? "refine-completed" : "refine-failed",
      sessionTag: session.sessionTag,
      detail: detail || null,
    });
    // Remove after a short grace period so a client reconnecting moments
    // later still sees the terminal state in the snapshot. The client is
    // responsible for its own auto-hide delay on the terminal event.
    setTimeout(() => activeRefines.delete(session.sessionTag), 2000);
  }

  return [
    // --- List features (includes project list for autocomplete) ---
    {
      method: "GET", path: "/api/dispatch/features", handler: auth(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const status = url.searchParams.get("status");
        const features = store.listFeatures(status || undefined);
        const projects = await getProjects();
        json(res, 200, { features, projects });
      }),
    },

    // --- Add raw idea ---
    {
      method: "POST", path: "/api/dispatch/features", handler: auth(csrf(async (req, res) => {
        const body = await parseJSON(req);
        if (!body.raw || typeof body.raw !== "string" || !body.raw.trim()) {
          return json(res, 400, { error: "raw idea text is required" });
        }
        const feature = await store.addFeature(body.raw.trim(), body.projects);
        broadcast({ type: "feature-added", feature });
        json(res, 201, feature);
      })),
    },

    // --- SSE stream for live progress ---
    // Must come before the prefix route so "/features/stream" isn't matched as an ID
    {
      method: "GET", path: "/api/dispatch/stream", handler: auth(async (req, res) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        req.on("close", () => sseClients.delete(res));
        res.write("\n");
        sseClients.add(res);

        // Send current state snapshot — includes in-flight refine sessions so
        // the activity panel rehydrates on reconnect without waiting for the
        // next progress event.
        const features = store.listFeatures();
        const refines = [...activeRefines.values()];
        res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", features, refines })}\n\n`);
      }),
    },

    // --- Hook endpoint for Claude tool events from kubos ---
    {
      method: "POST", path: "/api/dispatch/hook", handler: auth(async (req, res) => {
        let body;
        try { body = await parseJSON(req); } catch { json(res, 400, { error: "Invalid JSON" }); return; }

        const featureId = body.feature_id;
        if (!featureId) {
          json(res, 200, { ok: true });
          return;
        }

        const feature = store.getFeature(featureId);
        if (!feature) {
          json(res, 404, { error: "Feature not found" });
          return;
        }

        const toolName = body.tool_name || "";
        const toolInput = body.tool_input || {};
        let detail = "";

        if (toolName === "Bash") {
          const cmd = toolInput.command || "";
          if (cmd.includes("npm test") || cmd.includes("node test")) {
            detail = "Running tests...";
          } else if (cmd.includes("git commit")) {
            detail = "Committing changes...";
          } else if (cmd.includes("git push")) {
            detail = "Pushing to remote...";
          } else {
            detail = `Running: ${cmd.slice(0, 80)}`;
          }
        } else if (toolName === "Write" || toolName === "Edit") {
          const filePath = toolInput.file_path || "";
          detail = `Editing: ${filePath.split("/").pop()}`;
        } else if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
          detail = "Reading codebase...";
        }

        if (detail) {
          await store.addLog(featureId, detail);
          broadcast({ type: "hook", featureId, detail, tool: toolName });
        }

        json(res, 200, { ok: true });
      }),
    },

    // --- List available projects from diwa ---
    {
      method: "GET", path: "/api/dispatch/projects", handler: auth(async (req, res) => {
        try {
          const stdout = await exec("diwa", ["ls"], { timeout: 15000 });
          // Parse diwa ls output: "  Owner/Repo  <ansi>N insights  ~/path<ansi>"
          // Strip ANSI codes, extract slug and path
          const clean = stdout.replace(/\x1b\[[0-9;]*m/g, "");
          const projects = clean.trim().split("\n")
            .filter((line) => line.trim() && !line.includes("repos indexed") && !line.includes("diwa v"))
            .map((line) => {
              const parts = line.trim().split(/\s{2,}/);
              const name = parts[0] || "";
              const pathMatch = parts.find((p) => p.startsWith("~") || p.startsWith("/"));
              return { name, slug: name.split("/").pop(), path: pathMatch || "" };
            });
          json(res, 200, projects);
        } catch {
          json(res, 500, { error: "Failed to list projects. Is diwa installed?" });
        }
      }),
    },

    // --- Get / Update / Delete feature by ID ---
    // Uses prefix matching: /api/dispatch/features/<id> or /api/dispatch/features/<id>/action
    {
      method: "GET", prefix: "/api/dispatch/features/", handler: auth(async (req, res, param) => {
        const feature = store.getFeature(param);
        if (!feature) return json(res, 404, { error: "Feature not found" });
        json(res, 200, feature);
      }),
    },

    {
      method: "PUT", prefix: "/api/dispatch/features/", handler: auth(csrf(async (req, res, param) => {
        const body = await parseJSON(req);
        const existing = store.getFeature(param);
        if (!existing) return json(res, 404, { error: "Feature not found" });

        const allowed = {};
        if (body.raw !== undefined) allowed.body = body.raw;
        if (body.status && VALID_STATUSES.has(body.status)) allowed.status = body.status;
        if (body.project !== undefined) allowed.project = body.project;
        if (body.refined !== undefined) allowed.refined = body.refined;

        const updated = await store.updateFeature(param, allowed);
        broadcast({ type: "feature-updated", feature: updated });
        json(res, 200, updated);
      })),
    },

    {
      method: "DELETE", prefix: "/api/dispatch/features/", handler: auth(csrf(async (req, res, param) => {
        const existed = await store.deleteFeature(param);
        if (!existed) return json(res, 404, { error: "Feature not found" });
        broadcast({ type: "feature-deleted", id: param });
        json(res, 200, { ok: true });
      })),
    },

    // --- Batch refine: POST /api/dispatch/refine ---
    // Accepts { featureIds: [...] } or { all: true } to refine all raw features.
    {
      method: "POST", path: "/api/dispatch/refine", handler: auth(csrf(async (req, res) => {
        const body = await parseJSON(req);
        let featureIds;

        if (body.all === true) {
          featureIds = store.listFeatures("raw").map((f) => f.id);
        } else if (Array.isArray(body.featureIds) && body.featureIds.length > 0) {
          featureIds = body.featureIds;
        } else {
          return json(res, 400, { error: "Provide featureIds array or { all: true }" });
        }

        // Validate all features exist and are raw
        for (const id of featureIds) {
          const f = store.getFeature(id);
          if (!f) return json(res, 400, { error: `Feature ${id} not found` });
          if (f.status !== "raw") return json(res, 400, { error: `Feature ${id} is not raw (status: ${f.status})` });
        }

        if (featureIds.length === 0) {
          return json(res, 400, { error: "No raw features to refine" });
        }

        // Mark as grouped immediately
        const groupedInto = `batch-${Date.now()}`;
        for (const id of featureIds) {
          await store.updateFeature(id, { status: "grouped", groupedInto });
          broadcast({ type: "feature-updated", feature: store.getFeature(id) });
        }

        // Open an activity session so the sidebar panel shows a pulsing
        // "Refining N idea(s)…" header and streams bullets. This is separate
        // from the groupedInto tag — that's feature metadata; this is UI state.
        const session = startRefineSession(featureIds);

        json(res, 202, {
          ok: true, message: "Batch refinement started",
          sessionTag: session.sessionTag, count: featureIds.length,
        });

        // Run refinement in the background
        refiner.refineBatch(store, featureIds, {
          onProgress: (bullet) => appendRefineBullet(session, bullet),
        }).then((created) => {
          for (const f of created) {
            broadcast({ type: "feature-added", feature: f });
          }
          // Broadcast updated grouped features
          for (const id of featureIds) {
            broadcast({ type: "feature-updated", feature: store.getFeature(id) });
          }
          finishRefineSession(session, "completed");
        }).catch((err) => {
          log.warn("Batch refinement failed", { featureIds, error: err.message });
          // Revert to raw (refiner already does this, but broadcast the change)
          for (const id of featureIds) {
            broadcast({ type: "feature-updated", feature: store.getFeature(id) });
          }
          finishRefineSession(session, "failed", err.message);
        });
      })),
    },

    // --- Trigger single-feature refinement: POST /api/dispatch/refine/<id> ---
    // Kept for backward compatibility — delegates to batch refine with one ID.
    {
      method: "POST", prefix: "/api/dispatch/refine/", handler: auth(csrf(async (req, res, featureId) => {
        const feature = store.getFeature(featureId);
        if (!feature) return json(res, 404, { error: "Feature not found" });
        if (feature.status !== "raw") {
          return json(res, 400, { error: "Only raw features can be refined" });
        }

        const groupedInto = `single-${Date.now()}`;
        await store.updateFeature(featureId, { status: "grouped", groupedInto });
        broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });

        const session = startRefineSession([featureId]);
        json(res, 202, { ok: true, message: "Refinement started", sessionTag: session.sessionTag });

        // Refinement runs async in the background
        refiner.refineBatch(store, [featureId], {
          onProgress: (bullet) => appendRefineBullet(session, bullet),
        }).then((created) => {
          for (const f of created) {
            broadcast({ type: "feature-added", feature: f });
          }
          broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
          finishRefineSession(session, "completed");
        }).catch((err) => {
          log.warn("Refinement failed", { featureId, error: err.message });
          broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
          finishRefineSession(session, "failed", err.message);
        });
      })),
    },

    // --- Start execution: POST /api/dispatch/start/<id> ---
    {
      method: "POST", prefix: "/api/dispatch/start/", handler: auth(csrf(async (req, res, featureId) => {
        const feature = store.getFeature(featureId);
        if (!feature) return json(res, 404, { error: "Feature not found" });
        if (feature.status !== "refined" && feature.status !== "queued") {
          return json(res, 400, { error: "Only refined/queued features can be started" });
        }

        await store.updateFeature(featureId, { status: "active" });
        broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
        json(res, 202, { ok: true, message: "Execution started" });

        // Execution runs async in the background
        executor.dispatch(store, [featureId]).catch((err) => {
          log.warn("Execution dispatch failed", { featureId, error: err.message });
          broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
        });
      })),
    },

    // --- Cancel execution: POST /api/dispatch/cancel/<id> ---
    {
      method: "POST", prefix: "/api/dispatch/cancel/", handler: auth(csrf(async (req, res, featureId) => {
        const feature = store.getFeature(featureId);
        if (!feature) return json(res, 404, { error: "Feature not found" });
        if (feature.status !== "active") {
          return json(res, 400, { error: "Only active features can be cancelled" });
        }

        await executor.cancel(store, featureId);
        await store.updateFeature(featureId, { status: "cancelled" });
        broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
        json(res, 200, { ok: true });
      })),
    },
  ];
}
