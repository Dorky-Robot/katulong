# Passkey Cross-Device Login

## Done
- [x] Removed `authenticatorAttachment: "platform"` — allows hybrid/roaming authenticators
- [x] Capture `credential.transports` in verifyRegistration()
- [x] Store transports in credential via auth-handlers.js
- [x] Use stored transports in generateAuthOpts() instead of hardcoded "internal"
- [x] Existing credentials fall back to `["internal"]` (migration-safe)
