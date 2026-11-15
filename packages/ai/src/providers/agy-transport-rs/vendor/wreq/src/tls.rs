//!  TLS options configuration
//!
//! - Various parts of TLS can also be configured or even disabled on the `ClientBuilder`.

pub(super) mod conn;

pub mod compress;
pub mod keylog;
pub mod session;
pub mod trust;

use std::borrow::Cow;

/// Re-exports of TLS-related types from `btls` for public use.
pub use btls::ssl::{ExtensionType, KeyShare};
use bytes::{BufMut, Bytes, BytesMut};
use compress::CertificateCompressor;

/// Http extension carrying extra TLS layer information.
/// Made available to clients on responses when `tls_info` is set.
#[derive(Debug, Clone)]
pub struct TlsInfo {
    pub(crate) peer_certificate: Option<Bytes>,
    pub(crate) peer_certificate_chain: Option<Vec<Bytes>>,
}

impl TlsInfo {
    /// Get the DER encoded leaf certificate of the peer.
    pub fn peer_certificate(&self) -> Option<&[u8]> {
        self.peer_certificate.as_deref()
    }

    /// Get the DER encoded certificate chain of the peer.
    ///
    /// This includes the leaf certificate on the client side.
    pub fn peer_certificate_chain(&self) -> Option<impl Iterator<Item = &[u8]>> {
        self.peer_certificate_chain
            .as_ref()
            .map(|v| v.iter().map(|b| b.as_ref()))
    }
}

/// A TLS protocol version.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct TlsVersion(btls::ssl::SslVersion);

impl TlsVersion {
    /// Version 1.0 of the TLS protocol.
    pub const TLS_1_0: TlsVersion = TlsVersion(btls::ssl::SslVersion::TLS1);

    /// Version 1.1 of the TLS protocol.
    pub const TLS_1_1: TlsVersion = TlsVersion(btls::ssl::SslVersion::TLS1_1);

    /// Version 1.2 of the TLS protocol.
    pub const TLS_1_2: TlsVersion = TlsVersion(btls::ssl::SslVersion::TLS1_2);

    /// Version 1.3 of the TLS protocol.
    pub const TLS_1_3: TlsVersion = TlsVersion(btls::ssl::SslVersion::TLS1_3);
}

/// A TLS ALPN protocol.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct AlpnProtocol(&'static [u8]);

impl AlpnProtocol {
    /// Prefer HTTP/1.1
    pub const HTTP1: AlpnProtocol = AlpnProtocol(b"http/1.1");

    /// Prefer HTTP/2
    pub const HTTP2: AlpnProtocol = AlpnProtocol(b"h2");

    /// Prefer HTTP/3
    pub const HTTP3: AlpnProtocol = AlpnProtocol(b"h3");

    #[inline]
    fn encode(self) -> Bytes {
        Self::encode_sequence(std::iter::once(&self))
    }

    fn encode_sequence<'a, I>(items: I) -> Bytes
    where
        I: IntoIterator<Item = &'a AlpnProtocol>,
    {
        let mut buf = BytesMut::new();
        for item in items {
            buf.put_u8(item.0.len() as u8);
            buf.extend_from_slice(item.0);
        }
        buf.freeze()
    }
}

impl PartialEq<[u8]> for AlpnProtocol {
    #[inline]
    fn eq(&self, other: &[u8]) -> bool {
        self.0 == other
    }
}

