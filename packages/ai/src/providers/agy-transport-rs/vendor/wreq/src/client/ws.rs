//! WebSocket Upgrade

#[cfg(feature = "json")]
mod json;
pub mod message;

use std::{
    borrow::Cow,
    fmt,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    ops::{Deref, DerefMut},
    pin::Pin,
    task::{Context, Poll, ready},
};

use bytes::Bytes;
use futures_util::{Sink, SinkExt, Stream, StreamExt, stream::FusedStream};
use http::{
    HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, Version, header, uri::Scheme,
};
use http2::ext::Protocol;
use pin_project_lite::pin_project;
use tokio_tungstenite::tungstenite::{
    self,
    protocol::{self, CloseFrame, WebSocketConfig},
};

use self::message::{CloseCode, Message, Utf8Bytes};
use super::{emulate::IntoEmulation, request::RequestBuilder, response::Response};
use crate::{Error, Upgraded, header::OrigHeaderMap, proxy::Proxy};

/// A WebSocket stream.
type WebSocketStream = tokio_tungstenite::WebSocketStream<Upgraded>;

/// Wrapper for [`RequestBuilder`] that performs the
/// websocket handshake when sent.
pub struct WebSocketRequestBuilder {
    inner: RequestBuilder,
    accept_key: Option<Cow<'static, str>>,
    protocols: Option<Vec<Cow<'static, str>>>,
    config: WebSocketConfig,
}

impl WebSocketRequestBuilder {
    /// Creates a new WebSocket request builder.
    pub fn new(inner: RequestBuilder) -> Self {
        Self {
            inner: inner.version(Version::HTTP_11),
            accept_key: None,
            protocols: None,
            config: WebSocketConfig::default(),
        }
    }

    /// Sets a custom WebSocket accept key.
    ///
    /// This method allows you to set a custom WebSocket accept key for the connection.
    ///
    /// # Arguments
    ///
    /// * `key` - The custom WebSocket accept key to set.
    ///
    /// # Returns
    ///
    /// * `Self` - The modified instance with the custom WebSocket accept key.
    #[inline]
    pub fn accept_key<K>(mut self, key: K) -> Self
    where
        K: Into<Cow<'static, str>>,
    {
        self.accept_key = Some(key.into());
        self
    }

    /// Set HTTP version
    ///
    /// Configures the HTTP version used for the WebSocket handshake.
    /// Defaults to HTTP/1.1.
    ///
    /// # HTTP/1.1 (default)
    ///
    /// - Uses the standard `Upgrade: websocket` mechanism (RFC 6455)
    /// - Sends an HTTP `GET` request with `Connection: Upgrade` and `Upgrade: websocket` headers
    /// - Widely supported by servers
    ///
    /// # HTTP/2
    ///
    /// - Uses the Extended CONNECT Protocol (RFC 8441)
    /// - Sends a `CONNECT` request with the `:protocol: websocket` pseudo-header instead of the
    ///   traditional upgrade mechanism
    /// - Requires explicit server support for HTTP/2 WebSocket connections
    /// - Will fail if the server does not support HTTP/2 WebSocket upgrade
    #[inline]
    pub fn version(mut self, version: Version) -> Self {
        self.inner = self.inner.version(version);
        self
    }

    /// Sets the websocket subprotocols to request.
    ///
    /// This method allows you to specify the subprotocols that the websocket client
    /// should request during the handshake. Subprotocols are used to define the type
    /// of communication expected over the websocket connection.
    #[inline]
    pub fn protocols<P>(mut self, protocols: P) -> Self
    where
        P: IntoIterator,
        P::Item: Into<Cow<'static, str>>,
    {
        let protocols = protocols.into_iter().map(Into::into).collect();
        self.protocols = Some(protocols);
        self
    }

    /// Sets the websocket max_frame_size configuration.
    #[inline]
    pub fn max_frame_size(mut self, max_frame_size: usize) -> Self {
        self.config.max_frame_size = Some(max_frame_size);
        self
    }

