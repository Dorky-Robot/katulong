/**
 * CLI: katulong sub <topic>
 *
 * Subscribe to a topic. Streams messages to stdout via SSE.
 *
 * Flags:
 *   --once   Wait for one message, then exit
 *   --json   Output raw JSON envelopes
 */

import { ensureRunning } from "../api-client.js";
import envConfig from "../../env-config.js";

const BASE = `http://localhost:${process.env.KATULONG_PORT || envConfig.port}`;

export default async function sub(args) {
  const once = args.includes("--once");
  const jsonMode = args.includes("--json");
  const topic = args.find(a => !a.startsWith("--"));

  if (!topic) {
    console.error("Usage: katulong sub <topic> [--once] [--json]");
    process.exit(1);
  }

  ensureRunning();

  try {
    const response = await fetch(`${BASE}/sub/${encodeURIComponent(topic)}`);
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
    if (err.cause?.code === "ECONNREFUSED") {
      console.error("Server is not running. Start with: katulong start");
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}
