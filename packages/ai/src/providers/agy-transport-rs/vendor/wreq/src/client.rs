pub(super) mod body;
pub(super) mod emulate;
pub(super) mod future;
pub(super) mod layer;
pub(super) mod request;
pub(super) mod response;
pub(super) mod upgrade;

#[cfg(feature = "multipart")]
pub mod multipart;
#[cfg(feature = "ws")]
pub mod ws;

use std::{
    borrow::Cow,
    collections::HashMap,
    convert::TryInto,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    num::NonZeroUsize,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};

use http::header::{HeaderMap, HeaderValue, USER_AGENT};
use tower::{
    BoxError, Layer, Service, ServiceBuilder, ServiceExt,
    retry::{Retry, RetryLayer},
    util::{BoxCloneSyncService, BoxCloneSyncServiceLayer, Either, Oneshot},
};
use wreq_proto::body::Incoming;

#[cfg(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate",
))]
use self::layer::decoder::{AcceptEncoding, DecompressionLayer};
#[cfg(feature = "ws")]
use self::ws::WebSocketRequestBuilder;
use self::{
    body::Body,
    emulate::IntoEmulation,
    future::Pending,
    layer::{
        client::HttpClient,
        config::{ConfigService, ConfigServiceLayer},
        redirect::{FollowRedirect, FollowRedirectLayer},
        retry::RetryPolicy,
        timeout::{Timeout, TimeoutLayer, TimeoutOptions, body::TimeoutBody},
    },
    request::{Request, RequestBuilder},
    response::Response,
};
#[cfg(feature = "cookies")]
use crate::cookie;
#[cfg(feature = "hickory-dns")]
use crate::dns::hickory::HickoryDnsResolver;
use crate::{
    IntoUri, Method, Proxy,
    conn::{
        BoxedConnectorLayer, BoxedTransportConnector, Conn, Unnameable,
        connector::{Connector, ConnectorBuilder},
        http::HttpConnect,
        net::SocketBindOptions,
    },
    dns::{DnsResolverWithOverrides, DynResolver, GaiResolver, IntoResolve, Resolve},
    error::{self, Error},
    header::OrigHeaderMap,
    http1::Http1Options,
    http2::Http2Options,
    proxy::Matcher as ProxyMatcher,
    redirect::{self, FollowRedirectPolicy},
    retry,
    rt::{Executor, Timer},
    tls::{
        AlpnProtocol, TlsOptions, TlsVersion,
        keylog::KeyLog,
        session::{IntoTlsSessionCache, TlsSessionCache},
        trust::{CertStore, Identity},
    },
};

#[cfg(not(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate"
)))]
type MaybeDecompression<T> = T;

#[cfg(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate"
))]
type MaybeDecompression<T> = self::layer::decoder::Decompression<T>;

#[cfg(not(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate"
)))]
type MaybeDecompressionBody<T> = T;

#[cfg(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate"
))]
type MaybeDecompressionBody<T> = tower_http::decompression::DecompressionBody<T>;

type ClientService = Timeout<
    ConfigService<
        MaybeDecompression<Retry<RetryPolicy, FollowRedirect<HttpClient<Connector, Body>>>>,
    >,
>;

type BoxedClientService = BoxCloneSyncService<
    http::Request<Body>,
    http::Response<TimeoutBody<MaybeDecompressionBody<Incoming>>>,
    BoxError,
>;

type BoxedClientServiceLayer = BoxCloneSyncServiceLayer<
    BoxCloneSyncService<
        http::Request<Body>,
        http::Response<MaybeDecompressionBody<Incoming>>,
        BoxError,
    >,
    http::Request<Body>,
    http::Response<MaybeDecompressionBody<Incoming>>,
    BoxError,
>;

/// An [`Client`] to make Requests with.
///
/// The Client has various configuration values to tweak, but the defaults
/// are set to what is usually the most commonly desired value. To configure a
/// [`Client`], use [`Client::builder()`].
///
/// The [`Client`] holds a connection pool internally, so it is advised that
/// you create one and **reuse** it.
///
/// You do **not** have to wrap the [`Client`] in an [`Rc`] or [`Arc`] to **reuse** it,
/// because it already uses an [`Arc`] internally.
///
/// [`Rc`]: std::rc::Rc
#[derive(Clone)]
pub struct Client(Arc<Either<ClientService, BoxedClientService>>);

/// A [`ClientBuilder`] can be used to create a [`Client`] with custom configuration.
#[must_use]
pub struct ClientBuilder {
    config: Config,
}

/// The HTTP version preference for the client.
#[repr(u8)]
enum HttpVersionPref {
    Http1,
    Http2,
    All,
}

struct Config {
    error: Option<Error>,
    headers: HeaderMap,
    orig_headers: OrigHeaderMap,
    #[cfg(any(
        feature = "gzip",
        feature = "zstd",
        feature = "brotli",
        feature = "deflate",
    ))]
    accept_encoding: AcceptEncoding,
    connect_timeout: Option<Duration>,
    connection_verbose: bool,
    pool_idle_timeout: Option<Duration>,
    pool_max_idle_per_host: usize,
    pool_max_size: Option<NonZeroUsize>,
    tcp_nodelay: bool,
    tcp_reuse_address: bool,
    tcp_linger: Option<Duration>,
    tcp_keepalive: Option<Duration>,
    tcp_keepalive_interval: Option<Duration>,
    tcp_keepalive_retries: Option<u32>,
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    tcp_user_timeout: Option<Duration>,
    tcp_send_buffer_size: Option<usize>,
    tcp_recv_buffer_size: Option<usize>,
    tcp_happy_eyeballs_timeout: Option<Duration>,
    socket_bind_options: SocketBindOptions,
    proxies: Vec<ProxyMatcher>,
    auto_sys_proxy: bool,
    retry_policy: retry::Policy,
    redirect_policy: redirect::Policy,
    referer: bool,
    timeout_options: TimeoutOptions,
    #[cfg(feature = "cookies")]
    cookie_store: Option<Arc<dyn cookie::CookieStore>>,
    #[cfg(feature = "hickory-dns")]
    hickory_dns: bool,
    dns_overrides: HashMap<Cow<'static, str>, Vec<SocketAddr>>,
    dns_resolver: Option<Arc<dyn Resolve>>,
    http_version_pref: HttpVersionPref,
    https_only: bool,
    layers: Vec<BoxedClientServiceLayer>,
    connector_layers: Vec<BoxedConnectorLayer>,
    tls_sni: bool,
    tls_info: bool,
    tls_keylog: Option<KeyLog>,
    tls_identity: Option<Identity>,
    tls_cert_store: Option<CertStore>,
    tls_cert_verification: bool,
    tls_verify_hostname: bool,
    tls_min_version: Option<TlsVersion>,
    tls_max_version: Option<TlsVersion>,
    tls_session_cache: Option<Arc<dyn TlsSessionCache>>,
    tls_options: Option<TlsOptions>,
    http1_options: Option<Http1Options>,
    http2_options: Option<Http2Options>,
    timer: Timer,
    executor: Executor,
}

