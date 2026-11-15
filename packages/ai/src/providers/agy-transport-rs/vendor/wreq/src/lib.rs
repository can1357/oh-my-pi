#![deny(unused)]
#![deny(unsafe_code)]
#![deny(missing_docs)]
#![cfg_attr(test, deny(warnings))]
#![cfg_attr(docsrs, feature(doc_cfg))]

//! # wreq
//!
//! An ergonomic and modular Rust HTTP Client for high-fidelity protocol matching, featuring
//! customizable TLS, JA3/JA4, and HTTP/2 signature capabilities.
//!
//! - Plain bodies, [JSON](#json), [urlencoded](#forms), [multipart]
//! - HTTP Trailer
//! - Cookie Store
//! - [Redirect Policy](#redirect-policies)
//! - Original Header
//! - Rotating [Proxies](#proxies)
//! - [Tower](https://docs.rs/tower/latest/tower) Middleware
//! - [WebSocket](#websocket) Upgrade
//! - HTTPS via [BoringSSL](#tls)
//! - HTTP/2 over TLS Parity
//! - [Certificate Store (CAs & mTLS)](#certificate-store)
//!
//! Additional learning resources include:
//!
//! - [The Rust Cookbook](https://doc.rust-lang.org/stable/book/ch00-00-introduction.html)
//! - [Repository Examples](https://github.com/0x676e67/wreq/tree/main/examples)
//!
//! ## Making a GET request
//!
//! Making a GET request is simple.
//!
//! ```rust
//! # async fn run() -> wreq::Result<()> {
//! let body = wreq::get("https://www.rust-lang.org")
//!     .send()
//!     .await?
//!     .text()
//!     .await?;
//!
//! println!("body = {:?}", body);
//! # Ok(())
//! # }
//! ```
//!
//! **NOTE**: If you plan to perform multiple requests, it is best to create a
//! [`Client`][client] and reuse it, taking advantage of keep-alive connection
//! pooling.
//!
//! ## Making POST requests (or setting request bodies)
//!
//! There are several ways you can set the body of a request. The basic one is
//! by using the `body()` method of a [`RequestBuilder`][builder]. This lets you set the
//! exact raw bytes of what the body should be. It accepts various types,
//! including `String` and `Vec<u8>`. If you wish to pass a custom
//! type, you can use the `wreq::Body` constructors.
//!
//! ```rust
//! # use wreq::Error;
//! #
//! # async fn run() -> Result<(), Error> {
//! let client = wreq::Client::new();
//! let res = client
//!     .post("http://httpbin.org/post")
//!     .body("the exact body that is sent")
//!     .send()
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! ### Forms
//!
//! It's very common to want to send form data in a request body. This can be
//! done with any type that can be serialized into form data.
//!
//! This can be an array of tuples, or a `HashMap`, or a custom type that
//! implements [`Serialize`][serde].
//!
//! The feature `form` is required.
//!
//! ```rust
//! # use wreq::Error;
//! # #[cfg(feature = "form")]
//! # async fn run() -> Result<(), Error> {
//! // This will POST a body of `foo=bar&baz=quux`
//! let params = [("foo", "bar"), ("baz", "quux")];
//! let client = wreq::Client::new();
//! let res = client
//!     .post("http://httpbin.org/post")
//!     .form(&params)
//!     .send()
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! ### JSON
//!
//! There is also a `json` method helper on the [`RequestBuilder`][builder] that works in
//! a similar fashion the `form` method. It can take any value that can be
//! serialized into JSON. The feature `json` is required.
//!
//! ```rust
//! # use wreq::Error;
//! # use std::collections::HashMap;
//! #
//! # #[cfg(feature = "json")]
//! # async fn run() -> Result<(), Error> {
//! // This will POST a body of `{"lang":"rust","body":"json"}`
//! let mut map = HashMap::new();
//! map.insert("lang", "rust");
//! map.insert("body", "json");
//!
//! let client = wreq::Client::new();
//! let res = client
//!     .post("http://httpbin.org/post")
//!     .json(&map)
//!     .send()
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## Websocket
//!
//! The `websocket` module provides a way to upgrade a connection to a websocket.
//!
//! ```rust,no_run
//! use futures_util::{SinkExt, StreamExt, TryStreamExt};
//! use wreq::{header, ws::message::Message};
//!
//! #[tokio::main]
//! async fn main() -> wreq::Result<()> {
//!     // Use the API you're already familiar with
//!     let websocket = wreq::websocket("wss://echo.websocket.org")
//!         .header(header::USER_AGENT, env!("CARGO_PKG_NAME"))
//!         .send()
//!         .await?;
//!
//!     assert_eq!(websocket.version(), http::Version::HTTP_11);
//!
//!     let (mut tx, mut rx) = websocket.into_websocket().await?.split();
//!
//!     tokio::spawn(async move {
//!         for i in 1..11 {
//!             if let Err(err) = tx.send(Message::text(format!("Hello, World! {i}"))).await {
//!                 eprintln!("failed to send message: {err}");
//!             }
//!         }
//!     });
//!
//!     while let Some(message) = rx.try_next().await? {
//!         if let Message::Text(text) = message {
//!             println!("received: {text}");
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```
//!
//! ## Redirect Policies
//!
//! By default, the client does not handle HTTP redirects.
//! To customize this behavior, you can use [`redirect::Policy`][redirect] with ClientBuilder.
//!
//! ## Cookies
//!
//! The automatic storing and sending of session cookies can be enabled with
//! the [`cookie_store`][ClientBuilder::cookie_store] method on `ClientBuilder`.
//!
//! ## Proxies
//!
//! **NOTE**: System proxies are enabled by default.
//!
//! System proxies look in environment variables to set HTTP or HTTPS proxies.
//!
//! `HTTP_PROXY` or `http_proxy` provide HTTP proxies for HTTP connections while
//! `HTTPS_PROXY` or `https_proxy` provide HTTPS proxies for HTTPS connections.
//! `ALL_PROXY` or `all_proxy` provide proxies for both HTTP and HTTPS connections.
//! If both the all proxy and HTTP or HTTPS proxy variables are set the more specific
//! HTTP or HTTPS proxies take precedence.
//!
//! These can be overwritten by adding a [`Proxy`] to `ClientBuilder`
//! i.e. `let proxy = wreq::Proxy::http("https://secure.example")?;`
//! or disabled by calling `ClientBuilder::no_proxy()`.
//!
//! `socks` feature is required if you have configured socks proxy like this:
//!
//! ```bash
//! export https_proxy=socks5://127.0.0.1:1086
//! ```
//!
//! * `http://` is the scheme for http proxy
//! * `https://` is the scheme for https proxy
//! * `socks4://` is the scheme for socks4 proxy
//! * `socks4a://` is the scheme for socks4a proxy
//! * `socks5://` is the scheme for socks5 proxy
//! * `socks5h://` is the scheme for socks5h proxy
//!  
//! ## TLS
//!
//! By default, clients will utilize BoringSSL transport layer security to connect to HTTPS targets.
//!
//! - Various parts of TLS can also be configured or even disabled on the `ClientBuilder`.
//!
//! ## Certificate Store
//!
//! By default, wreq uses Mozilla's root certificates through the webpki-roots crate.
//! This static root certificate bundle is not automatically updated and ignores any root
//! certificates installed on the host. You can disable default-features to use the system's default
//! certificate path. Additionally, wreq provides a certificate store for users to customize and
//! update certificates.
//!
//! Custom Certificate Store verification supports Root CA certificates, peer certificates, and
//! self-signed certificate SSL pinning.
//!
//! ## Optional Features
//!
//! The following are a list of [Cargo features][cargo-features] that can be
//! enabled or disabled:
//!
//! - **cookies**: Provides cookie session support.
//! - **gzip**: Provides response body gzip decompression.
//! - **brotli**: Provides response body brotli decompression.
//! - **zstd**: Provides response body zstd decompression.
//! - **deflate**: Provides response body deflate decompression.
//! - **query**: Provides query parameter serialization.
//! - **form**: Provides form data serialization.
//! - **json**: Provides serialization and deserialization for JSON bodies.
//! - **multipart**: Provides functionality for multipart forms.
//! - **charset**: Improved support for decoding text.
//! - **stream**: Adds support for `futures::Stream`.
//! - **socks**: Provides SOCKS5 and SOCKS4 proxy support.
//! - **ws**: Provides websocket support.
//! - **hickory-dns**: Enables a hickory-dns async resolver instead of default threadpool using
//!   `getaddrinfo`.
//! - **webpki-roots** *(enabled by default)*: Use the webpki-roots crate for root certificates.
//! - **system-proxy**: Enable system proxy support.
//! - **tracing**: Enable tracing logging support.
//! - **prefix-symbols**: Prefix BoringSSL symbols to avoid OpenSSL conflicts.
//!
//! [client]: ./struct.Client.html
//! [response]: ./struct.Response.html
//! [get]: ./fn.get.html
//! [builder]: ./struct.RequestBuilder.html
//! [serde]: http://serde.rs
//! [redirect]: crate::redirect
//! [Proxy]: ./struct.Proxy.html
//! [cargo-features]: https://doc.rust-lang.org/stable/cargo/reference/manifest.html#the-features-section

