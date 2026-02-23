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
 * @param {object} opts.credentialLockout - Lockout tracker for failed authentication attempts
 * @param {object} opts.bridge - Transport bridge to register SSH relay subscriber
 * @returns {{ server: Server }}
 */
export function startSSHServer({ port, hostKey, password, daemonRPC, daemonSend, credentialLockout, bridge }) {
  // Map clientId -> { stream, session (name) }
  const sshClients = new Map();

  function disconnectSessionClients(sessionName, message) {
    for (const [clientId, info] of sshClients) {
      if (info.session === sessionName) {
        try {
          info.stream.write(`\r\n${message}\r\n`);
          info.stream.close();
        } catch { /* stream closed */ }
        sshClients.delete(clientId);
      }
    }
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let authenticatedUser = null;
    // Track clientIds that belong to this specific SSH client connection
    const clientIds = new Set();

    client.on("authentication", (ctx) => {
      if (ctx.method === "password") {
        const username = ctx.username || "default";

        // Check if this username is locked out
        if (credentialLockout) {
          const lockoutStatus = credentialLockout.isLocked(username);
          if (lockoutStatus.locked) {
            log.warn("SSH login blocked - account locked", { username, retryAfter: lockoutStatus.retryAfter });
            ctx.reject(["password"]);
            return;
          }
        }

        // Verify password
        if (safeCompare(ctx.password, password)) {
          authenticatedUser = username;
          // Record successful authentication
          if (credentialLockout) {
            credentialLockout.recordSuccess(username);
          }
          ctx.accept();
        } else {
          // Record failed authentication
          if (credentialLockout) {
            const lockout = credentialLockout.recordFailure(username);
            if (lockout.locked) {
              log.warn("SSH login failed - account now locked", { username, retryAfter: lockout.retryAfter });
            } else {
              log.warn("SSH login failed", { username });
            }
          }
          ctx.reject(["password"]);
        }
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
            clientIds.add(clientId);
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
            stream.write("\r\nConnection error. Please try again.\r\n");
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
      // Clean up only the streams owned by this specific SSH client connection
      for (const clientId of clientIds) {
        const info = sshClients.get(clientId);
        if (info) {
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
      }
    });
  });

  // Register SSH transport with the bridge
  bridge?.register((msg) => {
    switch (msg.type) {
      case "output":
        for (const [, info] of sshClients) {
          if (info.session === msg.session) {
            try { info.stream.write(msg.data); } catch { /* stream closed */ }
          }
        }
        break;
      case "exit":
        disconnectSessionClients(msg.session, "Session exited.");
        break;
      case "session-removed":
        disconnectSessionClients(msg.session, "Session was removed.");
        break;
      case "session-renamed":
        for (const [, info] of sshClients) {
          if (info.session === msg.session) {
            info.session = msg.newName;
          }
        }
        break;
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log.info("Katulong SSH started", { port });
  });

  return { server };
}
