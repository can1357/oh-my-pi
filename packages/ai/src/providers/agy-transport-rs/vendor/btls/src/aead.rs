//! Authenticated encryption with detached authentication tags.
//!
//! This module wraps BoringSSL's `EVP_AEAD` interface and is intended for
//! protocols that keep ciphertext and authentication tag in separate buffers.
//!
//! # Overview
//!
//! [`AeadCtx`] is the main type. Create one with an [`Algorithm`] and a key,
//! then use it to encrypt and decrypt:
//!
//! - [`AeadCtxRef::seal_in_place`] / [`AeadCtxRef::open_in_place`] — encrypt
//!   or decrypt a buffer in place with a detached tag. These cover the common
//!   case (TLS record framing, packet formats with explicit tag fields, etc.).
//!
//! - [`AeadCtxRef::seal_scatter`] / [`AeadCtxRef::open_gather`] — lower-level
//!   scatter/gather operations for protocols that split ciphertext output across
//!   multiple buffers.
//!
//! # When to use [`crate::symm`] instead
//!
//! If you want one-shot helpers that allocate output buffers or APIs centered
//! on `EVP_CIPHER`, prefer [`crate::symm`], including
//! [`crate::symm::encrypt_aead`] and [`crate::symm::decrypt_aead`].
//!
//! # Nonce guidance
//!
//! Never reuse a nonce with the same key. Nonce reuse can completely undermine
//! AEAD security.
//!
//! Nonces are usually public (not secret). They must either be transmitted with
//! the message or derived by both sides (for example from a shared sequence
//! number).
//!
//! Different algorithms can have different nonce-length requirements and safety
//! considerations around nonce generation. The caller is responsible for
//! following safe nonce practices for the selected algorithm.
//! [`Algorithm::nonce_len`] returns the required nonce size in bytes.
//!
//! # Example
//!
//! ```
//! use btls::aead::{AeadCtx, Algorithm};
//!
//! let algorithm = Algorithm::aes_128_gcm();
//! let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 16]).unwrap();
//! let nonce = [0u8; 12];
//! let aad = b"record-header";
//! let mut payload = b"hello world".to_vec();
//! let mut tag = vec![0u8; algorithm.max_overhead()];
//!
//! ctx.seal_in_place(&nonce, payload.as_mut_slice(), &mut tag, aad)
//!     .unwrap();
//!
//! ctx.open_in_place(&nonce, payload.as_mut_slice(), &tag, aad)
//!     .unwrap();
//!
//! assert_eq!(payload.as_slice(), b"hello world");
//! ```

use std::ptr;

use foreign_types::{ForeignType, ForeignTypeRef};
use openssl_macros::corresponds;

use crate::error::ErrorStack;
use crate::ffi;
use crate::{cvt, cvt_p};

/// Represents a specific AEAD algorithm.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Algorithm(*const ffi::EVP_AEAD);

impl Algorithm {
    /// Creates an [`Algorithm`] from a raw BoringSSL pointer.
    ///
    /// # Safety
    ///
    /// The caller must ensure that `ptr` is a valid pointer to an
    /// `EVP_AEAD` with a `'static` lifetime.
    #[must_use]
    pub const unsafe fn from_ptr(ptr: *const ffi::EVP_AEAD) -> Self {
        Self(ptr)
    }

    /// AES-128 in Galois Counter Mode (GCM).
    #[corresponds(EVP_aead_aes_128_gcm)]
    #[must_use]
    pub fn aes_128_gcm() -> Self {
        unsafe { Self(ffi::EVP_aead_aes_128_gcm()) }
    }

    /// AES-256 in Galois Counter Mode (GCM).
    #[corresponds(EVP_aead_aes_256_gcm)]
    #[must_use]
    pub fn aes_256_gcm() -> Self {
        unsafe { Self(ffi::EVP_aead_aes_256_gcm()) }
    }

    /// ChaCha20-Poly1305 as described in RFC 8439.
    #[corresponds(EVP_aead_chacha20_poly1305)]
    #[must_use]
    pub fn chacha20_poly1305() -> Self {
        unsafe { Self(ffi::EVP_aead_chacha20_poly1305()) }
    }

