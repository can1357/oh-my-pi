//! Low level AES IGE and key wrapping functionality
//!
//! AES ECB, CBC, XTS, CTR, CFB, GCM and other conventional symmetric encryption
//! modes are found in [`symm`].  This is the implementation of AES IGE and key wrapping
//!
//! Advanced Encryption Standard (AES) provides symmetric key cipher that
//! the same key is used to encrypt and decrypt data.  This implementation
//! uses 128, 192, or 256 bit keys.  This module provides functions to
//! create a new key with [`new_encrypt`].
//!
//! [`new_encrypt`]: struct.AesKey.html#method.new_encrypt
//!
//! The [`symm`] module should be used in preference to this module in most cases.
//! The IGE block cypher is a non-traditional cipher mode.  More traditional AES
//! encryption methods are found in the [`Crypter`] and [`Cipher`] structs.
//!
//! [`symm`]: ../symm/index.html
//! [`Crypter`]: ../symm/struct.Crypter.html
//! [`Cipher`]: ../symm/struct.Cipher.html
//!
//! # Examples
//!
//! ## Key wrapping
//! ```rust
//! use btls::aes::{AesKey, unwrap_key, wrap_key};
//!
//! let kek = b"\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F";
//! let key_to_wrap = b"\x00\x11\x22\x33\x44\x55\x66\x77\x88\x99\xAA\xBB\xCC\xDD\xEE\xFF";
//!
//! let enc_key = AesKey::new_encrypt(kek).unwrap();
//! let mut ciphertext = [0u8; 24];
//! wrap_key(&enc_key, None, &mut ciphertext, &key_to_wrap[..]).unwrap();
//! let dec_key = AesKey::new_decrypt(kek).unwrap();
//! let mut orig_key = [0u8; 16];
//! unwrap_key(&dec_key, None, &mut orig_key, &ciphertext[..]).unwrap();
//!
//! assert_eq!(&orig_key[..], &key_to_wrap[..]);
//! ```
//!
use crate::ffi;
use libc::c_int;
use openssl_macros::corresponds;
use std::mem::MaybeUninit;
use std::ptr;

/// Provides Error handling for parsing keys.
#[derive(Debug)]
pub struct KeyError(());

/// The key used to encrypt or decrypt cipher blocks.
pub struct AesKey(ffi::AES_KEY);

impl AesKey {
    /// Prepares a key for encryption.
    ///
    /// # Failure
    ///
    /// Returns an error if the key is not 128, 192, or 256 bits.
    #[corresponds(AES_set_encrypt_key)]
    pub fn new_encrypt(key: &[u8]) -> Result<AesKey, KeyError> {
        unsafe {
            assert!(key.len() <= c_int::MAX as usize / 8);

            let mut aes_key = MaybeUninit::uninit();
            let r = ffi::AES_set_encrypt_key(
                key.as_ptr(),
                (key.len() * 8).try_into().map_err(|_| KeyError(()))?,
                aes_key.as_mut_ptr(),
            );
            if r == 0 {
                Ok(AesKey(aes_key.assume_init()))
            } else {
                Err(KeyError(()))
            }
        }
    }

    /// Prepares a key for decryption.
    ///
    /// # Failure
    ///
    /// Returns an error if the key is not 128, 192, or 256 bits.
    #[corresponds(AES_set_decrypt_key)]
    pub fn new_decrypt(key: &[u8]) -> Result<AesKey, KeyError> {
        unsafe {
            assert!(key.len() <= c_int::MAX as usize / 8);

            let mut aes_key = MaybeUninit::uninit();
            let r = ffi::AES_set_decrypt_key(
                key.as_ptr(),
                (key.len() * 8).try_into().map_err(|_| KeyError(()))?,
                aes_key.as_mut_ptr(),
            );

            if r == 0 {
                Ok(AesKey(aes_key.assume_init()))
            } else {
                Err(KeyError(()))
            }
        }
    }
}

