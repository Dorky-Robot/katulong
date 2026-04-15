/**
 * Stable, URL-safe session identifier generator.
 *
 * Same alphabet and default length as the nanoid package (21 chars ≈ 126
 * bits of entropy, collision-resistant for the session lifetimes we care
 * about), inlined here to avoid a runtime dep. The alphabet (A–Z, a–z,
 * 0–9, `-`, `_`) is a superset of what tmux accepts in session names, so
 * a `kat_<id>` tmuxName needs no sanitization.
 *
 * Uses WebCrypto's `getRandomValues` (available in Node 20+) via the
 * module-scoped `crypto` global. Bytes are masked to the alphabet via
 * `byte & 63` — unbiased because the alphabet is exactly 64 symbols.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function sessionId(size = 21) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < size; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}

export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{21}$/;