/// A TLS ALPS protocol.
#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
pub struct AlpsProtocol(&'static [u8]);

impl AlpsProtocol {
    /// Prefer HTTP/1.1
    pub const HTTP1: AlpsProtocol = AlpsProtocol(b"http/1.1");

    /// Prefer HTTP/2
    pub const HTTP2: AlpsProtocol = AlpsProtocol(b"h2");

    /// Prefer HTTP/3
    pub const HTTP3: AlpsProtocol = AlpsProtocol(b"h3");
}

impl PartialEq<[u8]> for AlpsProtocol {
    #[inline]
    fn eq(&self, other: &[u8]) -> bool {
        self.0 == other
    }
}

/// Builder for `[`TlsOptions`]`.
#[must_use]
#[derive(Debug, Clone)]
pub struct TlsOptionsBuilder {
    config: TlsOptions,
}

/// TLS connection configuration options.
///
/// This struct provides fine-grained control over the behavior of TLS
/// connections, including:
/// - **Protocol negotiation** (ALPN, ALPS, TLS versions)
/// - **Session management** (tickets, PSK, key shares)
/// - **Security & privacy** (OCSP, GREASE, ECH, delegated credentials)
/// - **Performance tuning** (record size, cipher preferences, hardware overrides)
///
/// All fields are optional or have defaults. See each field for details.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct TlsOptions {
    /// Application-Layer Protocol Negotiation ([RFC 7301](https://datatracker.ietf.org/doc/html/rfc7301)).
    ///
    /// Specifies which application protocols (e.g., HTTP/2, HTTP/1.1) may be negotiated
    /// over a single TLS connection.
    ///
    /// **Default:** `Some([HTTP/2, HTTP/1.1])`
    pub alpn_protocols: Option<Cow<'static, [AlpnProtocol]>>,

    /// Application-Layer Protocol Settings (ALPS).
    ///
    /// Enables exchanging application-layer settings during the handshake
    /// for protocols negotiated via ALPN.
    ///
    /// **Default:** `None`
    pub alps_protocols: Option<Cow<'static, [AlpsProtocol]>>,

    /// Whether to use an alternative ALPS codepoint for compatibility.
    ///
    /// Useful when larger ALPS payloads are required.
    ///
    /// **Default:** `false`
    pub alps_use_new_codepoint: bool,

    /// Enables TLS Session Tickets ([RFC 5077](https://tools.ietf.org/html/rfc5077)).
    ///
    /// Allows session resumption without requiring server-side state.
    ///
    /// **Default:** `true`
    pub session_ticket: bool,

    /// Minimum TLS version allowed for the connection.
    ///
    /// **Default:** `None` (library default applied)
    pub min_tls_version: Option<TlsVersion>,

    /// Maximum TLS version allowed for the connection.
    ///
    /// **Default:** `None` (library default applied)
    pub max_tls_version: Option<TlsVersion>,

    /// Enables Pre-Shared Key (PSK) cipher suites ([RFC 4279](https://datatracker.ietf.org/doc/html/rfc4279)).
    ///
    /// Authentication relies on out-of-band pre-shared keys instead of certificates.
    ///
    /// **Default:** `false`
    pub pre_shared_key: bool,

    /// Controls whether to send a GREASE Encrypted ClientHello (ECH) extension
    /// when no supported ECH configuration is available.
    ///
    /// GREASE prevents protocol ossification by sending unknown extensions.
    ///
    /// **Default:** `false`
    pub enable_ech_grease: bool,

    /// Controls whether ClientHello extensions should be permuted.
    ///
    /// **Default:** `None` (implementation default)
    pub permute_extensions: Option<bool>,

    /// Controls whether GREASE extensions ([RFC 8701](https://datatracker.ietf.org/doc/html/rfc8701))
    /// are enabled in general.
    ///
    /// **Default:** `None` (implementation default)
    pub grease_enabled: Option<bool>,

    /// Enables OCSP stapling for the connection.
    ///
    /// **Default:** `false`
    pub enable_ocsp_stapling: bool,

    /// Enables Signed Certificate Timestamps (SCT).
    ///
    /// **Default:** `false`
    pub enable_signed_cert_timestamps: bool,

    /// Sets the maximum TLS record size.
    ///
    /// **Default:** `None`
    pub record_size_limit: Option<u16>,

    /// Whether to skip session tickets when using PSK.
    ///
    /// **Default:** `false`
    pub psk_skip_session_ticket: bool,

    /// Whether to set specific key shares for TLS 1.3 handshakes.
    ///
    /// **Default:** `None`
    pub key_shares: Option<Cow<'static, [KeyShare]>>,

    /// Enables PSK with (EC)DHE key establishment (`psk_dhe_ke`).
    ///
    /// **Default:** `true`
    pub psk_dhe_ke: bool,

    /// Enables TLS renegotiation by sending the `renegotiation_info` extension.
    ///
    /// **Default:** `true`
    pub renegotiation: bool,

    /// Delegated Credentials ([RFC 9345](https://datatracker.ietf.org/doc/html/rfc9345)).
    ///
    /// Allows TLS 1.3 endpoints to use temporary delegated credentials
    /// for authentication with reduced long-term key exposure.
    ///
    /// **Default:** `None`
    pub delegated_credentials: Option<Cow<'static, str>>,

    /// List of supported elliptic curves.
    ///
    /// **Default:** `None`
    pub curves_list: Option<Cow<'static, str>>,

    /// List of supported signature algorithms.
    ///
    /// **Default:** `None`
    pub sigalgs_list: Option<Cow<'static, str>>,

    /// Cipher suite configuration string.
    ///
    /// Uses BoringSSL's mini-language to select, enable, and prioritize ciphers.
    ///
    /// **Default:** `None`
    pub cipher_list: Option<Cow<'static, str>>,

    /// Sets whether to preserve the TLS 1.3 cipher list as configured by [`Self::cipher_list`].
    ///
    /// **Default:** `None`
    pub preserve_tls13_cipher_list: Option<bool>,

    /// Emits TLS 1.3 cipher suites after legacy suites without changing support.
    ///
    /// **Default:** `None` (TLS 1.3 suites first)
    pub tls13_ciphers_last: Option<bool>,

    /// Supported certificate compression algorithms ([RFC 8879](https://datatracker.ietf.org/doc/html/rfc8879)).
    ///
    /// **Default:** `None`
    pub certificate_compressors: Option<Cow<'static, [&'static dyn CertificateCompressor]>>,

    /// Supported TLS extensions, used for extension ordering/permutation.
    ///
    /// **Default:** `None`
    pub extension_permutation: Option<Cow<'static, [ExtensionType]>>,

    /// Raw TLS group ids for `supported_groups`, bypassing the name table.
    ///
    /// Applied after `curves_list`, so it wins. Ids this build does not
    /// implement are still advertised; selecting one fails the handshake.
    ///
    /// **Default:** `None`
    pub group_ids: Option<Cow<'static, [u16]>>,

    /// ClientHello signature-algorithm wire IDs, applied after `sigalgs_list`.
    ///
    /// Unknown IDs are advertised only; they cannot verify handshake signatures.
    /// This option is for structural probes, not evidence of protocol support.
    ///
    /// **Default:** `None`
    pub sigalgs: Option<Cow<'static, [u16]>>,

    /// ClientHello `signature_algorithms_cert` wire IDs.
    ///
    /// This advertisement never changes certificate-chain or hostname checks.
    /// An empty list omits the extension. Unsupported algorithms remain unsupported.
    ///
    /// **Default:** `None`
    pub cert_sigalgs: Option<Cow<'static, [u16]>>,

    /// Overrides AES hardware acceleration.
    ///
    /// **Default:** `None`
    pub aes_hw_override: Option<bool>,

    /// Overrides the random AES hardware acceleration.
    ///
    /// **Default:** `false`
    pub random_aes_hw_override: bool,
}

