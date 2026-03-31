# Notifications

## Open
- [ ] No Web Push (server-sent push when page is fully closed) — needs push server + VAPID keys. Low priority since WebSocket keeps page alive.

## Done
- [x] Android Chrome — switched from `navigator.serviceWorker.controller` gate to `navigator.serviceWorker.ready` (controller is null on first load before SW activates)
- [x] notificationclick handler — focuses existing tab or opens new one
- [x] In-app toast fallback — always shows toast so notifications work even without native permission
- [x] Extracted to `public/lib/notify.js` module
