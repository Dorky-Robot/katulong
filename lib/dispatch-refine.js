/**
 * Dispatch Refinement Engine — Headless Batch
 *
 * Runs a single `claude` subprocess with --output-format stream-json to
 * refine one or more raw feature ideas into actionable tickets. Progress
 * bullets are derived from tool_use events in the stream and pushed to
 * each grouped feature via store.addLog, which broadcasts over SSE.
 *
 * No terminal sessions, no workspace dirs, no trust-dialog handling.
 * Communication is stdout-only.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * Translate a stream-json tool_use event into a short human-readable bullet.
 * Returns null to skip the event.
 */
function toolUseBullet(event) {
  const tool = event.tool || event.name || "";
  const input = event.tool_input || event.input || {};

  if (tool === "Bash") {
    const cmd = input.command || "";
    if (cmd.includes("diwa search")) return "Searching diwa history";
    if (cmd.includes("diwa ls")) return "Listing projects";
    if (cmd.includes("npm test") || cmd.includes("node test")) return "Running tests";
    if (cmd.includes("git")) return null; // skip noisy git ops
    return null;
  }
  if (tool === "Read") {
    const fp = input.file_path || "";
    if (fp.endsWith("CLAUDE.md")) {
      const project = fp.split("/").at(-2) || "project";
      return `Reading ${project} CLAUDE.md`;
    }
    const base = fp.split("/").pop() || "file";
    return `Reading ${base}`;
  }
  if (tool === "Grep" || tool === "Glob") return "Searching codebase";
  return null; // skip unknown tools
}

/**
 * Build the prompt that tells Claude to triage and refine a numbered list
 * of raw feature ideas.
 */
function buildBatchPrompt(features) {
  const numbered = features
    .map((f, i) => `${i + 1}. [${f.id}] ${f.body || f.raw || ""}`)
    .join("\n");

  return `You are a feature triage and refinement engine. You will be given a numbered list of raw feature ideas, each tagged with a [f-xxx] ID.

Your job:
1. Run \`diwa ls\` to discover available projects.
2. For every project that might be affected by any idea, read its CLAUDE.md and run \`diwa search <project> "<idea>"\` for context.
3. Triage the ideas:
   - Consolidate duplicates (reference all source IDs).
   - Split cross-project ideas into separate tickets.
   - Flag vague ones as "needs-info".
4. Emit a JSON array as your FINAL response — nothing else. Each element:
   {
     "title": "short imperative title (under 60 chars)",
     "spec": "detailed specification of what to build",
     "project": "target project name from diwa ls",
     "sourceIds": ["f-xxx", ...],
     "status": "refined" or "needs-info",
     "subtasks": [{ "id": "st-1", "description": "...", "worktree": true }],
     "estimatedAgents": <number>,
     "needsInfoReason": "only if status is needs-info"
   }

Every source ID from the input MUST appear in exactly one ticket's sourceIds.

Raw ideas:
${numbered}

IMPORTANT: Your final response must be ONLY the JSON array. No markdown fences, no explanation, just the array.`;
}

/**
 * Parse the final result text from the claude subprocess.
 * Strips markdown fences if present, parses JSON array.
 */
function parseResult(text) {
  let json = text.trim();
  // Strip markdown fences
  const fenceMatch = json.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) json = fenceMatch[1].trim();
  // Sometimes the output has leading text before the array
  const arrayStart = json.indexOf("[");
  if (arrayStart > 0) json = json.slice(arrayStart);
  return JSON.parse(json);
}

/**
 * Create a refinement engine.
 */