impl TlsOptionsBuilder {
    /// Sets the ALPN protocols to use.
    #[inline]
    pub fn alpn_protocols<I>(mut self, alpn: I) -> Self
    where
        I: IntoIterator<Item = AlpnProtocol>,
    {
        self.config.alpn_protocols = Some(Cow::Owned(alpn.into_iter().collect()));
        self
    }

    /// Sets the ALPS protocols to use.
    #[inline]
    pub fn alps_protocols<I>(mut self, alps: I) -> Self
    where
        I: IntoIterator<Item = AlpsProtocol>,
    {
        self.config.alps_protocols = Some(Cow::Owned(alps.into_iter().collect()));
        self
    }

    /// Sets whether to use a new codepoint for ALPS.
    #[inline]
    pub fn alps_use_new_codepoint(mut self, enabled: bool) -> Self {
        self.config.alps_use_new_codepoint = enabled;
        self
    }
    /// Sets the session ticket flag.
    #[inline]
    pub fn session_ticket(mut self, enabled: bool) -> Self {
        self.config.session_ticket = enabled;
        self
    }

    /// Sets the minimum TLS version to use.
    #[inline]
    pub fn min_tls_version<T>(mut self, version: T) -> Self
    where
        T: Into<Option<TlsVersion>>,
    {
        self.config.min_tls_version = version.into();
        self
    }

    /// Sets the maximum TLS version to use.
    #[inline]
    pub fn max_tls_version<T>(mut self, version: T) -> Self
    where
        T: Into<Option<TlsVersion>>,
    {
        self.config.max_tls_version = version.into();
        self
    }

    /// Sets the pre-shared key flag.
    #[inline]
    pub fn pre_shared_key(mut self, enabled: bool) -> Self {
        self.config.pre_shared_key = enabled;
        self
    }

    /// Sets the GREASE ECH extension flag.
    #[inline]
    pub fn enable_ech_grease(mut self, enabled: bool) -> Self {
        self.config.enable_ech_grease = enabled;
        self
    }

    /// Sets whether to permute ClientHello extensions.
    #[inline]
    pub fn permute_extensions<T>(mut self, permute: T) -> Self
    where
        T: Into<Option<bool>>,
    {
        self.config.permute_extensions = permute.into();
        self
    }

    /// Sets the GREASE enabled flag.
    #[inline]
    pub fn grease_enabled<T>(mut self, enabled: T) -> Self
    where
        T: Into<Option<bool>>,
    {
        self.config.grease_enabled = enabled.into();
        self
    }