macro_rules! if_tokio_rt {
    (block: { $($tt:tt)* }) => {
        #[cfg(all(feature = "tokio-rt", not(feature = "compio-rt")))]
        $($tt)*
    };
    ($($item:item)*) => {$(
        #[cfg(all(feature = "tokio-rt", not(feature = "compio-rt")))]
        $item
    )*};
}

macro_rules! if_compio_rt {
    (block: { $($tt:tt)* }) => {
        #[cfg(all(feature = "compio-rt", not(feature = "tokio-rt")))]
        $($tt)*
    };
    ($($item:item)*) => {$(
        #[cfg(all(feature = "compio-rt", not(feature = "tokio-rt")))]
        $item
    )*};
}

macro_rules! if_all_rt {
    (block: { $($tt:tt)* }) => {
        #[cfg(all(feature = "tokio-rt", feature = "compio-rt"))]
        $($tt)*
    };
    ($($item:item)*) => {$(
        #[cfg(all(feature = "tokio-rt", feature = "compio-rt"))]
        $item
    )*};
}

macro_rules! if_any_rt {
    ($($item:item)*) => {$(
        #[cfg(any(feature = "tokio-rt", feature = "compio-rt"))]
        $item
    )*};
}

macro_rules! if_no_rt {
    (block: { $($tt:tt)* }) => {
        #[cfg(not(any(feature = "tokio-rt", feature = "compio-rt")))]
        $($tt)*
    };
}

