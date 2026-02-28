# Security

Every feature built with security as the foundation.

## WebAuthn (FIDO2)

Passwordless authentication using public key cryptography. Resistant to phishing, credential stuffing, and man-in-the-middle attacks.

## Content Security Policy

Strict CSP headers prevent XSS attacks. No inline scripts, no eval(), no unsafe practices.

## CSRF Protection

All state-changing operations require CSRF tokens. Prevents cross-site request forgery attacks.

## Atomic Operations

State mutations use file locking and atomic writes. No race conditions, no data corruption.

## Path Traversal Protection

Strict path validation prevents directory traversal attacks. All file operations are sandboxed.

## Self-Hosted Dependencies

All JavaScript dependencies served from your server. No CDN trust, no supply chain attacks.

## Input Validation

Comprehensive input validation and sanitization. Format validation for UUIDs, PINs, and user data.

## Secure Defaults

Localhost auto-authenticated, remote requires WebAuthn. TLS with self-signed certs for LAN access.

---

!!! info "Security Audit"

    **86 security improvements** completed in February 2026, including request body DoS protection,
    header trust removal, and environment variable filtering.

    [Read the full security improvements report](improvements.md)
