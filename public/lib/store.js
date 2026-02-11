/**
 * State Management Store
 *
 * Provides centralized, predictable state management with:
 * - Immutable state updates via reducers
 * - Subscribe/notify pattern for reactive updates
 * - Action logging for debugging
 * - Type-safe action dispatching
 */

/**
 * Creates a state store with reducer pattern
 * @param {object} initialState - Initial state object
 * @param {Function} reducer - Reducer function (state, action) => newState
 * @param {object} options - Configuration options
 * @param {boolean} [options.debug] - Enable action logging
 * @returns {object} Store instance with getState, dispatch, subscribe methods
 */
export function createStore(initialState, reducer, options = {}) {
  let state = initialState;
  const subscribers = new Set();
  const { debug = false } = options;

  return {
    /**
     * Get current state (read-only)
     * @returns {object} Current state
     */
    getState() {
      return state;
    },

    /**
     * Dispatch an action to update state
     * @param {object} action - Action object with type property
     * @returns {object} The dispatched action
     */
    dispatch(action) {
      if (!action || typeof action !== 'object' || !action.type) {
        console.error('Invalid action:', action);
        throw new Error('Actions must be objects with a type property');
      }

      const prevState = state;
      const newState = reducer(state, action);

      // Only update and notify if state changed
      if (newState !== prevState) {
        state = newState;

        // Debug logging
        if (debug) {
          console.log('[Store]', action.type, {
            action,
            prevState,
            newState
          });
        }

        // Notify all subscribers
        subscribers.forEach(listener => {
          try {
            listener(state, action, prevState);
          } catch (err) {
            console.error('Subscriber error:', err);
          }
        });
      }

      return action;
    },

    /**
     * Subscribe to state changes
     * @param {Function} listener - Callback (state, action, prevState) => void
     * @returns {Function} Unsubscribe function
     */
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new Error('Subscriber must be a function');
      }

      subscribers.add(listener);

      // Return unsubscribe function
      return () => {
        subscribers.delete(listener);
      };
    },

    /**
     * Get subscriber count (for debugging)
     * @returns {number} Number of active subscribers
     */
    getSubscriberCount() {
      return subscribers.size;
    }
  };
}

/**
 * Combines multiple reducers into one
 * @param {object} reducers - Object mapping state keys to reducers
 * @returns {Function} Combined reducer function
 */
export function combineReducers(reducers) {
  return (state = {}, action) => {
    const nextState = {};
    let hasChanged = false;

    Object.keys(reducers).forEach(key => {
      const reducer = reducers[key];
      const prevStateForKey = state[key];
      const nextStateForKey = reducer(prevStateForKey, action);

      nextState[key] = nextStateForKey;
      hasChanged = hasChanged || nextStateForKey !== prevStateForKey;
    });

    return hasChanged ? nextState : state;
  };
}

/**
 * Creates a simple reducer from action handlers
 * @param {object} initialState - Initial state for this reducer
 * @param {object} handlers - Map of action types to handler functions
 * @returns {Function} Reducer function
 */
export function createReducer(initialState, handlers) {
  return (state = initialState, action) => {
    if (handlers.hasOwnProperty(action.type)) {
      return handlers[action.type](state, action);
    }
    return state;
  };
}
