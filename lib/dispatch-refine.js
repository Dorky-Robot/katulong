/**
 * Dispatch Refinement Engine
 *
 * Creates a visible Claude Code session and gives it a prompt with
 * the raw ideas. Claude figures out the rest — it has access to diwa,
 * the filesystem, CLAUDE.md, etc. No server-side orchestration.
 *
 * Live progress comes from Claude Code hooks (configured in
 * .claude/settings.local.json) which POST tool events to
 * /api/dispatch/hook. The hook endpoint broadcasts them via SSE.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { log } from "./log.js";

function pollForFile(path, { intervalMs = 3000, timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      try {
        const content = await readFile(path, "utf-8");
        if (content.length > 0) { resolve(content); return; }
      } catch {}
      if (Date.now() > deadline) { reject(new Error(`Timeout waiting for ${path}`)); return; }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Create a refinement engine.
 * @param {object} [opts]
 * @param {object} [opts.sessionManager] - Katulong session manager
 */
export function createRefiner({ sessionManager } = {}) {
  return {
    /**
     * Batch-refine raw features in a visible Claude Code session.
     * Claude decides how to research, consolidate, split, and spec the ideas.
     *
     * @param {object} store - Dispatch store
     * @param {string[]} featureIds - Raw feature IDs to refine
     * @param {object} [opts]
     * @param {string} [opts.sessionTag] - Session name
     * @returns {Promise<object[]>} Array of newly created refined features
     */
    async refineBatch(store, featureIds, { sessionTag } = {}) {
      const features = featureIds.map((id) => store.getFeature(id)).filter(Boolean);
      if (features.length === 0) throw new Error("No features found");

      log.info("Starting batch refinement", { count: features.length, featureIds });

      const rawIdeasBlock = features.map((f, i) =>
        `${i + 1}. [${f.id}] "${f.body}"`
      ).join("\n");

      const outputFile = join(tmpdir(), `dispatch-refine-${sessionTag}.json`);

      const prompt =
        `You are a product engineer triaging raw feature ideas into implementable tickets.\n\n` +
        `## Raw ideas\n${rawIdeasBlock}\n\n` +
        `## Your task\n\n` +
        `### 1. Discover projects\n` +
        `Run \`diwa ls\` to see all available projects and their paths.\n\n` +
        `### 2. Understand each project's vision\n` +
        `For every project that might be affected by these ideas:\n` +
        `- Read its CLAUDE.md to understand architecture, constraints, and direction\n` +
        `- Run \`diwa search <project> "<relevant idea>"\` for past decisions and context\n\n` +
        `### 3. Organize ideas into tickets\n` +
        `These raw ideas may be scattered, overlap, or span multiple projects. Your job is to turn them into clean, actionable tickets:\n` +
        `- **One idea may affect multiple projects** — split into separate per-project tickets\n` +
        `- **Multiple ideas may be the same thing** — consolidate into one ticket\n` +
        `- **An idea may conflict with a project's direction** — flag it with what's misaligned\n` +
        `- **An idea may be too vague** — flag it as needs-info and say what's missing\n` +
        `- Each ticket targets exactly ONE project\n` +
        `- Each ticket should be aligned with that project's vision and constraints\n\n` +
        `### 4. Write results\n` +
        `Write a JSON array to ${outputFile}:\n` +
        `[\n` +
        `  {\n` +
        `    "title": "short imperative title (under 60 chars)",\n` +
        `    "spec": "detailed specification of what to build",\n` +
        `    "project": "slug" or ["slug1", "slug2"] for cross-project work,\n` +
        `    "sourceIds": ["f-abc", "f-def"],\n` +
        `    "status": "refined",\n` +
        `    "subtasks": [\n` +
        `      { "id": "st-1", "description": "...", "worktree": true }\n` +
        `    ],\n` +
        `    "estimatedAgents": 1\n` +
        `  }\n` +
        `]\n\n` +
        `- status: "refined" for actionable tickets, "needs-info" for vague/unclear ones\n` +
        `- For needs-info, add "needsInfoReason" explaining what's missing\n` +
        `- sourceIds must reference the [f-xxx] IDs from the raw ideas above\n` +
        `- A single raw idea can produce multiple tickets if it's truly separate work\n` +
        `- But if work spans projects naturally, use a single ticket with project as an array\n` +
        `- Multiple raw ideas can map to one ticket (consolidation)\n`;

      const sessionName = sessionTag || `refine-${Date.now()}`;

      if (!sessionManager) {
        throw new Error("sessionManager required for refinement");
      }

      const result = await sessionManager.createSession(sessionName, 120, 40, null, { persistent: true });
      if (result.error) throw new Error(`Failed to create session: ${result.error}`);

      // Link session to all grouped features
      for (const f of features) {
        await store.updateFeature(f.id, { sessionName });
      }

      // Write prompt to file and run Claude Code in the session
      const promptFile = join(tmpdir(), `dispatch-refine-${sessionTag}.txt`);
      writeFileSync(promptFile, prompt);

      const session = sessionManager.getSession(sessionName);
      session.write(`claude -p "$(cat ${promptFile})"\r`);

      log.info("Launched Claude Code refine session", { sessionName, featureCount: features.length });

      // Wait for Claude to write the output file
      let response;
      try {
        response = await pollForFile(outputFile, { intervalMs: 3000, timeoutMs: 600000 });
      } finally {
        try { unlinkSync(promptFile); } catch {}
        try { unlinkSync(outputFile); } catch {}
      }

      // Parse and create refined features
      let jsonStr = response;
      const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) jsonStr = fenceMatch[1];

      const tickets = JSON.parse(jsonStr.trim());
      if (!Array.isArray(tickets)) throw new Error("Claude did not return an array");

      const created = [];
      for (const ticket of tickets) {
        if (!ticket.title || !ticket.sourceIds) continue;

        const status = ticket.status === "needs-info" ? "raw" : "refined";
        const newFeature = store.addFeature(ticket.spec || ticket.title, null);

        store.updateFeature(newFeature.id, {
          status,
          project: ticket.project || null,
          sourceIds: ticket.sourceIds,
          refined: status === "refined" ? {
            title: ticket.title,
            spec: ticket.spec,
            subtasks: ticket.subtasks || [],
            estimatedAgents: ticket.estimatedAgents || 1,
          } : null,
          needsInfoReason: ticket.needsInfoReason || null,
        });

        created.push(store.getFeature(newFeature.id));
        log.info("Created refined feature", { id: newFeature.id, title: ticket.title, sourceIds: ticket.sourceIds });
      }

      log.info("Batch refinement complete", { inputCount: features.length, outputCount: created.length });
      return created;
    },

    /** Single-feature refine (backward compat). */
    async refine(store, featureId, opts = {}) {
      const results = await this.refineBatch(store, [featureId], { ...opts, sessionTag: `refine-${featureId}` });
      return results[0]?.refined || null;
    },
  };
}
