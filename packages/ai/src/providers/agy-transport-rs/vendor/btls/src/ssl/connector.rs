use std::io::{Read, Write};
use std::ops::{Deref, DerefMut};

use crate::dh::Dh;
use crate::error::ErrorStack;
use crate::ssl::{
    HandshakeError, Ssl, SslContext, SslContextBuilder, SslContextRef, SslMethod, SslMode,
    SslOptions, SslRef, SslStream, SslVerifyMode,
};
use crate::version;
use std::net::IpAddr;

use super::MidHandshakeSslStream;

const FFDHE_2048: &str = "
-----BEGIN DH PARAMETERS-----
MIIBCAKCAQEA//////////+t+FRYortKmq/cViAnPTzx2LnFg84tNpWp4TZBFGQz
+8yTnc4kmz75fS/jY2MMddj2gbICrsRhetPfHtXV/WVhJDP1H18GbtCFY2VVPe0a
87VXE15/V8k1mE8McODmi3fipona8+/och3xWKE2rec1MKzKT0g6eXq8CrGCsyT7
YdEIqUuyyOP7uWrat2DX9GgdT0Kj3jlN9K5W7edjcrsZCwenyO4KbXCeAvzhzffi
7MA0BM0oNC9hkXL+nOmFg/+OTxIy7vKBg8P+OxtMb61zO7X8vC7CIAXFjvGDfRaD
ssbzSibBsu/6iGtCOGEoXJf//////////wIBAg==
-----END DH PARAMETERS-----
";

#[allow(clippy::inconsistent_digit_grouping)]
fn ctx(method: SslMethod) -> Result<SslContextBuilder, ErrorStack> {
    let mut ctx = SslContextBuilder::new(method)?;

    let mut opts = SslOptions::ALL
        | SslOptions::NO_COMPRESSION
        | SslOptions::NO_SSLV2
        | SslOptions::NO_SSLV3
        | SslOptions::SINGLE_DH_USE
        | SslOptions::SINGLE_ECDH_USE;
    opts &= !SslOptions::DONT_INSERT_EMPTY_FRAGMENTS;

    ctx.set_options(opts);

    let mut mode =
        SslMode::AUTO_RETRY | SslMode::ACCEPT_MOVING_WRITE_BUFFER | SslMode::ENABLE_PARTIAL_WRITE;

    // This is quite a useful optimization for saving memory, but historically
    // caused CVEs in OpenSSL pre-1.0.1h, according to
    // https://bugs.python.org/issue25672
    if version::number() >= 0x1000_1080 {
        mode |= SslMode::RELEASE_BUFFERS;
    }

    ctx.set_mode(mode);

    Ok(ctx)
}

/// A type which wraps client-side streams in a TLS session.
///
/// OpenSSL's default configuration is highly insecure. This connector manages the OpenSSL
/// structures, configuring cipher suites, session options, hostname verification, and more.
///
/// OpenSSL's built in hostname verification is used when linking against OpenSSL 1.0.2 or 1.1.0,
/// and a custom implementation is used when linking against OpenSSL 1.0.1.
#[derive(Clone, Debug)]
pub struct SslConnector(SslContext);

impl SslConnector {
    /// Creates a new builder for TLS connections.
    ///
    /// The default configuration is subject to change, and is currently derived from Python.
    pub fn builder(method: SslMethod) -> Result<SslConnectorBuilder, ErrorStack> {
        let mut ctx = ctx(method)?;
        ctx.set_default_verify_paths()?;
        ctx.set_cipher_list(
            "DEFAULT:!aNULL:!eNULL:!MD5:!3DES:!DES:!RC4:!IDEA:!SEED:!aDSS:!SRP:!PSK",
        )?;
        ctx.set_verify(SslVerifyMode::PEER);

        Ok(SslConnectorBuilder(ctx))
    }

