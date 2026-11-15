//! TLS Trust and Identity management.
//!
//! Handles server certificate verification, mTLS identity, and CA
//! bundle management. Provides DER/PEM parsing for BoringSSL and
//! supports both system and custom trust stores.

mod identity;
mod parse;
mod store;

use btls::x509::X509;

pub use self::{
    identity::Identity,
    store::{CertStore, CertStoreBuilder},
};
use crate::Error;

/// A certificate input.
pub enum CertificateInput<'c> {
    /// Raw DER or PEM data.
    Raw(&'c [u8]),
    /// An already parsed certificate.
    Parsed(Certificate),
}

impl<'a> CertificateInput<'a> {
    pub(crate) fn with_parser<F>(self, parser: F) -> crate::Result<Certificate>
    where
        F: Fn(&'a [u8]) -> crate::Result<Certificate>,
    {
        match self {
            CertificateInput::Raw(data) => parser(data),
            CertificateInput::Parsed(cert) => Ok(cert),
        }
    }
}

impl From<Certificate> for CertificateInput<'_> {
    fn from(cert: Certificate) -> Self {
        CertificateInput::Parsed(cert)
    }
}

impl<'c, T: AsRef<[u8]> + ?Sized + 'c> From<&'c T> for CertificateInput<'c> {
    fn from(value: &'c T) -> CertificateInput<'c> {
        CertificateInput::Raw(value.as_ref())
    }
}

/// A certificate.
#[derive(Clone)]
pub struct Certificate(X509);

impl Certificate {
    /// Parse a certificate from DER data.
    #[inline]
    pub fn from_der<C: AsRef<[u8]>>(cert: C) -> crate::Result<Self> {
        X509::from_der(cert.as_ref()).map(Self).map_err(Error::tls)
    }

    /// Parse a certificate from PEM data.
    #[inline]
    pub fn from_pem<C: AsRef<[u8]>>(cert: C) -> crate::Result<Self> {
        X509::from_pem(cert.as_ref()).map(Self).map_err(Error::tls)
    }

    /// Parse a stack of certificates from DER data.
    #[inline]
    pub fn stack_from_pem<C: AsRef<[u8]>>(cert: C) -> crate::Result<Vec<Self>> {
        let certs = X509::stack_from_pem(cert.as_ref()).map_err(Error::tls)?;
        Ok(certs.into_iter().map(Self).collect())
    }
}
