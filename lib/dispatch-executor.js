/**
 * Dispatch Executor
 *
 * Groups features by their project set, creates a kubo per group,
 * and launches a host-side executor session per group that orchestrates
 * agents inside the kubo.
 *
 * Grouping logic:
 *   - Features targeting [katulong] go together
 *   - Features targeting [katulong, yelo] get their own kubo with both mounted
 *   - A single-project feature and a multi-project feature are separate groups
 *     even if they share a project, because the kubo mount sets differ
 *
 * Each executor session runs on the host as a visible katulong terminal.
 * It runs `yolo -p "..."` inside the kubo, which spawns agents per ticket.
 */

import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "./log.js";

function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

let projectPathCache = null;
let projectPathCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getProjectPaths() {
  const now = Date.now();
  if (projectPathCache && now - projectPathCacheTime < CACHE_TTL_MS) return projectPathCache;
  const stdout = await execAsync("diwa", ["ls", "--json"]);
  const projects = JSON.parse(stdout);
  const pathMap = new Map();
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (p.slug && p.path) pathMap.set(p.slug, p.path);
      if (p.name && p.path && !pathMap.has(p.name)) pathMap.set(p.name, p.path);
    }
  }
  projectPathCache = pathMap;
  projectPathCacheTime = now;
  return pathMap;
}

async function listKuboContainers() {
  try {
    const stdout = await execAsync("kubo", ["ls"]);
    return stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    log.warn("Failed to list kubo containers", { error: err.message });
    return [];
  }
}

/**
 * Get the sorted project set key for a feature (used for grouping).
 * e.g. "katulong" or "katulong+yelo"
 */
function projectSetKey(feature) {
  const p = feature.project;
  const slugs = Array.isArray(p) ? [...p].sort() : p ? [p] : [];
  return slugs.join("+");
}

function buildPrompt(features, projectSlugs) {
  const specsBlock = features
    .map((f, i) => {
      const project = Array.isArray(f.project) ? f.project.join(", ") : f.project || "unknown";
      const header = `## Feature ${i + 1}: ${f.refined?.title || f.body}`;
      const spec = f.refined?.spec || f.body;
      return `${header}\nProject: ${project}\nFeature ID: ${f.id}\n\n${spec}`;
    })
    .join("\n\n---\n\n");

  const projectList = projectSlugs.length === 1
    ? `the "${projectSlugs[0]}" project`
    : `these projects: ${projectSlugs.join(", ")}`;

  return `You are implementing features for ${projectList}.

${specsBlock}

## Instructions

1. **Use sub-agents with worktrees for parallel work.** Spin up one agent per ticket. Independent features can run in parallel.

2. **Create pull requests, do NOT push directly to main.** Each ticket gets its own PR with tests and clean commits.

3. **Read each project's CLAUDE.md** for conventions and constraints before making changes.

4. **Run tests before creating PRs.** All existing tests must pass plus new coverage for your changes.

5. When done, note completion in your final message.`;
}

/**
 * Create a dispatch executor.
 * @param {object} [opts]
 * @param {object} [opts.sessionManager] - Katulong session manager
 */
