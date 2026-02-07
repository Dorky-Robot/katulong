import ssh2 from "ssh2";
const { Server, utils: sshUtils } = ssh2;
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { log } from "./log.js";

/**
 * Generate an Ed25519 host key on first run, persist to DATA_DIR/ssh/host_ed25519.
 * Returns the private key PEM on subsequent runs.
 */
export function ensureHostKey(dataDir) {
  const sshDir = join(dataDir, "ssh");
  const keyPath = join(sshDir, "host_ed25519");

  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }

  mkdirSync(sshDir, { recursive: true });

  const keys = sshUtils.generateKeyPairSync("ed25519");

  writeFileSync(keyPath, keys.private, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // Best-effort on platforms that don't support chmod
  }

  log.info("SSH host key generated", { path: keyPath });
  return readFileSync(keyPath);
}

/**
 * Compare two strings in constant time.
 */
export function safeCompare(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to consume constant time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Start an SSH server that bridges to the daemon IPC protocol.
 *
 * @param {object} opts
 * @param {number} opts.port - SSH listen port
 * @param {Buffer} opts.hostKey - PEM-encoded host key
 * @param {string} opts.password - Password for authentication
 * @param {function} opts.daemonRPC - RPC call to daemon (returns Promise)
 * @param {function} opts.daemonSend - Fire-and-forget message to daemon
 * @returns {{ server: Server, relayBroadcast: function }}
 */
export function startSSHServer({ port, hostKey, password, daemonRPC, daemonSend }) {
  // Map clientId -> { stream, session (name) }
  const sshClients = new Map();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let authenticatedUser = null;

    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && safeCompare(ctx.password, password)) {
        authenticatedUser = ctx.username || "default";
        ctx.accept();
      } else if (ctx.method === "none") {
        ctx.reject(["password"]);
      } else {
        ctx.reject(["password"]);
      }
    });

    client.on("ready", () => {
      log.info("SSH client authenticated", { user: authenticatedUser });

      client.on("session", (accept) => {
        const session = accept();
        let ptyInfo = { cols: 80, rows: 24, term: "xterm-256color" };

        session.on("pty", (accept, _reject, info) => {
          ptyInfo = { cols: info.cols, rows: info.rows, term: info.term || "xterm-256color" };
          accept();
        });

        function handleShell(accept) {
          const stream = accept();
          const clientId = randomUUID();
          const sessionName = authenticatedUser || "default";

          daemonRPC({
            type: "attach",
            clientId,
            session: sessionName,
            cols: ptyInfo.cols,
            rows: ptyInfo.rows,
          }).then((result) => {
            sshClients.set(clientId, { stream, session: sessionName });
            log.debug("SSH client attached", { clientId, session: sessionName });

            if (result.buffer) {
              stream.write(result.buffer);
            }
            if (!result.alive) {
              stream.write("\r\nSession has exited.\r\n");
              stream.close();
              sshClients.delete(clientId);
              return;
            }

            stream.on("data", (data) => {
              daemonSend({ type: "input", clientId, data: data.toString() });
            });

            session.on("window-change", (accept, _reject, info) => {
              daemonSend({ type: "resize", clientId, cols: info.cols, rows: info.rows });
              if (accept) accept();
            });

            stream.on("close", () => {
              log.debug("SSH stream closed", { clientId });
              sshClients.delete(clientId);
              daemonSend({ type: "detach", clientId });
            });
          }).catch((err) => {
            log.error("SSH attach failed", { error: err.message });
            stream.write(`\r\nError: ${err.message}\r\n`);
            stream.close();
          });
        }

        session.on("shell", handleShell);
        session.on("exec", (accept, _reject, _info) => handleShell(accept));
      });
    });

    client.on("error", (err) => {
      log.debug("SSH client error", { error: err.message });
    });

    client.on("close", () => {
      // Clean up any streams owned by this client
      for (const [clientId, info] of sshClients) {
        try {
          if (info.stream?.destroyed === false) {
            info.stream.close();
          }
        } catch {
          // stream already closed
        }
        sshClients.delete(clientId);
        daemonSend({ type: "detach", clientId });
      }
    });
  });

  function relayBroadcast(msg) {
    switch (msg.type) {
      case "output":
        for (const [, info] of sshClients) {
          if (info.session === msg.session) {
            try { info.stream.write(msg.data); } catch { /* stream closed */ }
          }
        }
        break;
      case "exit":
        for (const [clientId, info] of sshClients) {
          if (info.session === msg.session) {
            try {
              info.stream.write("\r\nSession exited.\r\n");
              info.stream.close();
            } catch { /* stream closed */ }
            sshClients.delete(clientId);
          }
        }
        break;
      case "session-removed":
        for (const [clientId, info] of sshClients) {
          if (info.session === msg.session) {
            try {
              info.stream.write("\r\nSession was removed.\r\n");
              info.stream.close();
            } catch { /* stream closed */ }
            sshClients.delete(clientId);
          }
        }
        break;
      case "session-renamed":
        for (const [, info] of sshClients) {
          if (info.session === msg.session) {
            info.session = msg.newName;
          }
        }
        break;
    }
  }

  server.listen(port, "0.0.0.0", () => {
    log.info("Katulong SSH started", { port });
  });

  return { server, relayBroadcast };
}
