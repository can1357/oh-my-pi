//! The standard defining the format of public key certificates.
//!
//! An `X509` certificate binds an identity to a public key, and is either
//! signed by a certificate authority (CA) or self-signed. An entity that gets
//! a hold of a certificate can both verify your identity (via a CA) and encrypt
//! data with the included public key. `X509` certificates are used in many
//! Internet protocols, including SSL/TLS, which is the basis for HTTPS,
//! the secure protocol for browsing the web.

use foreign_types::{ForeignType, ForeignTypeRef};
use libc::{c_int, c_long, c_void};
use openssl_macros::corresponds;
use std::convert::TryInto;
use std::error::Error;
use std::ffi::{CStr, CString};
use std::fmt;
use std::marker::PhantomData;
use std::mem;
use std::net::IpAddr;
use std::path::Path;
use std::ptr;
use std::str;
use std::sync::LazyLock;

use crate::asn1::{
    Asn1BitStringRef, Asn1IntegerRef, Asn1Object, Asn1ObjectRef, Asn1StringRef, Asn1TimeRef,
    Asn1Type,
};
use crate::bio::{MemBio, MemBioSlice};
use crate::conf::ConfRef;
use crate::error::ErrorStack;
use crate::ex_data::Index;
use crate::hash::{DigestBytes, MessageDigest};
use crate::nid::Nid;
use crate::pkey::{HasPrivate, HasPublic, PKey, PKeyRef, Public};
use crate::ssl::SslRef;
use crate::stack::{Stack, StackRef, Stackable};
use crate::string::OpensslString;
use crate::try_int;
use crate::util::ForeignTypeRefExt;
use crate::x509::verify::{X509VerifyParam, X509VerifyParamRef};
use crate::{cvt, cvt_n, cvt_p};
use crate::{ffi, free_data_box};

pub mod extension;
pub mod store;
pub mod verify;

#[cfg(test)]
mod tests;

static STORE_INDEX: LazyLock<Index<X509StoreContext, store::X509Store>> =
    LazyLock::new(|| X509StoreContext::new_ex_index().unwrap());

static CERT_INDEX: LazyLock<Index<X509StoreContext, X509>> =
    LazyLock::new(|| X509StoreContext::new_ex_index().unwrap());

static CERT_CHAIN_INDEX: LazyLock<Index<X509StoreContext, Stack<X509>>> =
    LazyLock::new(|| X509StoreContext::new_ex_index().unwrap());

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_STORE_CTX;
    fn drop = ffi::X509_STORE_CTX_free;

    /// An `X509` certificate store context.
    pub struct X509StoreContext;
}

impl X509StoreContext {
    /// Returns the index which can be used to obtain a reference to the `Ssl` associated with a
    /// context.
    #[corresponds(SSL_get_ex_data_X509_STORE_CTX_idx)]
    pub fn ssl_idx() -> Result<Index<X509StoreContext, SslRef>, ErrorStack> {
        unsafe { cvt_n(ffi::SSL_get_ex_data_X509_STORE_CTX_idx()).map(|idx| Index::from_raw(idx)) }
    }

    /// Creates a new `X509StoreContext` instance.
    #[corresponds(X509_STORE_CTX_new)]
    pub fn new() -> Result<X509StoreContext, ErrorStack> {
        unsafe {
            ffi::init();
            cvt_p(ffi::X509_STORE_CTX_new()).map(|p| X509StoreContext::from_ptr(p))
        }
    }

    /// Returns a new extra data index.
    ///
    /// Each invocation of this function is guaranteed to return a distinct index. These can be used
    /// to store data in the context that can be retrieved later by callbacks, for example.
    #[corresponds(SSL_CTX_get_ex_new_index)]
    pub fn new_ex_index<T>() -> Result<Index<X509StoreContext, T>, ErrorStack>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            ffi::init();
            let idx = cvt_n(get_new_x509_store_ctx_idx(Some(free_data_box::<T>)))?;
            Ok(Index::from_raw(idx))
        }
    }
}

impl X509StoreContextRef {
    /// Returns application data pertaining to an `X509` store context.
    #[corresponds(X509_STORE_CTX_get_ex_data)]
    #[must_use]
    pub fn ex_data<T>(&self, index: Index<X509StoreContext, T>) -> Option<&T> {
        unsafe {
            ffi::X509_STORE_CTX_get_ex_data(self.as_ptr(), index.as_raw())
                .cast::<T>()
                .as_ref()
        }
    }

    /// Returns a mutable reference to the extra data at the specified index.
    #[corresponds(X509_STORE_CTX_get_ex_data)]
    pub fn ex_data_mut<T>(&mut self, index: Index<X509StoreContext, T>) -> Option<&mut T> {
        unsafe {
            ffi::X509_STORE_CTX_get_ex_data(self.as_ptr(), index.as_raw())
                .cast::<T>()
                .as_mut()
        }
    }

    /// Sets or overwrites the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `Ssl::new_ex_index` method to create an `Index`.
    #[corresponds(X509_STORE_CTX_set_ex_data)]
    pub fn set_ex_data<T>(&mut self, index: Index<X509StoreContext, T>, data: T) {
        if let Some(old) = self.ex_data_mut(index) {
            *old = data;

            return;
        }

        unsafe {
            let data = Box::new(data);

            ffi::X509_STORE_CTX_set_ex_data(
                self.as_ptr(),
                index.as_raw(),
                Box::into_raw(data).cast(),
            );
        }
    }

    /// Returns the verify result of the context.
    #[corresponds(X509_STORE_CTX_get_error)]
    pub fn verify_result(&self) -> X509VerifyResult {
        unsafe { X509VerifyError::from_raw(ffi::X509_STORE_CTX_get_error(self.as_ptr())) }
    }

