//! FIPS 140-2 support.
//!
//! See [OpenSSL's documentation] for details.
//!
//! [OpenSSL's documentation]: https://www.openssl.org/docs/fips/UserGuide-2.0.pdf
use crate::ffi;
use openssl_macros::corresponds;

/// Determines if the library is running in the FIPS 140-2 mode of operation.
#[corresponds(FIPS_mode)]
#[must_use]
pub fn enabled() -> bool {
    unsafe { ffi::FIPS_mode() != 0 }
}

#[test]
fn is_enabled() {
    #[cfg(feature = "fips")]
    assert!(enabled());
    #[cfg(not(feature = "fips"))]
    assert!(!enabled());
}