    /// XChaCha20-Poly1305 with a 24-byte nonce.
    #[corresponds(EVP_aead_xchacha20_poly1305)]
    #[must_use]
    pub fn xchacha20_poly1305() -> Self {
        unsafe { Self(ffi::EVP_aead_xchacha20_poly1305()) }
    }

    /// Returns the key length, in bytes, required by this algorithm.
    #[corresponds(EVP_AEAD_key_length)]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn key_length(&self) -> usize {
        unsafe { ffi::EVP_AEAD_key_length(self.0) }
    }

    /// Returns the maximum additional bytes produced when sealing.
    #[corresponds(EVP_AEAD_max_overhead)]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn max_overhead(&self) -> usize {
        unsafe { ffi::EVP_AEAD_max_overhead(self.0) }
    }

    /// Returns the maximum tag length for this algorithm.
    #[corresponds(EVP_AEAD_max_tag_len)]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn max_tag_len(&self) -> usize {
        unsafe { ffi::EVP_AEAD_max_tag_len(self.0) }
    }

    /// Returns the nonce length, in bytes, required by this algorithm.
    #[corresponds(EVP_AEAD_nonce_length)]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn nonce_len(&self) -> usize {
        unsafe { ffi::EVP_AEAD_nonce_length(self.0) }
    }

    /// Returns the raw `EVP_AEAD` pointer.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub const fn as_ptr(&self) -> *const ffi::EVP_AEAD {
        self.0
    }
}

unsafe impl Send for Algorithm {}
unsafe impl Sync for Algorithm {}

foreign_type_and_impl_send_sync! {
    type CType = ffi::EVP_AEAD_CTX;
    fn drop = ffi::EVP_AEAD_CTX_free;

    /// An AEAD encryption/decryption context wrapping BoringSSL's `EVP_AEAD_CTX`.
    ///
    /// Holds the keying material for a specific [`Algorithm`]. Use
    /// [`AeadCtx::new_default_tag`] for the common case, or [`AeadCtx::new`]
    /// when you need a custom tag length.
    ///
    /// See [`AeadCtxRef::seal_in_place`] and [`AeadCtxRef::open_in_place`] for
    /// the primary encryption/decryption API.
    pub struct AeadCtx;
}

impl AeadCtx {
    /// Creates a new AEAD context.
    ///
    /// `tag_len` controls the default tag length used by the context.
    #[corresponds(EVP_AEAD_CTX_new)]
    pub fn new(algorithm: &Algorithm, key: &[u8], tag_len: usize) -> Result<Self, ErrorStack> {
        ffi::init();

        if key.len() != algorithm.key_length() {
            return Err(ErrorStack::internal_error_str("invalid key size"));
        }

        unsafe {
            cvt_p(ffi::EVP_AEAD_CTX_new(
                algorithm.as_ptr(),
                key.as_ptr(),
                key.len(),
                tag_len,
            ))
            .map(|ptr| AeadCtx::from_ptr(ptr))
        }
    }

    /// Creates a new AEAD context using the algorithm's full (maximum) tag
    /// length.
    ///
    /// This is the recommended constructor for most use cases. The full tag
    /// length provides the strongest authentication guarantee for the algorithm.
    /// Use [`AeadCtx::new`] instead when your protocol requires a truncated tag.
    pub fn new_default_tag(algorithm: &Algorithm, key: &[u8]) -> Result<Self, ErrorStack> {
        Self::new(algorithm, key, ffi::EVP_AEAD_DEFAULT_TAG_LENGTH as usize)
    }
}

impl AeadCtxRef {
    /// Computes the exact tag length for a [`seal_scatter`](AeadCtxRef::seal_scatter)
    /// call with the given `in_len` and `extra_in_len`.
    ///
    /// This is useful for sizing `out_tag` buffers precisely rather than relying
    /// on the worst-case [`Algorithm::max_overhead`].
    #[corresponds(EVP_AEAD_CTX_tag_len)]
    pub fn tag_len(&self, in_len: usize, extra_in_len: usize) -> Result<usize, ErrorStack> {
        let mut out_tag_len: usize = 0;
        unsafe {
            cvt(ffi::EVP_AEAD_CTX_tag_len(
                self.as_ptr(),
                &mut out_tag_len,
                in_len,
                extra_in_len,
            ))?;
        }
        Ok(out_tag_len)
    }