    /// Initializes this context with the given certificate, certificates chain and certificate
    /// store. After initializing the context, the `with_context` closure is called with the prepared
    /// context. As long as the closure is running, the context stays initialized and can be used
    /// to e.g. verify a certificate. The context will be cleaned up, after the closure finished.
    ///
    /// * `trust` - The certificate store with the trusted certificates.
    /// * `cert` - The certificate that should be verified.
    /// * `cert_chain` - The certificates chain.
    /// * `with_context` - The closure that is called with the initialized context.
    ///
    /// Calls [`X509_STORE_CTX_cleanup`] after calling `with_context`.
    ///
    /// [`X509_STORE_CTX_cleanup`]:  https://www.openssl.org/docs/man1.0.2/crypto/X509_STORE_CTX_cleanup.html
    #[corresponds(X509_STORE_CTX_init)]
    pub fn init<F, T>(
        &mut self,
        trust: &store::X509StoreRef,
        cert: &X509Ref,
        cert_chain: &StackRef<X509>,
        with_context: F,
    ) -> Result<T, ErrorStack>
    where
        F: FnOnce(&mut X509StoreContextRef) -> Result<T, ErrorStack>,
    {
        struct Cleanup<'a>(&'a mut X509StoreContextRef);

        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                unsafe {
                    ffi::X509_STORE_CTX_cleanup(self.0.as_ptr());
                }
            }
        }

        unsafe {
            let cleanup = Cleanup(self);

            cvt(ffi::X509_STORE_CTX_init(
                cleanup.0.as_ptr(),
                trust.as_ptr(),
                cert.as_ptr(),
                cert_chain.as_ptr(),
            ))?;

            with_context(cleanup.0)
        }
    }

    /// Initializes this context with the given certificate, certificates chain and certificate
    /// store.
    ///
    /// * `trust` - The certificate store with the trusted certificates.
    /// * `cert` - The certificate that should be verified.
    /// * `cert_chain` - The certificates chain.
    #[corresponds(X509_STORE_CTX_init)]
    pub fn reset_with_context_data(
        &mut self,
        trust: store::X509Store,
        cert: X509,
        cert_chain: Stack<X509>,
    ) -> Result<(), ErrorStack> {
        unsafe {
            if let Err(e) = cvt(ffi::X509_STORE_CTX_init(
                self.as_ptr(),
                trust.as_ptr(),
                cert.as_ptr(),
                cert_chain.as_ptr(),
            )) {
                ffi::X509_STORE_CTX_cleanup(self.as_ptr());

                return Err(e);
            }
        }

        self.set_ex_data(*STORE_INDEX, trust);
        self.set_ex_data(*CERT_INDEX, cert);
        self.set_ex_data(*CERT_CHAIN_INDEX, cert_chain);

        Ok(())
    }

    /// Returns a reference to the X509 verification configuration.
    #[corresponds(X509_STORE_CTX_get0_param)]
    pub fn verify_param(&mut self) -> &X509VerifyParamRef {
        unsafe { X509VerifyParamRef::from_ptr(ffi::X509_STORE_CTX_get0_param(self.as_ptr())) }
    }

    /// Returns a mutable reference to the X509 verification configuration.
    #[corresponds(X509_STORE_CTX_get0_param)]
    pub fn verify_param_mut(&mut self) -> &mut X509VerifyParamRef {
        unsafe { X509VerifyParamRef::from_ptr_mut(ffi::X509_STORE_CTX_get0_param(self.as_ptr())) }
    }

    /// Sets the X509 verification configuration.
    #[corresponds(X509_STORE_CTX_set0_param)]
    pub fn set_verify_param(&mut self, param: X509VerifyParam) {
        unsafe { ffi::X509_STORE_CTX_set0_param(self.as_ptr(), param.as_ptr()) }
    }

    /// Verifies the stored certificate.
    ///
    /// Returns `true` if verification succeeds. The `error` method will return the specific
    /// validation error if the certificate was not valid.
    ///
    /// This will only work inside of a call to `init`.
    #[corresponds(X509_verify_cert)]
    pub fn verify_cert(&mut self) -> Result<bool, ErrorStack> {
        unsafe { cvt_n(ffi::X509_verify_cert(self.as_ptr())).map(|n| n != 0) }
    }

    /// Set the verify result of the context.
    #[corresponds(X509_STORE_CTX_set_error)]
    pub fn set_error(&mut self, result: X509VerifyResult) {
        unsafe {
            ffi::X509_STORE_CTX_set_error(
                self.as_ptr(),
                result
                    .err()
                    .as_ref()
                    .map_or(ffi::X509_V_OK, X509VerifyError::as_raw),
            );
        }
    }

    /// Returns a reference to the certificate which caused the error or None if
    /// no certificate is relevant to the error.
    #[corresponds(X509_STORE_CTX_get_current_cert)]
    #[must_use]
    pub fn current_cert(&self) -> Option<&X509Ref> {
        unsafe {
            let ptr = ffi::X509_STORE_CTX_get_current_cert(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509Ref::from_ptr(ptr))
            }
        }
    }

    /// Returns a non-negative integer representing the depth in the certificate
    /// chain where the error occurred. If it is zero it occurred in the end
    /// entity certificate, one if it is the certificate which signed the end
    /// entity certificate and so on.
    #[corresponds(X509_STORE_CTX_get_error_depth)]
    #[must_use]
    pub fn error_depth(&self) -> u32 {
        unsafe { ffi::X509_STORE_CTX_get_error_depth(self.as_ptr()) as u32 }
    }

    /// Returns a reference to a complete valid `X509` certificate chain.
    #[corresponds(X509_STORE_CTX_get0_chain)]
    #[must_use]
    pub fn chain(&self) -> Option<&StackRef<X509>> {
        unsafe {
            let chain = X509_STORE_CTX_get0_chain(self.as_ptr());

            if chain.is_null() {
                None
            } else {
                Some(StackRef::from_ptr(chain))
            }
        }
    }

    /// Returns a reference to the `X509` certificates used to initialize the
    /// [`X509StoreContextRef`].
    #[corresponds(X509_STORE_CTX_get0_untrusted)]
    #[must_use]
    pub fn untrusted(&self) -> Option<&StackRef<X509>> {
        unsafe {
            let certs = ffi::X509_STORE_CTX_get0_untrusted(self.as_ptr());

            if certs.is_null() {
                None
            } else {
                Some(StackRef::from_ptr(certs))
            }
        }
    }

    /// Returns a reference to the certificate being verified.
    /// May return None if a raw public key is being verified.
    #[corresponds(X509_STORE_CTX_get0_cert)]
    #[must_use]
    pub fn cert(&self) -> Option<&X509Ref> {
        unsafe {
            let ptr = ffi::X509_STORE_CTX_get0_cert(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509Ref::from_ptr(ptr))
            }
        }
    }
}

/// A builder used to construct an `X509`.
pub struct X509Builder(X509);

impl X509Builder {
    /// Creates a new builder.
    #[corresponds(X509_new)]
    pub fn new() -> Result<X509Builder, ErrorStack> {
        unsafe {
            ffi::init();
            cvt_p(ffi::X509_new()).map(|p| X509Builder(X509::from_ptr(p)))
        }
    }

    /// Sets the notAfter constraint on the certificate.
    #[corresponds(X509_set1_notAfter)]
    pub fn set_not_after(&mut self, not_after: &Asn1TimeRef) -> Result<(), ErrorStack> {
        unsafe { cvt(X509_set1_notAfter(self.0.as_ptr(), not_after.as_ptr())) }
    }

    /// Sets the notBefore constraint on the certificate.
    #[corresponds(X509_set1_notBefore)]
    pub fn set_not_before(&mut self, not_before: &Asn1TimeRef) -> Result<(), ErrorStack> {
        unsafe { cvt(X509_set1_notBefore(self.0.as_ptr(), not_before.as_ptr())) }
    }

    /// Sets the version of the certificate.
    ///
    /// Note that the version is zero-indexed; that is, a certificate corresponding to version 3 of
    /// the X.509 standard should pass `2` to this method.
    #[corresponds(X509_set_version)]
    pub fn set_version(&mut self, version: i32) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::X509_set_version(self.0.as_ptr(), version.into())) }
    }

    /// Sets the serial number of the certificate.
    #[corresponds(X509_set_serialNumber)]
    pub fn set_serial_number(&mut self, serial_number: &Asn1IntegerRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_set_serialNumber(
                self.0.as_ptr(),
                serial_number.as_ptr(),
            ))
        }
    }

    /// Sets the issuer name of the certificate.
    #[corresponds(X509_set_issuer_name)]
    pub fn set_issuer_name(&mut self, issuer_name: &X509NameRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_set_issuer_name(
                self.0.as_ptr(),
                issuer_name.as_ptr(),
            ))
        }
    }

    /// Sets the subject name of the certificate.
    ///
    /// When building certificates, the `C`, `ST`, and `O` options are common when using the openssl command line tools.
    /// The `CN` field is used for the common name, such as a DNS name.
    ///
    /// ```
    /// use btls::x509::{X509, X509NameBuilder};
    ///
    /// let mut x509_name = btls::x509::X509NameBuilder::new().unwrap();
    /// x509_name.append_entry_by_text("C", "US").unwrap();
    /// x509_name.append_entry_by_text("ST", "CA").unwrap();
    /// x509_name.append_entry_by_text("O", "Some organization").unwrap();
    /// x509_name.append_entry_by_text("CN", "www.example.com").unwrap();
    /// let x509_name = x509_name.build();
    ///
    /// let mut x509 = btls::x509::X509::builder().unwrap();
    /// x509.set_subject_name(&x509_name).unwrap();
    /// ```
    #[corresponds(X509_set_subject_name)]
    pub fn set_subject_name(&mut self, subject_name: &X509NameRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_set_subject_name(
                self.0.as_ptr(),
                subject_name.as_ptr(),
            ))
        }
    }

    /// Sets the public key associated with the certificate.
    #[corresponds(X509_set_pubkey)]
    pub fn set_pubkey<T>(&mut self, key: &PKeyRef<T>) -> Result<(), ErrorStack>
    where
        T: HasPublic,
    {
        unsafe { cvt(ffi::X509_set_pubkey(self.0.as_ptr(), key.as_ptr())) }
    }

    /// Returns a context object which is needed to create certain X509 extension values.
    ///
    /// Set `issuer` to `None` if the certificate will be self-signed.
    #[corresponds(X509V3_set_ctx)]
    #[must_use]
    pub fn x509v3_context<'a>(
        &'a self,
        issuer: Option<&'a X509Ref>,
        conf: Option<&'a ConfRef>,
    ) -> X509v3Context<'a> {
        unsafe {
            let mut ctx = mem::zeroed();

            let issuer = match issuer {
                Some(issuer) => issuer.as_ptr(),
                None => self.0.as_ptr(),
            };
            let subject = self.0.as_ptr();
            ffi::X509V3_set_ctx(
                &mut ctx,
                issuer,
                subject,
                ptr::null_mut(),
                ptr::null_mut(),
                0,
            );

            // nodb case taken care of since we zeroed ctx above
            if let Some(conf) = conf {
                ffi::X509V3_set_nconf(&mut ctx, conf.as_ptr());
            }

            X509v3Context(ctx, PhantomData)
        }
    }

    /// Adds an X509 extension value to the certificate.
    #[corresponds(X509_add_ext)]
    pub fn append_extension(&mut self, extension: &X509ExtensionRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_add_ext(self.0.as_ptr(), extension.as_ptr(), -1))?;
            Ok(())
        }
    }

    /// Signs the certificate with a private key.
    #[corresponds(X509_sign)]
    pub fn sign<T>(&mut self, key: &PKeyRef<T>, hash: MessageDigest) -> Result<(), ErrorStack>
    where
        T: HasPrivate,
    {
        unsafe { cvt(ffi::X509_sign(self.0.as_ptr(), key.as_ptr(), hash.as_ptr())) }
    }

    /// Consumes the builder, returning the certificate.
    #[must_use]
    pub fn build(self) -> X509 {
        self.0
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509;
    fn drop = ffi::X509_free;

    /// An `X509` public key certificate.
    pub struct X509;
}