// ===== impl Client =====

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

impl Client {
    /// Constructs a new [`Client`].
    ///
    /// # Panics
    ///
    /// This method panics if a TLS backend cannot be initialized, or the resolver
    /// cannot load the system configuration.
    ///
    /// Use [`Client::builder()`] if you wish to handle the failure as an [`Error`]
    /// instead of panicking.
    #[inline]
    pub fn new() -> Client {
        Client::builder().build().expect("Client::new()")
    }

    /// Creates a [`ClientBuilder`] to configure a [`Client`].
    pub fn builder() -> ClientBuilder {
        ClientBuilder {
            config: Config {
                error: None,
                headers: HeaderMap::new(),
                orig_headers: OrigHeaderMap::new(),
                #[cfg(any(
                    feature = "gzip",
                    feature = "zstd",
                    feature = "brotli",
                    feature = "deflate",
                ))]
                accept_encoding: AcceptEncoding::default(),
                connect_timeout: None,
                connection_verbose: false,
                pool_idle_timeout: Some(Duration::from_secs(90)),
                pool_max_idle_per_host: usize::MAX,
                pool_max_size: None,
                tcp_keepalive: Some(Duration::from_secs(15)),
                tcp_keepalive_interval: Some(Duration::from_secs(15)),
                tcp_keepalive_retries: Some(3),
                #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
                tcp_user_timeout: Some(Duration::from_secs(30)),
                tcp_nodelay: true,
                tcp_reuse_address: false,
                tcp_linger: None,
                tcp_send_buffer_size: None,
                tcp_recv_buffer_size: None,
                tcp_happy_eyeballs_timeout: Some(Duration::from_millis(300)),
                socket_bind_options: SocketBindOptions::default(),
                proxies: Vec::new(),
                auto_sys_proxy: true,
                retry_policy: retry::Policy::default(),
                redirect_policy: redirect::Policy::none(),
                referer: true,
                timeout_options: TimeoutOptions::default(),
                #[cfg(feature = "hickory-dns")]
                hickory_dns: cfg!(feature = "hickory-dns"),
                #[cfg(feature = "cookies")]
                cookie_store: None,
                dns_overrides: HashMap::new(),
                dns_resolver: None,
                http_version_pref: HttpVersionPref::All,
                https_only: false,
                http1_options: None,
                http2_options: None,
                layers: Vec::new(),
                connector_layers: Vec::new(),
                tls_sni: true,
                tls_info: false,
                tls_keylog: None,
                tls_identity: None,
                tls_cert_store: None,
                tls_cert_verification: true,
                tls_verify_hostname: true,
                tls_min_version: None,
                tls_max_version: None,
                tls_session_cache: None,
                tls_options: None,
                timer: Timer::default(),
                executor: Executor::default(),
            },
        }
    }

    /// Convenience method to make a `GET` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn get<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::GET, uri)
    }

    /// Convenience method to make a `POST` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn post<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::POST, uri)
    }

    /// Convenience method to make a `PUT` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn put<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::PUT, uri)
    }

    /// Convenience method to make a `PATCH` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn patch<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::PATCH, uri)
    }

    /// Convenience method to make a `DELETE` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn delete<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::DELETE, uri)
    }

    /// Convenience method to make a `HEAD` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn head<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::HEAD, uri)
    }

    /// Convenience method to make a `OPTIONS` request to a URI.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    #[inline]
    pub fn options<U: IntoUri>(&self, uri: U) -> RequestBuilder {
        self.request(Method::OPTIONS, uri)
    }

    /// Start building a `Request` with the `Method` and `Uri`.
    ///
    /// Returns a `RequestBuilder`, which will allow setting headers and
    /// the request body before sending.
    ///
    /// # Errors
    ///
    /// This method fails whenever the supplied `Uri` cannot be parsed.
    pub fn request<U: IntoUri>(&self, method: Method, uri: U) -> RequestBuilder {
        let req = uri.into_uri().map(move |uri| Request::new(method, uri));
        RequestBuilder::new(self.clone(), req)
    }

    /// Upgrades the [`RequestBuilder`] to perform a
    /// websocket handshake. This returns a wrapped type, so you must do
    /// this after you set up your request, and just before you send the
    /// request.
    #[inline]
    #[cfg(feature = "ws")]
    #[cfg_attr(docsrs, doc(cfg(feature = "ws")))]
    pub fn websocket<U: IntoUri>(&self, uri: U) -> WebSocketRequestBuilder {
        WebSocketRequestBuilder::new(self.request(Method::GET, uri))
    }

    /// Executes a `Request`.
    ///
    /// A `Request` can be built manually with `Request::new()` or obtained
    /// from a RequestBuilder with `RequestBuilder::build()`.
    ///
    /// You should prefer to use the `RequestBuilder` and
    /// `RequestBuilder::send()`.
    ///
    /// # Errors
    ///
    /// This method fails if there was an error while sending request,
    /// redirect loop was detected or redirect limit was exhausted.
    pub fn execute(&self, request: Request) -> Pending {
        let req = http::Request::<Body>::from(request);
        Pending::Request {
            uri: Some(req.uri().clone()),
            fut: Box::pin(Oneshot::new((*self.0).clone(), req)),
        }
    }
}

impl tower::Service<Request> for Client {
    type Response = Response;
    type Error = Error;
    type Future = Pending;

    #[inline(always)]
    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    #[inline(always)]
    fn call(&mut self, req: Request) -> Self::Future {
        self.execute(req)
    }
}

