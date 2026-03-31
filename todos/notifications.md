# Notifications

Push notifications to phone/tablet so the user can walk away.

## Open
- [ ] **Android notifications broken** — `new Notification()` in app.js doesn't work on Android Chrome. Need to use `navigator.serviceWorker.ready.then(reg => reg.showNotification(...))` instead, which works even when the page is backgrounded. The service worker (sw.js) needs no changes — `showNotification` is a built-in ServiceWorkerRegistration method.
- [ ] Service worker has no `notificationclick` handler — tapping the notification should focus the katulong tab
- [ ] No Web Push (server-sent push notifications when the page is fully closed) — would need a push server + VAPID keys. Lower priority since the WebSocket keeps the page alive.

## Context
- Permission request UI works (Settings > Enable Notifications)
- The `katulong notify` CLI and `POST /notify` API send a WebSocket message to all connected clients
- Client receives `notification` message type → calls `onNotification(title, message)`
- Currently uses `new Notification(title, { body, icon })` which is the basic Web Notification API
- Android Chrome requires either PWA install or service worker registration for notifications
