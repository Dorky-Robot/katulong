/**
 * Dispatch Executor
 *
 * Takes approved refined features, groups them by project, spins up kubo
 * containers, and launches Claude (via yolo) to implement them autonomously.
 *
 * Execution flow:
 *   1. Look up project paths via `diwa ls --json`
 *   2. Group features by project slug
 *   3. For each project group, find or create a kubo container
 *   4. Build a prompt with all refined specs for the group
 *   5. Run `docker exec <container> yolo -p "<prompt>"` via spawn
 *   6. Track the child process so cancel() can kill it
 */

import { spawn, execFile } from "node:child_process";
import { log } from "./log.js";

/**
 * Promisified execFile with a reasonable timeout.
 */
function execAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/** Cache for diwa project path lookups: slug → absolute path */
let projectPathCache = null;
let projectPathCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Look up project paths from diwa. Returns a Map of slug → path.
 * Cached for CACHE_TTL_MS to avoid repeated subprocess calls.
 */
async function getProjectPaths() {
  const now = Date.now();
  if (projectPathCache && now - projectPathCacheTime < CACHE_TTL_MS) {
    return projectPathCache;
  }

  const stdout = await execAsync("diwa", ["ls", "--json"]);
  const projects = JSON.parse(stdout);

  const pathMap = new Map();
  // diwa ls --json returns an array of { slug, path, ... } objects
  if (Array.isArray(projects)) {
    for (const p of projects) {
      if (p.slug && p.path) pathMap.set(p.slug, p.path);
      // Also try name as slug fallback
      if (p.name && p.path && !pathMap.has(p.name)) pathMap.set(p.name, p.path);
    }
  }

  projectPathCache = pathMap;
  projectPathCacheTime = now;
  return pathMap;
}

/**
 * List running kubo containers. Returns an array of container name strings.
 */
async function listKuboContainers() {
  try {
    const stdout = await execAsync("kubo", ["ls"]);
    return stdout
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    log.warn("Failed to list kubo containers", { error: err.message });
    return [];
  }
}

/**
 * Find an existing kubo container for a project slug.
 * Container naming convention: agent-<project-slug>
 */
function findContainerForProject(containers, projectSlug) {
  const prefix = `agent-${projectSlug}`;
  return containers.find(
    (name) => name === prefix || name.startsWith(prefix + "-")
  );
}

/**
 * Create a new kubo container for a project.
 * @param {string} projectSlug - The project slug
 * @param {string} projectPath - Absolute path to the project
 * @returns {Promise<string>} The container name
 */
async function createKuboContainer(projectSlug, projectPath) {
  const containerName = `agent-${projectSlug}`;
  log.info("Creating kubo container", { name: containerName, path: projectPath });

  try {
    await execAsync("kubo", ["new", containerName, projectPath], {
      timeout: 60000, // container creation can take a while
    });
    return containerName;
  } catch (err) {
    log.error("Failed to create kubo container", {
      name: containerName,
      error: err.message,
    });
    throw err;
  }
}

/**
 * Build the prompt for Claude inside the kubo container.
 * Includes all refined specs for a project group plus instructions
 * for worktree-based parallel work and PR creation.
 */
function buildPrompt(features, projectSlug) {
  const specsBlock = features
    .map((f, i) => {
      const header = `## Feature ${i + 1}: ${f.refined?.title || f.raw}`;
      const spec = f.refined?.spec || f.refined || f.raw;
      const featureId = f.id;
      return `${header}\n\nFeature ID: ${featureId}\n\n${spec}`;
    })
    .join("\n\n---\n\n");

  return `You are implementing features for the "${projectSlug}" project.

Here are the feature specifications to implement:

${specsBlock}

## Instructions

1. **Use sub-agents with worktrees for parallel work.** If there are multiple independent features, use separate worktrees so they can be developed in parallel without conflicts.

2. **Create pull requests, do NOT push directly to main.** Each feature should result in its own PR with:
   - A clear title and description
   - Tests for the new functionality
   - Clean commit history

3. **Follow the project's existing conventions.** Read CLAUDE.md and existing code to understand the coding style, test patterns, and project structure before making changes.

4. **Run tests before creating PRs.** Make sure all existing tests pass and add new tests for your changes.

5. When done with each feature, update its status by noting completion in your final message.`;
}

