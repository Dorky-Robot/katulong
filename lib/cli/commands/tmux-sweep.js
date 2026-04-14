import { sweepOrphanTmuxSockets, tmuxSocketDir } from "../../tmux-socket-sweep.js";

/**
 * `katulong tmux-sweep` — reap orphaned `katulong-test-<pid>` sockets.
 *
 * On dev machines these accumulate into the thousands when SIGKILL
 * (pre-push timeouts, CI timeouts, OOM) bypasses the test harness's
 * exit handler. Also wired into the Homebrew post_install so upgrading
 * the package implicitly cleans up.
 *
 * Safe to run any time: only reaps sockets whose creator PID is no
 * longer alive, and only those matching the `katulong-test-` prefix.
 * Prints a short summary.
 *
 * Flags:
 *   --quiet    suppress the summary line (used from post_install)
 */
export default async function tmuxSweep(args) {
  const quiet = args.includes("--quiet") || args.includes("-q");

  const removed = sweepOrphanTmuxSockets("katulong-test-");

  if (!quiet) {
    if (removed === 0) {
      console.log(`No orphan tmux sockets to sweep in ${tmuxSocketDir()}.`);
    } else {
      console.log(`Swept ${removed} orphan tmux socket${removed === 1 ? "" : "s"} from ${tmuxSocketDir()}.`);
    }
  }
}