    /// Creates a bare builder for TLS connections without default CA certificates.
    ///
    /// The caller is responsible for providing a custom certificate store.
    pub fn bare_builder(method: SslMethod) -> Result<SslConnectorBuilder, ErrorStack> {
        let mut ctx = ctx(method)?;
        ctx.set_cipher_list(
            "DEFAULT:!aNULL:!eNULL:!MD5:!3DES:!DES:!RC4:!IDEA:!SEED:!aDSS:!SRP:!PSK",
        )?;

        Ok(SslConnectorBuilder(ctx))
    }

    /// Initiates a client-side TLS session on a stream.
    ///
    /// The domain is used for SNI and hostname verification.
    pub fn setup_connect<S>(
        &self,
        domain: &str,
        stream: S,
    ) -> Result<MidHandshakeSslStream<S>, ErrorStack>
    where
        S: Read + Write,
    {
        self.configure()?.setup_connect(domain, stream)
    }

    /// Attempts a client-side TLS session on a stream.
    ///
    /// The domain is used for SNI (if it is not an IP address) and hostname verification if enabled.
    ///
    /// This is a convenience method which combines [`Self::setup_connect`] and
    /// [`MidHandshakeSslStream::handshake`].
    pub fn connect<S>(&self, domain: &str, stream: S) -> Result<SslStream<S>, HandshakeError<S>>
    where
        S: Read + Write,
    {
        self.setup_connect(domain, stream)
            .map_err(HandshakeError::SetupFailure)?
            .handshake()
    }

    /// Returns a structure allowing for configuration of a single TLS session before connection.
    pub fn configure(&self) -> Result<ConnectConfiguration, ErrorStack> {
        Ssl::new(&self.0).map(|ssl| ConnectConfiguration {
            ssl,
            sni: true,
            verify_hostname: true,
        })
    }

    /// Consumes the `SslConnector`, returning the inner raw `SslContext`.
    #[must_use]
    pub fn into_context(self) -> SslContext {
        self.0
    }

    /// Returns a shared reference to the inner raw `SslContext`.
    #[must_use]
    pub fn context(&self) -> &SslContextRef {
        &self.0
    }
}

/// A builder for `SslConnector`s.
pub struct SslConnectorBuilder(SslContextBuilder);

impl SslConnectorBuilder {
    /// Consumes the builder, returning an `SslConnector`.
    #[must_use]
    pub fn build(self) -> SslConnector {
        SslConnector(self.0.build())
    }
}

impl Deref for SslConnectorBuilder {
    type Target = SslContextBuilder;

    fn deref(&self) -> &SslContextBuilder {
        &self.0
    }
}

impl DerefMut for SslConnectorBuilder {
    fn deref_mut(&mut self) -> &mut SslContextBuilder {
        &mut self.0
    }
}

/// A type which allows for configuration of a client-side TLS session before connection.
pub struct ConnectConfiguration {
    ssl: Ssl,
    sni: bool,
    verify_hostname: bool,
}

impl ConnectConfiguration {
    /// A builder-style version of `set_use_server_name_indication`.
    #[must_use]
    pub fn use_server_name_indication(mut self, use_sni: bool) -> ConnectConfiguration {
        self.set_use_server_name_indication(use_sni);
        self
    }

    /// Configures the use of Server Name Indication (SNI) when connecting.
    ///
    /// Defaults to `true`.
    pub fn set_use_server_name_indication(&mut self, use_sni: bool) {
        self.sni = use_sni;
    }

    /// A builder-style version of `set_verify_hostname`.
    #[must_use]
    pub fn verify_hostname(mut self, verify_hostname: bool) -> ConnectConfiguration {
        self.set_verify_hostname(verify_hostname);
        self
    }

    /// Configures the use of hostname verification when connecting.
    ///
    /// Defaults to `true`.
    ///
    /// # Warning
    ///
    /// You should think very carefully before you use this method. If hostname verification is not
    /// used, *any* valid certificate for *any* site will be trusted for use from any other. This
    /// introduces a significant vulnerability to man-in-the-middle attacks.
    pub fn set_verify_hostname(&mut self, verify_hostname: bool) {
        self.verify_hostname = verify_hostname;
    }

