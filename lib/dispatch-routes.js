/**
 * Dispatch Routes
 *
 * API endpoints for the dispatch feature queue and orchestration system.
 * Manages the raw → refined → active pipeline for feature requests
 * across all diwa-indexed projects.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";

const VALID_STATUSES = new Set(["raw", "refining", "refined", "grouped", "queued", "active", "done", "failed", "cancelled", "dismissed"]);

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

  function broadcastFeature(featureId) {
    const f = store.getFeature(featureId);
    if (f) broadcast({ type: "feature-updated", feature: f });
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

        const features = store.listFeatures();
        res.write(`event: snapshot\ndata: ${JSON.stringify({ type: "snapshot", features })}\n\n`);
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
          broadcastFeature(featureId);
        }

        json(res, 200, { ok: true });
      }),
    },

    // --- List available projects from diwa ---
    {
      method: "GET", path: "/api/dispatch/projects", handler: auth(async (req, res) => {
        try {
          const stdout = await exec("diwa", ["ls"], { timeout: 15000 });
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
        broadcastFeature(param);
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
    // Body: { featureIds: [...] } or { all: true }
    {
      method: "POST", path: "/api/dispatch/refine", handler: auth(csrf(async (req, res) => {
        const body = await parseJSON(req);

        let featureIds;
        if (body.all) {
          featureIds = store.listFeatures("raw").map((f) => f.id);
        } else if (Array.isArray(body.featureIds) && body.featureIds.length > 0) {
          featureIds = body.featureIds;
        } else {
          return json(res, 400, { error: "featureIds array or all: true required" });
        }

        // Validate all features exist and are raw
        const features = featureIds.map((id) => store.getFeature(id)).filter(Boolean);
        const nonRaw = features.filter((f) => f.status !== "raw");
        if (nonRaw.length > 0) {
          return json(res, 400, { error: `Features not in raw status: ${nonRaw.map((f) => f.id).join(", ")}` });
        }
        if (features.length === 0) {
          return json(res, 400, { error: "No raw features found" });
        }

        // Mark all as grouped
        const sessionTag = `refine-${Date.now()}`;
        for (const f of features) {
          await store.updateFeature(f.id, { status: "grouped", groupedInto: sessionTag });
          broadcastFeature(f.id);
        }

        json(res, 202, { ok: true, sessionTag, featureIds: features.map((f) => f.id) });

        // Run batch refinement in the background — Claude Code does the work
        refiner.refineBatch(store, features.map((f) => f.id), { sessionTag }).then((results) => {
          for (const rf of results) {
            broadcast({ type: "feature-added", feature: rf });
          }
          for (const f of features) broadcastFeature(f.id);
        }).catch((err) => {
          log.warn("Batch refinement failed", { featureIds, error: err.message });
          for (const f of features) {
            store.updateFeature(f.id, { status: "raw", groupedInto: null });
            broadcastFeature(f.id);
          }
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

        json(res, 202, { ok: true, message: "Execution started" });

        // Execution runs async — re-broadcast when session is live so Open button appears
        executor.dispatch(store, [featureId], {
          onSessionCreated: (fIds) => fIds.forEach(broadcastFeature),
        }).catch((err) => {
          log.warn("Execution dispatch failed", { featureId, error: err.message });
          store.updateFeature(featureId, { status: "failed" });
          broadcastFeature(featureId);
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
        broadcastFeature(featureId);
        json(res, 200, { ok: true });
      })),
    },
  ];
}