export function createExecutor({ sessionManager } = {}) {
  const activeExecutions = new Map();

  return {
    /**
     * Dispatch features for execution. Groups by project set, creates a kubo
     * and host-side executor session per group.
     *
     * @param {object} store - Dispatch store
     * @param {string[]} featureIds - Feature IDs to execute
     * @param {object} [opts]
     * @param {Function} [opts.onSessionCreated] - Called per group with (featureIds, sessionName)
     */
    async dispatch(store, featureIds, { onSessionCreated } = {}) {
      const features = featureIds.map((id) => store.getFeature(id)).filter(Boolean);
      if (features.length === 0) throw new Error("No valid features found");

      if (!sessionManager) throw new Error("sessionManager required for execution");

      // Group features by their project set
      const groups = new Map();
      for (const f of features) {
        const key = projectSetKey(f);
        if (!key) {
          store.updateFeature(f.id, { status: "failed", execution: { error: "No project assigned" } });
          continue;
        }
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
      }

      let projectPaths;
      try {
        projectPaths = await getProjectPaths();
      } catch (err) {
        throw new Error(`Failed to look up project paths via diwa: ${err.message}`);
      }

      const existingContainers = await listKuboContainers();
      const results = {};

      // Launch one executor session per group (in parallel)
      const groupPromises = [...groups.entries()].map(async ([key, groupFeatures]) => {
        const slugs = key.split("+");

        // Resolve paths for all projects in this group
        const mounts = [];
        for (const slug of slugs) {
          const path = projectPaths.get(slug);
          if (path) mounts.push({ slug, path });
          else log.warn("Unknown project slug, skipping", { slug });
        }

        if (mounts.length === 0) {
          for (const f of groupFeatures) {
            store.updateFeature(f.id, { status: "failed", execution: { error: `Unknown projects: ${key}` } });
          }
          results[key] = { error: "unknown projects" };
          return;
        }

        try {
          // Find or create kubo — named after the project set key
          const containerName = `agent-${key}`;
          const exists = existingContainers.includes(containerName);

          if (!exists) {
            log.info("Creating kubo container", { name: containerName, mounts: mounts.map((m) => m.slug) });
            await execAsync("kubo", ["new", containerName, mounts[0].path], { timeout: 60000 });
            for (const m of mounts.slice(1)) {
              try {
                await execAsync("kubo", ["add", containerName, m.path], { timeout: 30000 });
              } catch (err) {
                log.warn("Failed to add mount", { container: containerName, slug: m.slug, error: err.message });
              }
            }
          }

          // Build prompt and write to temp file
          const prompt = buildPrompt(groupFeatures, slugs);
          const startedAt = new Date().toISOString();
          const promptFile = join(tmpdir(), `dispatch-exec-${key}-${Date.now()}.txt`);
          writeFileSync(promptFile, prompt);

          // Create host-side executor session
          const sessionName = `exec-${key}-${Date.now()}`;
          const result = await sessionManager.createSession(sessionName, 120, 40, null, { persistent: true });
          if (result.error) {
            try { unlinkSync(promptFile); } catch {}
            throw new Error(`Failed to create session: ${result.error}`);
          }

          // Update features with session info
          for (const f of groupFeatures) {
            store.updateFeature(f.id, {
              status: "active",
              sessionName,
              execution: { kuboName: containerName, startedAt },
            });
            activeExecutions.set(f.id, { sessionName, containerName, startedAt });
          }

          // Notify so routes can broadcast the updated features (with sessionName)
          if (onSessionCreated) onSessionCreated(groupFeatures.map((f) => f.id), sessionName);

          // Launch yolo in the kubo from the host session
          const session = sessionManager.getSession(sessionName);
          session.write(`docker exec -i ${containerName} yolo -p "$(cat ${promptFile})"\r`);

          log.info("Executor session launched", {
            session: sessionName,
            container: containerName,
            projects: slugs,
            features: groupFeatures.map((f) => f.id),
          });

          // Poll for session exit
          const pollExit = setInterval(() => {
            const s = sessionManager.getSession(sessionName);
            if (!s || !s.alive) {
              clearInterval(pollExit);
              try { unlinkSync(promptFile); } catch {}
              for (const f of groupFeatures) {
                activeExecutions.delete(f.id);
                const current = store.getFeature(f.id);
                if (current && current.status === "active") {
                  store.updateFeature(f.id, {
                    status: "done",
                    execution: { ...current.execution, finishedAt: new Date().toISOString() },
                  });
                }
              }
            }
          }, 5000);
          pollExit.unref?.();

          results[key] = { containerName, sessionName, featureIds: groupFeatures.map((f) => f.id) };
        } catch (err) {
          log.error("Executor group failed", { key, error: err.message });
          for (const f of groupFeatures) {
            store.updateFeature(f.id, {
              status: "failed",
              execution: { error: `Dispatch failed: ${err.message}` },
            });
          }
          results[key] = { error: err.message };
        }
      });

      await Promise.allSettled(groupPromises);
      return results;
    },

    async cancel(store, featureId) {
      const execution = activeExecutions.get(featureId);
      if (!execution) {
        log.warn("Cancel requested but no active execution found", { featureId });
        return false;
      }

      const { sessionName } = execution;
      log.info("Cancelling execution", { featureId, session: sessionName });

      if (sessionName && sessionManager) {
        const session = sessionManager.getSession(sessionName);
        if (session?.alive) {
          session.write("\x03");
          setTimeout(() => {
            const s = sessionManager.getSession(sessionName);
            if (s?.alive) sessionManager.deleteSession(sessionName);
          }, 5000);
        }
      }

      activeExecutions.delete(featureId);
      const current = store.getFeature(featureId);
      if (current) {
        store.updateFeature(featureId, {
          status: "cancelled",
          execution: { ...current.execution, cancelledAt: new Date().toISOString(), error: "Cancelled by user" },
        });
      }
      return true;
    },

    getActiveExecutions() {
      return [...activeExecutions.entries()].map(([featureId, exec]) => ({
        featureId,
        sessionName: exec.sessionName,
        containerName: exec.containerName,
        startedAt: exec.startedAt,
      }));
    },
  };
}