impl X509Ref {
    /// Returns this certificate's subject name.
    #[corresponds(X509_get_subject_name)]
    #[must_use]
    pub fn subject_name(&self) -> &X509NameRef {
        unsafe {
            let name = ffi::X509_get_subject_name(self.as_ptr());
            X509NameRef::from_const_ptr_opt(name).expect("issuer name must not be null")
        }
    }

    /// Returns the hash of the certificates subject
    #[corresponds(X509_subject_name_hash)]
    #[must_use]
    pub fn subject_name_hash(&self) -> u32 {
        unsafe { ffi::X509_subject_name_hash(self.as_ptr()) as u32 }
    }

    /// Returns this certificate's subject alternative name entries, if they exist.
    #[corresponds(X509_get_ext_d2i)]
    #[must_use]
    pub fn subject_alt_names(&self) -> Option<Stack<GeneralName>> {
        unsafe {
            let stack = ffi::X509_get_ext_d2i(
                self.as_ptr(),
                ffi::NID_subject_alt_name,
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if stack.is_null() {
                None
            } else {
                Some(Stack::from_ptr(stack.cast()))
            }
        }
    }

    /// Returns this certificate's issuer name.
    #[corresponds(X509_get_issuer_name)]
    #[must_use]
    pub fn issuer_name(&self) -> &X509NameRef {
        unsafe {
            let name = ffi::X509_get_issuer_name(self.as_ptr());
            X509NameRef::from_const_ptr_opt(name).expect("issuer name must not be null")
        }
    }

    /// Returns this certificate's issuer alternative name entries, if they exist.
    #[corresponds(X509_get_ext_d2i)]
    #[must_use]
    pub fn issuer_alt_names(&self) -> Option<Stack<GeneralName>> {
        unsafe {
            let stack = ffi::X509_get_ext_d2i(
                self.as_ptr(),
                ffi::NID_issuer_alt_name,
                ptr::null_mut(),
                ptr::null_mut(),
            );
            if stack.is_null() {
                None
            } else {
                Some(Stack::from_ptr(stack.cast()))
            }
        }
    }

    /// Returns this certificate's subject key id, if it exists.
    #[corresponds(X509_get0_subject_key_id)]
    #[must_use]
    pub fn subject_key_id(&self) -> Option<&Asn1StringRef> {
        unsafe {
            let data = ffi::X509_get0_subject_key_id(self.as_ptr());
            Asn1StringRef::from_const_ptr_opt(data)
        }
    }

    /// Returns this certificate's authority key id, if it exists.
    #[corresponds(X509_get0_authority_key_id)]
    #[must_use]
    pub fn authority_key_id(&self) -> Option<&Asn1StringRef> {
        unsafe {
            let data = ffi::X509_get0_authority_key_id(self.as_ptr());
            Asn1StringRef::from_const_ptr_opt(data)
        }
    }

    #[corresponds(X509_get_pubkey)]
    pub fn public_key(&self) -> Result<PKey<Public>, ErrorStack> {
        unsafe {
            let pkey = cvt_p(ffi::X509_get_pubkey(self.as_ptr()))?;
            Ok(PKey::from_ptr(pkey))
        }
    }

    /// Returns a digest of the DER representation of the certificate.
    #[corresponds(X509_digest)]
    pub fn digest(&self, hash_type: MessageDigest) -> Result<DigestBytes, ErrorStack> {
        unsafe {
            let mut digest = DigestBytes {
                buf: [0; ffi::EVP_MAX_MD_SIZE as usize],
                len: ffi::EVP_MAX_MD_SIZE as usize,
            };
            let mut len = try_int(ffi::EVP_MAX_MD_SIZE)?;
            cvt(ffi::X509_digest(
                self.as_ptr(),
                hash_type.as_ptr(),
                digest.buf.as_mut_ptr(),
                &mut len,
            ))?;
            digest.len = try_int(len)?;

            Ok(digest)
        }
    }

    #[deprecated(since = "0.10.9", note = "renamed to digest")]
    pub fn fingerprint(&self, hash_type: MessageDigest) -> Result<Vec<u8>, ErrorStack> {
        self.digest(hash_type).map(|b| b.to_vec())
    }

    /// Returns the certificate's Not After validity period.
    #[corresponds(X509_getm_notAfter)]
    #[must_use]
    pub fn not_after(&self) -> &Asn1TimeRef {
        unsafe {
            let date = X509_getm_notAfter(self.as_ptr());
            assert!(!date.is_null());
            Asn1TimeRef::from_ptr(date)
        }
    }

    /// Returns the certificate's Not Before validity period.
    #[corresponds(X509_getm_notBefore)]
    #[must_use]
    pub fn not_before(&self) -> &Asn1TimeRef {
        unsafe {
            let date = X509_getm_notBefore(self.as_ptr());
            assert!(!date.is_null());
            Asn1TimeRef::from_ptr(date)
        }
    }

    /// Returns the certificate's signature
    #[corresponds(X509_get0_signature)]
    #[must_use]
    pub fn signature(&self) -> &Asn1BitStringRef {
        unsafe {
            let mut signature = ptr::null();
            X509_get0_signature(&mut signature, ptr::null_mut(), self.as_ptr());
            assert!(!signature.is_null());
            Asn1BitStringRef::from_ptr(signature.cast_mut())
        }
    }

    /// Returns the certificate's signature algorithm.
    #[corresponds(X509_get0_signature)]
    #[must_use]
    pub fn signature_algorithm(&self) -> &X509AlgorithmRef {
        unsafe {
            let mut algor = ptr::null();
            X509_get0_signature(ptr::null_mut(), &mut algor, self.as_ptr());
            assert!(!algor.is_null());
            X509AlgorithmRef::from_ptr(algor.cast_mut())
        }
    }

    /// Returns the list of OCSP responder URLs specified in the certificate's Authority Information
    /// Access field.
    #[corresponds(X509_get1_ocsp)]
    pub fn ocsp_responders(&self) -> Result<Stack<OpensslString>, ErrorStack> {
        unsafe { cvt_p(ffi::X509_get1_ocsp(self.as_ptr())).map(|p| Stack::from_ptr(p)) }
    }

    /// Checks that this certificate issued `subject`.
    #[corresponds(X509_check_issued)]
    pub fn issued(&self, subject: &X509Ref) -> X509VerifyResult {
        unsafe {
            let r = ffi::X509_check_issued(self.as_ptr(), subject.as_ptr());
            X509VerifyError::from_raw(r)
        }
    }

    /// Check if the certificate is signed using the given public key.
    ///
    /// Only the signature is checked: no other checks (such as certificate chain validity)
    /// are performed.
    ///
    /// Returns `true` if verification succeeds.
    #[corresponds(X509_verify)]
    pub fn verify<T>(&self, key: &PKeyRef<T>) -> Result<bool, ErrorStack>
    where
        T: HasPublic,
    {
        unsafe { cvt_n(ffi::X509_verify(self.as_ptr(), key.as_ptr())).map(|n| n != 0) }
    }

    /// Returns this certificate's serial number.
    #[corresponds(X509_get_serialNumber)]
    #[must_use]
    pub fn serial_number(&self) -> &Asn1IntegerRef {
        unsafe {
            let r = ffi::X509_get_serialNumber(self.as_ptr());
            assert!(!r.is_null());
            Asn1IntegerRef::from_ptr(r)
        }
    }

    pub fn check_host(&self, host: &str) -> Result<bool, ErrorStack> {
        unsafe {
            cvt_n(ffi::X509_check_host(
                self.as_ptr(),
                host.as_ptr().cast(),
                host.len(),
                0,
                std::ptr::null_mut(),
            ))
            .map(|n| n == 1)
        }
    }

    #[corresponds(X509_check_ip_asc)]
    pub fn check_ip_asc(&self, address: &str) -> Result<bool, ErrorStack> {
        let c_str = CString::new(address).map_err(ErrorStack::internal_error)?;

        unsafe { cvt_n(ffi::X509_check_ip_asc(self.as_ptr(), c_str.as_ptr(), 0)).map(|n| n == 1) }
    }

    to_pem! {
        /// Serializes the certificate into a PEM-encoded X509 structure.
        ///
        /// The output will have a header of `-----BEGIN CERTIFICATE-----`.
        #[corresponds(PEM_write_bio_X509)]
        to_pem,
        ffi::PEM_write_bio_X509
    }

    to_der! {
        /// Serializes the certificate into a DER-encoded X509 structure.
        #[corresponds(i2d_X509)]
        to_der,
        ffi::i2d_X509
    }
}

impl ToOwned for X509Ref {
    type Owned = X509;

