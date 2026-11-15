use std::{
    convert::TryFrom,
    fmt,
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};

#[cfg(any(feature = "form", feature = "json", feature = "multipart"))]
use http::header::CONTENT_TYPE;
use http::{Extensions, Uri, Version};
#[cfg(any(feature = "query", feature = "form", feature = "json"))]
use serde::Serialize;
#[cfg(feature = "multipart")]
use {super::multipart, bytes::Bytes, http::header::CONTENT_LENGTH};

#[cfg(any(
    feature = "gzip",
    feature = "zstd",
    feature = "brotli",
    feature = "deflate",
))]
use super::layer::decoder::AcceptEncoding;
use super::{
    Body, Client, IntoEmulation, Response,
    future::Pending,
    layer::{
        config::{DefaultHeaders, RequestOptions},
        timeout::TimeoutOptions,
    },
};
#[cfg(feature = "cookies")]
use crate::cookie::{CookieStore, IntoCookieStore};
use crate::{
    Error, Method, Proxy,
    config::{RequestConfig, RequestConfigValue},
    ext::UriExt,
    group::Group,
    header::{AUTHORIZATION, HeaderMap, HeaderName, HeaderValue, OrigHeaderMap},
    redirect,
};

/// A request which can be executed with [`Client::execute()`].
#[derive(Debug)]
pub struct Request(http::Request<Option<Body>>);

/// A builder to construct the properties of a [`Request`].
///
/// To construct a [`RequestBuilder`], refer to the [`Client`] documentation.
#[must_use = "RequestBuilder does nothing until you 'send' it"]
pub struct RequestBuilder {
    client: Client,
    request: crate::Result<Request>,
}

impl Request {
    /// Constructs a new [`Request`].
    pub fn new(method: Method, uri: Uri) -> Self {
        let mut request = http::Request::new(None);
        *request.method_mut() = method;
        *request.uri_mut() = uri;
        Request(request)
    }

    /// Get the method.
    #[inline]
    pub fn method(&self) -> &Method {
        self.0.method()
    }

    /// Get a mutable reference to the method.
    #[inline]
    pub fn method_mut(&mut self) -> &mut Method {
        self.0.method_mut()
    }

    /// Get the uri.
    #[inline]
    pub fn uri(&self) -> &Uri {
        self.0.uri()
    }

    /// Get a mutable reference to the uri.
    #[inline]
    pub fn uri_mut(&mut self) -> &mut Uri {
        self.0.uri_mut()
    }

    /// Get the headers.
    #[inline]
    pub fn headers(&self) -> &HeaderMap {
        self.0.headers()
    }

    /// Get a mutable reference to the headers.
    #[inline]
    pub fn headers_mut(&mut self) -> &mut HeaderMap {
        self.0.headers_mut()
    }

    /// Get the body.
    #[inline]
    pub fn body(&self) -> Option<&Body> {
        self.0.body().as_ref()
    }

    /// Get a mutable reference to the body.
    #[inline]
    pub fn body_mut(&mut self) -> &mut Option<Body> {
        self.0.body_mut()
    }

    /// Get the http version.
    #[inline]
    pub fn version(&self) -> Option<Version> {
        self.config::<RequestOptions>()
            .and_then(|opts| opts.version)
    }

    /// Get a mutable reference to the http version.
    #[inline]
    pub fn version_mut(&mut self) -> &mut Option<Version> {
        &mut self
            .config_mut::<RequestOptions>()
            .get_or_insert_default()
            .version
    }

    /// Returns a reference to the associated extensions.
    ///
    /// # Examples
    ///
    /// ```
    /// # use wreq;
    /// let request = wreq::get("http://httpbin.org/get")
    ///     .build()
    ///     .expect("failed to build request");
    /// assert!(request.extensions().get::<i32>().is_none());
    /// ```
    #[inline]
    pub fn extensions(&self) -> &Extensions {
        self.0.extensions()
    }

    /// Returns a mutable reference to the associated extensions.
    ///
    /// # Examples
    ///
    /// ```
    /// # use wreq;
    /// let mut request = wreq::get("http://httpbin.org/get")
    ///     .build()
    ///     .expect("failed to build request");
    /// request.extensions_mut().insert("hello");
    /// assert_eq!(request.extensions().get(), Some(&"hello"));
    /// ```
    #[inline]
    pub fn extensions_mut(&mut self) -> &mut Extensions {
        self.0.extensions_mut()
    }

