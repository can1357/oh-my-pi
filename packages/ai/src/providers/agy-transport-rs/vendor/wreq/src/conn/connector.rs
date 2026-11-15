use std::{
    borrow::Cow,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use futures_util::future::BoxFuture;
use tokio_btls::SslStream;
use tower::{
    BoxError, Layer, Service, ServiceBuilder, ServiceExt,
    util::{BoxCloneSyncService, Either, MapRequest, MapRequestLayer},
};

#[cfg(unix)]
use super::net::UnixConnector;
use super::{
    AsyncConnWithInfo, BoxedConnectorLayer, BoxedTransportConnector, Conn, Connection,
    HttpConnector, TlsConn, TlsInfoFactory, Unnameable,
    descriptor::ConnectionDescriptor,
    http::HttpConnect,
    net::TcpConnector,
    proxy,
    timeout::{Timeout, TimeoutLayer},
    verbose::Verbose,
};
use crate::{
    dns::DynResolver,
    error::{ProxyConnect, map_timeout_to_connector_error},
    ext::UriExt,
    proxy::{Intercepted, Matcher as ProxyMatcher, matcher::Intercept},
    rt::Timer,
    tls::{
        TlsOptions,
        conn::{
            EstablishedConn, HttpsConnector, MaybeHttpsStream, TlsConnector, TlsConnectorBuilder,
        },
    },
};

/// Client-wide connection settings retained by each transport connector.
///
/// These defaults control proxy selection, socket behavior, stream instrumentation, and TLS
/// metadata. Settings that can vary per request remain in [`ConnectionDescriptor`] and are
/// applied when a connection starts.
#[derive(Clone)]
struct Config {
    proxies: Arc<Vec<ProxyMatcher>>,
    verbose: Verbose,
    nodelay: bool,
    tls_info: bool,
}

/// Assembles the transport service graph used by a client.
///
/// The builder owns DNS, TCP, TLS, and timeout configuration until [`ConnectorBuilder::build`]
/// places the timeout around the concrete connector and any user-provided layers.
pub struct ConnectorBuilder {
    config: Config,
    timer: Timer,
    timeout: Option<Duration>,
    #[cfg(feature = "socks")]
    resolver: DynResolver,
    http: HttpConnector,
    builder: TlsConnectorBuilder,
}

/// Client-owned transport service selected when the connector graph is assembled.
///
/// The left branch keeps the graph concrete when no custom layers are present. The right branch
/// wraps the type-erased custom-layer graph so it also accepts [`ConnectionDescriptor`]. Both
/// branches remain with the client and create a separately timed future for each connection
/// attempt.
pub type Connector = Either<
    Timeout<TransportConnector>,
    MapRequest<BoxedTransportConnector, fn(ConnectionDescriptor) -> Unnameable>,
>;

/// Establishes the transport consumed by the HTTP protocol layer.
///
/// Each call selects the proxy path, applies request-specific socket and TLS settings, and returns
/// an established [`Conn`]. The service is cloned into each in-flight connection future, while its
/// immutable TLS builder is shared across those attempts.
#[derive(Clone)]
pub struct TransportConnector {
    config: Config,
    #[cfg(feature = "socks")]
    resolver: DynResolver,
    tls: TlsConnector,
    http: HttpConnector,
    builder: Arc<TlsConnectorBuilder>,
}

// ===== impl ConnectorBuilder =====

impl ConnectorBuilder {
    /// Creates a builder with the client's proxy and DNS configuration.
    pub(crate) fn new(proxies: Vec<ProxyMatcher>, resolver: DynResolver) -> Self {
        Self {
            config: Config {
                proxies: Arc::new(proxies),
                verbose: Verbose::OFF,
                nodelay: true,
                tls_info: false,
            },
            timer: Timer::default(),
            timeout: None,
            #[cfg(feature = "socks")]
            resolver: resolver.clone(),
            http: HttpConnector::new(resolver, TcpConnector::new()),
            builder: TlsConnector::builder(),
        }
    }

    /// Set the HTTP connector to use.
    #[inline]
    pub fn with_http<F>(mut self, call: F) -> ConnectorBuilder
    where
        F: FnOnce(&mut HttpConnector),
    {
        call(&mut self.http);
        self
    }

    /// Set the TLS connector builder to use.
    #[inline]
    pub fn with_tls<F>(mut self, call: F) -> ConnectorBuilder
    where
        F: FnOnce(TlsConnectorBuilder) -> TlsConnectorBuilder,
    {
        self.builder = call(self.builder);
        self
    }

    /// Set the connect timeout.
    #[inline]
    pub fn timeout(mut self, timeout: Option<Duration>) -> ConnectorBuilder {
        self.timeout = timeout;
        self
    }

    /// Set the timer used to drive the connect timeout.
    #[inline]
    pub fn timer(mut self, timer: Timer) -> ConnectorBuilder {
        self.timer = timer;
        self
    }

    /// Set connecting verbose mode.
    #[inline]
    pub fn verbose(mut self, enabled: bool) -> ConnectorBuilder {
        self.config.verbose.0 = enabled;
        self
    }

    /// Sets the TLS info flag.
    #[inline]
    pub fn tls_info(mut self, enabled: bool) -> ConnectorBuilder {
        self.config.tls_info = enabled;
        self
    }

    /// Sets the TCP_NODELAY option for connections.
    #[inline]
    pub fn tcp_nodelay(mut self, enabled: bool) -> ConnectorBuilder {
        self.config.nodelay = enabled;
        self
    }

    /// Build a [`Connector`] with the provided layers.
    pub fn build(
        self,
        tls_options: Option<TlsOptions>,
        layers: Vec<BoxedConnectorLayer>,
    ) -> crate::Result<Connector> {
        let timeout = TimeoutLayer::new(self.timer, self.timeout);
        let service = TransportConnector {
            config: self.config,
            #[cfg(feature = "socks")]
            resolver: self.resolver.clone(),
            http: self.http,
            tls: self
                .builder
                .build(tls_options.map(Cow::Owned).unwrap_or_default())?,
            builder: Arc::new(self.builder),
        };

        // we have no user-provided layers, only use concrete types
        if layers.is_empty() {
            return Ok(Either::Left(timeout.layer(service)));
        }

        // otherwise we have user provided layers
        // so we need type erasure all the way through
        // as well as mapping the unnameable type of the layers back to ConnectionDescriptor for the
        // inner service
        let service = layers.into_iter().fold(
            BoxCloneSyncService::new(
                ServiceBuilder::new()
                    .layer(MapRequestLayer::new(|request: Unnameable| request.0))
                    .service(service),
            ),
            |service, layer| ServiceBuilder::new().layer(layer).service(service),
        );

        // Keep the built-in timeout outside user layers so it covers their work too.
        // The final mapping also handles a tower timeout supplied by the caller.
        let service = ServiceBuilder::new()
            .layer(timeout)
            .service(service)
            .map_err(map_timeout_to_connector_error);

        let service = MapRequest::new(
            BoxCloneSyncService::new(service),
            Unnameable as fn(ConnectionDescriptor) -> Unnameable,
        );

        Ok(Either::Right(service))
    }
}

// ===== impl TransportConnector =====

impl TransportConnector {
    fn build_https_connector(
        &self,
        https: bool,
        descriptor: &ConnectionDescriptor,
    ) -> Result<HttpsConnector<HttpConnector>, BoxError> {
        let mut http = self.http.clone();

        // Disable Nagle's algorithm for TLS handshake
        //
        // https://www.openssl.org/docs/man1.1.1/man3/SSL_connect.html#NOTES
        if https && !self.config.nodelay {
            http.set_nodelay(true);
        }

        // Apply TCP options if provided in metadata
        if let Some(socket_opts) = descriptor.socket_bind_options() {
            http.set_local_addresses(socket_opts.ipv4_address, socket_opts.ipv6_address);
            #[cfg(any(
                target_os = "android",
                target_os = "fuchsia",
                target_os = "illumos",
                target_os = "ios",
                target_os = "linux",
                target_os = "macos",
                target_os = "solaris",
                target_os = "tvos",
                target_os = "visionos",
                target_os = "watchos",
            ))]
            if let Some(interface) = &socket_opts.interface {
                http.set_interface(interface.clone());
            }
        }

        // Prefer TLS options from metadata, fallback to default
        let tls = descriptor
            .tls_options()
            .map(|opts| self.builder.build(Cow::Borrowed(opts)))
            .transpose()?
            .unwrap_or_else(|| self.tls.clone());

        Ok(HttpsConnector::new(http, tls))
    }

    fn tunnel_conn_from_stream<IO>(&self, io: MaybeHttpsStream<IO>) -> Result<Conn, BoxError>
    where
        IO: AsyncConnWithInfo,
        TlsConn<IO>: Connection,
        SslStream<IO>: TlsInfoFactory,
    {
        let conn = match io {
            MaybeHttpsStream::Http(stream) => Conn {
                stream: self.config.verbose.wrap(stream),
                tls_info: false,
                proxy: None,
            },
            MaybeHttpsStream::Https(stream) => Conn {
                stream: self.config.verbose.wrap(TlsConn { stream }),
                tls_info: self.config.tls_info,
                proxy: None,
            },
        };

        Ok(conn)
    }

    fn conn_from_stream<IO, P>(&self, io: MaybeHttpsStream<IO>, proxy: P) -> Result<Conn, BoxError>
    where
        IO: AsyncConnWithInfo,
        TlsConn<IO>: Connection,
        SslStream<IO>: TlsInfoFactory,
        P: Into<Option<Intercept>>,
    {
        let conn = match io {
            MaybeHttpsStream::Http(stream) => self.config.verbose.wrap(stream),
            MaybeHttpsStream::Https(stream) => self.config.verbose.wrap(TlsConn { stream }),
        };

        Ok(Conn {
            stream: conn,
            tls_info: self.config.tls_info,
            proxy: proxy.into(),
        })
    }

    async fn connect_auto_proxy<P: Into<Option<Intercept>>>(
        self,
        descriptor: ConnectionDescriptor,
        proxy: P,
    ) -> Result<Conn, BoxError> {
        let is_https = descriptor.uri().is_https();
        let proxy = proxy.into();

        trace!("connect with maybe proxy: {:?}", proxy);

        let mut connector = self.build_https_connector(is_https, &descriptor)?;

        // When using a proxy for HTTPS targets, disable ALPN to avoid protocol negotiation issues
        if proxy.is_some() && is_https {
            connector.no_alpn();
        }

        let io = connector.call(descriptor).await?;

        // Re-enable Nagle's algorithm if it was disabled earlier
        if_tokio_rt!(block:{
            if is_https && !self.config.nodelay {
                io.as_ref().set_nodelay(false)?;
            }
        });

        self.conn_from_stream(io, proxy)
    }

    async fn connect_via_proxy(
        self,
        mut descriptor: ConnectionDescriptor,
        proxy: Intercepted,
    ) -> Result<Conn, BoxError> {
        let uri = descriptor.uri().clone();

        match proxy {
            Intercepted::Proxy(proxy) => {
                let is_https = uri.is_https();
                let proxy_uri = proxy.uri().clone();

                #[cfg(feature = "socks")]
                {
                    use proxy::socks::{DnsResolve, SocksConnector, Version};

                    if let Some((version, dns_resolve)) = match proxy_uri.scheme_str() {
                        Some("socks4") => Some((Version::V4, DnsResolve::Local)),
                        Some("socks4a") => Some((Version::V4, DnsResolve::Remote)),
                        Some("socks5") => Some((Version::V5, DnsResolve::Local)),
                        Some("socks5h") => Some((Version::V5, DnsResolve::Remote)),
                        _ => None,
                    } {
                        trace!("connecting via SOCKS proxy: {:?}", proxy_uri);

                        // Connect to the proxy and establish the SOCKS connection.
                        let conn = {
                            // Build a SOCKS connector.
                            let mut socks = SocksConnector::new(
                                proxy_uri,
                                self.http.clone(),
                                self.resolver.clone(),
                            );
                            socks.set_auth(proxy.raw_auth());
                            socks.set_version(version);
                            socks.set_dns_mode(dns_resolve);
                            socks.call(uri).await?
                        };

                        // Build an HTTPS connector.
                        let mut connector = self.build_https_connector(is_https, &descriptor)?;

                        // Wrap the established SOCKS connection with TLS if needed.
                        let io = connector
                            .call(EstablishedConn::new(conn, descriptor))
                            .await?;

                        // Re-enable Nagle's algorithm if it was disabled earlier
                        if_tokio_rt!(block:{
                            if is_https && !self.config.nodelay {
                                io.as_ref().set_nodelay(false)?;
                            }
                        });

                        return self.tunnel_conn_from_stream(io);
                    }
                }

                if is_https {
                    trace!("tunneling over HTTP(s) proxy: {:?}", proxy_uri);

                    // Build an HTTPS connector.
                    let mut connector = self.build_https_connector(is_https, &descriptor)?;

                    // Build a tunnel connector to establish the CONNECT tunnel.
                    let tunneled = {
                        let mut tunnel =
                            proxy::tunnel::TunnelConnector::new(proxy_uri, connector.clone());

                        // If the proxy requires basic authentication, add it to the tunnel.
                        if let Some(auth) = proxy.basic_auth() {
                            tunnel = tunnel.with_auth(auth.clone());
                        }

                        // If the proxy has custom headers, add them to the tunnel.
                        if let Some(headers) = proxy.custom_headers() {
                            tunnel = tunnel.with_headers(headers.clone());
                        }

                        // Connect to the proxy and establish the tunnel.
                        tunnel.call(uri).await?
                    };

                    // Wrap the established tunneled stream with TLS.
                    let io = connector
                        .call(EstablishedConn::new(tunneled, descriptor))
                        .await?;

                    // Re-enable Nagle's algorithm if it was disabled earlier
                    if_tokio_rt!(block:{
                        if !self.config.nodelay {
                            io.as_ref().as_ref().set_nodelay(false)?;
                        }
                    });

                    return self.tunnel_conn_from_stream(io);
                }

                *descriptor.uri_mut() = proxy_uri;
                self.connect_auto_proxy(descriptor, proxy)
                    .await
                    .map_err(ProxyConnect)
                    .map_err(Into::into)
            }
            #[cfg(unix)]
            Intercepted::Unix(unix_socket) => {
                trace!("connecting via Unix socket: {:?}", unix_socket);

                // Create a Unix connector with the specified socket path.
                let mut connector =
                    HttpsConnector::new(UnixConnector::new(unix_socket), self.tls.clone());

                // If the target URI is HTTPS, establish a CONNECT tunnel over the Unix socket,
                // then upgrade the tunneled stream to TLS.
                if uri.is_https() {
                    // Use a dummy HTTP URI so the HTTPS connector works over the Unix socket.
                    let proxy_uri = http::Uri::from_static("http://localhost");

                    // The tunnel connector will first establish a CONNECT tunnel,
                    // then perform the TLS handshake over the tunneled stream.
                    let tunneled = {
                        // Create a tunnel connector using the Unix socket and the HTTPS
                        // connector.
                        let mut tunnel =
                            proxy::tunnel::TunnelConnector::new(proxy_uri, connector.clone());

                        tunnel.call(uri).await?
                    };

                    // Wrap the established tunneled stream with TLS.
                    let io = connector
                        .call(EstablishedConn::new(tunneled, descriptor))
                        .await?;

                    return self.tunnel_conn_from_stream(io);
                }

                // For plain HTTP, use the Unix connector directly.
                let io = connector.call(descriptor).await?;

                self.conn_from_stream(io, None)
            }
        }
    }

    async fn connect_auto(self, req: ConnectionDescriptor) -> Result<Conn, BoxError> {
        debug!("starting new connection: {:?}", req.uri());

        // Determine if a proxy should be used for this request.
        let intercepted = req
            .proxy()
            .and_then(|prox| prox.intercept(req.uri()))
            .or_else(|| {
                self.config
                    .proxies
                    .iter()
                    .find_map(|prox| prox.intercept(req.uri()))
            });

        // If a proxy is matched, connect via proxy; otherwise, connect directly.
        if let Some(intercepted) = intercepted {
            self.connect_via_proxy(req, intercepted).await
        } else {
            self.connect_auto_proxy(req, None).await
        }
    }
}

impl Service<ConnectionDescriptor> for TransportConnector {
    type Response = Conn;
    type Error = BoxError;
    type Future = BoxFuture<'static, Result<Conn, BoxError>>;

    #[inline]
    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    #[inline]
    fn call(&mut self, descriptor: ConnectionDescriptor) -> Self::Future {
        Box::pin(self.clone().connect_auto(descriptor))
    }
}
