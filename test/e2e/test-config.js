/**
 * Shard-aware test configuration
 *
 * Reads TEST_SHARD_INDEX env var (default 0) and derives all ports, paths,
 * and URLs so each shard gets its own isolated server instance.
 *
 * Shard 0 produces the exact same values as the original hardcoded ones,
 * so non-sharded runs (npm run test:e2e) work unchanged.
 */

const SHARD_INDEX = parseInt(process.env.TEST_SHARD_INDEX || '0', 10);

const TEST_PORT     = 3099 + SHARD_INDEX * 10;
const BASE_URL        = `http://localhost:${TEST_PORT}`;

const TEST_DATA_DIR = SHARD_INDEX === 0
  ? '/tmp/katulong-e2e-data'
  : `/tmp/katulong-e2e-data-${SHARD_INDEX}`;

// Per-shard tmux socket name. Passed to the test katulong server via
// KATULONG_TMUX_SOCKET so every tmux command it runs goes through
// `tmux -L <name>` instead of the developer's default socket.
//
// Without this, smoke/session e2e tests create real sessions on the
// user's personal tmux server — tmux-continuum then snapshots them and
// replays them forever on reboot, polluting the user's katulong UI
// with dozens of `smoke-*` / `session-*` leftovers.
//
// Must match tmuxSocketArgs() validation: /^[A-Za-z0-9_-]+$/.
const TEST_TMUX_SOCKET = `katulong-e2e-${SHARD_INDEX}`;

export {
  SHARD_INDEX,
  TEST_PORT,
  BASE_URL,
  TEST_DATA_DIR,
  TEST_TMUX_SOCKET,
};