    fn to_owned(&self) -> X509 {
        unsafe {
            X509_up_ref(self.as_ptr());
            X509::from_ptr(self.as_ptr())
        }
    }
}

impl X509 {
    /// Returns a new builder.
    pub fn builder() -> Result<X509Builder, ErrorStack> {
        X509Builder::new()
    }

    from_pem! {
        /// Deserializes a PEM-encoded X509 structure.
        ///
        /// The input should have a header of `-----BEGIN CERTIFICATE-----`.
        #[corresponds(PEM_read_bio_X509)]
        from_pem,
        X509,
        ffi::PEM_read_bio_X509
    }

    from_der! {
        /// Deserializes a DER-encoded X509 structure.
        #[corresponds(d2i_X509)]
        from_der,
        X509,
        ffi::d2i_X509,
        ::libc::c_long
    }

    /// Deserializes a list of PEM-formatted certificates.
    #[corresponds(PEM_read_bio_X509)]
    pub fn stack_from_pem(pem: &[u8]) -> Result<Vec<X509>, ErrorStack> {
        unsafe {
            ffi::init();
            let bio = MemBioSlice::new(pem)?;

            let mut certs = vec![];
            loop {
                let r =
                    ffi::PEM_read_bio_X509(bio.as_ptr(), ptr::null_mut(), None, ptr::null_mut());
                if r.is_null() {
                    let err = ffi::ERR_peek_last_error();

                    if ffi::ERR_GET_LIB(err) == ffi::ERR_LIB_PEM.0.try_into().unwrap()
                        && ffi::ERR_GET_REASON(err) == ffi::PEM_R_NO_START_LINE
                    {
                        ErrorStack::clear();
                        break;
                    }

                    return Err(ErrorStack::get());
                } else {
                    certs.push(X509::from_ptr(r));
                }
            }

            Ok(certs)
        }
    }
}

impl Clone for X509 {
    fn clone(&self) -> X509 {
        X509Ref::to_owned(self)
    }
}

impl fmt::Debug for X509 {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        let serial = match &self.serial_number().to_bn() {
            Ok(bn) => match bn.to_hex_str() {
                Ok(hex) => hex.to_string(),
                Err(_) => "".to_string(),
            },
            Err(_) => "".to_string(),
        };
        let mut debug_struct = formatter.debug_struct("X509");
        debug_struct.field("serial_number", &serial);
        debug_struct.field("signature_algorithm", &self.signature_algorithm().object());
        debug_struct.field("issuer", &self.issuer_name());
        debug_struct.field("subject", &self.subject_name());
        if let Some(subject_alt_names) = &self.subject_alt_names() {
            debug_struct.field("subject_alt_names", subject_alt_names);
        }
        debug_struct.field("not_before", &self.not_before());
        debug_struct.field("not_after", &self.not_after());

        if let Ok(public_key) = &self.public_key() {
            debug_struct.field("public_key", public_key);
        }
        // TODO: Print extensions once they are supported on the X509 struct.

        debug_struct.finish()
    }
}

impl AsRef<X509Ref> for X509Ref {
    fn as_ref(&self) -> &X509Ref {
        self
    }
}

impl Stackable for X509 {
    type StackType = ffi::stack_st_X509;
}

/// A context object required to construct certain `X509` extension values.
pub struct X509v3Context<'a>(ffi::X509V3_CTX, PhantomData<(&'a X509Ref, &'a ConfRef)>);

impl X509v3Context<'_> {
    #[must_use]
    pub fn as_ptr(&self) -> *mut ffi::X509V3_CTX {
        std::ptr::addr_of!(self.0).cast_mut()
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_EXTENSION;
    fn drop = ffi::X509_EXTENSION_free;

    /// Permit additional fields to be added to an `X509` v3 certificate.
    pub struct X509Extension;
}

impl Stackable for X509Extension {
    type StackType = ffi::stack_st_X509_EXTENSION;
}

impl X509Extension {
    /// Constructs an X509 extension value. See `man x509v3_config` for information on supported
    /// names and their value formats.
    ///
    /// Some extension types, such as `subjectAlternativeName`, require an `X509v3Context` to be
    /// provided.
    ///
    /// DO NOT CALL THIS WITH UNTRUSTED `value`: `value` is an OpenSSL
    /// mini-language that can read arbitrary files.
    ///
    /// See the extension module for builder types which will construct certain common extensions.
    pub fn new(
        conf: Option<&ConfRef>,
        context: Option<&X509v3Context>,
        name: &str,
        value: &str,
    ) -> Result<X509Extension, ErrorStack> {
        let name = CString::new(name).map_err(ErrorStack::internal_error)?;
        let value = CString::new(value).map_err(ErrorStack::internal_error)?;
        let mut ctx;
        unsafe {
            ffi::init();
            let conf = conf.map_or(ptr::null_mut(), ConfRef::as_ptr);
            let context_ptr = match context {
                Some(c) => c.as_ptr(),
                None => {
                    ctx = mem::zeroed();

                    ffi::X509V3_set_ctx(
                        &mut ctx,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        0,
                    );
                    &mut ctx
                }
            };
            let name = name.as_ptr().cast_mut();
            let value = value.as_ptr().cast_mut();

            cvt_p(ffi::X509V3_EXT_nconf(conf, context_ptr, name, value))
                .map(|p| X509Extension::from_ptr(p))
        }
    }

    /// Constructs an X509 extension value. See `man x509v3_config` for information on supported
    /// extensions and their value formats.
    ///
    /// Some extension types, such as `nid::SUBJECT_ALTERNATIVE_NAME`, require an `X509v3Context` to
    /// be provided.
    ///
    /// DO NOT CALL THIS WITH UNTRUSTED `value`: `value` is an OpenSSL
    /// mini-language that can read arbitrary files.
    ///
    /// See the extension module for builder types which will construct certain common extensions.
    pub fn new_nid(
        conf: Option<&ConfRef>,
        context: Option<&X509v3Context>,
        name: Nid,
        value: &str,
    ) -> Result<X509Extension, ErrorStack> {
        let value = CString::new(value).map_err(ErrorStack::internal_error)?;
        let mut ctx;
        unsafe {
            ffi::init();
            let conf = conf.map_or(ptr::null_mut(), ConfRef::as_ptr);
            let context_ptr = match context {
                Some(c) => c.as_ptr(),
                None => {
                    ctx = mem::zeroed();

                    ffi::X509V3_set_ctx(
                        &mut ctx,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        ptr::null_mut(),
                        0,
                    );
                    &mut ctx
                }
            };
            let name = name.as_raw();
            let value = value.as_ptr().cast_mut();

            cvt_p(ffi::X509V3_EXT_nconf_nid(conf, context_ptr, name, value))
                .map(|p| X509Extension::from_ptr(p))
        }
    }