#[macro_use]
mod trace;
#[macro_use]
mod ext;
#[macro_use]
mod config;
mod client;
mod conn;
mod error;
mod group;
mod into_uri;
mod proxy;
mod rt;
mod sync;
mod util;

#[cfg(feature = "cookies")]
pub mod cookie;
pub mod dns;
pub mod header;
pub mod redirect;
pub mod retry;
pub mod tls;

#[cfg(feature = "multipart")]
pub use self::client::multipart;
#[cfg(feature = "ws")]
pub use self::client::ws;
pub use self::{
    client::{
        Client, ClientBuilder,
        body::Body,
        emulate::{Emulation, EmulationBuilder, IntoEmulation},
        request::{Request, RequestBuilder},
        response::Response,
        upgrade::Upgraded,
    },
    error::{Error, Result},
    ext::{ResponseBuilderExt, ResponseExt},
    group::Group,
    into_uri::IntoUri,
    proxy::{NoProxy, Proxy},
};

pub mod http1 {
    //! HTTP/1 protocol implementation and utilities.

    pub use wreq_proto::http1::{Http1Options, Http1OptionsBuilder};
}

pub mod http2 {
    //! HTTP/2 protocol implementation and utilities.

    pub use http2::frame::{
        Priorities, PrioritiesBuilder, Priority, PseudoId, PseudoOrder, Setting, SettingId,
        SettingsOrder, SettingsOrderBuilder, StreamDependency, StreamId,
    };
    pub use wreq_proto::http2::{Http2Options, Http2OptionsBuilder};
}

pub use http::{Method, StatusCode, Uri, Version};
#[cfg(unix)]
use libc as _;

