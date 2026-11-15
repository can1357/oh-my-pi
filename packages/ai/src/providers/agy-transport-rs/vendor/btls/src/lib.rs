//! Bindings to BoringSSL
//!
//! This crate provides a safe interface to the BoringSSL cryptography library.
//!
//! # Versioning
//!
//! ## Crate versioning
//!
//! The crate and all the related crates (FFI bindings, etc.) are released simultaneously and all
//! bumped to the same version disregard whether particular crate has any API changes or not.
//! However, semantic versioning guarantees still hold, as all the crate versions will be updated
//! based on the crate with most significant changes.
//!
//! ## BoringSSL version
//!
//! By default, the crate aims to statically link with the latest BoringSSL master branch.
//! *Note*: any BoringSSL revision bumps will be released as a major version update of all crates.
//!
//! # Compilation and linking options
//!
//! ## Environment variables
//!
//! This crate uses various environment variables to tweak how btls is built. The variables
//! are all prefixed by `BORING_BSSL_` for non-FIPS builds, and by `BORING_BSSL_FIPS_` for FIPS builds.
//!
//! ## Support for pre-built binaries or custom source
//!
//! While this crate can build BoringSSL on its own, you may want to provide pre-built binaries instead.
//! To do so, specify the environment variable `BORING_BSSL{,_FIPS}_PATH` with the path to the binaries.
//!
//! You can also provide specific headers by setting `BORING_BSSL{,_FIPS}_INCLUDE_PATH`.
//!
//! _Notes_: The crate will look for headers in the`$BORING_BSSL{,_FIPS}_INCLUDE_PATH/openssl/`
//! folder, make sure to place your headers there.
//!
//! In alternative a different path for the BoringSSL source code directory can be specified by setting
//! `BORING_BSSL{,_FIPS}_SOURCE_PATH` which will automatically be compiled during the build process.
//!
//! _Warning_: When providing a different version of BoringSSL make sure to use a compatible one, the
//! crate relies on the presence of certain functions.
//!
//! ## Building with a FIPS-validated module
//!
//! Only BoringCrypto module version `853ca1ea1168dff08011e5d42d94609cc0ca2e27`, as certified with
//! [FIPS 140-2 certificate 4407](https://csrc.nist.gov/projects/cryptographic-module-validation-program/certificate/4407)
//! is supported by this crate. Support is enabled by this crate's `fips` feature.
//!
//! `btls-sys` comes with a test that FIPS is enabled/disabled depending on the feature flag. You can run it as follows:
//!
//! ```bash
//! $ cargo test --features fips fips::is_enabled
//! ```
//!
//! ## Linking current BoringSSL version with precompiled FIPS-validated module (`bcm.o`)
//!
//! It's possible to link latest supported version of BoringSSL with FIPS-validated crypto module
//! (`bcm.o`). To enable this compilation option one should enable `fips-link-precompiled`
//! compilation feature and provide a `BORING_BSSL_FIPS_PRECOMPILED_BCM_O` env variable with a path to the
//! precompiled FIPS-validated `bcm.o` module.
//!
//! Note that `BORING_BSSL_PRECOMPILED_BCM_O` is never used, as linking BoringSSL with precompiled non-FIPS
//! module is not supported.
//!
//! ## Linking with a C++ standard library
//!
//! Recent versions of boringssl require some C++ standard library features, so btls needs to link
//! with a STL implementation. This can be controlled using the BORING_BSSL_RUST_CPPLIB variable. If
//! no library is specified, libc++ is used on macOS and iOS whereas libstdc++ is used on other Unix
//! systems.
//!
//! # Optional patches
//!
//! ## Experimental post-quantum cryptography
//!
//! The crate can be compiled with [post-quantum cryptography](https://blog.cloudflare.com/post-quantum-for-all/)
//! support by turning on `post-quantum` compilation feature.
//!
//! Upstream BoringSSL support the post-quantum hybrid key agreement `X25519Kyber768Draft00`. Most
//! users should stick to that one for now. Enabling this feature, adds a few other post-quantum key
//! agreements:
//!
//! - `X25519MLKEM768` is the successor of `X25519Kyber768Draft00`. We expect servers to switch
//!   before the end of 2024.
//! - `X25519Kyber768Draft00Old` is the same as `X25519Kyber768Draft00`, but under its old codepoint.
//! - `X25519Kyber512Draft00`. Similar to `X25519Kyber768Draft00`, but uses level 1 parameter set for
//!   Kyber. Not recommended. It's useful to test whether the shorter ClientHello upsets fewer middle
//!   boxes.
//! - `P256Kyber768Draft00`. Similar again to `X25519Kyber768Draft00`, but uses P256 as classical
//!   part. It uses a non-standard codepoint. Not recommended.
//!
//! Presently all these key agreements are deployed by Cloudflare, but we do not guarantee continued
//! support for them.

