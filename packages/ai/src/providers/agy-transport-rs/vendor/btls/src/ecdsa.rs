//! Low level Elliptic Curve Digital Signature Algorithm (ECDSA) functions.

use crate::ffi;
use foreign_types::{ForeignType, ForeignTypeRef};
use libc::c_int;
use openssl_macros::corresponds;
use std::mem;
use std::ptr;

use crate::bn::{BigNum, BigNumRef};
use crate::ec::EcKeyRef;
use crate::error::ErrorStack;
use crate::pkey::{HasPrivate, HasPublic};
use crate::{cvt_n, cvt_p};

foreign_type_and_impl_send_sync! {
    type CType = ffi::ECDSA_SIG;
    fn drop = ffi::ECDSA_SIG_free;

    /// A low level interface to ECDSA
    ///
    /// OpenSSL documentation at [`ECDSA_sign`]
    ///
    /// [`ECDSA_sign`]: https://www.openssl.org/docs/man1.1.0/crypto/ECDSA_sign.html
    pub struct EcdsaSig;
}

impl EcdsaSig {
    /// Computes a digital signature of the hash value `data` using the private EC key eckey.
    #[corresponds(ECDSA_do_sign)]
    pub fn sign<T>(data: &[u8], eckey: &EcKeyRef<T>) -> Result<EcdsaSig, ErrorStack>
    where
        T: HasPrivate,
    {
        unsafe {
            assert!(data.len() <= c_int::MAX as usize);
            let sig = cvt_p(ffi::ECDSA_do_sign(
                data.as_ptr(),
                data.len(),
                eckey.as_ptr(),
            ))?;
            Ok(EcdsaSig::from_ptr(sig))
        }
    }

    /// Returns a new `EcdsaSig` by setting the `r` and `s` values associated with a
    /// ECDSA signature.
    #[corresponds(ECDSA_SIG_set0)]
    pub fn from_private_components(r: BigNum, s: BigNum) -> Result<EcdsaSig, ErrorStack> {
        unsafe {
            let sig = cvt_p(ffi::ECDSA_SIG_new())?;
            ECDSA_SIG_set0(sig, r.as_ptr(), s.as_ptr());
            mem::forget((r, s));
            Ok(EcdsaSig::from_ptr(sig))
        }
    }

    from_der! {
        /// Decodes a DER-encoded ECDSA signature.
        #[corresponds(d2i_ECDSA_SIG)]
        from_der,
        EcdsaSig,
        ffi::d2i_ECDSA_SIG,
        ::libc::c_long
    }
}

impl EcdsaSigRef {
    to_der! {
        /// Serializes the ECDSA signature into a DER-encoded ECDSASignature structure.
        #[corresponds(i2d_ECDSA_SIG)]
        to_der,
        ffi::i2d_ECDSA_SIG
    }

    /// Verifies if the signature is a valid ECDSA signature using the given public key.
    #[corresponds(ECDSA_do_verify)]
    pub fn verify<T>(&self, data: &[u8], eckey: &EcKeyRef<T>) -> Result<bool, ErrorStack>
    where
        T: HasPublic,
    {
        unsafe {
            assert!(data.len() <= c_int::MAX as usize);
            cvt_n(ffi::ECDSA_do_verify(
                data.as_ptr(),
                data.len(),
                self.as_ptr(),
                eckey.as_ptr(),
            ))
            .map(|x| x == 1)
        }
    }

    /// Returns internal component: `r` of an `EcdsaSig`. (See X9.62 or FIPS 186-2)
    #[corresponds(ECDSA_SIG_get0)]
    #[must_use]
    pub fn r(&self) -> &BigNumRef {
        unsafe {
            let mut r = ptr::null();
            ECDSA_SIG_get0(self.as_ptr(), &mut r, ptr::null_mut());
            BigNumRef::from_ptr(r.cast_mut())
        }
    }

    /// Returns internal components: `s` of an `EcdsaSig`. (See X9.62 or FIPS 186-2)
    #[corresponds(ECDSA_SIG_get0)]
    #[must_use]
    pub fn s(&self) -> &BigNumRef {
        unsafe {
            let mut s = ptr::null();
            ECDSA_SIG_get0(self.as_ptr(), ptr::null_mut(), &mut s);
            BigNumRef::from_ptr(s.cast_mut())
        }
    }
}

use crate::ffi::{ECDSA_SIG_get0, ECDSA_SIG_set0};