    /// Sets the websocket read_buffer_size configuration.
    #[inline]
    pub fn read_buffer_size(mut self, read_buffer_size: usize) -> Self {
        self.config.read_buffer_size = read_buffer_size;
        self
    }

    /// Sets the websocket write_buffer_size configuration.
    #[inline]
    pub fn write_buffer_size(mut self, write_buffer_size: usize) -> Self {
        self.config.write_buffer_size = write_buffer_size;
        self
    }

    /// Sets the websocket max_write_buffer_size configuration.
    #[inline]
    pub fn max_write_buffer_size(mut self, max_write_buffer_size: usize) -> Self {
        self.config.max_write_buffer_size = max_write_buffer_size;
        self
    }

    /// Sets the websocket max_message_size configuration.
    #[inline]
    pub fn max_message_size(mut self, max_message_size: usize) -> Self {
        self.config.max_message_size = Some(max_message_size);
        self
    }

    /// Sets the websocket accept_unmasked_frames configuration.
    #[inline]
    pub fn accept_unmasked_frames(mut self, accept_unmasked_frames: bool) -> Self {
        self.config.accept_unmasked_frames = accept_unmasked_frames;
        self
    }

    /// Add a `Header` to this Request.
    ///
    /// If the header is already present, the value will be replaced.
    #[inline]
    pub fn header<K, V>(mut self, key: K, value: V) -> Self
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.inner = self.inner.header(key, value);
        self
    }

    /// Add a set of Headers to the existing ones on this Request.
    ///
    /// The headers will be merged in to any already set.
    #[inline]
    pub fn headers(mut self, headers: HeaderMap) -> Self {
        self.inner = self.inner.headers(headers);
        self
    }

    /// Set the original headers for this request.
    #[inline]
    pub fn orig_headers(mut self, orig_headers: OrigHeaderMap) -> Self {
        self.inner = self.inner.orig_headers(orig_headers);
        self
    }

    /// Enable or disable client default headers for this request.
    ///
    /// By default, client default headers are included. Set to `false` to skip them.
    pub fn default_headers(mut self, enable: bool) -> Self {
        self.inner = self.inner.default_headers(enable);
        self
    }

    /// Enable HTTP authentication.
    ///
    /// ```rust
    /// # use wreq::Error;
    /// #
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let resp = client
    ///     .websocket("http://httpbin.org/get")
    ///     .auth("your_token_here")
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn auth<V>(mut self, value: V) -> Self
    where
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.inner = self.inner.auth(value);
        self
    }

    /// Enable HTTP basic authentication.
    ///
    /// ```rust
    /// # use wreq::Error;
    ///
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let resp = client
    ///     .websocket("http://httpbin.org/delete")
    ///     .basic_auth("admin", Some("good password"))
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn basic_auth<U, P>(mut self, username: U, password: Option<P>) -> Self
    where
        U: fmt::Display,
        P: fmt::Display,
    {
        self.inner = self.inner.basic_auth(username, password);
        self
    }

    /// Enable HTTP bearer authentication.
    ///
    /// ```rust
    /// # use wreq::Error;
    /// #
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let resp = client
    ///     .websocket("http://httpbin.org/get")
    ///     .bearer_auth("your_token_here")
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn bearer_auth<T>(mut self, token: T) -> Self
    where
        T: fmt::Display,
    {
        self.inner = self.inner.bearer_auth(token);
        self
    }

    /// Modify the query string of the URI.
    ///
    /// Modifies the URI of this request, adding the parameters provided.
    /// This method appends and does not overwrite. This means that it can
    /// be called multiple times and that existing query parameters are not
    /// overwritten if the same key is used. The key will simply show up
    /// twice in the query string.
    /// Calling `.query(&[("foo", "a"), ("foo", "b")])` gives `"foo=a&foo=b"`.
    /// Existing URI components and query encoding are preserved.
    ///
    /// # Note
    /// This method does not support serializing a single key-value
    /// pair. Instead of using `.query(("key", "val"))`, use a sequence, such
    /// as `.query(&[("key", "val")])`. It's also possible to serialize structs
    /// and maps into a key-value pair.
    ///
    /// # Errors
    /// This method fails if the parameters cannot be serialized or the
    /// resulting URI is invalid.
    #[inline]
    #[cfg(feature = "query")]
    #[cfg_attr(docsrs, doc(cfg(feature = "query")))]
    pub fn query<T: serde::Serialize + ?Sized>(mut self, query: &T) -> Self {
        self.inner = self.inner.query(query);
        self
    }

    /// Set the proxy for this request.
    #[inline]
    pub fn proxy(mut self, proxy: Proxy) -> Self {
        self.inner = self.inner.proxy(proxy);
        self
    }

    /// Set the local address for this request.
    #[inline]
    pub fn local_address<V>(mut self, local_address: V) -> Self
    where
        V: Into<Option<IpAddr>>,
    {
        self.inner = self.inner.local_address(local_address);
        self
    }

    /// Set the local addresses for this request.
    #[inline]
    pub fn local_addresses<V4, V6>(mut self, ipv4: V4, ipv6: V6) -> Self
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>,
    {
        self.inner = self.inner.local_addresses(ipv4, ipv6);
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
    pub fn interface<I>(mut self, interface: I) -> Self
    where
        I: Into<std::borrow::Cow<'static, str>>,
    {
        self.inner = self.inner.interface(interface);
        self
    }

    /// Sets the request builder to emulation the specified HTTP context.
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
    pub fn emulation<T: IntoEmulation>(mut self, emulation: T) -> Self {
        self.inner = self.inner.emulation(emulation);
        self
    }

    /// Sends the request and returns and [`WebSocketResponse`].
    pub async fn send(self) -> Result<WebSocketResponse, Error> {
        let (client, request) = self.inner.build_split();
        let mut request = request?;

        // Ensure the scheme is http or https
        let uri = request.uri_mut();
        let scheme = match uri.scheme_str() {
            Some("ws") => Some(Scheme::HTTP),
            Some("wss") => Some(Scheme::HTTPS),
            _ => None,
        };
        if scheme.is_some() {
            let mut parts = uri.clone().into_parts();
            parts.scheme = scheme;
            *uri = Uri::from_parts(parts).map_err(Error::builder)?;
        }

        // Get the version of the request
        let version = request.version();

        // Set the headers for the websocket handshake
        let headers = request.headers_mut();
        headers.insert(
            header::SEC_WEBSOCKET_VERSION,
            HeaderValue::from_static("13"),
        );

        // Ensure the request is HTTP 1.1/HTTP 2
        let accept_key = match version {
            Some(Version::HTTP_10 | Version::HTTP_11) => {
                // Generate a nonce if one wasn't provided
                let nonce = self
                    .accept_key
                    .unwrap_or_else(|| Cow::Owned(tungstenite::handshake::client::generate_key()));

                headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
                headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
                headers.insert(
                    header::SEC_WEBSOCKET_KEY,
                    HeaderValue::from_str(&nonce).map_err(Error::builder)?,
                );

                *request.method_mut() = Method::GET;
                *request.version_mut() = Some(Version::HTTP_11);
                Some(nonce)
            }
            Some(Version::HTTP_2) => {
                *request.method_mut() = Method::CONNECT;
                *request.version_mut() = Some(Version::HTTP_2);
                request
                    .extensions_mut()
                    .insert(Protocol::from_static("websocket"));
                None
            }
            unsupported => {
                return Err(Error::upgrade(format!(
                    "unsupported version: {unsupported:?}"
                )));
            }
        };

        // Set websocket subprotocols
        if let Some(ref protocols) = self.protocols {
            // Sets subprotocols
            if !protocols.is_empty() {
                let subprotocols = protocols
                    .iter()
                    .map(|s| s.as_ref())
                    .collect::<Vec<&str>>()
                    .join(", ");

                request.headers_mut().insert(
                    header::SEC_WEBSOCKET_PROTOCOL,
                    HeaderValue::from_maybe_shared(Bytes::from(subprotocols))
                        .map_err(Error::builder)?,
                );
            }
        }

        client
            .execute(request)
            .await
            .map(|inner| WebSocketResponse {
                inner,
                accept_key,
                protocols: self.protocols,
                config: self.config,
            })
    }
}