    pub(crate) unsafe fn new_internal(
        nid: Nid,
        critical: bool,
        value: *mut c_void,
    ) -> Result<X509Extension, ErrorStack> {
        ffi::init();
        unsafe {
            cvt_p(ffi::X509V3_EXT_i2d(nid.as_raw(), critical as _, value))
                .map(|p| X509Extension::from_ptr(p))
        }
    }
}

impl X509ExtensionRef {
    to_der! {
        /// Serializes the Extension to its standard DER encoding.
        to_der,
        ffi::i2d_X509_EXTENSION
    }
}

/// A builder used to construct an `X509Name`.
pub struct X509NameBuilder(X509Name);

impl X509NameBuilder {
    /// Creates a new builder.
    pub fn new() -> Result<X509NameBuilder, ErrorStack> {
        unsafe {
            ffi::init();
            cvt_p(ffi::X509_NAME_new()).map(|p| X509NameBuilder(X509Name::from_ptr(p)))
        }
    }

    /// Add a field entry by str.
    #[corresponds(X509_NAME_add_entry_by_txt)]
    pub fn append_entry_by_text(&mut self, field: &str, value: &str) -> Result<(), ErrorStack> {
        unsafe {
            let field = CString::new(field).map_err(ErrorStack::internal_error)?;
            cvt(ffi::X509_NAME_add_entry_by_txt(
                self.0.as_ptr(),
                field.as_ptr().cast_mut(),
                ffi::MBSTRING_UTF8,
                value.as_ptr(),
                try_int(value.len())?,
                -1,
                0,
            ))
        }
    }

    /// Add a field entry by str with a specific type.
    #[corresponds(X509_NAME_add_entry_by_txt)]
    pub fn append_entry_by_text_with_type(
        &mut self,
        field: &str,
        value: &str,
        ty: Asn1Type,
    ) -> Result<(), ErrorStack> {
        unsafe {
            let field = CString::new(field).map_err(ErrorStack::internal_error)?;
            cvt(ffi::X509_NAME_add_entry_by_txt(
                self.0.as_ptr(),
                field.as_ptr().cast_mut(),
                ty.as_raw(),
                value.as_ptr(),
                try_int(value.len())?,
                -1,
                0,
            ))
        }
    }

    /// Add a field entry by NID.
    #[corresponds(X509_NAME_add_entry_by_NID)]
    pub fn append_entry_by_nid(&mut self, field: Nid, value: &str) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_NAME_add_entry_by_NID(
                self.0.as_ptr(),
                field.as_raw(),
                ffi::MBSTRING_UTF8,
                value.as_ptr().cast_mut(),
                try_int(value.len())?,
                -1,
                0,
            ))
        }
    }

    /// Add a field entry by NID with a specific type.
    #[corresponds(X509_NAME_add_entry_by_NID)]
    pub fn append_entry_by_nid_with_type(
        &mut self,
        field: Nid,
        value: &str,
        ty: Asn1Type,
    ) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_NAME_add_entry_by_NID(
                self.0.as_ptr(),
                field.as_raw(),
                ty.as_raw(),
                value.as_ptr().cast_mut(),
                try_int(value.len())?,
                -1,
                0,
            ))
        }
    }

    /// Return an `X509Name`.
    #[must_use]
    pub fn build(self) -> X509Name {
        // Round-trip through bytes because OpenSSL is not const correct and
        // names in a "modified" state compute various things lazily. This can
        // lead to data-races because OpenSSL doesn't have locks or anything.
        X509Name::from_der(&self.0.to_der().unwrap()).unwrap()
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_NAME;
    fn drop = ffi::X509_NAME_free;

    /// The names of an `X509` certificate.
    pub struct X509Name;
}

impl X509Name {
    /// Returns a new builder.
    pub fn builder() -> Result<X509NameBuilder, ErrorStack> {
        X509NameBuilder::new()
    }

    /// Loads subject names from a file containing PEM-formatted certificates.
    ///
    /// This is commonly used in conjunction with `SslContextBuilder::set_client_ca_list`.
    pub fn load_client_ca_file<P: AsRef<Path>>(file: P) -> Result<Stack<X509Name>, ErrorStack> {
        let file = CString::new(file.as_ref().as_os_str().as_encoded_bytes())
            .map_err(ErrorStack::internal_error)?;
        unsafe { cvt_p(ffi::SSL_load_client_CA_file(file.as_ptr())).map(|p| Stack::from_ptr(p)) }
    }

    from_der! {
        /// Deserializes a DER-encoded X509 name structure.
        #[corresponds(d2i_X509_NAME)]
        from_der,
        X509Name,
        ffi::d2i_X509_NAME,
        ::libc::c_long
    }
}

impl Stackable for X509Name {
    type StackType = ffi::stack_st_X509_NAME;
}

impl X509NameRef {
    /// Returns the name entries by the nid.
    #[must_use]
    pub fn entries_by_nid(&self, nid: Nid) -> X509NameEntries<'_> {
        X509NameEntries {
            name: self,
            nid: Some(nid),
            loc: -1,
        }
    }

    /// Returns an iterator over all `X509NameEntry` values
    #[must_use]
    pub fn entries(&self) -> X509NameEntries<'_> {
        X509NameEntries {
            name: self,
            nid: None,
            loc: -1,
        }
    }

    /// Returns an owned String representing the X509 name configurable via incoming flags.
    ///
    /// This function will return `None` if the underlying string contains invalid utf-8.
    #[corresponds(X509_NAME_print_ex)]
    #[must_use]
    pub fn print_ex(&self, flags: i32) -> Option<String> {
        unsafe {
            let bio = MemBio::new().ok()?;
            ffi::X509_NAME_print_ex(bio.as_ptr(), self.as_ptr(), 0, flags as _);
            let buf = bio.get_buf().to_vec();
            let res = String::from_utf8(buf);
            res.ok()
        }
    }

    to_der! {
        /// Serializes the certificate into a DER-encoded X509 name structure.
        #[corresponds(i2d_X509_NAME)]
        to_der,
        ffi::i2d_X509_NAME
    }
}

impl fmt::Debug for X509NameRef {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_list().entries(self.entries()).finish()
    }
}

/// A type to destructure and examine an `X509Name`.
pub struct X509NameEntries<'a> {
    name: &'a X509NameRef,
    nid: Option<Nid>,
    loc: c_int,
}

impl<'a> Iterator for X509NameEntries<'a> {
    type Item = &'a X509NameEntryRef;

    fn next(&mut self) -> Option<&'a X509NameEntryRef> {
        unsafe {
            match self.nid {
                Some(nid) => {
                    // There is a `Nid` specified to search for
                    self.loc =
                        ffi::X509_NAME_get_index_by_NID(self.name.as_ptr(), nid.as_raw(), self.loc);
                    if self.loc == -1 {
                        return None;
                    }
                }
                None => {
                    // Iterate over all `Nid`s
                    self.loc += 1;
                    if self.loc >= ffi::X509_NAME_entry_count(self.name.as_ptr()) {
                        return None;
                    }
                }
            }

            let entry = ffi::X509_NAME_get_entry(self.name.as_ptr(), self.loc);
            assert!(!entry.is_null());

            Some(X509NameEntryRef::from_ptr(entry))
        }
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_NAME_ENTRY;
    fn drop = ffi::X509_NAME_ENTRY_free;

    /// A name entry associated with a `X509Name`.
    pub struct X509NameEntry;
}

impl X509NameEntryRef {
    /// Returns the field value of an `X509NameEntry`.
    #[corresponds(X509_NAME_ENTRY_get_data)]
    #[must_use]
    pub fn data(&self) -> &Asn1StringRef {
        unsafe {
            let data = ffi::X509_NAME_ENTRY_get_data(self.as_ptr());
            Asn1StringRef::from_ptr(data)
        }
    }