    /// Returns an [`Ssl`] configured to connect to the provided domain.
    ///
    /// The domain is used for SNI (if it is not an IP address) and hostname verification if enabled.
    pub fn into_ssl(mut self, domain: &str) -> Result<Ssl, ErrorStack> {
        if self.sni && domain.parse::<IpAddr>().is_err() {
            self.ssl.set_hostname(domain)?;
        }

        if self.verify_hostname {
            setup_verify_hostname(&mut self.ssl, domain)?;
        }

        Ok(self.ssl)
    }

    /// Initiates a client-side TLS session on a stream.
    ///
    /// The domain is used for SNI (if it is not an IP address) and hostname verification if enabled.
    ///
    /// This is a convenience method which combines [`Self::into_ssl`] and
    /// [`Ssl::setup_connect`].
    pub fn setup_connect<S>(
        self,
        domain: &str,
        stream: S,
    ) -> Result<MidHandshakeSslStream<S>, ErrorStack>
    where
        S: Read + Write,
    {
        Ok(self.into_ssl(domain)?.setup_connect(stream))
    }

    /// Attempts a client-side TLS session on a stream.
    ///
    /// The domain is used for SNI (if it is not an IP address) and hostname verification if enabled.
    ///
    /// This is a convenience method which combines [`Self::setup_connect`] and
    /// [`MidHandshakeSslStream::handshake`].
    pub fn connect<S>(self, domain: &str, stream: S) -> Result<SslStream<S>, HandshakeError<S>>
    where
        S: Read + Write,
    {
        self.setup_connect(domain, stream)
            .map_err(HandshakeError::SetupFailure)?
            .handshake()
    }
}

impl Deref for ConnectConfiguration {
    type Target = SslRef;

    fn deref(&self) -> &SslRef {
        &self.ssl
    }
}

impl DerefMut for ConnectConfiguration {
    fn deref_mut(&mut self) -> &mut SslRef {
        &mut self.ssl
    }
}

/// A type which wraps server-side streams in a TLS session.
///
/// OpenSSL's default configuration is highly insecure. This connector manages the OpenSSL
/// structures, configuring cipher suites, session options, and more.
#[derive(Clone)]
pub struct SslAcceptor(SslContext);

impl SslAcceptor {
    /// Creates a new builder configured to connect to non-legacy clients. This should generally be
    /// considered a reasonable default choice.
    ///
    /// This corresponds to the intermediate configuration of version 5 of Mozilla's server side TLS
    /// recommendations. See its [documentation][docs] for more details on specifics.
    ///
    /// [docs]: https://wiki.mozilla.org/Security/Server_Side_TLS
    pub fn mozilla_intermediate_v5(method: SslMethod) -> Result<SslAcceptorBuilder, ErrorStack> {
        let mut ctx = ctx(method)?;
        ctx.set_options(SslOptions::NO_TLSV1 | SslOptions::NO_TLSV1_1);
        let dh = Dh::params_from_pem(FFDHE_2048.as_bytes())?;
        ctx.set_tmp_dh(&dh)?;
        ctx.set_cipher_list(
            "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:\
             ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:\
             DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384"
        )?;
        Ok(SslAcceptorBuilder(ctx))
    }

    /// Creates a new builder configured to connect to non-legacy clients. This should generally be
    /// considered a reasonable default choice.
    ///
    /// This corresponds to the intermediate configuration of version 4 of Mozilla's server side TLS
    /// recommendations. See its [documentation][docs] for more details on specifics.
    ///
    /// [docs]: https://wiki.mozilla.org/Security/Server_Side_TLS
    // FIXME remove in next major version
    pub fn mozilla_intermediate(method: SslMethod) -> Result<SslAcceptorBuilder, ErrorStack> {
        let mut ctx = ctx(method)?;
        ctx.set_options(SslOptions::CIPHER_SERVER_PREFERENCE);
        ctx.set_options(SslOptions::NO_TLSV1_3);
        let dh = Dh::params_from_pem(FFDHE_2048.as_bytes())?;
        ctx.set_tmp_dh(&dh)?;
        ctx.set_cipher_list(
            "ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:\
             ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:\
             DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256:\
             ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES256-SHA384:\
             ECDHE-ECDSA-AES256-SHA:ECDHE-RSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA:\
             DHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA:ECDHE-ECDSA-DES-CBC3-SHA:ECDHE-RSA-DES-CBC3-SHA:\
             EDH-RSA-DES-CBC3-SHA:AES128-GCM-SHA256:AES256-GCM-SHA384:AES128-SHA256:AES256-SHA256:AES128-SHA:\
             AES256-SHA:DES-CBC3-SHA:!DSS",
        )?;
        Ok(SslAcceptorBuilder(ctx))
    }