    /// Sets the OCSP stapling flag.
    #[inline]
    pub fn enable_ocsp_stapling(mut self, enabled: bool) -> Self {
        self.config.enable_ocsp_stapling = enabled;
        self
    }

    /// Sets the signed certificate timestamps flag.
    #[inline]
    pub fn enable_signed_cert_timestamps(mut self, enabled: bool) -> Self {
        self.config.enable_signed_cert_timestamps = enabled;
        self
    }

    /// Sets the record size limit.
    #[inline]
    pub fn record_size_limit<U: Into<Option<u16>>>(mut self, limit: U) -> Self {
        self.config.record_size_limit = limit.into();
        self
    }

    /// Sets the PSK skip session ticket flag.
    #[inline]
    pub fn psk_skip_session_ticket(mut self, skip: bool) -> Self {
        self.config.psk_skip_session_ticket = skip;
        self
    }

    /// Sets the PSK DHE key establishment flag.
    #[inline]
    pub fn psk_dhe_ke(mut self, enabled: bool) -> Self {
        self.config.psk_dhe_ke = enabled;
        self
    }

    /// Sets the renegotiation flag.
    #[inline]
    pub fn renegotiation(mut self, enabled: bool) -> Self {
        self.config.renegotiation = enabled;
        self
    }

    /// Sets the delegated credentials.
    #[inline]
    pub fn delegated_credentials<T>(mut self, creds: T) -> Self
    where
        T: Into<Cow<'static, str>>,
    {
        self.config.delegated_credentials = Some(creds.into());
        self
    }

    /// Sets the client key shares to be used in the TLS 1.3 handshake.
    #[inline]
    pub fn key_shares<T>(mut self, key_shares: T) -> Self
    where
        T: Into<Cow<'static, [KeyShare]>>,
    {
        self.config.key_shares = Some(key_shares.into());
        self
    }

    /// Sets the supported curves list.
    #[inline]
    pub fn curves_list<T>(mut self, curves: T) -> Self
    where
        T: Into<Cow<'static, str>>,
    {
        self.config.curves_list = Some(curves.into());
        self
    }

    /// Sets the cipher list.
    #[inline]
    pub fn cipher_list<T>(mut self, ciphers: T) -> Self
    where
        T: Into<Cow<'static, str>>,
    {
        self.config.cipher_list = Some(ciphers.into());
        self
    }

    /// Sets the supported signature algorithms.
    #[inline]
    pub fn sigalgs_list<T>(mut self, sigalgs: T) -> Self
    where
        T: Into<Cow<'static, str>>,
    {
        self.config.sigalgs_list = Some(sigalgs.into());
        self
    }

    /// Sets the certificate compression algorithms.
    #[inline]
    pub fn certificate_compressors<T>(mut self, algs: T) -> Self
    where
        T: Into<Cow<'static, [&'static dyn CertificateCompressor]>>,
    {
        self.config.certificate_compressors = Some(algs.into());
        self
    }

    /// Sets the extension permutation.
    #[inline]
    pub fn extension_permutation<T>(mut self, permutation: T) -> Self
    where
        T: Into<Cow<'static, [ExtensionType]>>,
    {
        self.config.extension_permutation = Some(permutation.into());
        self
    }

    /// Sets raw TLS group ids for `supported_groups`, bypassing the name table.
    #[inline]
    pub fn group_ids<I>(mut self, group_ids: I) -> Self
    where
        I: Into<Cow<'static, [u16]>>,
    {
        self.config.group_ids = Some(group_ids.into());
        self
    }

    /// Sets ClientHello signature-algorithm wire IDs; unknown IDs cannot negotiate.
    #[inline]
    pub fn sigalgs<I>(mut self, sigalgs: I) -> Self
    where
        I: Into<Cow<'static, [u16]>>,
    {
        self.config.sigalgs = Some(sigalgs.into());
        self
    }

    /// Sets the `signature_algorithms_cert` advertisement without changing verification.
    #[inline]
    pub fn cert_sigalgs<I>(mut self, sigalgs: I) -> Self
    where
        I: Into<Cow<'static, [u16]>>,
    {
        self.config.cert_sigalgs = Some(sigalgs.into());
        self
    }

    /// Places TLS 1.3 cipher suites after legacy suites in ClientHello.
    #[inline]
    pub fn tls13_ciphers_last<T>(mut self, enabled: T) -> Self
    where
        T: Into<Option<bool>>,
    {
        self.config.tls13_ciphers_last = enabled.into();
        self
    }

    /// Sets the AES hardware override flag.
    #[inline]
    pub fn aes_hw_override<T>(mut self, enabled: T) -> Self
    where
        T: Into<Option<bool>>,
    {
        self.config.aes_hw_override = enabled.into();
        self
    }

    /// Sets the random AES hardware override flag.
    #[inline]
    pub fn random_aes_hw_override(mut self, enabled: bool) -> Self {
        self.config.random_aes_hw_override = enabled;
        self
    }

    /// Sets whether to preserve the TLS 1.3 cipher list as configured by [`Self::cipher_list`].
    ///
    /// By default, BoringSSL does not preserve the TLS 1.3 cipher list. When this option is
    /// disabled (the default), BoringSSL uses its internal default TLS 1.3 cipher suites in its
    /// default order, regardless of what is set via [`Self::cipher_list`].
    ///
    /// When enabled, this option ensures that the TLS 1.3 cipher suites explicitly set via
    /// [`Self::cipher_list`] are retained in their original order, without being reordered or
    /// modified by BoringSSL's internal logic. This is useful for maintaining specific cipher suite
    /// priorities for TLS 1.3. Note that if [`Self::cipher_list`] does not include any TLS 1.3
    /// cipher suites, BoringSSL will still fall back to its default TLS 1.3 cipher suites and
    /// order.
    #[inline]
    pub fn preserve_tls13_cipher_list<T>(mut self, enabled: T) -> Self
    where
        T: Into<Option<bool>>,
    {
        self.config.preserve_tls13_cipher_list = enabled.into();
        self
    }

    /// Builds the `TlsOptions` from the builder.
    #[inline]
    pub fn build(self) -> TlsOptions {
        self.config
    }
}

