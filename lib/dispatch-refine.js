/**
 * Dispatch Refinement Engine
 *
 * Takes a raw feature idea and refines it into an actionable spec
 * by consulting diwa for project context and Claude for spec generation.
 * The refined spec includes a title, detailed description, sub-tasks,
 * and an estimate of how many agents are needed.
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.js";

/**
 * Run a command and return stdout. Rejects on non-zero exit.
 */
function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, maxBuffer: 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/**
 * Ask Claude a question via the CLI. Returns the response text.
 */
async function askClaude(prompt) {
  const stdout = await exec("claude", ["--print", "-p", prompt], { timeout: 120000 });
  return stdout.trim();
}

/**
 * Get the list of available diwa-indexed projects.
 * Tries --json first, falls back to plain text parsing.
 * @returns {Array<{name: string, path: string}>}
 */
async function getProjects() {
  try {
    const stdout = await exec("diwa", ["ls", "--json"]);
    const parsed = JSON.parse(stdout);
    // Handle both array and object-with-projects formats
    if (Array.isArray(parsed)) return parsed;
    if (parsed.projects && Array.isArray(parsed.projects)) return parsed.projects;
    return Object.entries(parsed).map(([name, info]) => ({
      name,
      path: typeof info === "string" ? info : info.path || "",
    }));
  } catch {
    // Fall back to plain text
    const stdout = await exec("diwa", ["ls"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.map((line) => {
      // Common formats: "name  /path/to/project" or "name: /path/to/project"
      const match = line.match(/^(\S+)\s+(.+)$/) || line.match(/^(\S+):\s*(.+)$/);
      if (match) return { name: match[1], path: match[2].trim() };
      return { name: line.trim(), path: "" };
    });
  }
}

/**
 * Search diwa for architectural context related to the idea.
 * @param {string} project - Project slug
 * @param {string} query - Search query (the raw idea)
 * @returns {string[]} Array of relevant insights
 */
async function searchDiwa(project, query) {
  try {
    const stdout = await exec("diwa", ["search", project, query], { timeout: 30000 });
    const lines = stdout.trim().split("\n").filter(Boolean);
    return lines.length > 0 ? lines : [];
  } catch (err) {
    log.warn("diwa search failed, proceeding without context", { project, error: err.message });
    return [];
  }
}

/**
 * Read a project's CLAUDE.md for constraints and guidelines.
 * @param {string} projectPath - Absolute path to the project root
 * @returns {string} Contents of CLAUDE.md, or empty string if not found
 */
function readClaudeMd(projectPath) {
  if (!projectPath) return "";
  try {
    return readFileSync(join(projectPath, "CLAUDE.md"), "utf-8");
  } catch {
    return "";
  }
}

/**
 * Create a refinement engine.
 * @returns {{ refine(store: object, featureId: string): Promise<object> }}
 */
export function createRefiner() {
  return {
    /**
     * Refine a raw feature idea into an actionable spec.
     * Updates the store with the refined spec or reverts to "raw" on failure.
     *
     * @param {object} store - Dispatch store instance
     * @param {string} featureId - Feature ID to refine
     * @returns {Promise<object>} The refined spec object
     */
    async refine(store, featureId) {
      const feature = store.getFeature(featureId);
      if (!feature) throw new Error(`Feature ${featureId} not found`);

      const rawIdea = feature.raw;
      log.info("Starting refinement", { featureId, raw: rawIdea.slice(0, 100) });

      try {
        // Step 1: Get available projects
        const projects = await getProjects();
        const projectList = projects
          .map((p) => `- ${p.name} (${p.path})`)
          .join("\n");

        // Step 2: Ask Claude which project this targets
        const projectAnswer = await askClaude(
          `Given this list of projects:\n${projectList}\n\n` +
          `Which project does this feature idea target? Answer with ONLY the project name, nothing else.\n\n` +
          `Feature idea: "${rawIdea}"`
        );

        const projectName = projectAnswer.trim().split("\n")[0].trim();
        const matchedProject = projects.find(
          (p) => p.name.toLowerCase() === projectName.toLowerCase()
        );
        const projectPath = matchedProject?.path || "";

        log.info("Identified target project", { featureId, project: projectName, path: projectPath });

        // Step 3: Search diwa for related context
        const diwaContext = await searchDiwa(projectName, rawIdea);

        // Step 4: Read project's CLAUDE.md
        const claudeMd = readClaudeMd(projectPath);
        const constraintsSection = claudeMd
          ? `\n\nProject constraints (from CLAUDE.md):\n${claudeMd.slice(0, 3000)}`
          : "";

        const diwaSection = diwaContext.length > 0
          ? `\n\nRelated architectural history (from diwa):\n${diwaContext.join("\n")}`
          : "";

        // Step 5: Ask Claude to produce the refined spec
        const specPrompt =
          `You are refining a raw feature idea into an actionable spec for a development team.\n\n` +
          `Raw idea: "${rawIdea}"\n` +
          `Target project: ${projectName}` +
          constraintsSection +
          diwaSection +
          `\n\nProduce a JSON object with exactly this structure (no markdown fencing, just raw JSON):\n` +
          `{\n` +
          `  "title": "short imperative title (under 60 chars)",\n` +
          `  "spec": "detailed specification of what to build and how",\n` +
          `  "subtasks": [\n` +
          `    { "id": "st-1", "description": "what this subtask does", "worktree": true }\n` +
          `  ],\n` +
          `  "estimatedAgents": 1\n` +
          `}\n\n` +
          `Guidelines:\n` +
          `- The title should be a clear imperative (e.g., "Add configurable key bindings system")\n` +
          `- The spec should be detailed enough for an engineer to implement without further clarification\n` +
          `- Break into subtasks that can run in parallel where possible\n` +
          `- Set worktree: true for subtasks that modify code (most of them)\n` +
          `- Set worktree: false for subtasks that are research-only or documentation-only\n` +
          `- estimatedAgents is how many parallel agents could work on this (usually matches subtask count)\n` +
          `- Number subtask IDs sequentially: st-1, st-2, st-3, etc.\n`;

        const specResponse = await askClaude(specPrompt);

        // Parse the JSON response — strip markdown fencing if Claude added it anyway
        let specJson = specResponse;
        const fenceMatch = specResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) specJson = fenceMatch[1];

        const refined = JSON.parse(specJson.trim());

        // Validate required fields
        if (!refined.title || !refined.spec || !Array.isArray(refined.subtasks)) {
          throw new Error("Claude returned invalid spec structure");
        }

        // Attach diwa context for reference
        refined.diwaContext = diwaContext;

        // Step 6: Update the store
        store.updateFeature(featureId, {
          status: "refined",
          project: projectName,
          refined,
        });

        log.info("Refinement complete", {
          featureId,
          title: refined.title,
          subtasks: refined.subtasks.length,
          estimatedAgents: refined.estimatedAgents,
        });

        return refined;
      } catch (err) {
        log.error("Refinement failed", { featureId, error: err.message });
        store.updateFeature(featureId, { status: "raw" });
        throw err;
      }
    },
  };
}