#[macro_use]
extern crate bitflags;
#[macro_use]
extern crate foreign_types;
extern crate btls_sys as ffi;
extern crate libc;

#[cfg(test)]
extern crate hex;

use std::ffi::{c_int, c_long, c_void};
use std::num::NonZeroUsize;

#[doc(inline)]
pub use crate::ffi::init;

use crate::error::ErrorStack;

#[macro_use]
mod macros;

mod bio;
#[macro_use]
mod util;
pub mod aead;
pub mod aes;
pub mod asn1;
pub mod base64;
pub mod bn;
pub mod conf;
pub mod derive;
pub mod dh;
pub mod dsa;
pub mod ec;
pub mod ecdsa;
pub mod error;
pub mod ex_data;
pub mod fips;
pub mod hash;
pub mod hmac;
pub mod hpke;
pub mod memcmp;
#[cfg(feature = "mlkem")]
pub mod mlkem;
pub mod nid;
pub mod pkcs12;
pub mod pkcs5;
pub mod pkey;
#[cfg(feature = "prf")]
pub mod prf;
pub mod rand;
pub mod rsa;
pub mod sha;
pub mod sign;
pub mod srtp;
pub mod ssl;
pub mod stack;
pub mod string;
pub mod symm;
pub mod version;
pub mod x509;

fn cvt_p<T>(r: *mut T) -> Result<*mut T, ErrorStack> {
    if r.is_null() {
        Err(ErrorStack::get())
    } else {
        Ok(r)
    }
}

fn cvt_0(r: usize) -> Result<(), ErrorStack> {
    if r == 0 {
        Err(ErrorStack::get())
    } else {
        Ok(())
    }
}

fn cvt_0i(r: c_int) -> Result<c_int, ErrorStack> {
    if r == 0 {
        Err(ErrorStack::get())
    } else {
        Ok(r)
    }
}

fn cvt(r: c_int) -> Result<(), ErrorStack> {
    if r <= 0 {
        Err(ErrorStack::get())
    } else {
        Ok(())
    }
}

fn cvt_nz(r: c_int) -> Result<NonZeroUsize, ErrorStack> {
    usize::try_from(r)
        .ok()
        .and_then(NonZeroUsize::new)
        .ok_or_else(ErrorStack::get)
}

fn cvt_n(r: c_int) -> Result<c_int, ErrorStack> {
    if r < 0 {
        Err(ErrorStack::get())
    } else {
        Ok(r)
    }
}

fn try_int<F, T>(from: F) -> Result<T, ErrorStack>
where
    F: TryInto<T> + Send + Sync + Copy + 'static,
    T: Send + Sync + Copy + 'static,
{
    from.try_into()
        .map_err(|_| ErrorStack::internal_error_str("int overflow"))
}

unsafe extern "C" fn free_data_box<T>(
    _parent: *mut c_void,
    ptr: *mut c_void,
    _ad: *mut ffi::CRYPTO_EX_DATA,
    _idx: c_int,
    _argl: c_long,
    _argp: *mut c_void,
) {
    if !ptr.is_null() {
        unsafe {
            drop(Box::<T>::from_raw(ptr.cast::<T>()));
        }
    }
}