    /// Encrypts `in_out` in place and writes the authentication tag to
    /// `out_tag`.
    ///
    /// `extra_in` is optional additional plaintext for protocols that split
    /// ciphertext output across buffers. When `Some(extra)` is provided, the
    /// ciphertext for `extra` is written to the start of `out_tag`, followed by
    /// the detached tag bytes.
    ///
    /// In the common case, pass `None` and `out_tag` receives only the tag.
    ///
    /// `out_tag` must be large enough for all detached output:
    /// `extra_in.len() + tag_len` (or conservatively
    /// `extra_in.len() + Algorithm::max_overhead()`).
    ///
    /// # Parameters
    ///
    /// - `nonce`: Per-message nonce for this encryption operation.
    /// - `in_out`: Plaintext input and in-place ciphertext output.
    /// - `out_tag`: Detached output buffer for `extra_in` ciphertext (if any)
    ///   and the authentication tag.
    /// - `extra_in`: Optional extra plaintext chunk written as ciphertext into
    ///   `out_tag` before the tag.
    /// - `associated_data`: Additional authenticated data (AAD).
    ///
    /// Returns the sub-slice of `out_tag` that was written to.
    /// This includes any encrypted `extra_in` bytes and the final tag.
    ///
    /// # Examples
    ///
    /// ```
    /// use btls::aead::{AeadCtx, Algorithm};
    ///
    /// let algorithm = Algorithm::chacha20_poly1305();
    /// let ctx = AeadCtx::new(&algorithm, &[7u8; 32], algorithm.max_tag_len()).unwrap();
    ///
    /// let nonce = [1u8; 12];
    /// let aad = b"frame-header";
    ///
    /// // Main payload is encrypted in-place.
    /// let mut main = b"hello".to_vec();
    /// // Extra plaintext is encrypted into the detached buffer.
    /// let extra = b" world";
    /// let mut detached = vec![0u8; extra.len() + algorithm.max_overhead()];
    ///
    /// let detached_written = ctx
    ///     .seal_scatter(
    ///         &nonce,
    ///         main.as_mut_slice(),
    ///         detached.as_mut_slice(),
    ///         Some(extra),
    ///         aad,
    ///     )
    ///     .unwrap();
    ///
    /// // `detached_written` contains: extra ciphertext bytes followed by tag bytes.
    /// let extra_ct_len = extra.len();
    /// let tag = &detached_written[extra_ct_len..];
    ///
    /// // Reconstruct the full ciphertext by appending extra ciphertext bytes.
    /// let mut full_ciphertext = main.clone();
    /// full_ciphertext.extend_from_slice(&detached_written[..extra_ct_len]);
    ///
    /// // `open_gather` takes ciphertext and detached tag separately.
    /// ctx.open_gather(&nonce, full_ciphertext.as_mut_slice(), tag, aad)
    ///     .unwrap();
    ///
    /// assert_eq!(full_ciphertext.as_slice(), b"hello world");
    /// ```
    #[corresponds(EVP_AEAD_CTX_seal_scatter)]
    pub fn seal_scatter<'a>(
        &self,
        nonce: &[u8],
        in_out: &mut [u8],
        out_tag: &'a mut [u8],
        extra_in: Option<&[u8]>,
        associated_data: &[u8],
    ) -> Result<&'a mut [u8], ErrorStack> {
        let (extra_in_ptr, extra_in_len) = extra_in
            .map(|buf| (buf.as_ptr(), buf.len()))
            .unwrap_or((ptr::null(), 0));

        let mut out_tag_len = out_tag.len();
        unsafe {
            cvt(ffi::EVP_AEAD_CTX_seal_scatter(
                self.as_ptr(),
                in_out.as_mut_ptr(),
                out_tag.as_mut_ptr(),
                &mut out_tag_len,
                out_tag.len(),
                nonce.as_ptr(),
                nonce.len(),
                in_out.as_ptr(),
                in_out.len(),
                extra_in_ptr,
                extra_in_len,
                associated_data.as_ptr(),
                associated_data.len(),
            ))?;
        }

        Ok(&mut out_tag[..out_tag_len])
    }

    /// Decrypts `in_out` in place and verifies `in_tag` and
    /// `associated_data`.
    ///
    /// When the corresponding [`seal_scatter`](AeadCtxRef::seal_scatter) call
    /// used `extra_in`, append the extra ciphertext prefix to `in_out` and pass
    /// only the tag suffix as `in_tag`. See the [`seal_scatter`](AeadCtxRef::seal_scatter)
    /// documentation for a full example.
    ///
    /// # Parameters
    ///
    /// - `nonce`: The same nonce that was used during encryption.
    /// - `in_out`: Ciphertext input and in-place plaintext output.
    /// - `in_tag`: Detached tag bytes produced by
    ///   [`seal_scatter`](AeadCtxRef::seal_scatter).
    /// - `associated_data`: The same AAD that was passed during encryption.
    #[corresponds(EVP_AEAD_CTX_open_gather)]
    pub fn open_gather(
        &self,
        nonce: &[u8],
        in_out: &mut [u8],
        in_tag: &[u8],
        associated_data: &[u8],
    ) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::EVP_AEAD_CTX_open_gather(
                self.as_ptr(),
                in_out.as_mut_ptr(),
                nonce.as_ptr(),
                nonce.len(),
                in_out.as_ptr(),
                in_out.len(),
                in_tag.as_ptr(),
                in_tag.len(),
                associated_data.as_ptr(),
                associated_data.len(),
            ))
        }
    }

    /// Encrypts `buffer` in place and writes the authentication tag into `tag`.
    ///
    /// This is a convenience wrapper around [`seal_scatter`](AeadCtxRef::seal_scatter)
    /// with `extra_in = None`.
    ///
    /// # Parameters
    ///
    /// - `nonce`: Per-message nonce. Must match the length returned by
    ///   [`Algorithm::nonce_len`].
    /// - `buffer`: Plaintext on input, ciphertext on output (encrypted in
    ///   place).
    /// - `tag`: Output buffer for the authentication tag. Must be at least
    ///   [`Algorithm::max_overhead`] bytes; use [`AeadCtxRef::tag_len`] for
    ///   the exact size.
    /// - `associated_data`: Additional authenticated data (AAD) that is
    ///   authenticated but not encrypted.
    ///
    /// Returns the sub-slice of `tag` that was written to.
    pub fn seal_in_place<'a>(
        &self,
        nonce: &[u8],
        buffer: &mut [u8],
        tag: &'a mut [u8],
        associated_data: &[u8],
    ) -> Result<&'a mut [u8], ErrorStack> {
        self.seal_scatter(nonce, buffer, tag, None, associated_data)
    }

    /// Decrypts `buffer` in place, verifying the authentication `tag` and
    /// `associated_data`.
    ///
    /// This is a convenience wrapper around [`open_gather`](AeadCtxRef::open_gather).
    ///
    /// # Parameters
    ///
    /// - `nonce`: The same nonce that was used during encryption.
    /// - `buffer`: Ciphertext on input, plaintext on output (decrypted in
    ///   place).
    /// - `tag`: The authentication tag produced by
    ///   [`seal_in_place`](AeadCtxRef::seal_in_place).
    /// - `associated_data`: The same AAD that was passed during encryption.
    pub fn open_in_place(
        &self,
        nonce: &[u8],
        buffer: &mut [u8],
        tag: &[u8],
        associated_data: &[u8],
    ) -> Result<(), ErrorStack> {
        self.open_gather(nonce, buffer, tag, associated_data)
    }
}

