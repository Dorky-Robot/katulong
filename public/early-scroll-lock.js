// Prevent any document-level scrolling — the app is a fixed viewport.
// Must run early before any content renders.
//
// Extracted from inline <script> in index.html so the Content-Security-Policy
// can use strict script-src 'self' without needing 'unsafe-inline' or a nonce.
document.addEventListener('touchmove', function(e) {
  if (e.target.closest('.xterm-viewport, .tab-scroll-area, .modal-body, #sidebar-content, .html-tile-content')) return;
  e.preventDefault();
}, { passive: false });
document.addEventListener('scroll', function() { window.scrollTo(0, 0); });
