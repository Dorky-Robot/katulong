# Frontend Cleanup Roadmap

## ✅ Completed (Phases 1-3)

### Phase 1: Design Tokens & Utilities
- ✅ Created `public/design-tokens.css` with CSS custom properties
- ✅ Created `public/lib/utils.js` with DOM utilities
- ✅ Updated all CSS to use design tokens
- ✅ Consistent spacing, colors, heights, radii, z-index

### Phase 2: Shared Modules
- ✅ Created `public/lib/device.js` - Device identity & IndexedDB (134 lines)
- ✅ Created `public/lib/webauthn-errors.js` - WebAuthn error handling (59 lines)
- ✅ Created `public/lib/forms.js` - Form state & API utilities (135 lines)
- ✅ Eliminated ~360 lines of duplication

### Phase 3: Button Standardization
- ✅ Created unified button system with BEM classes
- ✅ Created `public/lib/button.js` factory functions (157 lines)
- ✅ Standardized button variants, sizes, states
- ✅ Replaced all emoji icons with Phosphor icons

**Total Impact:**
- 6 new shared modules created
- ~360 lines of duplication eliminated
- Consistent design system across entire app
- All 666 tests passing

---

## 🔄 In Progress / Next Steps

### Phase 4: Modal Manager (Future PR)

**Current State:**
- 9 modal overlays in `public/index.html`
- Basic functions: `openModal()`, `closeModal()`, `dismissModal()`
- Keyboard handling (Esc key) duplicated across modals

**Proposed Improvements:**
```javascript
// public/lib/modal.js
export class ModalManager {
  constructor(modalId) {
    this.overlay = document.getElementById(`${modalId}-overlay`);
    this.panel = document.getElementById(modalId);
    this.onClose = null;
    this._setupKeyboardHandling();
    this._setupBackdropDismiss();
  }

  open(options = {}) {
    this.onClose = options.onClose;
    this.overlay.classList.add('visible');
    this._trapFocus();
  }

  close() {
    this.overlay.classList.remove('visible');
    if (this.onClose) this.onClose();
    term.focus(); // Return focus to terminal
  }

  _setupKeyboardHandling() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.classList.contains('visible')) {
        this.close();
      }
    });
  }

  _setupBackdropDismiss() {
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.close();
    });
  }

  _trapFocus() {
    // Focus trap implementation for accessibility
  }
}

// Usage
const addModal = new ModalManager('add-modal');
addModal.open({
  onClose: () => console.log('Modal closed')
});
```

**Benefits:**
- Centralized modal logic
- Consistent keyboard handling (Esc key)
- Focus management for accessibility
- Easy to create new modals

**Estimated Effort:** 1-2 days

---

### Phase 5: List Renderers (Future PR)

**Current Duplication:**
- Device list rendering (lines 1565-1620 in app.js)
- Token list rendering (lines 1730-1790 in app.js)
- Session list rendering (scattered across multiple functions)

**Proposed Improvements:**
```javascript
// public/lib/list-renderer.js
export class ListRenderer {
  constructor(container, options) {
    this.container = container;
    this.itemTemplate = options.itemTemplate;
    this.emptyState = options.emptyState;
    this.onAction = options.onAction;
    this.data = [];
  }

  render(items) {
    this.data = items;

    if (items.length === 0) {
      this.container.innerHTML = this.emptyState;
      return;
    }

    this.container.innerHTML = items
      .map((item, index) => this.itemTemplate(item, index))
      .join('');

    this._attachEventListeners();
  }

  update(index, newData) {
    this.data[index] = { ...this.data[index], ...newData };
    this.render(this.data);
  }

  remove(index) {
    this.data.splice(index, 1);
    this.render(this.data);
  }

  _attachEventListeners() {
    this.container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.action;
        const id = e.currentTarget.dataset.id;
        if (this.onAction) {
          this.onAction({ action, id, element: e.currentTarget });
        }
      });
    });
  }
}

// Usage
const deviceList = new ListRenderer(deviceListEl, {
  itemTemplate: (device) => `
    <div class="device-item" data-device-id="${device.id}">
      <i class="ph ${device.isMobile ? 'ph-device-mobile' : 'ph-desktop'}"></i>
      <span>${escapeHtml(device.name)}</span>
      <button data-action="rename" data-id="${device.id}">Rename</button>
      <button data-action="remove" data-id="${device.id}">Remove</button>
    </div>
  `,
  emptyState: '<div class="empty-state">No devices</div>',
  onAction: ({ action, id }) => {
    if (action === 'rename') renameDevice(id);
    if (action === 'remove') removeDevice(id);
  }
});

deviceList.render(devices);
```