impl tower::Service<Request> for &'_ Client {
    type Response = Response;
    type Error = Error;
    type Future = Pending;

    #[inline(always)]
    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    #[inline(always)]
    fn call(&mut self, req: Request) -> Self::Future {
        self.execute(req)
    }
}

// ===== impl ClientBuilder =====

impl ClientBuilder {
    /// Returns a [`Client`] that uses this [`ClientBuilder`] configuration.
    ///
    /// # Errors
    ///
    /// This method fails if a TLS backend cannot be initialized, or the resolver
    /// cannot load the system configuration.
    pub fn build(self) -> crate::Result<Client> {
        let mut config = self.config;

        if let Some(err) = config.error {
            return Err(err);
        }

        // Prepare proxies
        if config.auto_sys_proxy {
            config.proxies.push(ProxyMatcher::system());
        }

        // Create base client service
        let service = {
            let resolver = {
                let mut resolver: Arc<dyn Resolve> = match config.dns_resolver {
                    Some(dns_resolver) => dns_resolver,
                    #[cfg(feature = "hickory-dns")]
                    None if config.hickory_dns => Arc::new(HickoryDnsResolver::new()),
                    None => Arc::new(GaiResolver::new()),
                };

                if !config.dns_overrides.is_empty() {
                    resolver = Arc::new(DnsResolverWithOverrides::new(
                        resolver,
                        config.dns_overrides,
                    ));
                }
                DynResolver::new(resolver)
            };

            let connector = ConnectorBuilder::new(config.proxies, resolver)
                .timer(config.timer.clone())
                .timeout(config.connect_timeout)
                .tls_info(config.tls_info)
                .tcp_nodelay(config.tcp_nodelay)
                .verbose(config.connection_verbose)
                .with_tls(|tls| {
                    tls.alpn_protocol(match config.http_version_pref {
                        HttpVersionPref::Http1 => Some(AlpnProtocol::HTTP1),
                        HttpVersionPref::Http2 => Some(AlpnProtocol::HTTP2),
                        _ => None,
                    })
                    .keylog(config.tls_keylog)
                    .cert_store(config.tls_cert_store)
                    .identity(config.tls_identity)
                    .max_version(config.tls_max_version)
                    .min_version(config.tls_min_version)
                    .tls_sni(config.tls_sni)
                    .verify_hostname(config.tls_verify_hostname)
                    .cert_verification(config.tls_cert_verification)
                    .session_store(config.tls_session_cache)
                })
                .with_http(|http| {
                    http.enforce_http(false);
                    http.set_keepalive(config.tcp_keepalive);
                    http.set_keepalive_interval(config.tcp_keepalive_interval);
                    http.set_keepalive_retries(config.tcp_keepalive_retries);
                    http.set_reuse_address(config.tcp_reuse_address);
                    http.set_linger(config.tcp_linger);
                    http.set_connect_timeout(config.connect_timeout);
                    http.set_nodelay(config.tcp_nodelay);
                    http.set_send_buffer_size(config.tcp_send_buffer_size);
                    http.set_recv_buffer_size(config.tcp_recv_buffer_size);
                    http.set_happy_eyeballs_timeout(config.tcp_happy_eyeballs_timeout);

                    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
                    http.set_tcp_user_timeout(config.tcp_user_timeout);

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
                    if let Some(interface) = config.socket_bind_options.interface {
                        http.set_interface(interface);
                    }

                    http.set_local_addresses(
                        config.socket_bind_options.ipv4_address,
                        config.socket_bind_options.ipv6_address,
                    );
                })
                .build(config.tls_options, config.connector_layers)?;

            #[allow(unused_mut)]
            let mut builder = HttpClient::builder(config.executor);

            #[cfg(feature = "cookies")]
            {
                builder = builder.cookie_store(config.cookie_store);
            }

            builder
                .http1_options(config.http1_options)
                .http2_options(config.http2_options)
                .http2_only(matches!(config.http_version_pref, HttpVersionPref::Http2))
                .http2_timer(config.timer.clone())
                .pool_timer(config.timer.clone())
                .pool_idle_timeout(config.pool_idle_timeout)
                .pool_max_idle_per_host(config.pool_max_idle_per_host)
                .pool_max_size(config.pool_max_size)
                .build(connector)
        };

        // Configured client service with layers
        let client = {
            let service = ServiceBuilder::new()
                .layer(RetryLayer::new(RetryPolicy::new(config.retry_policy)))
                .layer({
                    let policy = FollowRedirectPolicy::new(config.redirect_policy)
                        .with_referer(config.referer)
                        .with_https_only(config.https_only);
                    FollowRedirectLayer::with_policy(policy)
                })
                .service(service);

            #[cfg(any(
                feature = "gzip",
                feature = "zstd",
                feature = "brotli",
                feature = "deflate",
            ))]
            let service = ServiceBuilder::new()
                .layer(DecompressionLayer::new(config.accept_encoding))
                .service(service);

            let service = ServiceBuilder::new()
                .layer(ConfigServiceLayer::new(
                    config.https_only,
                    config.headers,
                    config.orig_headers,
                ))
                .service(service);

            if config.layers.is_empty() {
                let service = ServiceBuilder::new()
                    .layer(TimeoutLayer::new(config.timer, config.timeout_options))
                    .service(service);

                Either::Left(service)
            } else {
                let service = config
                    .layers
                    .into_iter()
                    .fold(BoxCloneSyncService::new(service), |service, layer| {
                        ServiceBuilder::new().layer(layer).service(service)
                    });

                let service = ServiceBuilder::new()
                    .layer(TimeoutLayer::new(config.timer, config.timeout_options))
                    .service(service)
                    .map_err(error::map_timeout_to_request_error);

                Either::Right(BoxCloneSyncService::new(service))
            }
        };

        Ok(Client(Arc::new(client)))
    }

    // Higher-level options

    /// Sets the `User-Agent` header to be used by this client.
    ///
    /// # Example
    ///
    /// ```rust
    /// # async fn doc() -> wreq::Result<()> {
    /// // Name your user agent after your app?
    /// static APP_USER_AGENT: &str = concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION"),);
    ///
    /// let client = wreq::Client::builder().user_agent(APP_USER_AGENT).build()?;
    /// let res = client.get("https://www.rust-lang.org").send().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn user_agent<V>(mut self, value: V) -> ClientBuilder
    where
        V: TryInto<HeaderValue>,
        V::Error: Into<http::Error>,
    {
        match value.try_into() {
            Ok(value) => {
                self.config.headers.insert(USER_AGENT, value);
            }
            Err(err) => {
                self.config.error = Some(Error::builder(err.into()));
            }
        };
        self
    }

    /// Sets the default headers for every request.
    ///
    /// # Example
    ///
    /// ```rust
    /// use wreq::header;
    /// # async fn doc() -> wreq::Result<()> {
    /// let mut headers = header::HeaderMap::new();
    /// headers.insert("X-MY-HEADER", header::HeaderValue::from_static("value"));
    ///
    /// // Consider marking security-sensitive headers with `set_sensitive`.
    /// let mut auth_value = header::HeaderValue::from_static("secret");
    /// auth_value.set_sensitive(true);
    /// headers.insert(header::AUTHORIZATION, auth_value);
    ///
    /// // get a client builder
    /// let client = wreq::Client::builder().default_headers(headers).build()?;
    /// let res = client.get("https://www.rust-lang.org").send().await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// Override the default headers:
    ///
    /// ```rust
    /// use wreq::header;
    /// # async fn doc() -> wreq::Result<()> {
    /// let mut headers = header::HeaderMap::new();
    /// headers.insert("X-MY-HEADER", header::HeaderValue::from_static("value"));
    ///
    /// // get a client builder
    /// let client = wreq::Client::builder().default_headers(headers).build()?;
    /// let res = client
    ///     .get("https://www.rust-lang.org")
    ///     .header("X-MY-HEADER", "new_value")
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn default_headers(mut self, headers: HeaderMap) -> ClientBuilder {
        crate::util::replace_headers(&mut self.config.headers, headers);
        self
    }

    /// Sets the original headers for every request.
    #[inline]
    pub fn orig_headers(mut self, orig_headers: OrigHeaderMap) -> ClientBuilder {
        self.config.orig_headers.extend(orig_headers);
        self
    }

    /// Enable a persistent cookie store for the client.
    ///
    /// Cookies received in responses will be preserved and included in
    /// additional requests.
    ///
    /// By default, no cookie store is used.
    ///
    /// # Optional
    ///
    /// This requires the optional `cookies` feature to be enabled.
    #[inline]
    #[cfg(feature = "cookies")]
    #[cfg_attr(docsrs, doc(cfg(feature = "cookies")))]
    pub fn cookie_store(mut self, enable: bool) -> ClientBuilder {
        if enable {
            self.cookie_provider(Arc::new(cookie::Jar::default()))
        } else {
            self.config.cookie_store = None;
            self
        }
    }

    /// Set the persistent cookie store for the client.
    ///
    /// Cookies received in responses will be passed to this store, and
    /// additional requests will query this store for cookies.
    ///
    /// By default, no cookie store is used.
    ///
    /// # Optional
    ///
    /// This requires the optional `cookies` feature to be enabled.
    #[inline]
    #[cfg(feature = "cookies")]
    #[cfg_attr(docsrs, doc(cfg(feature = "cookies")))]
    pub fn cookie_provider<C: cookie::IntoCookieStore>(mut self, cookie_store: C) -> ClientBuilder {
        self.config.cookie_store = Some(cookie_store.into_shared());
        self
    }

    /// Enable auto gzip decompression by checking the `Content-Encoding` response header.
    ///
    /// If auto gzip decompression is turned on:
    ///
    /// - Requests without `Accept-Encoding` advertise `gzip`. Range requests use `Accept-Encoding:
    ///   identity` instead. The request body is **not** automatically compressed.
    /// - When receiving a response, if its headers contain a `Content-Encoding` value of `gzip`,
    ///   both `Content-Encoding` and `Content-Length` are removed from the headers' set. The
    ///   response body is automatically decompressed.
    ///
    /// If the `gzip` feature is turned on, the default option is enabled.
    ///
    /// # Optional
    ///
    /// This requires the optional `gzip` feature to be enabled
    #[inline]
    #[cfg(feature = "gzip")]
    #[cfg_attr(docsrs, doc(cfg(feature = "gzip")))]
    pub fn gzip(mut self, enable: bool) -> ClientBuilder {
        self.config.accept_encoding.gzip = enable;
        self
    }

    /// Enable auto brotli decompression by checking the `Content-Encoding` response header.
    ///
    /// If auto brotli decompression is turned on:
    ///
    /// - Requests without `Accept-Encoding` advertise `br`. Range requests use `Accept-Encoding:
    ///   identity` instead. The request body is **not** automatically compressed.
    /// - When receiving a response, if its headers contain a `Content-Encoding` value of `br`, both
    ///   `Content-Encoding` and `Content-Length` are removed from the headers' set. The response
    ///   body is automatically decompressed.
    ///
    /// If the `brotli` feature is turned on, the default option is enabled.
    ///
    /// # Optional
    ///
    /// This requires the optional `brotli` feature to be enabled
    #[inline]
    #[cfg(feature = "brotli")]
    #[cfg_attr(docsrs, doc(cfg(feature = "brotli")))]
    pub fn brotli(mut self, enable: bool) -> ClientBuilder {
        self.config.accept_encoding.brotli = enable;
        self
    }

    /// Enable auto zstd decompression by checking the `Content-Encoding` response header.
    ///
    /// If auto zstd decompression is turned on:
    ///
    /// - Requests without `Accept-Encoding` advertise `zstd`. Range requests use `Accept-Encoding:
    ///   identity` instead. The request body is **not** automatically compressed.
    /// - When receiving a response, if its headers contain a `Content-Encoding` value of `zstd`,
    ///   both `Content-Encoding` and `Content-Length` are removed from the headers' set. The
    ///   response body is automatically decompressed.
    ///
    /// If the `zstd` feature is turned on, the default option is enabled.
    ///
    /// # Optional
    ///
    /// This requires the optional `zstd` feature to be enabled
    #[inline]
    #[cfg(feature = "zstd")]
    #[cfg_attr(docsrs, doc(cfg(feature = "zstd")))]
    pub fn zstd(mut self, enable: bool) -> ClientBuilder {
        self.config.accept_encoding.zstd = enable;
        self
    }

    /// Enable auto deflate decompression by checking the `Content-Encoding` response header.
    ///
    /// If auto deflate decompression is turned on:
    ///
    /// - Requests without `Accept-Encoding` advertise `deflate`. Range requests use
    ///   `Accept-Encoding: identity` instead. The request body is **not** automatically compressed.
    /// - When receiving a response, if it's headers contain a `Content-Encoding` value that equals
    ///   to `deflate`, both values `Content-Encoding` and `Content-Length` are removed from the
    ///   headers' set. The response body is automatically decompressed.
    ///
    /// If the `deflate` feature is turned on, the default option is enabled.
    ///
    /// # Optional
    ///
    /// This requires the optional `deflate` feature to be enabled
    #[inline]
    #[cfg(feature = "deflate")]
    #[cfg_attr(docsrs, doc(cfg(feature = "deflate")))]
    pub fn deflate(mut self, enable: bool) -> ClientBuilder {
        self.config.accept_encoding.deflate = enable;
        self
    }

    /// Disable auto response body zstd decompression.
    ///
    /// This method exists even if the optional `zstd` feature is not enabled.
    /// This can be used to ensure a `Client` doesn't use zstd decompression
    /// even if another dependency were to enable the optional `zstd` feature.
    #[inline]
    pub fn no_zstd(self) -> ClientBuilder {
        #[cfg(feature = "zstd")]
        {
            self.zstd(false)
        }

        #[cfg(not(feature = "zstd"))]
        {
            self
        }
    }

    /// Disable auto response body gzip decompression.
    ///
    /// This method exists even if the optional `gzip` feature is not enabled.
    /// This can be used to ensure a `Client` doesn't use gzip decompression
    /// even if another dependency were to enable the optional `gzip` feature.
    #[inline]
    pub fn no_gzip(self) -> ClientBuilder {
        #[cfg(feature = "gzip")]
        {
            self.gzip(false)
        }

        #[cfg(not(feature = "gzip"))]
        {
            self
        }
    }

    /// Disable auto response body brotli decompression.
    ///
    /// This method exists even if the optional `brotli` feature is not enabled.
    /// This can be used to ensure a `Client` doesn't use brotli decompression
    /// even if another dependency were to enable the optional `brotli` feature.
    #[inline]
    pub fn no_brotli(self) -> ClientBuilder {
        #[cfg(feature = "brotli")]
        {
            self.brotli(false)
        }

        #[cfg(not(feature = "brotli"))]
        {
            self
        }
    }

    /// Disable auto response body deflate decompression.
    ///
    /// This method exists even if the optional `deflate` feature is not enabled.
    /// This can be used to ensure a `Client` doesn't use deflate decompression
    /// even if another dependency were to enable the optional `deflate` feature.
    #[inline]
    pub fn no_deflate(self) -> ClientBuilder {
        #[cfg(feature = "deflate")]
        {
            self.deflate(false)
        }

        #[cfg(not(feature = "deflate"))]
        {
            self
        }
    }

    // Redirect options

    /// Set a `RedirectPolicy` for this client.
    ///
    /// Default will follow redirects up to a maximum of 10.
    #[inline]
    pub fn redirect(mut self, policy: redirect::Policy) -> ClientBuilder {
        self.config.redirect_policy = policy;
        self
    }

    /// Enable or disable automatic `Referer` management during redirects.
    ///
    /// When enabled, redirect responses can control how an existing `Referer`
    /// is forwarded through `Referrer-Policy`. No header is added when the
    /// request has none.
    ///
    /// Default is `true`.
    #[inline]
    pub fn referer(mut self, enable: bool) -> ClientBuilder {
        self.config.referer = enable;
        self
    }

    // Retry options

    /// Set a request retry policy.
    pub fn retry(mut self, policy: retry::Policy) -> ClientBuilder {
        self.config.retry_policy = policy;
        self
    }

    // Proxy options

    /// Add a `Proxy` to the list of proxies the `Client` will use.
    ///
    /// # Note
    ///
    /// Adding a proxy will disable the automatic usage of the "system" proxy.
    ///
    /// # Example
    /// ```
    /// use wreq::{Client, Proxy};
    ///
    /// let proxy = Proxy::http("http://proxy:8080").unwrap();
    /// let client = Client::builder().proxy(proxy).build().unwrap();
    /// ```
    #[inline]
    pub fn proxy(mut self, proxy: Proxy) -> ClientBuilder {
        self.config.proxies.push(proxy.into_matcher());
        self.config.auto_sys_proxy = false;
        self
    }

    /// Clear all `Proxies`, so `Client` will use no proxy anymore.
    ///
    /// # Note
    /// To add a proxy exclusion list, use [crate::proxy::Proxy::no_proxy()]
    /// on all desired proxies instead.
    ///
    /// This also disables the automatic usage of the "system" proxy.
    #[inline]
    pub fn no_proxy(mut self) -> ClientBuilder {
        self.config.proxies.clear();
        self.config.auto_sys_proxy = false;
        self
    }

    // Timeout options

    /// Enables a request timeout.
    ///
    /// The timeout is applied from when the request starts connecting until the
    /// response body has finished.
    ///
    /// Default is no timeout.
    #[inline]
    pub fn timeout(mut self, timeout: Duration) -> ClientBuilder {
        self.config.timeout_options.total_timeout(timeout);
        self
    }

    /// Sets a timeout for waiting for response headers and reading each body frame.
    ///
    /// Time spent by the caller between body reads is not counted.
    ///
    /// Default is `None`.
    #[inline]
    pub fn read_timeout(mut self, timeout: Duration) -> ClientBuilder {
        self.config.timeout_options.read_timeout(timeout);
        self
    }

    /// Set a timeout for only the connect phase of a `Client`.
    ///
    /// The timeout covers DNS resolution, the complete TCP address race,
    /// proxy tunneling, and the TLS handshake.
    ///
    /// Default is `None`.
    #[inline]
    pub fn connect_timeout(mut self, timeout: Duration) -> ClientBuilder {
        self.config.connect_timeout = Some(timeout);
        self
    }

    /// Set whether connections should emit verbose logs.
    ///
    /// Enabling this option will emit [log][] messages at the `TRACE` level
    /// for read and write operations on connections.
    ///
    /// [log]: https://crates.io/crates/log
    #[inline]
    pub fn connection_verbose(mut self, verbose: bool) -> ClientBuilder {
        self.config.connection_verbose = verbose;
        self
    }

    // HTTP options

    /// Set an optional timeout for idle sockets being kept-alive.
    ///
    /// Pass `None` to disable timeout.
    ///
    /// Default is 90 seconds.
    #[inline]
    pub fn pool_idle_timeout<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.pool_idle_timeout = val.into();
        self
    }

    /// Sets the maximum idle connection per host allowed in the pool.
    #[inline]
    pub fn pool_max_idle_per_host(mut self, max: usize) -> ClientBuilder {
        self.config.pool_max_idle_per_host = max;
        self
    }

    /// Sets the maximum number of connections in the pool.
    #[inline]
    pub fn pool_max_size(mut self, max: usize) -> ClientBuilder {
        self.config.pool_max_size = NonZeroUsize::new(max);
        self
    }

    /// Restrict the Client to be used with HTTPS only requests.
    ///
    /// Defaults to false.
    #[inline]
    pub fn https_only(mut self, enabled: bool) -> ClientBuilder {
        self.config.https_only = enabled;
        self
    }

    /// Only use HTTP/1.
    #[inline]
    pub fn http1_only(mut self) -> ClientBuilder {
        self.config.http_version_pref = HttpVersionPref::Http1;
        self
    }

    /// Only use HTTP/2.
    #[inline]
    pub fn http2_only(mut self) -> ClientBuilder {
        self.config.http_version_pref = HttpVersionPref::Http2;
        self
    }

    /// Sets the HTTP/1 options for the client.
    #[inline]
    pub fn http1_options<T>(mut self, options: T) -> ClientBuilder
    where
        T: Into<Option<Http1Options>>,
    {
        self.config.http1_options = options.into();
        self
    }

    /// Sets the HTTP/2 options for the client.
    #[inline]
    pub fn http2_options<T>(mut self, options: T) -> ClientBuilder
    where
        T: Into<Option<Http2Options>>,
    {
        self.config.http2_options = options.into();
        self
    }

    // TCP options

    /// Set whether sockets have `TCP_NODELAY` enabled.
    ///
    /// Default is `true`.
    #[inline]
    pub fn tcp_nodelay(mut self, enabled: bool) -> ClientBuilder {
        self.config.tcp_nodelay = enabled;
        self
    }

    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied duration.
    ///
    /// If `None`, the option will not be set.
    ///
    /// Default is 15 seconds.
    #[inline]
    pub fn tcp_keepalive<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.tcp_keepalive = val.into();
        self
    }

    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied interval.
    ///
    /// If `None`, the option will not be set.
    ///
    /// Default is 15 seconds.
    #[inline]
    pub fn tcp_keepalive_interval<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.tcp_keepalive_interval = val.into();
        self
    }

    /// Set that all sockets have `SO_KEEPALIVE` set with the supplied retry count.
    ///
    /// If `None`, the option will not be set.
    ///
    /// Default is 3 retries.
    #[inline]
    pub fn tcp_keepalive_retries<C>(mut self, retries: C) -> ClientBuilder
    where
        C: Into<Option<u32>>,
    {
        self.config.tcp_keepalive_retries = retries.into();
        self
    }

    /// Set that all sockets have `TCP_USER_TIMEOUT` set with the supplied duration.
    ///
    /// This option controls how long transmitted data may remain unacknowledged before
    /// the connection is force-closed.
    ///
    /// If `None`, the option will not be set.
    ///
    /// Default is 30 seconds.
    #[inline]
    #[cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux"))]
    #[cfg_attr(
        docsrs,
        doc(cfg(any(target_os = "android", target_os = "fuchsia", target_os = "linux")))
    )]
    pub fn tcp_user_timeout<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.tcp_user_timeout = val.into();
        self
    }

    /// Set whether sockets have `SO_REUSEADDR` enabled.
    #[inline]
    pub fn tcp_reuse_address(mut self, enabled: bool) -> ClientBuilder {
        self.config.tcp_reuse_address = enabled;
        self
    }

    /// Set that all sockets have `SO_LINGER` set with the supplied duration.
    ///
    /// This option controls how long the socket lingers on close while data
    /// remains unsent. A duration of zero aborts the connection on close: unsent
    /// data is discarded, the connection is reset (`RST`) rather than going
    /// through the normal `FIN` termination sequence, and the socket does not
    /// enter `TIME_WAIT`.
    ///
    /// If `None`, the option will not be set and the operating system default
    /// applies.
    ///
    /// Default is `None`.
    #[inline]
    pub fn tcp_linger<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.tcp_linger = val.into();
        self
    }

    /// Sets the size of the TCP send buffer on this client socket.
    ///
    /// On most operating systems, this sets the `SO_SNDBUF` socket option.
    #[inline]
    pub fn tcp_send_buffer_size<S>(mut self, size: S) -> ClientBuilder
    where
        S: Into<Option<usize>>,
    {
        self.config.tcp_send_buffer_size = size.into();
        self
    }

    /// Sets the size of the TCP receive buffer on this client socket.
    ///
    /// On most operating systems, this sets the `SO_RCVBUF` socket option.
    #[inline]
    pub fn tcp_recv_buffer_size<S>(mut self, size: S) -> ClientBuilder
    where
        S: Into<Option<usize>>,
    {
        self.config.tcp_recv_buffer_size = size.into();
        self
    }

    /// Set the delay between connection attempts for
    /// [RFC 8305 (Happy Eyeballs v2)][RFC 8305].
    ///
    /// The first address is attempted immediately. Later addresses are started
    /// after this delay without waiting for the previous attempt to finish.
    ///
    /// If `None`, parallel connection attempts are disabled.
    ///
    /// Default is 300 milliseconds.
    ///
    /// [RFC 8305]: https://www.rfc-editor.org/rfc/rfc8305.html#section-5
    #[inline]
    pub fn tcp_happy_eyeballs_timeout<D>(mut self, val: D) -> ClientBuilder
    where
        D: Into<Option<Duration>>,
    {
        self.config.tcp_happy_eyeballs_timeout = val.into();
        self
    }

    /// Bind to a local IP Address.
    ///
    /// # Example
    ///
    /// ```
    /// use std::net::IpAddr;
    /// let local_addr = IpAddr::from([12, 4, 1, 8]);
    /// let client = wreq::Client::builder()
    ///     .local_address(local_addr)
    ///     .build()
    ///     .unwrap();
    /// ```
    #[inline]
    pub fn local_address<T>(mut self, addr: T) -> ClientBuilder
    where
        T: Into<Option<IpAddr>>,
    {
        self.config
            .socket_bind_options
            .set_local_address(addr.into());
        self
    }

    /// Set that all sockets are bound to the configured IPv4 or IPv6 address (depending on host's
    /// preferences) before connection.
    ///
    ///  # Example
    /// ///
    /// ```
    /// use std::net::{Ipv4Addr, Ipv6Addr};
    /// let ipv4 = Ipv4Addr::new(127, 0, 0, 1);
    /// let ipv6 = Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1);
    /// let client = wreq::Client::builder()
    ///     .local_addresses(ipv4, ipv6)
    ///     .build()
    ///     .unwrap();
    /// ```
    #[inline]
    pub fn local_addresses<V4, V6>(mut self, ipv4: V4, ipv6: V6) -> ClientBuilder
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>,
    {
        self.config
            .socket_bind_options
            .set_local_addresses(ipv4, ipv6);
        self
    }

    /// Bind connections only on the specified network interface.
    ///
    /// This option is only available on the following operating systems:
    ///
    /// - Android
    /// - Fuchsia
    /// - Linux,
    /// - macOS and macOS-like systems (iOS, tvOS, watchOS and visionOS)
    /// - Solaris and illumos
    ///
    /// On Android, Linux, and Fuchsia, this uses the
    /// [`SO_BINDTODEVICE`][man-7-socket] socket option. On macOS and macOS-like
    /// systems, Solaris, and illumos, this instead uses the [`IP_BOUND_IF` and
    /// `IPV6_BOUND_IF`][man-7p-ip] socket options (as appropriate).
    ///
    /// Note that connections will fail if the provided interface name is not a
    /// network interface that currently exists when a connection is established.
    ///
    /// # Example
    ///
    /// ```
    /// # fn doc() -> Result<(), wreq::Error> {
    /// let interface = "lo";
    /// let client = wreq::Client::builder()
    ///     .interface(interface)
    ///     .build()?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// [man-7-socket]: https://man7.org/linux/man-pages/man7/socket.7.html
    /// [man-7p-ip]: https://docs.oracle.com/cd/E86824_01/html/E54777/ip-7p.html
    #[inline]
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
    #[cfg_attr(
        docsrs,
        doc(cfg(any(
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
        )))
    )]
    pub fn interface<T>(mut self, interface: T) -> ClientBuilder
    where
        T: Into<std::borrow::Cow<'static, str>>,
    {
        self.config.socket_bind_options.set_interface(interface);
        self
    }

    // TLS options

    /// Sets the identity to be used for client certificate authentication.
    #[inline]
    pub fn tls_identity(mut self, identity: Identity) -> ClientBuilder {
        self.config.tls_identity = Some(identity);
        self
    }

    /// Sets the verify certificate store for the client.
    ///
    /// This method allows you to specify a custom verify certificate store to be used
    /// for TLS connections. By default, the system's verify certificate store is used.
    #[inline]
    pub fn tls_cert_store(mut self, store: CertStore) -> ClientBuilder {
        self.config.tls_cert_store = Some(store);
        self
    }

    /// Controls the use of certificate validation.
    ///
    /// Defaults to `true`.
    ///
    /// # Warning
    ///
    /// You should think very carefully before using this method. If
    /// invalid certificates are trusted, *any* certificate for *any* site
    /// will be trusted for use. This includes expired certificates. This
    /// introduces significant vulnerabilities, and should only be used
    /// as a last resort.
    #[inline]
    pub fn tls_cert_verification(mut self, cert_verification: bool) -> ClientBuilder {
        self.config.tls_cert_verification = cert_verification;
        self
    }

    /// Configures the use of hostname verification when connecting.
    ///
    /// Defaults to `true`.
    /// # Warning
    ///
    /// You should think very carefully before you use this method. If hostname verification is not
    /// used, *any* valid certificate for *any* site will be trusted for use from any other. This
    /// introduces a significant vulnerability to man-in-the-middle attacks.
    #[inline]
    pub fn tls_verify_hostname(mut self, verify_hostname: bool) -> ClientBuilder {
        self.config.tls_verify_hostname = verify_hostname;
        self
    }

    /// Configures the use of Server Name Indication (SNI) when connecting.
    ///
    /// Defaults to `true`.
    #[inline]
    pub fn tls_sni(mut self, tls_sni: bool) -> ClientBuilder {
        self.config.tls_sni = tls_sni;
        self
    }

    /// Configures TLS key logging for the client.
    #[inline]
    pub fn tls_keylog(mut self, keylog: KeyLog) -> ClientBuilder {
        self.config.tls_keylog = Some(keylog);
        self
    }

    /// Set the minimum required TLS version for connections.
    ///
    /// By default the TLS backend's own default is used.
    #[inline]
    pub fn tls_min_version(mut self, version: TlsVersion) -> ClientBuilder {
        self.config.tls_min_version = Some(version);
        self
    }

    /// Set the maximum allowed TLS version for connections.
    ///
    /// By default there's no maximum.
    #[inline]
    pub fn tls_max_version(mut self, version: TlsVersion) -> ClientBuilder {
        self.config.tls_max_version = Some(version);
        self
    }

    /// Add TLS information as `TlsInfo` extension to responses.
    ///
    /// # Optional
    ///
    /// feature to be enabled.
    #[inline]
    pub fn tls_info(mut self, tls_info: bool) -> ClientBuilder {
        self.config.tls_info = tls_info;
        self
    }

    /// Sets the TLS session cache.
    ///
    /// By default, an in-memory LRU cache is used. Use this method to provide
    /// a custom [`TlsSessionCache`] implementation (e.g., file-based or distributed).
    #[inline]
    pub fn tls_session_cache<S: IntoTlsSessionCache>(mut self, store: S) -> ClientBuilder {
        self.config.tls_session_cache = Some(store.into_shared());
        self
    }

    /// Sets the TLS options for the client.
    #[inline]
    pub fn tls_options<T>(mut self, options: T) -> ClientBuilder
    where
        T: Into<Option<TlsOptions>>,
    {
        self.config.tls_options = options.into();
        self
    }

    // DNS options

    /// Disables the hickory-dns async resolver.
    ///
    /// This method exists even if the optional `hickory-dns` feature is not enabled.
    /// This can be used to ensure a `Client` doesn't use the hickory-dns async resolver
    /// even if another dependency were to enable the optional `hickory-dns` feature.
    #[inline]
    #[cfg(feature = "hickory-dns")]
    #[cfg_attr(docsrs, doc(cfg(feature = "hickory-dns")))]
    pub fn no_hickory_dns(mut self) -> ClientBuilder {
        self.config.hickory_dns = false;
        self
    }

    /// Override DNS resolution for specific domains to a particular IP address.
    ///
    /// Warning
    ///
    /// Since the DNS protocol has no notion of ports, if you wish to send
    /// traffic to a particular port you must include this port in the URI
    /// itself, any port in the overridden addr will be ignored and traffic sent
    /// to the conventional port for the given scheme (e.g. 80 for http).
    #[inline]
    pub fn resolve<D>(self, domain: D, addr: SocketAddr) -> ClientBuilder
    where
        D: Into<Cow<'static, str>>,
    {
        self.resolve_to_addrs(domain, std::iter::once(addr))
    }

    /// Override DNS resolution for specific domains to particular IP addresses.
    ///
    /// Warning
    ///
    /// Since the DNS protocol has no notion of ports, if you wish to send
    /// traffic to a particular port you must include this port in the URI
    /// itself, any port in the overridden addresses will be ignored and traffic sent
    /// to the conventional port for the given scheme (e.g. 80 for http).
    #[inline]
    pub fn resolve_to_addrs<D, A>(mut self, domain: D, addrs: A) -> ClientBuilder
    where
        D: Into<Cow<'static, str>>,
        A: IntoIterator<Item = SocketAddr>,
    {
        self.config
            .dns_overrides
            .insert(domain.into(), addrs.into_iter().collect());
        self
    }

    /// Override the DNS resolver implementation.
    ///
    /// Pass any type implementing `IntoResolve`.
    /// Overrides for specific names passed to `resolve` and `resolve_to_addrs` will
    /// still be applied on top of this resolver.
    #[inline]
    pub fn dns_resolver<R: IntoResolve>(mut self, resolver: R) -> ClientBuilder {
        self.config.dns_resolver = Some(resolver.into_shared());
        self
    }

    // Tower middleware options

    /// Adds a new Tower [`Layer`](https://docs.rs/tower/latest/tower/trait.Layer.html) to the
    /// request [`Service`](https://docs.rs/tower/latest/tower/trait.Service.html) which is responsible
    /// for request processing.
    ///
    /// Each subsequent invocation of this function will wrap previous layers.
    ///
    /// If configured, the `timeout` will be the outermost layer.
    ///
    /// Example usage:
    /// ```
    /// use std::time::Duration;
    ///
    /// let client = wreq::Client::builder()
    ///     .timeout(Duration::from_millis(200))
    ///     .layer(tower::timeout::TimeoutLayer::new(Duration::from_millis(50)))
    ///     .build()
    ///     .unwrap();
    /// ```
    #[inline]
    pub fn layer<L>(mut self, layer: L) -> ClientBuilder
    where
        L: Layer<
                BoxCloneSyncService<
                    http::Request<Body>,
                    http::Response<MaybeDecompressionBody<Incoming>>,
                    BoxError,
                >,
            > + Clone
            + Send
            + Sync
            + 'static,
        L::Service: Service<
                http::Request<Body>,
                Response = http::Response<MaybeDecompressionBody<Incoming>>,
                Error = BoxError,
            > + Clone
            + Send
            + Sync
            + 'static,
        <L::Service as Service<http::Request<Body>>>::Future: Send + 'static,
    {
        let layer = BoxCloneSyncServiceLayer::new(layer);
        self.config.layers.push(layer);
        self
    }

    /// Adds a new Tower [`Layer`](https://docs.rs/tower/latest/tower/trait.Layer.html) to the
    /// base connector [`Service`](https://docs.rs/tower/latest/tower/trait.Service.html) which
    /// is responsible for connection establishment.a
    ///
    /// Each subsequent invocation of this function will wrap previous layers.
    ///
    /// If configured, the `connect_timeout` will be the outermost layer.
    ///
    /// Example usage:
    /// ```
    /// use std::time::Duration;
    ///
    /// let client = wreq::Client::builder()
    ///     // resolved to outermost layer, meaning while we are waiting on concurrency limit
    ///     .connect_timeout(Duration::from_millis(200))
    ///     // underneath the concurrency check, so only after concurrency limit lets us through
    ///     .connector_layer(tower::timeout::TimeoutLayer::new(Duration::from_millis(50)))
    ///     .connector_layer(tower::limit::concurrency::ConcurrencyLimitLayer::new(2))
    ///     .build()
    ///     .unwrap();
    /// ```
    #[inline]
    pub fn connector_layer<L>(mut self, layer: L) -> ClientBuilder
    where
        L: Layer<BoxedTransportConnector> + Clone + Send + Sync + 'static,
        L::Service:
            Service<Unnameable, Response = Conn, Error = BoxError> + Clone + Send + Sync + 'static,
        <L::Service as Service<Unnameable>>::Future: Send + 'static,
    {
        let layer = BoxCloneSyncServiceLayer::new(layer);
        self.config.connector_layers.push(layer);
        self
    }

    // TLS/HTTP2 emulation options

    /// Configures the client builder to emulation the specified HTTP context.
    ///
    /// This method sets the necessary headers, HTTP/1 and HTTP/2 options configurations, and  TLS
    /// options config to use the specified HTTP context. It allows the client to mimic the
    /// behavior of different versions or setups, which can be useful for testing or ensuring
    /// compatibility with various environments.
    ///
    /// # Note
    /// This will overwrite the existing configuration.
    /// You must set emulation before you can perform subsequent HTTP1/HTTP2/TLS fine-tuning.
    #[inline]
    pub fn emulation<T: IntoEmulation>(self, emulation: T) -> ClientBuilder {
        let emulation = emulation.into_emulation();
        self.tls_options(emulation.tls_options)
            .http1_options(emulation.http1_options)
            .http2_options(emulation.http2_options)
            .default_headers(emulation.headers)
            .orig_headers(emulation.orig_headers)
    }
}