/// The server's response to the websocket upgrade request.
///
/// This implements `Deref<Target = Response>`, so you can access all the usual
/// information from the [`Response`].
#[derive(Debug)]
pub struct WebSocketResponse {
    inner: Response,
    accept_key: Option<Cow<'static, str>>,
    protocols: Option<Vec<Cow<'static, str>>>,
    config: WebSocketConfig,
}

impl Deref for WebSocketResponse {
    type Target = Response;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

impl DerefMut for WebSocketResponse {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.inner
    }
}

impl WebSocketResponse {
    /// Turns the response into a websocket. This checks if the websocket
    /// handshake was successful.
    pub async fn into_websocket(self) -> Result<WebSocket, Error> {
        let (inner, protocol) = {
            let status = self.inner.status();
            let headers = self.inner.headers();

            match self.inner.version() {
                // HTTP/1.0 and HTTP/1.1 use the traditional upgrade mechanism
                Version::HTTP_10 | Version::HTTP_11 => {
                    if status != StatusCode::SWITCHING_PROTOCOLS {
                        return Err(Error::upgrade(format!("unexpected status code: {status}")));
                    }

                    if !header_contains(self.inner.headers(), header::CONNECTION, "upgrade") {
                        return Err(Error::upgrade("missing connection header"));
                    }

                    if !header_eq(self.inner.headers(), header::UPGRADE, "websocket") {
                        return Err(Error::upgrade("invalid upgrade header"));
                    }

                    match self
                        .accept_key
                        .zip(headers.get(header::SEC_WEBSOCKET_ACCEPT))
                    {
                        Some((nonce, header)) => {
                            if !header.to_str().is_ok_and(|s| {
                                s == tungstenite::handshake::derive_accept_key(nonce.as_bytes())
                            }) {
                                return Err(Error::upgrade(format!(
                                    "invalid accept key: {header:?}"
                                )));
                            }
                        }
                        None => {
                            return Err(Error::upgrade("missing accept key"));
                        }
                    }
                }
                // HTTP/2 uses the Extended CONNECT Protocol (RFC 8441)
                // See: https://datatracker.ietf.org/doc/html/rfc8441
                Version::HTTP_2 => {
                    if status != StatusCode::OK {
                        return Err(Error::upgrade(format!("unexpected status code: {status}")));
                    }
                }
                _ => {
                    return Err(Error::upgrade(format!(
                        "unsupported version: {:?}",
                        self.inner.version()
                    )));
                }
            }

            let protocol = headers.get(header::SEC_WEBSOCKET_PROTOCOL).cloned();
            let requested = self.protocols.as_ref().filter(|p| !p.is_empty());
            let replied = protocol.as_ref().and_then(|v| v.to_str().ok());

            match (requested, replied) {
                // okay, we requested protocols and got one back
                (Some(req), Some(rep)) => {
                    if !req.contains(&Cow::Borrowed(rep)) {
                        return Err(Error::upgrade(format!("invalid protocol: {rep}")));
                    }
                }
                // server didn't reply with a protocol
                (Some(_), None) => {
                    return Err(Error::upgrade(format!(
                        "missing protocol: {:?}",
                        self.protocols
                    )));
                }
                // we didn't request any protocols, but got one anyway
                (None, Some(_)) => {
                    return Err(Error::upgrade(format!("invalid protocol: {protocol:?}")));
                }
                // we didn't request any protocols, so we don't expect one
                (None, None) => {}
            };

            let inner = WebSocketStream::from_raw_socket(
                self.inner.upgrade().await?,
                protocol::Role::Client,
                Some(self.config),
            )
            .await;

            (inner, protocol)
        };

        Ok(WebSocket { inner, protocol })
    }
}