export function createRefiner() {
  return {
    /**
     * Refine a batch of raw features via a single headless claude subprocess.
     *
     * @param {object} store - Dispatch store instance
     * @param {string[]} featureIds - Feature IDs to refine
     * @param {object} [opts] - Options
     * @param {AbortSignal} [opts.signal] - Abort signal to kill the subprocess
     * @param {(bullet: string) => void} [opts.onProgress] - Called for each
     *   translated tool_use bullet as it arrives (already deduped across the
     *   whole batch). Use for real-time streaming to clients. Exceptions are
     *   swallowed so a bad listener can't tear down the refine.
     * @returns {Promise<object[]>} Array of refined ticket objects
     */
    async refineBatch(store, featureIds, opts = {}) {
      const sessionTag = `batch-${randomUUID().slice(0, 8)}`;

      // Load raw features
      const features = featureIds.map((id) => store.getFeature(id)).filter(Boolean);
      if (features.length === 0) throw new Error("No valid features to refine");

      const prompt = buildBatchPrompt(features);
      log.info("Starting batch refinement", { sessionTag, count: features.length });

      // Dedupe bullets for the whole batch — the sidebar panel aggregates
      // progress across features, so a bullet that already fired for one
      // feature shouldn't fire again for another in the same batch.
      let lastBroadcast = null;
      const lastBullet = new Map();

      function addBulletToAll(text) {
        for (const f of features) {
          if (lastBullet.get(f.id) === text) continue;
          lastBullet.set(f.id, text);
          store.addLog(f.id, text);
        }
        if (lastBroadcast !== text) {
          lastBroadcast = text;
          if (typeof opts.onProgress === "function") {
            try { opts.onProgress(text); }
            catch (err) { log.warn("onProgress listener threw", { error: err.message }); }
          }
        }
      }

      return new Promise((resolve, reject) => {
        const args = [
          "-p",
          "--output-format", "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
          prompt,
        ];

        const child = spawn("claude", args, {
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 300000, // 5 minutes
        });

        if (opts.signal) {
          opts.signal.addEventListener("abort", () => child.kill(), { once: true });
        }

        let lastResultText = "";
        let stdoutBuffer = "";

        function processLine(line) {
          if (!line) return;
          try {
            const event = JSON.parse(line);

            // Capture the final result text
            if (event.type === "result") {
              lastResultText = event.result || event.text || "";
            }
            // Assistant messages carry both text (final response) and tool_use
            // blocks (progress signals) inside event.message.content[]. The
            // top-level stream-json event type is "assistant" — tool_use never
            // appears as a top-level event, it's always nested in a block.
            if (event.type === "assistant" && event.message) {
              const content = event.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    lastResultText = block.text;
                  } else if (block.type === "tool_use") {
                    const bullet = toolUseBullet(block);
                    if (bullet) addBulletToAll(bullet);
                  }
                }
              } else if (typeof content === "string") {
                lastResultText = content;
              }
            }
            // Defensive: if a future stream-json version ever emits tool_use
            // at the top level, handle it too. Harmless today.
            if (event.type === "tool_use") {
              const bullet = toolUseBullet(event);
              if (bullet) addBulletToAll(bullet);
            }
          } catch {
            // Not valid JSON — ignore partial lines
          }
        }

        child.stdout.on("data", (chunk) => {
          stdoutBuffer += chunk.toString();
          let newlineIdx;
          while ((newlineIdx = stdoutBuffer.indexOf("\n")) !== -1) {
            processLine(stdoutBuffer.slice(0, newlineIdx).trim());
            stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
          }
        });

        // Process any remaining buffered data when stdout ends
        let stdoutEnded = false;
        let exitCode = null;

        child.stdout.on("end", () => {
          if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
          stdoutBuffer = "";
          stdoutEnded = true;
          if (exitCode !== null) finish();
        });

        let stderrBuf = "";
        child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

        child.on("error", (err) => {
          reject(new Error(`claude subprocess error: ${err.message}`));
        });

        child.on("close", (code) => {
          exitCode = code;
          if (stdoutEnded) finish();
        });

        function finish() {
          const code = exitCode;
          if (code !== 0 && !lastResultText) {
            // Revert grouped features to raw
            for (const f of features) {
              store.updateFeature(f.id, { status: "raw", groupedInto: null });
            }
            reject(new Error(`claude exited with code ${code}: ${stderrBuf.slice(0, 500)}`));
            return;
          }

          try {
            const tickets = parseResult(lastResultText);
            if (!Array.isArray(tickets) || tickets.length === 0) {
              throw new Error("Expected non-empty JSON array from claude");
            }

            // Validate each ticket has required fields
            for (const ticket of tickets) {
              if (!ticket.title || !ticket.spec || !Array.isArray(ticket.sourceIds)) {
                throw new Error(`Invalid ticket structure: missing title, spec, or sourceIds`);
              }
            }

            // Create refined features from tickets
            const created = [];
            for (const ticket of tickets) {
              const refined = {
                title: ticket.title,
                spec: ticket.spec,
                subtasks: ticket.subtasks || [],
                estimatedAgents: ticket.estimatedAgents || 1,
                needsInfoReason: ticket.needsInfoReason || null,
              };

              const newFeature = store.addFeature(ticket.spec);
              store.updateFeature(newFeature.id, {
                status: ticket.status === "needs-info" ? "needs-info" : "refined",
                project: ticket.project || null,
                refined,
                sourceIds: ticket.sourceIds,
                body: `${ticket.title}\n\n${ticket.spec}`,
              });

              created.push(store.getFeature(newFeature.id));
            }

            // Mark source features as grouped — but only if the caller
            // hasn't already done so. Routes mark features `grouped` with
            // their own tag *before* invoking refineBatch (so the UI shows
            // the transition instantly); re-writing `groupedInto` here would
            // clobber that tag. Standalone callers (tests, scripts) that
            // pass in raw features still get a sessionTag assigned.
            for (const f of features) {
              const latest = store.getFeature(f.id);
              if (!latest || latest.status === "grouped") continue;
              store.updateFeature(f.id, { status: "grouped", groupedInto: sessionTag });
            }

            log.info("Batch refinement complete", {
              sessionTag,
              inputCount: features.length,
              outputCount: created.length,
            });

            resolve(created);
          } catch (err) {
            // Revert source features to raw on parse failure
            for (const f of features) {
              store.updateFeature(f.id, { status: "raw", groupedInto: null });
            }
            reject(new Error(`Failed to parse refinement result: ${err.message}`));
          }
        }
      });
    },

    /**
     * Backward-compatible single-feature refine.
     * Wraps refineBatch with a single ID.
     */
    async refine(store, featureId) {
      const results = await this.refineBatch(store, [featureId]);
      return results[0]?.refined || results[0];
    },
  };
}

// Exported for testing
export { toolUseBullet, buildBatchPrompt, parseResult };