    /// Returns the `Asn1Object` value of an `X509NameEntry`.
    /// This is useful for finding out about the actual `Nid` when iterating over all `X509NameEntries`.
    #[corresponds(X509_NAME_ENTRY_get_object)]
    #[must_use]
    pub fn object(&self) -> &Asn1ObjectRef {
        unsafe {
            let object = ffi::X509_NAME_ENTRY_get_object(self.as_ptr());
            Asn1ObjectRef::from_ptr(object)
        }
    }
}

impl fmt::Debug for X509NameEntryRef {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_fmt(format_args!("{:?} = {:?}", self.object(), self.data()))
    }
}

/// A builder used to construct an `X509Req`.
pub struct X509ReqBuilder(X509Req);

impl X509ReqBuilder {
    /// Returns a builder for a certificate request.
    #[corresponds(X509_REQ_new)]
    pub fn new() -> Result<X509ReqBuilder, ErrorStack> {
        unsafe {
            ffi::init();
            cvt_p(ffi::X509_REQ_new()).map(|p| X509ReqBuilder(X509Req::from_ptr(p)))
        }
    }

    /// Set the numerical value of the version field.
    #[corresponds(X509_REQ_set_version)]
    pub fn set_version(&mut self, version: i32) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::X509_REQ_set_version(self.0.as_ptr(), version.into())) }
    }

    /// Set the issuer name.
    #[corresponds(X509_REQ_set_subject_name)]
    pub fn set_subject_name(&mut self, subject_name: &X509NameRef) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_REQ_set_subject_name(
                self.0.as_ptr(),
                subject_name.as_ptr(),
            ))
        }
    }

    /// Set the public key.
    #[corresponds(X509_REQ_set_pubkey)]
    pub fn set_pubkey<T>(&mut self, key: &PKeyRef<T>) -> Result<(), ErrorStack>
    where
        T: HasPublic,
    {
        unsafe { cvt(ffi::X509_REQ_set_pubkey(self.0.as_ptr(), key.as_ptr())) }
    }

    /// Return an `X509v3Context`. This context object can be used to construct
    /// certain `X509` extensions.
    #[must_use]
    pub fn x509v3_context<'a>(&'a self, conf: Option<&'a ConfRef>) -> X509v3Context<'a> {
        unsafe {
            let mut ctx = mem::zeroed();

            ffi::X509V3_set_ctx(
                &mut ctx,
                ptr::null_mut(),
                ptr::null_mut(),
                self.0.as_ptr(),
                ptr::null_mut(),
                0,
            );

            // nodb case taken care of since we zeroed ctx above
            if let Some(conf) = conf {
                ffi::X509V3_set_nconf(&mut ctx, conf.as_ptr());
            }

            X509v3Context(ctx, PhantomData)
        }
    }

    /// Permits any number of extension fields to be added to the certificate.
    pub fn add_extensions(
        &mut self,
        extensions: &StackRef<X509Extension>,
    ) -> Result<(), ErrorStack> {
        unsafe {
            cvt(ffi::X509_REQ_add_extensions(
                self.0.as_ptr(),
                extensions.as_ptr(),
            ))
        }
    }

    /// Sign the request using a private key.
    #[corresponds(X509_REQ_sign)]
    pub fn sign<T>(&mut self, key: &PKeyRef<T>, hash: MessageDigest) -> Result<(), ErrorStack>
    where
        T: HasPrivate,
    {
        unsafe {
            cvt(ffi::X509_REQ_sign(
                self.0.as_ptr(),
                key.as_ptr(),
                hash.as_ptr(),
            ))
        }
    }

    /// Returns the `X509Req`.
    #[must_use]
    pub fn build(self) -> X509Req {
        self.0
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_REQ;
    fn drop = ffi::X509_REQ_free;

    /// An `X509` certificate request.
    pub struct X509Req;
}

impl X509Req {
    /// A builder for `X509Req`.
    pub fn builder() -> Result<X509ReqBuilder, ErrorStack> {
        X509ReqBuilder::new()
    }

    from_pem! {
        /// Deserializes a PEM-encoded PKCS#10 certificate request structure.
        ///
        /// The input should have a header of `-----BEGIN CERTIFICATE REQUEST-----`.
        #[corresponds(PEM_read_bio_X509_REQ)]
        from_pem,
        X509Req,
        ffi::PEM_read_bio_X509_REQ
    }

    from_der! {
        /// Deserializes a DER-encoded PKCS#10 certificate request structure.
        #[corresponds(d2i_X509_REQ)]
        from_der,
        X509Req,
        ffi::d2i_X509_REQ,
        ::libc::c_long
    }
}

impl X509ReqRef {
    to_pem! {
        /// Serializes the certificate request to a PEM-encoded PKCS#10 structure.
        ///
        /// The output will have a header of `-----BEGIN CERTIFICATE REQUEST-----`.
        #[corresponds(PEM_write_bio_X509_REQ)]
        to_pem,
        ffi::PEM_write_bio_X509_REQ
    }

    to_der! {
        /// Serializes the certificate request to a DER-encoded PKCS#10 structure.
        #[corresponds(i2d_X509_REQ)]
        to_der,
        ffi::i2d_X509_REQ
    }

    /// Returns the numerical value of the version field of the certificate request.
    #[corresponds(X509_REQ_get_version)]
    #[must_use]
    pub fn version(&self) -> i32 {
        unsafe { X509_REQ_get_version(self.as_ptr()) as i32 }
    }

    /// Returns the subject name of the certificate request.
    #[corresponds(X509_REQ_get_subject_name)]
    #[must_use]
    pub fn subject_name(&self) -> &X509NameRef {
        unsafe {
            let name = X509_REQ_get_subject_name(self.as_ptr());
            assert!(!name.is_null());
            X509NameRef::from_ptr(name)
        }
    }

    /// Returns the public key of the certificate request.
    #[corresponds(X509_REQ_get_pubkey)]
    pub fn public_key(&self) -> Result<PKey<Public>, ErrorStack> {
        unsafe {
            let key = cvt_p(ffi::X509_REQ_get_pubkey(self.as_ptr()))?;
            Ok(PKey::from_ptr(key))
        }
    }

    /// Check if the certificate request is signed using the given public key.
    ///
    /// Returns `true` if verification succeeds.
    #[corresponds(X509_REQ_verify)]
    pub fn verify<T>(&self, key: &PKeyRef<T>) -> Result<bool, ErrorStack>
    where
        T: HasPublic,
    {
        unsafe { cvt_n(ffi::X509_REQ_verify(self.as_ptr(), key.as_ptr())).map(|n| n != 0) }
    }

    /// Returns the extensions of the certificate request.
    #[corresponds(X509_REQ_get_extensions)]
    pub fn extensions(&self) -> Result<Stack<X509Extension>, ErrorStack> {
        unsafe {
            let extensions = cvt_p(ffi::X509_REQ_get_extensions(self.as_ptr()))?;
            Ok(Stack::from_ptr(extensions))
        }
    }
}

/// The result of peer certificate verification.
pub type X509VerifyResult = Result<(), X509VerifyError>;

#[derive(Copy, Clone, PartialEq, Eq)]
pub struct X509VerifyError(c_int);

impl fmt::Debug for X509VerifyError {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        fmt.debug_struct("X509VerifyError")
            .field("code", &self.0)
            .field("error", &self.error_string())
            .finish()
    }
}

impl fmt::Display for X509VerifyError {
    fn fmt(&self, fmt: &mut fmt::Formatter) -> fmt::Result {
        fmt.write_str(self.error_string())
    }
}

impl Error for X509VerifyError {}

impl X509VerifyError {
    /// Creates an [`X509VerifyResult`] from a raw error number.
    ///
    /// # Safety
    ///
    /// Some methods on [`X509VerifyError`] are not thread safe if the error
    /// number is invalid.
    pub unsafe fn from_raw(err: c_int) -> X509VerifyResult {
        if err == ffi::X509_V_OK {
            Ok(())
        } else {
            Err(X509VerifyError(err))
        }
    }

