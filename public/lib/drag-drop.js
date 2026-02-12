/**
 * Drag and Drop Manager
 *
 * Manages drag-and-drop state for file uploads.
 */

const DRAG_DROP_ACTIONS = {
  DRAG_ENTER: 'drag-drop/enter',
  DRAG_LEAVE: 'drag-drop/leave',
  DROP: 'drag-drop/drop'
};

const dragDropReducer = (state, action) => {
  switch (action.type) {
    case DRAG_DROP_ACTIONS.DRAG_ENTER:
      return {
        ...state,
        dragCounter: state.dragCounter + 1,
        isDragging: true
      };
    case DRAG_DROP_ACTIONS.DRAG_LEAVE:
      const newCounter = state.dragCounter - 1;
      return {
        ...state,
        dragCounter: Math.max(0, newCounter),
        isDragging: newCounter > 0
      };
    case DRAG_DROP_ACTIONS.DROP:
      return {
        dragCounter: 0,
        isDragging: false
      };
    default:
      return state;
  }
};

/**
 * Create drag-drop manager
 */
export function createDragDropManager(options = {}) {
  const { onDrop, isImageFile } = options;
  let dragState = { dragCounter: 0, isDragging: false };
  const dropOverlay = document.getElementById("drop-overlay");

  const dispatch = (action) => {
    const prevState = dragState;
    dragState = dragDropReducer(dragState, action);

    // Side effect: Update overlay visibility
    if (prevState.isDragging !== dragState.isDragging && dropOverlay) {
      if (dragState.isDragging) {
        dropOverlay.classList.add("visible");
      } else {
        dropOverlay.classList.remove("visible");
      }
    }
  };

  return {
    init() {
      document.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dispatch({ type: DRAG_DROP_ACTIONS.DRAG_ENTER });
      });

      document.addEventListener("dragover", (e) => {
        e.preventDefault();
      });

      document.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dispatch({ type: DRAG_DROP_ACTIONS.DRAG_LEAVE });
      });

      document.addEventListener("drop", (e) => {
        e.preventDefault();
        dispatch({ type: DRAG_DROP_ACTIONS.DROP });

        if (onDrop) {
          const files = [...(e.dataTransfer?.files || [])];
          const imageFiles = isImageFile ? files.filter(isImageFile) : files;
          onDrop(imageFiles, files.length);
        }
      });
    },

    getState: () => dragState
  };
}
