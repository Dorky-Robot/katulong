import envConfig from "./env-config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVELS[envConfig.logLevel?.toLowerCase()] ?? LEVELS.info;

function emit(level, msg, meta) {
  if (LEVELS[level] < threshold) return;
  const entry = { time: new Date().toISOString(), level, msg };
  if (meta !== undefined) entry.meta = meta;
  const line = JSON.stringify(entry) + "\n";
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info:  (msg, meta) => emit("info",  msg, meta),
  warn:  (msg, meta) => emit("warn",  msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
