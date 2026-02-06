// Newline-delimited JSON framing for net.Socket streams.

import { log } from "./log.js";

export function encode(msg) {
  return JSON.stringify(msg) + "\n";
}

// Returns a "data" handler that parses newline-delimited JSON chunks
// and calls onMessage(parsed) for each complete line.
export function decoder(onMessage) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line));
        } catch (e) {
          log.warn("Bad ndjson message", { error: e.message });
        }
      }
    }
  };
}
