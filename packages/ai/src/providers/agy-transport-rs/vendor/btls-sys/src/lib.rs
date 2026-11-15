#![allow(
    clippy::missing_safety_doc,
    clippy::redundant_static_lifetimes,
    clippy::too_many_arguments,
    clippy::unreadable_literal,
    clippy::upper_case_acronyms,
    improper_ctypes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unused_imports
)]

use std::convert::TryInto;
use std::ffi::c_void;
use std::os::raw::{c_char, c_int, c_uint, c_ulong};

#[allow(
    clippy::useless_transmute,
    clippy::derive_partial_eq_without_eq,
    clippy::ptr_offset_with_cast,
    dead_code
)]
mod generated {
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

// explicitly require presence of some symbols to check if the bindings worked
pub use generated::{ssl_compliance_policy_t, ERR_add_error_data, SSL_set1_groups}; // if these are missing, your include path is incorrect or has a wrong version of boringssl
pub use generated::{BIO_new, OPENSSL_free, SSL_ERROR_NONE}; // if these are missing, your include path is incorrect
#[cfg(feature = "fips")]
pub use generated::{FIPS_mode, SSL_CTX_set_compliance_policy}; // your include path is incorrect or has a version of boringssl without FIPS support
#[cfg(feature = "mlkem")]
pub use generated::{MLKEM768_encap, MLKEM768_private_key_from_seed}; // your include path is incorrect or has a version of boringssl without mlkem support

pub use generated::*;
#[cfg(target_pointer_width = "64")]
pub type BN_ULONG = u64;
#[cfg(target_pointer_width = "32")]
pub type BN_ULONG = u32;

#[must_use]
pub const fn ERR_PACK(l: c_int, f: c_int, r: c_int) -> c_ulong {
    ((l as c_ulong & 0x0FF) << 24) | ((f as c_ulong & 0xFFF) << 12) | (r as c_ulong & 0xFFF)
}

#[must_use]
pub const fn ERR_GET_LIB(l: c_uint) -> c_int {
    ((l >> 24) & 0x0FF) as c_int
}

#[must_use]
pub const fn ERR_GET_FUNC(l: c_uint) -> c_int {
    ((l >> 12) & 0xFFF) as c_int
}

#[must_use]
pub const fn ERR_GET_REASON(l: c_uint) -> c_int {
    (l & 0xFFF) as c_int
}

pub fn init() {
    unsafe {
        CRYPTO_library_init();
    }
}

pub mod internal {
    use super::EVP_MD;
    use std::os::raw::c_int;

    extern "C" {
        /// Calculates `out_len` bytes of the TLS 1.2 PRF using `digest` and writes
        /// them to `out`.
        ///
        /// This symbol is exported by BoringSSL, but it is declared in an internal
        /// header (`crypto/fipsmodule/tls/internal.h`) and is therefore not present
        /// in generated bindgen output.
        pub fn CRYPTO_tls1_prf(
            digest: *const EVP_MD,
            out: *mut u8,
            out_len: usize,
            secret: *const u8,
            secret_len: usize,
            label: *const u8,
            label_len: usize,
            seed1: *const u8,
            seed1_len: usize,
            seed2: *const u8,
            seed2_len: usize,
        ) -> c_int;
    }
}
