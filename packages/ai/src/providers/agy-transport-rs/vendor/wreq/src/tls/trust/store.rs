use std::{net::IpAddr, sync::Arc};

use btls::x509::{
    store::{X509Store, X509StoreBuilder},
    verify::X509CheckFlags,
};

use super::{
    Certificate, CertificateInput,
    parse::{filter_map_certs, parse_certs, parse_certs_with_stack, process_certs},
};
use crate::{Error, Result};

/// A builder for constructing a [`CertStore`].
pub struct CertStoreBuilder {
    builder: Result<X509StoreBuilder>,
}

impl CertStoreBuilder {
    fn parse_cert<'c, C, P>(mut self, cert: C, parser: P) -> Self
    where
        C: Into<CertificateInput<'c>>,
        P: Fn(&'c [u8]) -> Result<Certificate>,
    {
        if let Ok(ref mut builder) = self.builder {
            let input = cert.into();
            let result = input
                .with_parser(parser)
                .and_then(|cert| builder.add_cert(cert.0).map_err(Error::tls));

            if let Err(err) = result {
                self.builder = Err(err);
            }
        }
        self
    }

    fn parse_certs<'c, I>(mut self, certs: I, parser: fn(&'c [u8]) -> Result<Certificate>) -> Self
    where
        I: IntoIterator,
        I::Item: Into<CertificateInput<'c>>,
    {
        if let Ok(ref mut builder) = self.builder {
            let certs = filter_map_certs(certs, parser);
            if let Err(err) = process_certs(certs, builder) {
                self.builder = Err(err);
            }
        }
        self
    }

    /// Adds a DER-encoded certificate to the certificate store.
    #[inline]
    pub fn add_der_cert<'c, C>(self, cert: C) -> Self
    where
        C: Into<CertificateInput<'c>>,
    {
        self.parse_cert(cert, Certificate::from_der)
    }

    /// Adds a PEM-encoded certificate to the certificate store.
    #[inline]
    pub fn add_pem_cert<'c, C>(self, cert: C) -> Self
    where
        C: Into<CertificateInput<'c>>,
    {
        self.parse_cert(cert, Certificate::from_pem)
    }

    /// Adds multiple DER-encoded certificates to the certificate store.
    #[inline]
    pub fn add_der_certs<'c, I>(self, certs: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<CertificateInput<'c>>,
    {
        self.parse_certs(certs, Certificate::from_der)
    }

    /// Adds multiple PEM-encoded certificates to the certificate store.
    #[inline]
    pub fn add_pem_certs<'c, I>(self, certs: I) -> Self
    where
        I: IntoIterator,
        I::Item: Into<CertificateInput<'c>>,
    {
        self.parse_certs(certs, Certificate::from_pem)
    }

    /// Adds a PEM-encoded certificate stack to the certificate store.
    pub fn add_stack_pem_certs<C>(mut self, certs: C) -> Self
    where
        C: AsRef<[u8]>,
    {
        if let Ok(ref mut builder) = self.builder {
            let result = Certificate::stack_from_pem(certs.as_ref())
                .and_then(|certs| process_certs(certs.into_iter(), builder));

            if let Err(err) = result {
                self.builder = Err(err);
            }
        }
        self
    }

    /// Load certificates from their default locations.
    ///
    /// These locations are read from the `SSL_CERT_FILE` and `SSL_CERT_DIR`
    /// environment variables if present, or defaults specified at OpenSSL
    /// build time otherwise.
    pub fn set_default_paths(mut self) -> Self {
        if let Ok(ref mut builder) = self.builder
            && let Err(err) = builder.set_default_paths()
        {
            self.builder = Err(Error::tls(err));
        }
        self
    }

    /// Requires peer certificates to be issued for `host`, a DNS name or IP address.
    ///
    /// The check runs during chain verification and does not depend on the request URI, so a
    /// server dialed by IP address can be verified against the DNS name in its certificate.
    /// The subject common name is never used as a fallback.
    ///
    /// Use it with [`ClientBuilder::tls_verify_hostname(false)`]. Otherwise the URI host is checked
    /// as well: a host of the same kind replaces this requirement, and one of the other kind must
    /// match too. The requirement applies to every client built with this store.
    ///
    /// [`ClientBuilder::tls_verify_hostname(false)`]: crate::ClientBuilder::tls_verify_hostname
    pub fn verify_host<H>(mut self, host: H) -> Self
    where
        H: AsRef<str>,
    {
        if let Ok(ref mut builder) = self.builder {
            let host = host.as_ref();
            let param = builder.verify_param_mut();
            param.set_hostflags(X509CheckFlags::NEVER_CHECK_SUBJECT);
            let result = match host.parse::<IpAddr>() {
                Ok(ip) => param.set_ip(ip),
                Err(_) => param.set_host(host),
            };
            if let Err(err) = result {
                self.builder = Err(Error::tls(err));
            }
        }
        self
    }

    /// Constructs the [`CertStore`].
    ///
    /// This method finalizes the builder and constructs the [`CertStore`]
    /// containing all the added certificates.
    #[inline]
    pub fn build(self) -> Result<CertStore> {
        self.builder
            .map(X509StoreBuilder::build)
            .map(Arc::new)
            .map(CertStore)
    }
}

/// A thread-safe certificate store for TLS connections.
///
/// [`CertStore`] manages a collection of trusted certificates used for verifying peer identities.
/// It is designed to be shared and reused across requests and connections, similar to `Client`.
///
/// Internally, [`CertStore`] uses an [`Arc`] for reference counting, so you do **not** need to wrap
/// it in an additional [`Rc`] or [`Arc`] for sharing between threads or tasks.
///
/// To configure a [`CertStore`], use [`CertStore::builder()`]. You can also construct it from DER
/// or PEM certificates, or load system defaults.
///
/// [`Rc`]: std::rc::Rc
/// [`Arc`]: std::sync::Arc
#[derive(Clone)]
pub struct CertStore(pub(in crate::tls) Arc<X509Store>);

impl CertStore {
    /// Creates a new [`CertStoreBuilder`].
    #[inline]
    pub fn builder() -> CertStoreBuilder {
        CertStoreBuilder {
            builder: X509StoreBuilder::new().map_err(Error::builder),
        }
    }

    /// Creates a new [`CertStore`] from a collection of DER-encoded certificates.
    #[inline]
    pub fn from_der_certs<'c, C>(certs: C) -> Result<CertStore>
    where
        C: IntoIterator,
        C::Item: Into<CertificateInput<'c>>,
    {
        parse_certs(certs, Certificate::from_der)
            .map(Arc::new)
            .map(CertStore)
    }

    /// Creates a new [`CertStore`] from a collection of PEM-encoded certificates.
    #[inline]
    pub fn from_pem_certs<'c, C>(certs: C) -> Result<CertStore>
    where
        C: IntoIterator,
        C::Item: Into<CertificateInput<'c>>,
    {
        parse_certs(certs, Certificate::from_pem)
            .map(Arc::new)
            .map(CertStore)
    }

    /// Creates a new [`CertStore`] from a PEM-encoded certificate stack.
    #[inline]
    pub fn from_pem_stack<C>(certs: C) -> Result<CertStore>
    where
        C: AsRef<[u8]>,
    {
        parse_certs_with_stack(certs, Certificate::stack_from_pem)
            .map(Arc::new)
            .map(CertStore)
    }
}
