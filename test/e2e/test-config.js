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

const TEST_PORT       = 3099 + SHARD_INDEX * 10;
const TEST_HTTPS_PORT = 3100 + SHARD_INDEX * 10;
const TEST_SSH_PORT   = 2223 + SHARD_INDEX * 10;
const BASE_URL        = `http://localhost:${TEST_PORT}`;

const TEST_DATA_DIR = SHARD_INDEX === 0
  ? '/tmp/katulong-e2e-data'
  : `/tmp/katulong-e2e-data-${SHARD_INDEX}`;

const TEST_SOCK_PATH = SHARD_INDEX === 0
  ? '/tmp/katulong-test.sock'
  : `/tmp/katulong-test-${SHARD_INDEX}.sock`;

export {
  SHARD_INDEX,
  TEST_PORT,
  TEST_HTTPS_PORT,
  TEST_SSH_PORT,
  BASE_URL,
  TEST_DATA_DIR,
  TEST_SOCK_PATH,
};
