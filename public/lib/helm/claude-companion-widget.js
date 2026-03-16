/**
 * Claude Companion Widget
 *
 * Wraps createHelmComponent as a dashboard widget. Each instance is
 * an independent helm view scoped to one Claude Code session.
 */

import { createHelmComponent } from "/lib/helm/helm-component.js";
import { registerWidget } from "/lib/helm/dashboard.js";

/**
 * Register the claude-companion widget type.
 *
 * @param {object} opts
 * @param {(session: string, content: string) => void} opts.onSendMessage
 * @param {(session: string) => void} opts.onAbort
 */
export function registerClaudeCompanionWidget({ onSendMessage, onAbort }) {
  registerWidget("claude-companion", {
    create(el, context) {
      const helm = createHelmComponent({
        onSendMessage,
        onAbort,
        onToggleTerminal: () => {}, // no-op inside dashboard
      });

      helm.mount(el);

      if (context.sessionName) {
        helm.helmStarted(context.sessionName, {
          agent: context.agent || "claude-code",
          prompt: context.prompt || null,
          cwd: context.cwd || null,
        });
        helm.showSession(context.sessionName);
      }

      return {
        update(ctx) {
          if (ctx.sessionName) helm.showSession(ctx.sessionName);
        },
        unmount() {
          helm.unmount();
        },
        // Expose helm API for event routing
        helm,
      };
    },
  });
}
