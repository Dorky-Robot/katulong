// Prevent any document-level scrolling — the app is a fixed viewport.
// Must run early before any content renders.
//
// Extracted from inline <script> in index.html so the Content-Security-Policy
// can use strict script-src 'self' without needing 'unsafe-inline' or a nonce.
// Terminal panes use touch-action:none + initTouchScroll's pointer bridge,
// so they don't need (and shouldn't have) a native-scroll allowance here.
document.addEventListener('touchmove', function(e) {
  if (e.target.closest('.tab-scroll-area, .modal-panel, #sidebar-content')) return;
  e.preventDefault();
}, { passive: false });
document.addEventListener('scroll', function() { window.scrollTo(0, 0); });