    /// Return the integer representation of an [`X509VerifyError`].
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn as_raw(&self) -> c_int {
        self.0
    }

    /// Return a human readable error string from the verification error.
    ///
    /// Returns empty string if the message was not UTF-8.
    #[corresponds(X509_verify_cert_error_string)]
    #[allow(clippy::trivially_copy_pass_by_ref)]
    #[must_use]
    pub fn error_string(&self) -> &'static str {
        ffi::init();

        unsafe {
            let s = ffi::X509_verify_cert_error_string(c_long::from(self.0));
            CStr::from_ptr(s).to_str().unwrap_or_default()
        }
    }
}

#[allow(missing_docs)] // no need to document the constants
impl X509VerifyError {
    pub const UNSPECIFIED: Self = Self(ffi::X509_V_ERR_UNSPECIFIED);
    pub const UNABLE_TO_GET_ISSUER_CERT: Self = Self(ffi::X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT);
    pub const UNABLE_TO_GET_CRL: Self = Self(ffi::X509_V_ERR_UNABLE_TO_GET_CRL);
    pub const UNABLE_TO_DECRYPT_CERT_SIGNATURE: Self =
        Self(ffi::X509_V_ERR_UNABLE_TO_DECRYPT_CERT_SIGNATURE);
    pub const UNABLE_TO_DECRYPT_CRL_SIGNATURE: Self =
        Self(ffi::X509_V_ERR_UNABLE_TO_DECRYPT_CRL_SIGNATURE);
    pub const UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: Self =
        Self(ffi::X509_V_ERR_UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY);
    pub const CERT_SIGNATURE_FAILURE: Self = Self(ffi::X509_V_ERR_CERT_SIGNATURE_FAILURE);
    pub const CRL_SIGNATURE_FAILURE: Self = Self(ffi::X509_V_ERR_CRL_SIGNATURE_FAILURE);
    pub const CERT_NOT_YET_VALID: Self = Self(ffi::X509_V_ERR_CERT_NOT_YET_VALID);
    pub const CERT_HAS_EXPIRED: Self = Self(ffi::X509_V_ERR_CERT_HAS_EXPIRED);
    pub const CRL_NOT_YET_VALID: Self = Self(ffi::X509_V_ERR_CRL_NOT_YET_VALID);
    pub const CRL_HAS_EXPIRED: Self = Self(ffi::X509_V_ERR_CRL_HAS_EXPIRED);
    pub const ERROR_IN_CERT_NOT_BEFORE_FIELD: Self =
        Self(ffi::X509_V_ERR_ERROR_IN_CERT_NOT_BEFORE_FIELD);
    pub const ERROR_IN_CERT_NOT_AFTER_FIELD: Self =
        Self(ffi::X509_V_ERR_ERROR_IN_CERT_NOT_AFTER_FIELD);
    pub const ERROR_IN_CRL_LAST_UPDATE_FIELD: Self =
        Self(ffi::X509_V_ERR_ERROR_IN_CRL_LAST_UPDATE_FIELD);
    pub const ERROR_IN_CRL_NEXT_UPDATE_FIELD: Self =
        Self(ffi::X509_V_ERR_ERROR_IN_CRL_NEXT_UPDATE_FIELD);
    pub const OUT_OF_MEM: Self = Self(ffi::X509_V_ERR_OUT_OF_MEM);
    pub const DEPTH_ZERO_SELF_SIGNED_CERT: Self = Self(ffi::X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT);
    pub const SELF_SIGNED_CERT_IN_CHAIN: Self = Self(ffi::X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN);
    pub const UNABLE_TO_GET_ISSUER_CERT_LOCALLY: Self =
        Self(ffi::X509_V_ERR_UNABLE_TO_GET_ISSUER_CERT_LOCALLY);
    pub const UNABLE_TO_VERIFY_LEAF_SIGNATURE: Self =
        Self(ffi::X509_V_ERR_UNABLE_TO_VERIFY_LEAF_SIGNATURE);
    pub const CERT_CHAIN_TOO_LONG: Self = Self(ffi::X509_V_ERR_CERT_CHAIN_TOO_LONG);
    pub const CERT_REVOKED: Self = Self(ffi::X509_V_ERR_CERT_REVOKED);
    pub const INVALID_CA: Self = Self(ffi::X509_V_ERR_INVALID_CA);
    pub const PATH_LENGTH_EXCEEDED: Self = Self(ffi::X509_V_ERR_PATH_LENGTH_EXCEEDED);
    pub const INVALID_PURPOSE: Self = Self(ffi::X509_V_ERR_INVALID_PURPOSE);
    pub const CERT_UNTRUSTED: Self = Self(ffi::X509_V_ERR_CERT_UNTRUSTED);
    pub const CERT_REJECTED: Self = Self(ffi::X509_V_ERR_CERT_REJECTED);
    pub const SUBJECT_ISSUER_MISMATCH: Self = Self(ffi::X509_V_ERR_SUBJECT_ISSUER_MISMATCH);
    pub const AKID_SKID_MISMATCH: Self = Self(ffi::X509_V_ERR_AKID_SKID_MISMATCH);
    pub const AKID_ISSUER_SERIAL_MISMATCH: Self = Self(ffi::X509_V_ERR_AKID_ISSUER_SERIAL_MISMATCH);
    pub const KEYUSAGE_NO_CERTSIGN: Self = Self(ffi::X509_V_ERR_KEYUSAGE_NO_CERTSIGN);
    pub const UNABLE_TO_GET_CRL_ISSUER: Self = Self(ffi::X509_V_ERR_UNABLE_TO_GET_CRL_ISSUER);
    pub const UNHANDLED_CRITICAL_EXTENSION: Self =
        Self(ffi::X509_V_ERR_UNHANDLED_CRITICAL_EXTENSION);
    pub const KEYUSAGE_NO_CRL_SIGN: Self = Self(ffi::X509_V_ERR_KEYUSAGE_NO_CRL_SIGN);
    pub const UNHANDLED_CRITICAL_CRL_EXTENSION: Self =
        Self(ffi::X509_V_ERR_UNHANDLED_CRITICAL_CRL_EXTENSION);
    pub const INVALID_NON_CA: Self = Self(ffi::X509_V_ERR_INVALID_NON_CA);
    pub const PROXY_PATH_LENGTH_EXCEEDED: Self = Self(ffi::X509_V_ERR_PROXY_PATH_LENGTH_EXCEEDED);
    pub const KEYUSAGE_NO_DIGITAL_SIGNATURE: Self =
        Self(ffi::X509_V_ERR_KEYUSAGE_NO_DIGITAL_SIGNATURE);
    pub const PROXY_CERTIFICATES_NOT_ALLOWED: Self =
        Self(ffi::X509_V_ERR_PROXY_CERTIFICATES_NOT_ALLOWED);
    pub const INVALID_EXTENSION: Self = Self(ffi::X509_V_ERR_INVALID_EXTENSION);
    pub const INVALID_POLICY_EXTENSION: Self = Self(ffi::X509_V_ERR_INVALID_POLICY_EXTENSION);
    pub const NO_EXPLICIT_POLICY: Self = Self(ffi::X509_V_ERR_NO_EXPLICIT_POLICY);
    pub const DIFFERENT_CRL_SCOPE: Self = Self(ffi::X509_V_ERR_DIFFERENT_CRL_SCOPE);
    pub const UNSUPPORTED_EXTENSION_FEATURE: Self =
        Self(ffi::X509_V_ERR_UNSUPPORTED_EXTENSION_FEATURE);
    pub const UNNESTED_RESOURCE: Self = Self(ffi::X509_V_ERR_UNNESTED_RESOURCE);
    pub const PERMITTED_VIOLATION: Self = Self(ffi::X509_V_ERR_PERMITTED_VIOLATION);
    pub const EXCLUDED_VIOLATION: Self = Self(ffi::X509_V_ERR_EXCLUDED_VIOLATION);
    pub const SUBTREE_MINMAX: Self = Self(ffi::X509_V_ERR_SUBTREE_MINMAX);
    pub const APPLICATION_VERIFICATION: Self = Self(ffi::X509_V_ERR_APPLICATION_VERIFICATION);
    pub const UNSUPPORTED_CONSTRAINT_TYPE: Self = Self(ffi::X509_V_ERR_UNSUPPORTED_CONSTRAINT_TYPE);
    pub const UNSUPPORTED_CONSTRAINT_SYNTAX: Self =
        Self(ffi::X509_V_ERR_UNSUPPORTED_CONSTRAINT_SYNTAX);
    pub const UNSUPPORTED_NAME_SYNTAX: Self = Self(ffi::X509_V_ERR_UNSUPPORTED_NAME_SYNTAX);
    pub const CRL_PATH_VALIDATION_ERROR: Self = Self(ffi::X509_V_ERR_CRL_PATH_VALIDATION_ERROR);
    pub const HOSTNAME_MISMATCH: Self = Self(ffi::X509_V_ERR_HOSTNAME_MISMATCH);
    pub const EMAIL_MISMATCH: Self = Self(ffi::X509_V_ERR_EMAIL_MISMATCH);
    pub const IP_ADDRESS_MISMATCH: Self = Self(ffi::X509_V_ERR_IP_ADDRESS_MISMATCH);
    pub const INVALID_CALL: Self = Self(ffi::X509_V_ERR_INVALID_CALL);
    pub const STORE_LOOKUP: Self = Self(ffi::X509_V_ERR_STORE_LOOKUP);
    pub const NAME_CONSTRAINTS_WITHOUT_SANS: Self =
        Self(ffi::X509_V_ERR_NAME_CONSTRAINTS_WITHOUT_SANS);
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::GENERAL_NAME;
    fn drop = ffi::GENERAL_NAME_free;

