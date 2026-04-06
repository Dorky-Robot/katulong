/**
 * CLI: katulong sub <topic>
 *
 * Subscribe to a topic. Streams messages to stdout via SSE.
 *
 * Flags:
 *   --once           Wait for one message, then exit
 *   --json           Output raw JSON envelopes (includes seq number)
 *   --from-seq N     Replay messages starting at sequence number N
 */

import { ensureRunning, getBase } from "../api-client.js";

export default async function sub(args) {
  const once = args.includes("--once");
  const jsonMode = args.includes("--json");

  // Parse --from-seq N
  let fromSeq = null;
  const fromSeqIdx = args.indexOf("--from-seq");
  if (fromSeqIdx !== -1 && args[fromSeqIdx + 1]) {
    fromSeq = parseInt(args[fromSeqIdx + 1], 10);
    if (!Number.isFinite(fromSeq) || fromSeq < 0) {
      console.error("Error: --from-seq requires a non-negative integer");
      process.exit(1);
    }
  }

  const topic = args.find(a => !a.startsWith("--") && a !== String(fromSeq));

  if (!topic) {
    console.error("Usage: katulong sub <topic> [--once] [--json] [--from-seq N]");
    process.exit(1);
  }

  ensureRunning();

  try {
    let url = `${getBase()}/sub/${encodeURIComponent(topic)}`;
    if (fromSeq !== null) url += `?fromSeq=${fromSeq}`;

    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Error: ${response.status} ${response.statusText}`);
      process.exit(1);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        try {
          const envelope = JSON.parse(data);
          if (jsonMode) {
            console.log(JSON.stringify(envelope));
          } else {
            console.log(envelope.message);
          }
          if (once) {
            reader.cancel();
            process.exit(0);
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }
  } catch (err) {
    // Match api-client.request()'s guard: fetch wraps some errors in `cause`
    // (common on Linux/macOS), while others surface `code` directly (varies
    // by Node version). Checking both covers the full matrix.
    if (err.cause?.code === "ECONNREFUSED" || err.code === "ECONNREFUSED") {
      console.error("Server is not running. Start with: katulong start");
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}