/// Checks if the header value is equal to the given value.
fn header_eq(headers: &HeaderMap, key: HeaderName, value: &'static str) -> bool {
    if let Some(header) = headers.get(&key) {
        header.as_bytes().eq_ignore_ascii_case(value.as_bytes())
    } else {
        false
    }
}

/// Checks if the header value contains the given value.
fn header_contains(headers: &HeaderMap, key: HeaderName, value: &'static str) -> bool {
    let header = if let Some(header) = headers.get(&key) {
        header
    } else {
        return false;
    };

    if let Ok(header) = std::str::from_utf8(header.as_bytes()) {
        header.to_ascii_lowercase().contains(value)
    } else {
        false
    }
}

pin_project! {
    /// A websocket connection
    #[derive(Debug)]
    pub struct WebSocket {
        #[pin]
        inner: WebSocketStream,
        protocol: Option<HeaderValue>,
    }
}

impl WebSocket {
    /// Return the selected WebSocket subprotocol, if one has been chosen.
    #[inline]
    pub fn protocol(&self) -> Option<&HeaderValue> {
        self.protocol.as_ref()
    }

    /// Receive another message.
    ///
    /// Returns `None` if the stream has closed.
    #[inline]
    pub async fn recv(&mut self) -> Option<Result<Message, Error>> {
        self.next().await
    }

