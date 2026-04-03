/**
 * Dispatch Routes
 *
 * API endpoints for the dispatch feature queue and orchestration system.
 * Manages the raw → refined → active pipeline for feature requests
 * across all diwa-indexed projects.
 */

import { execFile } from "node:child_process";
import { log } from "./log.js";

const VALID_STATUSES = new Set(["raw", "refining", "refined", "queued", "active", "done", "failed", "cancelled", "dismissed"]);

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

  return [
    // --- List features ---
    {
      method: "GET", path: "/api/dispatch/features", handler: auth(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const status = url.searchParams.get("status");
        const features = store.listFeatures(status || undefined);
        json(res, 200, features);
      }),
    },

    // --- Add raw idea ---
    {
      method: "POST", path: "/api/dispatch/features", handler: auth(csrf(async (req, res) => {
        const body = await parseJSON(req);
        if (!body.raw || typeof body.raw !== "string" || !body.raw.trim()) {
          return json(res, 400, { error: "raw idea text is required" });
        }
        const feature = await store.addFeature(body.raw.trim());
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

        // Send current state snapshot
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
          broadcast({ type: "hook", featureId, detail, tool: toolName });
        }

        json(res, 200, { ok: true });
      }),
    },

    // --- List available projects from diwa ---
    {
      method: "GET", path: "/api/dispatch/projects", handler: auth(async (req, res) => {
        try {
          const stdout = await exec("diwa", ["ls", "--json"]);
          const projects = JSON.parse(stdout);
          json(res, 200, projects);
        } catch (err) {
          log.warn("Failed to list diwa projects", { error: err.message });
          try {
            const stdout = await exec("diwa", ["ls"]);
            const lines = stdout.trim().split("\n").filter(Boolean);
            json(res, 200, { raw: lines });
          } catch {
            json(res, 500, { error: "Failed to list projects. Is diwa installed?" });
          }
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
        if (body.raw !== undefined) allowed.raw = body.raw;
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

    // --- Trigger refinement: POST /api/dispatch/features/<id>/refine ---
    {
      method: "POST", prefix: "/api/dispatch/refine/", handler: auth(csrf(async (req, res, featureId) => {
        const feature = store.getFeature(featureId);
        if (!feature) return json(res, 404, { error: "Feature not found" });
        if (feature.status !== "raw") {
          return json(res, 400, { error: "Only raw features can be refined" });
        }

        await store.updateFeature(featureId, { status: "refining" });
        broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
        json(res, 202, { ok: true, message: "Refinement started" });

        // Refinement runs async in the background
        refiner.refine(store, featureId).then(() => {
          broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
        }).catch((err) => {
          log.warn("Refinement failed", { featureId, error: err.message });
          broadcast({ type: "feature-updated", feature: store.getFeature(featureId) });
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
