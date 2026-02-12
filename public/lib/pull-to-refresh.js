/**
 * Pull-to-Refresh Manager
 *
 * Handles pull-up gesture to refresh terminal or reconnect.
 */

export function createPullToRefreshManager(options = {}) {
  const { container, isAtBottom, onRefresh } = options;
  const indicator = document.getElementById("pull-refresh-indicator");

  let pullStartY = 0;
  let isPulling = false;
  const PULL_THRESHOLD = 80; // pixels to pull before triggering

  return {
    init() {
      if (!container || !indicator) return;

      container.addEventListener("touchstart", (e) => {
        const viewport = document.querySelector(".xterm-viewport");
        // Only allow pull-up if at bottom of scrollback
        if (isAtBottom && isAtBottom(viewport)) {
          pullStartY = e.touches[0].clientY;
          isPulling = false;
        }
      });

      container.addEventListener("touchmove", (e) => {
        if (pullStartY === 0) return;

        const currentY = e.touches[0].clientY;
        const pullDistance = pullStartY - currentY; // Negative = pulling down, Positive = pulling up

        if (pullDistance > 20) {
          isPulling = true;
          const progress = Math.min(pullDistance / PULL_THRESHOLD, 1);
          indicator.style.transform = `translateX(-50%) translateY(${100 - progress * 100}%)`;
          indicator.classList.add("visible");
        } else {
          indicator.classList.remove("visible");
          indicator.style.transform = "translateX(-50%) translateY(100%)";
        }
      });

      container.addEventListener("touchend", (e) => {
        if (isPulling && pullStartY > 0) {
          const lastY = e.changedTouches[0].clientY;
          const pullDistance = pullStartY - lastY;

          if (pullDistance >= PULL_THRESHOLD && onRefresh) {
            onRefresh();
          }
        }

        // Reset
        pullStartY = 0;
        isPulling = false;
        indicator.classList.remove("visible");
        indicator.style.transform = "translateX(-50%) translateY(100%)";
      });

      container.addEventListener("touchcancel", () => {
        pullStartY = 0;
        isPulling = false;
        indicator.classList.remove("visible");
        indicator.style.transform = "translateX(-50%) translateY(100%)";
      });
    }
  };
}