    /// An `X509` certificate alternative names.
    pub struct GeneralName;
}

impl GeneralName {
    unsafe fn new(
        type_: c_int,
        asn1_type: Asn1Type,
        value: &[u8],
    ) -> Result<GeneralName, ErrorStack> {
        ffi::init();
        unsafe {
            let gn = GeneralName::from_ptr(cvt_p(ffi::GENERAL_NAME_new())?);
            (*gn.as_ptr()).type_ = type_;
            let s = cvt_p(ffi::ASN1_STRING_type_new(asn1_type.as_raw()))?;
            ffi::ASN1_STRING_set(s, value.as_ptr().cast(), value.len().try_into().unwrap());

            (*gn.as_ptr()).d.ptr = s.cast();

            Ok(gn)
        }
    }

    pub(crate) fn new_email(email: &[u8]) -> Result<GeneralName, ErrorStack> {
        unsafe { GeneralName::new(ffi::GEN_EMAIL, Asn1Type::IA5STRING, email) }
    }

    pub(crate) fn new_dns(dns: &[u8]) -> Result<GeneralName, ErrorStack> {
        unsafe { GeneralName::new(ffi::GEN_DNS, Asn1Type::IA5STRING, dns) }
    }

    pub(crate) fn new_uri(uri: &[u8]) -> Result<GeneralName, ErrorStack> {
        unsafe { GeneralName::new(ffi::GEN_URI, Asn1Type::IA5STRING, uri) }
    }

    pub(crate) fn new_ip(ip: IpAddr) -> Result<GeneralName, ErrorStack> {
        match ip {
            IpAddr::V4(addr) => unsafe {
                GeneralName::new(ffi::GEN_IPADD, Asn1Type::OCTET_STRING, &addr.octets())
            },
            IpAddr::V6(addr) => unsafe {
                GeneralName::new(ffi::GEN_IPADD, Asn1Type::OCTET_STRING, &addr.octets())
            },
        }
    }

    pub(crate) fn new_rid(oid: Asn1Object) -> Result<GeneralName, ErrorStack> {
        unsafe {
            ffi::init();
            let gn = cvt_p(ffi::GENERAL_NAME_new())?;
            (*gn).type_ = ffi::GEN_RID;
            (*gn).d.registeredID = oid.into_ptr();

            Ok(GeneralName::from_ptr(gn))
        }
    }
}

impl GeneralNameRef {
    fn ia5_string(&self, ffi_type: c_int) -> Option<&str> {
        unsafe {
            if (*self.as_ptr()).type_ != ffi_type {
                return None;
            }

            let asn = Asn1BitStringRef::from_ptr((*self.as_ptr()).d.ia5);

            // IA5Strings are stated to be ASCII (specifically IA5). Hopefully
            // OpenSSL checks that when loading a certificate but if not we'll
            // use this instead of from_utf8_unchecked just in case.
            asn.to_str()
        }
    }

    /// Returns the contents of this `GeneralName` if it is an `rfc822Name`.
    #[must_use]
    pub fn email(&self) -> Option<&str> {
        self.ia5_string(ffi::GEN_EMAIL)
    }

    /// Returns the contents of this `GeneralName` if it is a `dNSName`.
    #[must_use]
    pub fn dnsname(&self) -> Option<&str> {
        self.ia5_string(ffi::GEN_DNS)
    }

    /// Returns the contents of this `GeneralName` if it is an `uniformResourceIdentifier`.
    #[must_use]
    pub fn uri(&self) -> Option<&str> {
        self.ia5_string(ffi::GEN_URI)
    }

    /// Returns the contents of this `GeneralName` if it is an `iPAddress`.
    #[must_use]
    pub fn ipaddress(&self) -> Option<&[u8]> {
        unsafe {
            if (*self.as_ptr()).type_ != ffi::GEN_IPADD {
                return None;
            }

            Some(Asn1BitStringRef::from_ptr((*self.as_ptr()).d.ip).as_slice())
        }
    }
}

impl fmt::Debug for GeneralNameRef {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        if let Some(email) = self.email() {
            formatter.write_str(email)
        } else if let Some(dnsname) = self.dnsname() {
            formatter.write_str(dnsname)
        } else if let Some(uri) = self.uri() {
            formatter.write_str(uri)
        } else if let Some(ipaddress) = self.ipaddress() {
            let result = String::from_utf8_lossy(ipaddress);
            formatter.write_str(&result)
        } else {
            formatter.write_str("(empty)")
        }
    }
}

impl Stackable for GeneralName {
    type StackType = ffi::stack_st_GENERAL_NAME;
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_ALGOR;
    fn drop = ffi::X509_ALGOR_free;

    /// An `X509` certificate signature algorithm.
    pub struct X509Algorithm;
}

impl X509AlgorithmRef {
    /// Returns the ASN.1 OID of this algorithm.
    #[must_use]
    pub fn object(&self) -> &Asn1ObjectRef {
        unsafe {
            let mut oid = ptr::null();
            X509_ALGOR_get0(&mut oid, ptr::null_mut(), ptr::null_mut(), self.as_ptr());
            assert!(!oid.is_null());
            Asn1ObjectRef::from_ptr(oid.cast_mut())
        }
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::X509_OBJECT;
    fn drop = X509_OBJECT_free;

    /// An `X509` or an X509 certificate revocation list.
    pub struct X509Object;
}

impl X509ObjectRef {
    #[must_use]
    pub fn x509(&self) -> Option<&X509Ref> {
        unsafe {
            let ptr = X509_OBJECT_get0_X509(self.as_ptr());
            if ptr.is_null() {
                None
            } else {
                Some(X509Ref::from_ptr(ptr))
            }
        }
    }
}

impl Stackable for X509Object {
    type StackType = ffi::stack_st_X509_OBJECT;
}

use crate::ffi::{X509_get0_signature, X509_getm_notAfter, X509_getm_notBefore, X509_up_ref};

use crate::ffi::{
    X509_ALGOR_get0, X509_REQ_get_subject_name, X509_REQ_get_version, X509_STORE_CTX_get0_chain,
    X509_set1_notAfter, X509_set1_notBefore,
};

use crate::ffi::X509_OBJECT_get0_X509;

#[allow(bad_style)]
unsafe fn X509_OBJECT_free(x: *mut ffi::X509_OBJECT) {
    unsafe {
        ffi::X509_OBJECT_free_contents(x);
        ffi::OPENSSL_free(x.cast());
    }
}

unsafe fn get_new_x509_store_ctx_idx(f: ffi::CRYPTO_EX_free) -> c_int {
    unsafe { ffi::X509_STORE_CTX_get_ex_new_index(0, ptr::null_mut(), ptr::null_mut(), None, f) }
}