    /// Attempt to clone the request.
    ///
    /// `None` is returned if the request can not be cloned, i.e. if the body is a stream.
    pub fn try_clone(&self) -> Option<Request> {
        let body = match self.body() {
            Some(body) => Some(body.try_clone()?),
            None => None,
        };
        let mut req = Request::new(self.method().clone(), self.uri().clone());
        *req.headers_mut() = self.headers().clone();
        *req.version_mut() = self.version();
        *req.extensions_mut() = self.extensions().clone();
        *req.body_mut() = body;
        Some(req)
    }

    #[inline]
    pub(crate) fn config<T>(&self) -> Option<&T::Value>
    where
        T: RequestConfigValue,
    {
        RequestConfig::<T>::get(self.extensions())
    }

    #[inline]
    pub(crate) fn config_mut<T>(&mut self) -> &mut Option<T::Value>
    where
        T: RequestConfigValue,
    {
        RequestConfig::<T>::get_mut(self.extensions_mut())
    }
}

impl RequestBuilder {
    pub(super) fn new(client: Client, request: crate::Result<Request>) -> RequestBuilder {
        let mut builder = RequestBuilder { client, request };

        let auth = builder
            .request
            .as_mut()
            .ok()
            .and_then(|req| extract_authority(req.uri_mut()));

        if let Some((username, password)) = auth {
            builder.basic_auth(username, password)
        } else {
            builder
        }
    }

    /// Assemble a builder starting from an existing `Client` and a `Request`.
    pub fn from_parts(client: Client, request: Request) -> RequestBuilder {
        RequestBuilder {
            client,
            request: crate::Result::Ok(request),
        }
    }