**Benefits:**
- DRY up list rendering logic
- Consistent event handling
- Easy to add loading/empty states
- Type-safe with JSDoc

**Estimated Effort:** 2-3 days

---

### Phase 6: State Management Formalization (Future PR)

**Current State:**
- `createAppState()` function with nested state
- Reducer pattern for shortcuts (`shortcutsReducer`)
- Manual state updates scattered across code

**Existing Patterns to Build On:**
```javascript
// From app.js line 166
const state = createAppState();

// From app.js line 169
const shortcutsReducer = (currentShortcuts, action) => {
  switch (action.type) {
    case 'LOAD': return action.items;
    case 'ADD': return [...currentShortcuts, action.item];
    case 'REMOVE': return currentShortcuts.filter((_, idx) => idx !== action.index);
    default: return currentShortcuts;
  }
};

const dispatchShortcuts = (action) => {
  const newShortcuts = shortcutsReducer(state.session.shortcuts, action);
  state.update('session.shortcuts', newShortcuts);
  renderBar(state.session.name);
};
```

**Proposed Improvements:**
```javascript
// public/lib/state.js
export function createStore(initialState, reducer) {
  let state = initialState;
  const subscribers = new Set();

  return {
    getState: () => state,

    dispatch: (action) => {
      const newState = reducer(state, action);
      if (newState !== state) {
        state = newState;
        subscribers.forEach(fn => fn(state, action));
      }
      return action;
    },

    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    }
  };
}

// Usage
const store = createStore(
  { shortcuts: [], sessions: [], devices: [] },
  appReducer
);

store.subscribe((state, action) => {
  if (action.type.startsWith('shortcuts/')) {
    renderBar(state.session.name);
  }
});

store.dispatch({ type: 'shortcuts/add', item: newShortcut });
```

**Benefits:**
- Centralized state updates
- Predictable state changes
- Easy to debug (action log)
- Testable reducers

**Estimated Effort:** 2-3 days

---

## 📋 Future Enhancements

### Component Library
- Extract button, input, select components
- Create form field wrappers with validation
- Build notification/toast system
- Progress indicators (spinner, skeleton screens)

### TypeScript Migration
- Add JSDoc type annotations
- Consider TypeScript for type safety
- Better IDE autocomplete

### Performance
- Virtual scrolling for long lists
- Lazy loading for off-screen content
- Code splitting for large modules

### Accessibility
- ARIA labels for all interactive elements
- Focus trap in modals
- Keyboard navigation for lists
- Screen reader testing

---

## 🎯 Recommended Next PR

**Title:** "Phase 4: Centralized Modal Manager"

**Scope:**
1. Create `public/lib/modal.js` with ModalManager class
2. Refactor 9 modal instances to use ModalManager
3. Add keyboard handling (Esc key closes modal)
4. Add focus trap for accessibility
5. Update tests

**Why This First:**
- Highest impact / effort ratio
- Independent of other refactorings
- Immediate UX improvement (better keyboard nav)
- Sets pattern for future component work

**Estimated Time:** 1-2 days

---

## 📊 Metrics

**Code Quality Improvements (Phases 1-3):**
- Lines of code eliminated: ~360
- New shared modules: 6
- Test coverage: Maintained (666 tests passing)
- Bundle size impact: +507 lines (better organization, more reusable)

**Developer Experience:**
- Easier to create new UI components (button factory, design tokens)
- Consistent patterns across codebase
- Better code organization (lib/ directory structure)
- Comprehensive JSDoc documentation

**Maintenance:**
- Single source of truth for styles (design tokens)
- No code duplication for common patterns
- Easier to update global styles (change token, affects everywhere)
- Icon system prevents emoji rendering issues
