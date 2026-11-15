use std::{
    borrow::Cow,
    task::{Context, Poll},
};

use bytes::Bytes;
use http::Uri;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_socks::{
    TargetAddr,
    tcp::{Socks4Stream, Socks5Stream},
};
use tower::Service;

use super::Tunneling;
use crate::{
    dns::{DnsResolver, GaiResolver, Name, resolve},
    error::BoxError,
    ext::UriExt,
};

#[derive(Debug)]
pub enum SocksError {
    ConnectFailed(BoxError),
    DnsResolveFailure(BoxError),
    Socks(tokio_socks::Error),
    Io(std::io::Error),
    Utf8(std::str::Utf8Error),
    DnsFailure,
    MissingHost,
}

impl std::fmt::Display for SocksError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SOCKS error: ")?;

        match self {
            Self::ConnectFailed(e) => {
                f.write_fmt(format_args!("failed to create underlying connection: {e}"))
            }
            Self::Socks(e) => f.write_fmt(format_args!("error during SOCKS handshake: {e}")),
            Self::Io(e) => f.write_fmt(format_args!("io error during SOCKS handshake: {e}")),
            Self::Utf8(e) => f.write_fmt(format_args!(
                "invalid UTF-8 during SOCKS authentication: {e}"
            )),
            Self::DnsResolveFailure(e) => {
                f.write_fmt(format_args!("failed to resolve DNS for SOCKS target: {e}"))
            }
            Self::DnsFailure => f.write_str("could not resolve to acceptable address type"),
            Self::MissingHost => f.write_str("missing destination host"),
        }
    }
}

impl std::error::Error for SocksError {}

impl From<std::io::Error> for SocksError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<std::str::Utf8Error> for SocksError {
    fn from(err: std::str::Utf8Error) -> Self {
        Self::Utf8(err)
    }
}

impl From<tokio_socks::Error> for SocksError {
    fn from(err: tokio_socks::Error) -> Self {
        Self::Socks(err)
    }
}

/// Represents the SOCKS protocol version.
#[derive(Clone, Copy)]
#[repr(u8)]
pub enum Version {
    V4,
    V5,
}

/// Represents the DNS resolution strategy for SOCKS connections.
#[derive(Clone, Copy)]
#[repr(u8)]
pub enum DnsResolve {
    Local,
    Remote,
}

/// A connector that establishes connections through a SOCKS proxy.
pub struct SocksConnector<C, R = GaiResolver> {
    inner: C,
    resolver: R,
    proxy_dst: Uri,
    auth: Option<(Bytes, Bytes)>,
    version: Version,
    dns_resolve: DnsResolve,
}

impl<C, R> SocksConnector<C, R>
where
    R: DnsResolver + Clone,
{
    /// Create a new [`SocksConnector`].
    pub fn new(proxy_dst: Uri, inner: C, resolver: R) -> Self {
        SocksConnector {
            inner,
            resolver,
            proxy_dst,
            version: Version::V5,
            dns_resolve: DnsResolve::Local,
            auth: None,
        }
    }

    /// Sets the authentication credentials for the SOCKS proxy connection.
    #[inline]
    pub fn set_auth(&mut self, auth: Option<(Bytes, Bytes)>) {
        self.auth = auth;
    }

    /// Sets whether to use the SOCKS5 protocol for the proxy connection.
    #[inline]
    pub fn set_version(&mut self, version: Version) {
        self.version = version;
    }

    /// Sets whether to resolve DNS locally or let the proxy handle DNS resolution.
    #[inline]
    pub fn set_dns_mode(&mut self, dns_resolve: DnsResolve) {
        self.dns_resolve = dns_resolve;
    }
}

impl<C, R> Service<Uri> for SocksConnector<C, R>
where
    C: Service<Uri>,
    C::Future: Send + 'static,
    C::Response: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C::Error: Into<BoxError>,
    R: DnsResolver + Clone + Send + 'static,
    R::Future: Send + 'static,
{
    type Response = C::Response;
    type Error = SocksError;
    type Future = Tunneling<C::Future, C::Response, Self::Error>;

    #[inline]
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner
            .poll_ready(cx)
            .map_err(Into::into)
            .map_err(SocksError::ConnectFailed)
    }

    fn call(&mut self, dst: Uri) -> Self::Future {
        let connecting = self.inner.call(self.proxy_dst.clone());

        let version = self.version;
        let dns_resolve = self.dns_resolve;
        let auth = self.auth.clone();
        let mut resolver = self.resolver.clone();

        let fut = async move {
            let host = dst.host().ok_or(SocksError::MissingHost)?;
            let host = crate::util::strip_ipv6_brackets(host);
            let port = dst.port_or_default();

            // Attempt to tcp connect to the proxy server.
            // This will return a `tokio::net::TcpStream` if successful.
            let socket = connecting
                .await
                .map_err(Into::into)
                .map_err(SocksError::ConnectFailed)?;

            // Resolve the target address using the provided resolver.
            let target_addr = match dns_resolve {
                DnsResolve::Local => {
                    let mut socket_addr = resolve(&mut resolver, Name::new(host.into()))
                        .await
                        .map(|mut s| s.next())
                        .transpose()
                        .ok_or(SocksError::DnsFailure)?
                        .map_err(Into::into)
                        .map_err(SocksError::DnsResolveFailure)?;
                    socket_addr.set_port(port);
                    TargetAddr::Ip(socket_addr)
                }
                DnsResolve::Remote => TargetAddr::Domain(Cow::Borrowed(host), port),
            };

            match version {
                Version::V4 => {
                    // For SOCKS4, we connect directly to the target address.
                    let stream = Socks4Stream::connect_with_socket(socket, target_addr).await?;
                    Ok(stream.into_inner())
                }
                Version::V5 => {
                    // For SOCKS5, we need to handle authentication if provided.
                    // The `auth` is an optional tuple of (username, password).
                    let stream = match auth {
                        Some((username, password)) => {
                            let username = std::str::from_utf8(&username)?;
                            let password = std::str::from_utf8(&password)?;
                            Socks5Stream::connect_with_password_and_socket(
                                socket,
                                target_addr,
                                username,
                                password,
                            )
                            .await?
                        }
                        None => Socks5Stream::connect_with_socket(socket, target_addr).await?,
                    };
                    Ok(stream.into_inner())
                }
            }
        };

        Tunneling {
            fut: Box::pin(fut),
            _marker: Default::default(),
        }
    }
}