    /// Creates a new builder configured to connect to modern clients.
    ///
    /// This corresponds to the modern configuration of version 4 of Mozilla's server side TLS recommendations.
    /// See its [documentation][docs] for more details on specifics.
    ///
    /// [docs]: https://wiki.mozilla.org/Security/Server_Side_TLS
    // FIXME remove in next major version
    pub fn mozilla_modern(method: SslMethod) -> Result<SslAcceptorBuilder, ErrorStack> {
        let mut ctx = ctx(method)?;
        ctx.set_options(
            SslOptions::CIPHER_SERVER_PREFERENCE | SslOptions::NO_TLSV1 | SslOptions::NO_TLSV1_1,
        );
        ctx.set_options(SslOptions::NO_TLSV1_3);
        ctx.set_cipher_list(
            "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:\
             ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:\
             ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA256",
        )?;
        Ok(SslAcceptorBuilder(ctx))
    }

    /// Initiates a server-side TLS handshake on a stream.
    ///
    /// See [`Ssl::setup_accept`] for more details.
    pub fn setup_accept<S>(&self, stream: S) -> Result<MidHandshakeSslStream<S>, ErrorStack>
    where
        S: Read + Write,
    {
        let ssl = Ssl::new(&self.0)?;

        Ok(ssl.setup_accept(stream))
    }

    /// Attempts a server-side TLS handshake on a stream.
    ///
    /// This is a convenience method which combines [`Self::setup_accept`] and
    /// [`MidHandshakeSslStream::handshake`].
    pub fn accept<S>(&self, stream: S) -> Result<SslStream<S>, HandshakeError<S>>
    where
        S: Read + Write,
    {
        self.setup_accept(stream)
            .map_err(HandshakeError::SetupFailure)?
            .handshake()
    }

    /// Consumes the `SslAcceptor`, returning the inner raw `SslContext`.
    #[must_use]
    pub fn into_context(self) -> SslContext {
        self.0
    }

    /// Returns a shared reference to the inner raw `SslContext`.
    #[must_use]
    pub fn context(&self) -> &SslContextRef {
        &self.0
    }
}

/// A builder for `SslAcceptor`s.
pub struct SslAcceptorBuilder(SslContextBuilder);

impl SslAcceptorBuilder {
    /// Consumes the builder, returning a `SslAcceptor`.
    #[must_use]
    pub fn build(self) -> SslAcceptor {
        SslAcceptor(self.0.build())
    }
}

impl Deref for SslAcceptorBuilder {
    type Target = SslContextBuilder;

    fn deref(&self) -> &SslContextBuilder {
        &self.0
    }
}

impl DerefMut for SslAcceptorBuilder {
    fn deref_mut(&mut self) -> &mut SslContextBuilder {
        &mut self.0
    }
}

fn setup_verify_hostname(ssl: &mut SslRef, domain: &str) -> Result<(), ErrorStack> {
    use crate::x509::verify::X509CheckFlags;

    let param = ssl.param_mut();
    param.set_hostflags(
        X509CheckFlags::NO_PARTIAL_WILDCARDS | X509CheckFlags::NEVER_CHECK_SUBJECT,
    );
    match domain.parse() {
        Ok(ip) => param.set_ip(ip),
        Err(_) => param.set_host(domain),
    }
}