fn _assert_impls() {
    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}
    fn assert_clone<T: Clone>() {}

    assert_send::<Client>();
    assert_sync::<Client>();
    assert_clone::<Client>();

    assert_send::<Request>();
    assert_send::<RequestBuilder>();
    #[cfg(feature = "ws")]
    assert_send::<ws::WebSocketRequestBuilder>();

    assert_send::<Response>();
    #[cfg(feature = "ws")]
    assert_send::<ws::WebSocketResponse>();
    #[cfg(feature = "ws")]
    assert_send::<ws::WebSocket>();

    assert_send::<Error>();
    assert_sync::<Error>();
}

/// Shortcut method to quickly make a `GET` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let body = wreq::get("https://www.rust-lang.org")
///     .send()
///     .await?
///     .text()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn get<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().get(uri)
}

/// Shortcut method to quickly make a `POST` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::post("https://httpbin.org/post")
///     .body("example body")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn post<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().post(uri)
}

/// Shortcut method to quickly make a `PUT` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::put("https://httpbin.org/put")
///     .body("update content")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn put<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().put(uri)
}

/// Shortcut method to quickly make a `DELETE` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::delete("https://httpbin.org/delete")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn delete<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().delete(uri)
}

/// Shortcut method to quickly make a `HEAD` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::head("https://httpbin.org/get")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn head<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().head(uri)
}

/// Shortcut method to quickly make a `PATCH` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::patch("https://httpbin.org/patch")
///     .body("patch content")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn patch<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().patch(uri)
}

/// Shortcut method to quickly make an `OPTIONS` request.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// let res = wreq::options("https://httpbin.org/get")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn options<T: IntoUri>(uri: T) -> RequestBuilder {
    Client::new().options(uri)
}

/// Shortcut method to quickly make a request with a custom HTTP method.
///
/// See also the methods on the [`wreq::RequestBuilder`](./struct.RequestBuilder.html)
/// type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// use http::Method;
/// let res = wreq::request(Method::TRACE, "https://httpbin.org/trace")
///     .send()
///     .await?;
/// # Ok(())
/// # }
/// ```
#[inline]
pub fn request<T: IntoUri>(method: Method, uri: T) -> RequestBuilder {
    Client::new().request(method, uri)
}

/// Shortcut method to quickly make a WebSocket request.
///
/// See also the methods on the
/// [`wreq::ws::WebSocketRequestBuilder`](./ws/struct.WebSocketRequestBuilder.html) type.
///
/// **NOTE**: This function creates a new internal `Client` on each call,
/// and so should not be used if making many requests. Create a
/// [`Client`](./struct.Client.html) instead.
///
/// # Examples
///
/// ```rust
/// # async fn run() -> wreq::Result<()> {
/// use futures_util::{SinkExt, StreamExt, TryStreamExt};
/// use wreq::{header, ws::message::Message};
///
/// let resp = wreq::websocket("wss://echo.websocket.org")
///     .header(header::USER_AGENT, env!("CARGO_PKG_NAME"))
///     .read_buffer_size(1024 * 1024)
///     .send()
///     .await?;
///
/// assert_eq!(resp.version(), http::Version::HTTP_11);
///
/// let websocket = resp.into_websocket().await?;
/// if let Some(protocol) = websocket.protocol() {
///     println!("WebSocket subprotocol: {:?}", protocol);
/// }
///
/// let (mut tx, mut rx) = websocket.split();
///
/// tokio::spawn(async move {
///     for i in 1..11 {
///         if let Err(err) = tx.send(Message::text(format!("Hello, World! {i}"))).await {
///             eprintln!("failed to send message: {err}");
///         }
///     }
/// });
///
/// while let Some(message) = rx.try_next().await? {
///     if let Message::Text(text) = message {
///         println!("received: {text}");
///     }
/// }
/// # Ok(())
/// # }
/// ```
#[inline]
#[cfg(feature = "ws")]
#[cfg_attr(docsrs, doc(cfg(feature = "ws")))]
pub fn websocket<T: IntoUri>(uri: T) -> ws::WebSocketRequestBuilder {
    Client::new().websocket(uri)
}
