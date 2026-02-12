/**
 * Generic Tab Manager
 *
 * Composable tab switching component.
 */

/**
 * Create tab manager
 */
export function createTabManager(options = {}) {
  const { tabSelector = '.tab', contentSelector = '.tab-content', onTabChange } = options;

  const switchTab = (targetTab) => {
    // Update tab buttons
    document.querySelectorAll(tabSelector).forEach(tab => {
      const active = tab.dataset.tab === targetTab;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active);
    });

    // Update tab content
    document.querySelectorAll(contentSelector).forEach(content => {
      // Match various ID patterns: "theme-content", "settings-tab-theme", etc.
      const active = content.id === `${targetTab}-content` ||
                     content.id === `settings-tab-${targetTab}` ||
                     content.dataset.tab === targetTab ||
                     content.classList.contains(`${targetTab}-tab`);
      content.classList.toggle("active", active);
    });

    if (onTabChange) {
      onTabChange(targetTab);
    }
  };

  return {
    init() {
      document.querySelectorAll(tabSelector).forEach(tab => {
        tab.addEventListener("click", () => {
          const targetTab = tab.dataset.tab;
          if (targetTab) {
            switchTab(targetTab);
          }
        });
      });
    },

    switch: switchTab
  };
}
