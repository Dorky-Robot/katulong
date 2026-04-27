/**
 * Manifest for the Ollama bridge.
 *
 * The Ollama daemon listens on 127.0.0.1:11434 by default and has no
 * native auth or TLS, so it can't be safely exposed across machines on
 * its own. This bridge wraps it: bearer-token auth at 127.0.0.1:11435,
 * opaque pass-through forwarded to the local daemon. A katulong on a
 * GPU-poor host points its outbound LLM client at this bridge running
 * on a GPU-rich host (with a Cloudflare tunnel or similar in front).
 */

export default {
  name: "ollama",
  port: 11435,
  target: "http://127.0.0.1:11434",
  description: "Authenticated reverse proxy to local Ollama (port 11434)",
};
