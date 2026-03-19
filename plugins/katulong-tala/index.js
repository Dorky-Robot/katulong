/**
 * katulong-tala — Tala notes connector for Katulong
 *
 * Connects katulong to a running tala instance via HTTP API.
 * Configure with the tala service URL and an API key in Settings > Connectors.
 *
 * Server side: proxies /tala/api/* requests to the tala instance.
 * Client side: provides a notes panel in katulong's sidebar.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default {
  name: "tala",
  version: "0.2.0",

  config: {
    url: { type: "url", label: "Tala URL", required: true, placeholder: "http://localhost:3838" },
    apiKey: { type: "secret", label: "API Key", required: true, placeholder: "tala_..." },
  },

  server: {
    _url: null,
    _apiKey: null,

    async init(ctx) {
      this._url = ctx.pluginConfig?.url || null;
      this._apiKey = ctx.pluginConfig?.apiKey || null;
      if (this._url && this._apiKey) {
        ctx.log.info("Tala connector configured", { url: this._url });
      } else {
        ctx.log.warn("Tala connector not configured — set URL and API key in Settings > Connectors");
      }
    },

    onConfigChange(config) {
      this._url = config.url || null;
      this._apiKey = config.apiKey || null;
    },

    routes(ctx) {
      const { auth } = ctx;
      const self = this;
      const routes = [];

      // Proxy all /tala/api/* to the tala instance
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        routes.push({
          method,
          prefix: "/tala/api/",
          handler: auth(async (req, res, param) => {
            if (!self._url || !self._apiKey) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Tala connector not configured" }));
              return;
            }
            await proxyToTala(self._url, self._apiKey, method, `/api/${param}`, req, res);
          }),
        });
      }

      // Serve the client-side panel JS
      const clientJsPath = join(__dirname, "client", "tala-panel.js");
      routes.push({
        method: "GET",
        path: "/tala/client/tala-panel.js",
        handler: auth((_req, res) => {
          const content = readFileSync(clientJsPath, "utf-8");
          res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-cache" });
          res.end(content);
        }),
      });

      return routes;
    },

    wsHandlers() {
      // No WS bridging in v1 — REST-only connector
      return {};
    },

    shutdown() {},
  },

  client: {
    css: `
      #tala-panel { display: none; flex: 1; min-height: 0; overflow: hidden; flex-direction: column; }
      #tala-panel.active { display: flex; }
      #terminal-container.tala-hidden { display: none !important; }
    `,
    sidebarButton: {
      id: "sidebar-tala-btn",
      icon: "ph-note-pencil",
      label: "Notes",
      title: "Notes (Tala)",
    },
    panelId: "tala-panel",
    moduleUrl: "/tala/client/tala-panel.js",
    hiddenClass: "tala-hidden",
  },
};

/**
 * Proxy a request to the tala instance.
 */
async function proxyToTala(talaUrl, apiKey, method, path, req, res) {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const targetUrl = `${talaUrl.replace(/\/$/, "")}${path}${reqUrl.search}`;

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  let body;
  if (method !== "GET" && method !== "DELETE") {
    body = await readRequestBody(req);
  }

  try {
    const resp = await fetch(targetUrl, { method, headers, body, signal: AbortSignal.timeout(15000) });
    const contentType = resp.headers.get("content-type") || "application/json";
    const responseBody = await resp.text();
    res.writeHead(resp.status, { "Content-Type": contentType });
    res.end(responseBody);
  } catch (err) {
    if (err.name === "TimeoutError") {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Tala request timed out" }));
    } else if (err.cause?.code === "ECONNREFUSED") {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cannot reach tala service" }));
    } else {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Tala proxy error: ${err.message}` }));
    }
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(); reject(new Error("Body too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