    /// Send a message.
    #[inline]
    pub async fn send(&mut self, msg: Message) -> Result<(), Error> {
        self.inner
            .send(msg.into_tungstenite())
            .await
            .map_err(Error::websocket)
    }

    /// Consumes the [`WebSocket`] and returns the underlying stream.
    #[inline]
    pub fn into_inner(self) -> Upgraded {
        self.inner.into_inner()
    }

    /// Closes the connection with a given code and (optional) reason.
    pub async fn close<C, R>(mut self, code: C, reason: R) -> Result<(), Error>
    where
        C: Into<CloseCode>,
        R: Into<Utf8Bytes>,
    {
        let close_frame = CloseFrame {
            code: code.into().0.into(),
            reason: reason.into().0,
        };

        self.inner
            .close(Some(close_frame))
            .await
            .map_err(Error::websocket)
    }
}

impl Sink<Message> for WebSocket {
    type Error = Error;

    #[inline]
    fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.project()
            .inner
            .poll_ready(cx)
            .map_err(Error::websocket)
    }

    #[inline]
    fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error> {
        self.project()
            .inner
            .start_send(item.into_tungstenite())
            .map_err(Error::websocket)
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.project()
            .inner
            .poll_flush(cx)
            .map_err(Error::websocket)
    }

    #[inline]
    fn poll_close(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.project()
            .inner
            .poll_close(cx)
            .map_err(Error::websocket)
    }
}

impl FusedStream for WebSocket {
    #[inline]
    fn is_terminated(&self) -> bool {
        self.inner.is_terminated()
    }
}

impl Stream for WebSocket {
    type Item = Result<Message, Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match ready!(self.inner.poll_next_unpin(cx)) {
                Some(Ok(msg)) => {
                    if let Some(msg) = Message::from_tungstenite(msg) {
                        return Poll::Ready(Some(Ok(msg)));
                    }
                }
                Some(Err(err)) => return Poll::Ready(Some(Err(Error::websocket(err)))),
                None => return Poll::Ready(None),
            }
        }
    }
}