#[cfg(test)]
mod tests {
    use super::{AeadCtx, Algorithm};

    #[test]
    fn in_out() {
        let algorithm = Algorithm::aes_128_gcm();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 16]).unwrap();
        let nonce = [0u8; 12];
        let associated_data = b"this is authenticated";
        let mut buffer = b"ABCDE".to_vec();

        let mut tag = [0u8; 16];
        ctx.seal_in_place(&nonce, buffer.as_mut_slice(), &mut tag, associated_data)
            .unwrap();

        ctx.open_in_place(&nonce, buffer.as_mut_slice(), &tag, associated_data)
            .unwrap();

        assert_eq!(b"ABCDE", buffer.as_slice());
    }

    #[test]
    fn xchacha_in_out() {
        let algorithm = Algorithm::xchacha20_poly1305();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 32]).unwrap();
        let nonce = [0u8; 24];
        let associated_data = b"xchacha";
        let mut buffer = b"payload".to_vec();

        let mut tag = [0u8; 16];
        let tag_written = ctx
            .seal_in_place(&nonce, buffer.as_mut_slice(), &mut tag, associated_data)
            .unwrap();
        let tag_len = tag_written.len();

        ctx.open_in_place(
            &nonce,
            buffer.as_mut_slice(),
            &tag[..tag_len],
            associated_data,
        )
        .unwrap();

        assert_eq!(b"payload", buffer.as_slice());
    }

    #[test]
    fn seal_scatter_with_extra_in() {
        let algorithm = Algorithm::chacha20_poly1305();
        let ctx = AeadCtx::new(&algorithm, &[7u8; 32], algorithm.max_tag_len()).unwrap();

        let nonce = [1u8; 12];
        let aad = b"frame-header";
        let mut main = b"hello".to_vec();
        let extra = b" world";
        let mut detached = vec![0u8; extra.len() + algorithm.max_overhead()];

        let detached_written = ctx
            .seal_scatter(
                &nonce,
                main.as_mut_slice(),
                detached.as_mut_slice(),
                Some(extra),
                aad,
            )
            .unwrap();

        let extra_ct_len = extra.len();
        let tag = &detached_written[extra_ct_len..];
        let mut full_ciphertext = main;
        full_ciphertext.extend_from_slice(&detached_written[..extra_ct_len]);

        ctx.open_gather(&nonce, full_ciphertext.as_mut_slice(), tag, aad)
            .unwrap();

        assert_eq!(full_ciphertext.as_slice(), b"hello world");
    }

    #[test]
    fn new_rejects_invalid_key_length() {
        let result = AeadCtx::new_default_tag(&Algorithm::aes_128_gcm(), &[0u8; 15]);
        assert!(result.is_err());
    }

    #[test]
    fn tag_len_returns_expected_value() {
        let algorithm = Algorithm::aes_128_gcm();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 16]).unwrap();

        let tag_len = ctx.tag_len(0, 0).unwrap();
        assert_eq!(tag_len, algorithm.max_overhead());
    }

    #[test]
    fn seal_rejects_invalid_nonce_length() {
        // ChaCha20-Poly1305 strictly requires a 12-byte nonce.
        // (AES-GCM accepts variable-length nonces per spec, so it is not
        // suitable for testing nonce-length rejection.)
        let algorithm = Algorithm::chacha20_poly1305();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 32]).unwrap();
        let mut payload = [0u8; 8];
        let mut tag = [0u8; 16];

        let result = ctx.seal_in_place(&[0u8; 11], &mut payload, &mut tag, b"");
        assert!(result.is_err());
    }

    #[test]
    fn seal_rejects_insufficient_tag_buffer() {
        let algorithm = Algorithm::aes_128_gcm();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 16]).unwrap();
        let mut payload = [0u8; 8];

        // AES-128-GCM produces a 16-byte tag; an 8-byte buffer must be rejected.
        let mut short_tag = [0u8; 8];
        let result = ctx.seal_in_place(&[0u8; 12], &mut payload, &mut short_tag, b"");
        assert!(result.is_err());
    }

    #[test]
    fn open_rejects_invalid_nonce_length() {
        let algorithm = Algorithm::chacha20_poly1305();
        let ctx = AeadCtx::new_default_tag(&algorithm, &[0u8; 32]).unwrap();
        let mut payload = [0u8; 8];
        let tag = [0u8; 16];

        let result = ctx.open_in_place(&[0u8; 11], &mut payload, &tag, b"");
        assert!(result.is_err());
    }
}
