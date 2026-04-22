//! Shared cryptographic-grade random helpers.
//!
//! Factored out so that every `bytes → hex` callsite in the crate pulls from
//! the same RNG and encodes the same way. Divergence here was already
//! mechanical (two copies in `setup_token.rs` and `webauthn.rs` would have
//! drifted the first time someone swapped encoders) — one place beats two.

use rand_core::{OsRng, RngCore};
use std::fmt::Write as _;

/// Return `bytes` random bytes from the OS CSPRNG, encoded as lowercase hex.
/// Result length is `bytes * 2`.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for b in buf {
        write!(&mut out, "{b:02x}").expect("write to String cannot fail");
    }
    out
}