/**
 * Create a dispatch executor that manages kubo containers and yolo processes.
 *
 * @returns {object} Executor API: dispatch(), cancel(), getActiveExecutions()
 */
export function createExecutor() {
  /** Map of featureId → { process, containerName, projectSlug, startedAt } */
  const activeExecutions = new Map();

  return {
    /**
     * Dispatch one or more features for execution in kubo containers.
     * Groups features by project, creates containers as needed, and
     * spawns yolo processes inside them.
     *
     * @param {object} store - The dispatch store instance
     * @param {string[]} featureIds - Array of feature IDs to dispatch
     * @returns {Promise<object>} Summary of dispatched groups
     */
    async dispatch(store, featureIds) {
      // Resolve features and validate
      const features = featureIds
        .map((id) => store.getFeature(id))
        .filter(Boolean);

      if (features.length === 0) {
        throw new Error("No valid features found for the given IDs");
      }

      // Check that all features have a project assigned
      const missing = features.filter((f) => !f.project);
      if (missing.length > 0) {
        throw new Error(
          `Features missing project assignment: ${missing.map((f) => f.id).join(", ")}`
        );
      }

      // Group features by project
      const groups = new Map();
      for (const f of features) {
        if (!groups.has(f.project)) groups.set(f.project, []);
        groups.get(f.project).push(f);
      }

      // Look up project paths
      let projectPaths;
      try {
        projectPaths = await getProjectPaths();
      } catch (err) {
        throw new Error(`Failed to look up project paths via diwa: ${err.message}`);
      }

      // List existing kubo containers once
      const existingContainers = await listKuboContainers();

      const results = {};

      // Process each project group
      for (const [projectSlug, groupFeatures] of groups) {
        const projectPath = projectPaths.get(projectSlug);
        if (!projectPath) {
          // Mark features as failed — unknown project
          for (const f of groupFeatures) {
            store.updateFeature(f.id, {
              status: "failed",
              execution: {
                error: `Unknown project slug: ${projectSlug}. Not found in diwa.`,
                failedAt: new Date().toISOString(),
              },
            });
          }
          results[projectSlug] = { error: "unknown project" };
          continue;
        }

        try {
          // Find or create kubo container
          let containerName = findContainerForProject(existingContainers, projectSlug);
          if (!containerName) {
            containerName = await createKuboContainer(projectSlug, projectPath);
          }

          // Build the prompt
          const prompt = buildPrompt(groupFeatures, projectSlug);

          // Mark features as active with execution metadata
          const startedAt = new Date().toISOString();
          for (const f of groupFeatures) {
            store.updateFeature(f.id, {
              status: "active",
              execution: {
                kuboName: containerName,
                startedAt,
                logs: [],
              },
            });
          }

          // Spawn yolo inside the kubo container
          const child = spawn(
            "docker",
            ["exec", "-i", containerName, "yolo", "-p", prompt],
            {
              stdio: ["ignore", "pipe", "pipe"],
              detached: false,
            }
          );

          log.info("Dispatched yolo execution", {
            container: containerName,
            project: projectSlug,
            featureCount: groupFeatures.length,
            featureIds: groupFeatures.map((f) => f.id),
            pid: child.pid,
          });

          // Track the execution for each feature in this group
          for (const f of groupFeatures) {
            activeExecutions.set(f.id, {
              process: child,
              containerName,
              projectSlug,
              startedAt,
            });
          }

          // Capture stdout for logging
          if (child.stdout) {
            child.stdout.on("data", (chunk) => {
              const text = chunk.toString().trim();
              if (!text) return;
              // Log to the first feature in the group (they share a process)
              const primaryId = groupFeatures[0].id;
              store.addLog(primaryId, text.slice(0, 500));
            });
          }

          // Capture stderr
          if (child.stderr) {
            child.stderr.on("data", (chunk) => {
              const text = chunk.toString().trim();
              if (!text) return;
              log.warn("yolo stderr", { project: projectSlug, text: text.slice(0, 500) });
            });
          }

          // Handle process exit
          child.on("close", (code) => {
            const status = code === 0 ? "done" : "failed";
            log.info("yolo process exited", {
              project: projectSlug,
              code,
              status,
            });

            for (const f of groupFeatures) {
              activeExecutions.delete(f.id);
              const current = store.getFeature(f.id);
              // Don't overwrite if already cancelled/failed by cancel()
              if (current && current.status === "active") {
                const execution = current.execution || {};
                store.updateFeature(f.id, {
                  status,
                  execution: {
                    ...execution,
                    finishedAt: new Date().toISOString(),
                    exitCode: code,
                    ...(code !== 0 ? { error: `Process exited with code ${code}` } : {}),
                  },
                });
              }
            }
          });

          // Handle spawn errors
          child.on("error", (err) => {
            log.error("yolo spawn error", {
              project: projectSlug,
              error: err.message,
            });

            for (const f of groupFeatures) {
              activeExecutions.delete(f.id);
              store.updateFeature(f.id, {
                status: "failed",
                execution: {
                  error: `Spawn error: ${err.message}`,
                  failedAt: new Date().toISOString(),
                },
              });
            }
          });

          results[projectSlug] = {
            containerName,
            featureIds: groupFeatures.map((f) => f.id),
            pid: child.pid,
          };
        } catch (err) {
          log.error("Failed to dispatch project group", {
            project: projectSlug,
            error: err.message,
          });

          for (const f of groupFeatures) {
            store.updateFeature(f.id, {
              status: "failed",
              execution: {
                error: `Dispatch failed: ${err.message}`,
                failedAt: new Date().toISOString(),
              },
            });
          }
          results[projectSlug] = { error: err.message };
        }
      }

      return results;
    },

    /**
     * Cancel an active feature execution.
     * Kills the spawned process and updates the feature status.
     *
     * @param {object} store - The dispatch store instance
     * @param {string} featureId - The feature ID to cancel
     * @returns {boolean} True if a process was killed
     */
    async cancel(store, featureId) {
      const execution = activeExecutions.get(featureId);
      if (!execution) {
        log.warn("Cancel requested but no active execution found", { featureId });
        return false;
      }

      const { process: child, containerName, projectSlug } = execution;

      log.info("Cancelling execution", {
        featureId,
        container: containerName,
        project: projectSlug,
        pid: child.pid,
      });

      // Kill the child process tree
      try {
        child.kill("SIGTERM");
        // Give it a moment to clean up, then force kill
        setTimeout(() => {
          try {
            if (!child.killed) child.kill("SIGKILL");
          } catch {
            // Already dead, that's fine
          }
        }, 5000);
      } catch (err) {
        log.warn("Error killing process", { error: err.message });
      }

      // Update feature status
      activeExecutions.delete(featureId);
      const current = store.getFeature(featureId);
      if (current) {
        const currentExecution = current.execution || {};
        store.updateFeature(featureId, {
          status: "cancelled",
          execution: {
            ...currentExecution,
            cancelledAt: new Date().toISOString(),
            error: "Cancelled by user",
          },
        });
      }

      return true;
    },

    /**
     * Get a snapshot of all active executions.
     * @returns {object[]} Array of { featureId, containerName, projectSlug, startedAt, pid }
     */
    getActiveExecutions() {
      const result = [];
      for (const [featureId, exec] of activeExecutions) {
        result.push({
          featureId,
          containerName: exec.containerName,
          projectSlug: exec.projectSlug,
          startedAt: exec.startedAt,
          pid: exec.process.pid,
        });
      }
      return result;
    },
  };
}