/// Wrap a key, according to [RFC 3394](https://tools.ietf.org/html/rfc3394)
///
/// * `key`: The key-encrypting-key to use. Must be a encrypting key
/// * `iv`: The IV to use. You must use the same IV for both wrapping and unwrapping
/// * `out`: The output buffer to store the ciphertext
/// * `in_`: The input buffer, storing the key to be wrapped
///
/// Returns the number of bytes written into `out`
///
/// # Panics
///
/// Panics if either `out` or `in_` do not have sizes that are a multiple of 8, or if
/// `out` is not 8 bytes longer than `in_`
#[corresponds(AES_wrap_key)]
pub fn wrap_key(
    key: &AesKey,
    iv: Option<[u8; 8]>,
    out: &mut [u8],
    in_: &[u8],
) -> Result<usize, KeyError> {
    unsafe {
        assert!(out.len() >= in_.len() + 8); // Ciphertext is 64 bits longer (see 2.2.1)

        let written = ffi::AES_wrap_key(
            std::ptr::addr_of!(key.0).cast_mut(), // this is safe, the implementation only uses the key as a const pointer.
            iv.as_ref().map_or(ptr::null(), |iv| iv.as_ptr()),
            out.as_mut_ptr(),
            in_.as_ptr(),
            in_.len(),
        );
        if written <= 0 {
            Err(KeyError(()))
        } else {
            Ok(written as usize)
        }
    }
}

/// Unwrap a key, according to [RFC 3394](https://tools.ietf.org/html/rfc3394)
///
/// * `key`: The key-encrypting-key to decrypt the wrapped key. Must be a decrypting key
/// * `iv`: The same IV used for wrapping the key
/// * `out`: The buffer to write the unwrapped key to
/// * `in_`: The input ciphertext
///
/// Returns the number of bytes written into `out`
///
/// # Panics
///
/// Panics if either `out` or `in_` do not have sizes that are a multiple of 8, or
/// if `in_` is not 8 bytes longer than `out`
#[corresponds(AES_unwrap_key)]
pub fn unwrap_key(
    key: &AesKey,
    iv: Option<[u8; 8]>,
    out: &mut [u8],
    in_: &[u8],
) -> Result<usize, KeyError> {
    unsafe {
        assert!(out.len() + 8 <= in_.len());

        let written = ffi::AES_unwrap_key(
            std::ptr::addr_of!(key.0).cast_mut(), // this is safe, the implementation only uses the key as a const pointer.
            iv.as_ref().map_or(ptr::null(), |iv| iv.as_ptr().cast()),
            out.as_ptr().cast_mut(),
            in_.as_ptr().cast(),
            in_.len(),
        );

        if written <= 0 {
            Err(KeyError(()))
        } else {
            Ok(written as usize)
        }
    }
}

#[cfg(test)]
mod test {
    use hex::FromHex;

    use super::*;

    // from the RFC https://tools.ietf.org/html/rfc3394#section-2.2.3
    #[test]
    fn test_wrap_unwrap() {
        let raw_key = Vec::from_hex("000102030405060708090A0B0C0D0E0F").unwrap();
        let key_data = Vec::from_hex("00112233445566778899AABBCCDDEEFF").unwrap();
        let expected_ciphertext =
            Vec::from_hex("1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5").unwrap();

        let enc_key = AesKey::new_encrypt(&raw_key).unwrap();
        let mut wrapped = [0; 24];
        assert_eq!(
            wrap_key(&enc_key, None, &mut wrapped, &key_data).unwrap(),
            24
        );
        assert_eq!(&wrapped[..], &expected_ciphertext[..]);

        let dec_key = AesKey::new_decrypt(&raw_key).unwrap();
        let mut unwrapped = [0; 16];
        assert_eq!(
            unwrap_key(&dec_key, None, &mut unwrapped, &wrapped).unwrap(),
            16
        );
        assert_eq!(&unwrapped[..], &key_data[..]);
    }
}