impl TlsOptions {
    /// Creates a new `TlsOptionsBuilder` instance.
    pub fn builder() -> TlsOptionsBuilder {
        TlsOptionsBuilder {
            config: TlsOptions::default(),
        }
    }
}

impl Default for TlsOptions {
    fn default() -> Self {
        TlsOptions {
            alpn_protocols: Some(Cow::Borrowed(&[AlpnProtocol::HTTP2, AlpnProtocol::HTTP1])),
            alps_protocols: None,
            alps_use_new_codepoint: false,
            session_ticket: true,
            min_tls_version: None,
            max_tls_version: None,
            pre_shared_key: false,
            enable_ech_grease: false,
            permute_extensions: None,
            grease_enabled: None,
            enable_ocsp_stapling: false,
            enable_signed_cert_timestamps: false,
            record_size_limit: None,
            psk_skip_session_ticket: false,
            key_shares: None,
            psk_dhe_ke: true,
            renegotiation: true,
            delegated_credentials: None,
            curves_list: None,
            group_ids: None,
            sigalgs: None,
            cert_sigalgs: None,
            cipher_list: None,
            sigalgs_list: None,
            certificate_compressors: None,
            extension_permutation: None,
            aes_hw_override: None,
            preserve_tls13_cipher_list: None,
            tls13_ciphers_last: None,
            random_aes_hw_override: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpn_protocol_encode() {
        let alpn = AlpnProtocol::encode_sequence(&[AlpnProtocol::HTTP1, AlpnProtocol::HTTP2]);
        assert_eq!(alpn, Bytes::from_static(b"\x08http/1.1\x02h2"));

        let alpn = AlpnProtocol::encode_sequence(&[AlpnProtocol::HTTP3]);
        assert_eq!(alpn, Bytes::from_static(b"\x02h3"));

        let alpn = AlpnProtocol::encode_sequence(&[AlpnProtocol::HTTP1, AlpnProtocol::HTTP3]);
        assert_eq!(alpn, Bytes::from_static(b"\x08http/1.1\x02h3"));

        let alpn = AlpnProtocol::encode_sequence(&[AlpnProtocol::HTTP2, AlpnProtocol::HTTP3]);
        assert_eq!(alpn, Bytes::from_static(b"\x02h2\x02h3"));

        let alpn = AlpnProtocol::encode_sequence(&[
            AlpnProtocol::HTTP1,
            AlpnProtocol::HTTP2,
            AlpnProtocol::HTTP3,
        ]);
        assert_eq!(alpn, Bytes::from_static(b"\x08http/1.1\x02h2\x02h3"));
    }

    #[test]
    fn alpn_protocol_encode_single() {
        let alpn = AlpnProtocol::HTTP1.encode();
        assert_eq!(alpn, b"\x08http/1.1".as_ref());

        let alpn = AlpnProtocol::HTTP2.encode();
        assert_eq!(alpn, b"\x02h2".as_ref());

        let alpn = AlpnProtocol::HTTP3.encode();
        assert_eq!(alpn, b"\x02h3".as_ref());
    }
}