    /// Add a `Header` to this Request with ability to define if `header_value` is sensitive.
    fn header_sensitive<K, V>(mut self, key: K, value: V, sensitive: bool) -> RequestBuilder
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        let mut error = None;
        if let Ok(ref mut req) = self.request {
            match <HeaderName as TryFrom<K>>::try_from(key) {
                Ok(key) => match <HeaderValue as TryFrom<V>>::try_from(value) {
                    Ok(mut value) => {
                        // We want to potentially make an non-sensitive header
                        // to be sensitive, not the reverse. So, don't turn off
                        // a previously sensitive header.
                        if sensitive {
                            value.set_sensitive(true);
                        }
                        req.headers_mut().append(key, value);
                    }
                    Err(e) => error = Some(Error::builder(e.into())),
                },
                Err(e) => error = Some(Error::builder(e.into())),
            };
        }
        if let Some(err) = error {
            self.request = Err(err);
        }
        self
    }

    /// Add a `Header` to this Request.
    ///
    /// If the header is already present, the value will be replaced.
    #[inline]
    pub fn header<K, V>(self, key: K, value: V) -> RequestBuilder
    where
        HeaderName: TryFrom<K>,
        <HeaderName as TryFrom<K>>::Error: Into<http::Error>,
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.header_sensitive(key, value, false)
    }

    /// Add a set of Headers to the existing ones on this Request.
    ///
    /// The headers will be merged in to any already set.
    pub fn headers(mut self, headers: HeaderMap) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            crate::util::replace_headers(req.headers_mut(), headers);
        }
        self
    }

    /// Set the original headers for this request.
    pub fn orig_headers(mut self, orig_headers: OrigHeaderMap) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<OrigHeaderMap>().replace(orig_headers);
        }
        self
    }

    /// Enable or disable client default headers for this request.
    ///
    /// By default, client default headers are included. Set to `false` to skip them.
    pub fn default_headers(mut self, enable: bool) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<DefaultHeaders>().replace(enable);
        }
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
    ///     .get("http://httpbin.org/get")
    ///     .auth("your_token_here")
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn auth<V>(self, token: V) -> RequestBuilder
    where
        HeaderValue: TryFrom<V>,
        <HeaderValue as TryFrom<V>>::Error: Into<http::Error>,
    {
        self.header_sensitive(AUTHORIZATION, token, true)
    }

    /// Enable HTTP basic authentication.
    ///
    /// ```rust
    /// # use wreq::Error;
    ///
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let resp = client
    ///     .delete("http://httpbin.org/delete")
    ///     .basic_auth("admin", Some("good password"))
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn basic_auth<U, P>(self, username: U, password: Option<P>) -> RequestBuilder
    where
        U: fmt::Display,
        P: fmt::Display,
    {
        let header_value = crate::util::basic_auth(username, password);
        self.header_sensitive(AUTHORIZATION, header_value, true)
    }

    /// Enable HTTP bearer authentication.
    ///
    /// ```rust
    /// # use wreq::Error;
    /// #
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let resp = client
    ///     .get("http://httpbin.org/get")
    ///     .bearer_auth("your_token_here")
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn bearer_auth<T: fmt::Display>(self, token: T) -> RequestBuilder {
        let header_value = format!("Bearer {token}");
        self.header_sensitive(AUTHORIZATION, header_value, true)
    }

    /// Enables a request timeout.
    ///
    /// The timeout is applied from when the request starts connecting until the
    /// response body has finished. It affects only this request and overrides
    /// the timeout configured using `ClientBuilder::timeout()`.
    pub fn timeout(mut self, timeout: Duration) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<TimeoutOptions>()
                .get_or_insert_default()
                .total_timeout(timeout);
        }
        self
    }

    /// Enables a read timeout.
    ///
    /// The timeout applies while waiting for response headers and reading each body frame. Time
    /// spent by the caller between body reads is not counted. It affects only this request and
    /// overrides `ClientBuilder::read_timeout()`.
    pub fn read_timeout(mut self, timeout: Duration) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<TimeoutOptions>()
                .get_or_insert_default()
                .read_timeout(timeout);
        }
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
    #[cfg(feature = "query")]
    #[cfg_attr(docsrs, doc(cfg(feature = "query")))]
    pub fn query<T: Serialize + ?Sized>(mut self, query: &T) -> RequestBuilder {
        if let Ok(ref mut req) = self.request
            && let Err(err) = serde_html_form::to_string(query)
                .map_err(Error::builder)
                .and_then(|query| {
                    if query.is_empty() {
                        return Ok(());
                    }

                    let uri = req.uri_mut();
                    let path = uri.path();
                    let path_and_query = match uri.query().filter(|query| !query.is_empty()) {
                        Some(existing) => format!("{path}?{existing}&{query}"),
                        None => format!("{path}?{query}"),
                    };
                    let path_and_query = http::uri::PathAndQuery::try_from(path_and_query)
                        .map_err(Error::builder)?;
                    let mut parts = uri.clone().into_parts();
                    parts.path_and_query = Some(path_and_query);
                    *uri = Uri::from_parts(parts).map_err(Error::builder)?;
                    Ok(())
                })
        {
            self.request = Err(err);
        }
        self
    }

    /// Send a form body.
    ///
    /// Sets the body to the uri encoded serialization of the passed value,
    /// and also sets the `Content-Type: application/x-www-form-urlencoded`
    /// header.
    ///
    /// ```rust
    /// # use wreq::Error;
    /// # use std::collections::HashMap;
    /// #
    /// # async fn run() -> Result<(), Error> {
    /// let mut params = HashMap::new();
    /// params.insert("lang", "rust");
    ///
    /// let client = wreq::Client::new();
    /// let res = client
    ///     .post("http://httpbin.org")
    ///     .form(&params)
    ///     .send()
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// This method fails if the passed value cannot be serialized into
    /// uri encoded format
    #[cfg(feature = "form")]
    #[cfg_attr(docsrs, doc(cfg(feature = "form")))]
    pub fn form<T: Serialize + ?Sized>(mut self, form: &T) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            match serde_html_form::to_string(form) {
                Ok(body) => {
                    const HEADER_VALUE: HeaderValue =
                        HeaderValue::from_static("application/x-www-form-urlencoded");

                    req.headers_mut()
                        .entry(CONTENT_TYPE)
                        .or_insert(HEADER_VALUE);
                    req.body_mut().replace(body.into());
                }
                Err(err) => self.request = Err(Error::builder(err)),
            }
        }
        self
    }

    /// Send a JSON body.
    ///
    /// Serializes the value as JSON and sets the resulting bytes as the request body.
    ///
    /// Sets `Content-Type` to `application/json` unless it is already set.
    ///
    /// # Optional
    ///
    /// This requires the optional `json` feature enabled.
    ///
    /// # Errors
    ///
    /// Serialization can fail if `T`'s implementation of `Serialize` decides to
    /// fail, or if `T` contains a map with non-string keys.
    #[cfg(feature = "json")]
    #[cfg_attr(docsrs, doc(cfg(feature = "json")))]
    pub fn json<T: Serialize + ?Sized>(mut self, json: &T) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            match serde_json::to_vec(json) {
                Ok(body) => {
                    const HEADER_VALUE: HeaderValue = HeaderValue::from_static("application/json");

                    req.headers_mut()
                        .entry(CONTENT_TYPE)
                        .or_insert(HEADER_VALUE);
                    req.body_mut().replace(body.into());
                }
                Err(err) => self.request = Err(Error::builder(err)),
            }
        }

        self
    }

    /// Set the request body.
    pub fn body<T: Into<Body>>(mut self, body: T) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            *req.body_mut() = Some(body.into());
        }
        self
    }

    /// Sends a multipart/form-data body.
    ///
    /// ```
    /// # use wreq::Error;
    ///
    /// # async fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let form = wreq::multipart::Form::new()
    ///     .text("key3", "value3")
    ///     .text("key4", "value4");
    ///
    /// let response = client.post("your uri").multipart(form).send().await?;
    /// # Ok(())
    /// # }
    /// ```
    #[cfg(feature = "multipart")]
    #[cfg_attr(docsrs, doc(cfg(feature = "multipart")))]
    pub fn multipart(mut self, mut multipart: multipart::Form) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            match HeaderValue::from_maybe_shared(Bytes::from(format!(
                "multipart/form-data; boundary={}",
                multipart.boundary()
            ))) {
                Ok(content_type) => {
                    req.headers_mut()
                        .entry(CONTENT_TYPE)
                        .or_insert(content_type);

                    if let Some(length) = multipart.compute_length() {
                        req.headers_mut()
                            .entry(CONTENT_LENGTH)
                            .or_insert_with(|| HeaderValue::from(length));
                    }

                    *req.body_mut() = Some(multipart.stream())
                }
                Err(err) => {
                    self.request = Err(Error::builder(err));
                }
            };
        }

        self
    }

    /// Set HTTP version
    pub fn version(mut self, version: Version) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.version_mut().replace(version);
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .version = Some(version);
        }
        self
    }

    /// Set the redirect policy for this request.
    pub fn redirect(mut self, policy: redirect::Policy) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<redirect::Policy>().replace(policy);
        }
        self
    }

    /// Set the persistent cookie store for the request.
    #[cfg(feature = "cookies")]
    #[cfg_attr(docsrs, doc(cfg(feature = "cookies")))]
    pub fn cookie_provider<C: IntoCookieStore>(mut self, cookie_store: C) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            use std::sync::Arc;

            req.config_mut::<Arc<dyn CookieStore>>()
                .replace(cookie_store.into_shared());
        }
        self
    }

    /// Sets if this request will announce that it accepts gzip encoding.
    #[cfg(feature = "gzip")]
    #[cfg_attr(docsrs, doc(cfg(feature = "gzip")))]
    pub fn gzip(mut self, gzip: bool) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<AcceptEncoding>()
                .get_or_insert_default()
                .gzip = gzip;
        }
        self
    }

    /// Sets if this request will announce that it accepts brotli encoding.
    #[cfg(feature = "brotli")]
    #[cfg_attr(docsrs, doc(cfg(feature = "brotli")))]
    pub fn brotli(mut self, brotli: bool) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<AcceptEncoding>()
                .get_or_insert_default()
                .brotli = brotli;
        }
        self
    }

    /// Sets if this request will announce that it accepts deflate encoding.
    #[cfg(feature = "deflate")]
    #[cfg_attr(docsrs, doc(cfg(feature = "deflate")))]
    pub fn deflate(mut self, deflate: bool) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<AcceptEncoding>()
                .get_or_insert_default()
                .deflate = deflate;
        }
        self
    }

    /// Sets if this request will announce that it accepts zstd encoding.
    #[cfg(feature = "zstd")]
    #[cfg_attr(docsrs, doc(cfg(feature = "zstd")))]
    pub fn zstd(mut self, zstd: bool) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<AcceptEncoding>()
                .get_or_insert_default()
                .zstd = zstd;
        }
        self
    }

    /// Set the proxy for this request.
    pub fn proxy(mut self, proxy: Proxy) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .proxy = Some(proxy.into_matcher());
        }
        self
    }

    /// Set the local address for this request.
    pub fn local_address<V>(mut self, local_address: V) -> RequestBuilder
    where
        V: Into<Option<IpAddr>>,
    {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .socket_bind_options
                .get_or_insert_default()
                .set_local_address(local_address);
        }
        self
    }

    /// Set the local addresses for this request.
    pub fn local_addresses<V4, V6>(mut self, ipv4_address: V4, ipv6_address: V6) -> RequestBuilder
    where
        V4: Into<Option<Ipv4Addr>>,
        V6: Into<Option<Ipv6Addr>>,
    {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .socket_bind_options
                .get_or_insert_default()
                .set_local_addresses(ipv4_address, ipv6_address);
        }
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
    pub fn interface<I>(mut self, interface: I) -> RequestBuilder
    where
        I: Into<std::borrow::Cow<'static, str>>,
    {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .socket_bind_options
                .get_or_insert_default()
                .set_interface(interface);
        }
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
    pub fn emulation<T: IntoEmulation>(mut self, emulation: T) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            let emulation = emulation.into_emulation();
            let opts = req.config_mut::<RequestOptions>().get_or_insert_default();
            opts.group.emulate(emulation.group);
            opts.tls_options = emulation.tls_options;
            opts.http1_options = emulation.http1_options;
            opts.http2_options = emulation.http2_options;
            return self
                .headers(emulation.headers)
                .orig_headers(emulation.orig_headers);
        }

        self
    }

    /// Assigns a logical group to this request.
    ///
    /// Groups define the request's identity and execution context.
    /// Requests in different groups are logically partitioned to ensure
    /// resource isolation and prevent metadata leakage.
    pub fn group(mut self, group: Group) -> RequestBuilder {
        if let Ok(ref mut req) = self.request {
            req.config_mut::<RequestOptions>()
                .get_or_insert_default()
                .group
                .request(group);
        }
        self
    }

    /// Build a `Request`, which can be inspected, modified and executed with
    /// [`Client::execute()`].
    #[inline]
    pub fn build(self) -> crate::Result<Request> {
        self.request
    }

    /// Build a `Request`, which can be inspected, modified and executed with
    /// [`Client::execute()`].
    ///
    /// This is similar to [`RequestBuilder::build()`], but also returns the
    /// embedded [`Client`].
    #[inline]
    pub fn build_split(self) -> (Client, crate::Result<Request>) {
        (self.client, self.request)
    }

    /// Constructs the Request and sends it to the target URI, returning a
    /// future Response.
    ///
    /// # Errors
    ///
    /// This method fails if there was an error while sending request,
    /// redirect loop was detected or redirect limit was exhausted.
    ///
    /// # Example
    ///
    /// ```no_run
    /// # use wreq::Error;
    /// #
    /// # async fn run() -> Result<(), Error> {
    /// let response = wreq::Client::new().get("https://hyper.rs").send().await?;
    /// # Ok(())
    /// # }
    /// ```
    pub fn send(self) -> impl Future<Output = crate::Result<Response>> {
        match self.request {
            Ok(req) => self.client.execute(req),
            Err(err) => Pending::Error { error: Some(err) },
        }
    }

    /// Attempt to clone the RequestBuilder.
    ///
    /// `None` is returned if the RequestBuilder can not be cloned,
    /// i.e. if the request body is a stream.
    ///
    /// # Examples
    ///
    /// ```
    /// # use wreq::Error;
    /// #
    /// # fn run() -> Result<(), Error> {
    /// let client = wreq::Client::new();
    /// let builder = client.post("http://httpbin.org/post").body("from a &str!");
    /// let clone = builder.try_clone();
    /// assert!(clone.is_some());
    /// # Ok(())
    /// # }
    /// ```
    pub fn try_clone(&self) -> Option<RequestBuilder> {
        self.request
            .as_ref()
            .ok()
            .and_then(|req| req.try_clone())
            .map(|req| RequestBuilder {
                client: self.client.clone(),
                request: Ok(req),
            })
    }
}

/// Check the request URI for a "username:password" type authority, and if
/// found, remove it from the URI and return it.
fn extract_authority(uri: &mut Uri) -> Option<(String, Option<String>)> {
    use percent_encoding::percent_decode;

    let (username, password) = uri.userinfo();

    let username: String = percent_decode(username?.as_bytes())
        .decode_utf8()
        .ok()?
        .into();
    let password = password.and_then(|pass| {
        percent_decode(pass.as_bytes())
            .decode_utf8()
            .ok()
            .map(String::from)
    });

    if !username.is_empty() || password.is_some() {
        uri.set_userinfo("", None);
        return Some((username, password));
    }

    None
}

impl<T: Into<Body>> From<http::Request<T>> for Request {
    #[inline]
    fn from(req: http::Request<T>) -> Request {
        Request(req.map(Into::into).map(Some))
    }
}

impl From<Request> for http::Request<Body> {
    #[inline]
    fn from(req: Request) -> http::Request<Body> {
        req.0.map(|body| body.unwrap_or_else(Body::empty))
    }
}
