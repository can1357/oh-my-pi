use std::{
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll},
};

use bytes::Bytes;
#[cfg(feature = "charset")]
use encoding_rs::{Encoding, UTF_8};
#[cfg(feature = "stream")]
use futures_util::Stream;
use http::{HeaderMap, StatusCode, Uri, Version};
use http_body::{Body as HttpBody, Frame};
use http_body_util::{BodyExt, Collected};
#[cfg(feature = "charset")]
use mime::Mime;
#[cfg(feature = "json")]
use serde::de::DeserializeOwned;
use wreq_proto::ext::ReasonPhrase;

#[cfg(feature = "cookies")]
use crate::cookie;
use crate::{
    Body, Error,
    conn::{Connected, http::HttpInfo},
    error::BoxError,
    ext::RequestUri,
};

/// A Response to a submitted [`crate::Request`].
#[derive(Debug)]
pub struct Response {
    uri: Uri,
    res: http::Response<Body>,
}

impl Response {
    #[inline]
    pub(super) fn new<B>(mut res: http::Response<B>, uri: Uri) -> Response
    where
        B: HttpBody + Send + Sync + 'static,
        B::Data: Into<Bytes>,
        B::Error: Into<BoxError>,
    {
        Response {
            uri: res
                .extensions_mut()
                .remove::<RequestUri>()
                .map_or(uri, |request_uri| request_uri.0),
            res: res.map(Body::wrap),
        }
    }

    /// Get the final [`Uri`] of this [`Response`].
    #[inline]
    pub fn uri(&self) -> &Uri {
        &self.uri
    }

    /// Get the [`StatusCode`] of this [`Response`].
    #[inline]
    pub fn status(&self) -> StatusCode {
        self.res.status()
    }

    /// Get the HTTP [`Version`] of this [`Response`].
    #[inline]
    pub fn version(&self) -> Version {
        self.res.version()
    }

    /// Get the [`HeaderMap`] of this [`Response`].
    #[inline]
    pub fn headers(&self) -> &HeaderMap {
        self.res.headers()
    }

    /// Get a mutable reference to the [`HeaderMap`] of this [`Response`].
    #[inline]
    pub fn headers_mut(&mut self) -> &mut HeaderMap {
        self.res.headers_mut()
    }

    /// Get the content length of the [`Response`], if it is known.
    ///
    /// This value does not directly represents the value of the `Content-Length`
    /// header, but rather the size of the response's body. To read the header's
    /// value, please use the [`Response::headers`] method instead.
    ///
    /// Reasons it may not be known:
    ///
    /// - The response does not include a body (e.g. it responds to a `HEAD` request).
    /// - The response is gzipped and automatically decoded (thus changing the actual decoded
    ///   length).
    #[inline]
    pub fn content_length(&self) -> Option<u64> {
        HttpBody::size_hint(self.res.body()).exact()
    }

    /// Retrieve the cookies contained in the [`Response`].
    ///
    /// Note that invalid 'Set-Cookie' headers will be ignored.
    ///
    /// # Optional
    ///
    /// This requires the optional `cookies` feature to be enabled.
    #[cfg(feature = "cookies")]
    pub fn cookies(&self) -> impl Iterator<Item = cookie::Cookie<'_>> {
        self.res
            .headers()
            .get_all(crate::header::SET_COOKIE)
            .iter()
            .map(cookie::Cookie::parse)
            .filter_map(Result::ok)
    }

    /// Get the local address used to get this [`Response`].
    pub fn local_addr(&self) -> Option<SocketAddr> {
        self.res
            .extensions()
            .get::<HttpInfo>()
            .map(HttpInfo::local_addr)
    }

    /// Get the remote address used to get this [`Response`].
    pub fn remote_addr(&self) -> Option<SocketAddr> {
        self.res
            .extensions()
            .get::<HttpInfo>()
            .map(HttpInfo::remote_addr)
    }

    // body methods

    /// Get the full response text.
    ///
    /// This method decodes the response body with BOM sniffing
    /// and with malformed sequences replaced with the [`char::REPLACEMENT_CHARACTER`].
    /// Encoding is determined from the `charset` parameter of `Content-Type` header,
    /// and defaults to `utf-8` if not presented.
    ///
    /// Note that the BOM is stripped from the returned String.
    ///
    /// # Note
    ///
    /// If the `charset` feature is disabled the method will only attempt to decode the
    /// response as UTF-8, regardless of the given `Content-Type`
    ///
    /// # Example
    ///
    /// ```
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let content = wreq::Client::new()
    ///     .get("http://httpbin.org/range/26")
    ///     .send()
    ///     .await?
    ///     .text()
    ///     .await?;
    ///
    /// println!("text: {content:?}");
    /// # Ok(())
    /// # }
    /// ```
    pub async fn text(self) -> crate::Result<String> {
        #[cfg(feature = "charset")]
        {
            self.text_with_charset("utf-8").await
        }

        #[cfg(not(feature = "charset"))]
        {
            let full = self.bytes().await?;
            let text = String::from_utf8_lossy(&full);
            Ok(text.into_owned())
        }
    }

    /// Get the full response text given a specific encoding.
    ///
    /// This method decodes the response body with BOM sniffing
    /// and with malformed sequences replaced with the
    /// [`char::REPLACEMENT_CHARACTER`].
    /// You can provide a default encoding for decoding the raw message, while the
    /// `charset` parameter of `Content-Type` header is still prioritized. For more information
    /// about the possible encoding name, please go to [`encoding_rs`] docs.
    ///
    /// Note that the BOM is stripped from the returned String.
    ///
    /// [`encoding_rs`]: https://docs.rs/encoding_rs/0.8/encoding_rs/#relationship-with-windows-code-pages
    ///
    /// # Optional
    ///
    /// This requires the optional `encoding_rs` feature enabled.
    ///
    /// # Example
    ///
    /// ```
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let content = wreq::Client::new()
    ///     .get("http://httpbin.org/range/26")
    ///     .send()
    ///     .await?
    ///     .text_with_charset("utf-8")
    ///     .await?;
    ///
    /// println!("text: {content:?}");
    /// # Ok(())
    /// # }
    /// ```
    #[cfg(feature = "charset")]
    #[cfg_attr(docsrs, doc(cfg(feature = "charset")))]
    pub async fn text_with_charset(
        self,
        default_encoding: impl AsRef<str>,
    ) -> crate::Result<String> {
        let content_type = self
            .headers()
            .get(crate::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<Mime>().ok());
        let encoding_name = content_type
            .as_ref()
            .and_then(|mime| mime.get_param("charset").map(|charset| charset.as_str()))
            .unwrap_or(default_encoding.as_ref());
        let encoding = Encoding::for_label(encoding_name.as_bytes()).unwrap_or(UTF_8);

        let full = self.bytes().await?;
        let (text, _, _) = encoding.decode(&full);
        Ok(text.into_owned())
    }

    /// Try to deserialize the response body as JSON.
    ///
    /// # Optional
    ///
    /// This requires the optional `json` feature enabled.
    ///
    /// # Examples
    ///
    /// ```
    /// # extern crate wreq;
    /// # extern crate serde;
    /// #
    /// # use wreq::Error;
    /// # use serde::Deserialize;
    /// #
    /// // This `derive` requires the `serde` dependency.
    /// #[derive(Deserialize)]
    /// struct Ip {
    ///     origin: String,
    /// }
    ///
    /// # async fn run() -> Result<(), Error> {
    /// let ip = wreq::Client::new()
    ///     .get("http://httpbin.org/ip")
    ///     .send()
    ///     .await?
    ///     .json::<Ip>()
    ///     .await?;
    ///
    /// println!("ip: {}", ip.origin);
    /// # Ok(())
    /// # }
    /// #
    /// # fn main() { }
    /// ```
    ///
    /// # Errors
    ///
    /// This method fails whenever the response body is not in JSON format
    /// or it cannot be properly deserialized to target type `T`. For more
    /// details please see [`serde_json::from_reader`].
    ///
    /// [`serde_json::from_reader`]: https://docs.serde.rs/serde_json/fn.from_reader.html
    #[cfg(feature = "json")]
    #[cfg_attr(docsrs, doc(cfg(feature = "json")))]
    pub async fn json<T: DeserializeOwned>(self) -> crate::Result<T> {
        match http_body_util::BodyExt::collect(self.res.into_body())
            .await
            .map(Collected::<Bytes>::to_bytes)
        {
            Ok(full) => serde_json::from_slice(&full)
                .map_err(Error::decode)
                .map_err(|err| err.with_uri(self.uri)),
            Err(err) => Err(err.with_uri(self.uri)),
        }
    }

    /// Get the full response body as [`Bytes`].
    ///
    /// # Example
    ///
    /// ```
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let bytes = wreq::Client::new()
    ///     .get("http://httpbin.org/ip")
    ///     .send()
    ///     .await?
    ///     .bytes()
    ///     .await?;
    ///
    /// println!("bytes: {bytes:?}");
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub async fn bytes(self) -> crate::Result<Bytes> {
        BodyExt::collect(self.res.into_body())
            .await
            .map(Collected::<Bytes>::to_bytes)
            .map_err(|err| err.with_uri(self.uri))
    }

    /// Convert the response into a [`Stream`] of [`Bytes`] from the body.
    ///
    /// # Example
    ///
    /// ```
    /// use futures_util::StreamExt;
    ///
    /// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
    /// let mut stream = wreq::Client::new()
    ///     .get("http://httpbin.org/ip")
    ///     .send()
    ///     .await?
    ///     .bytes_stream();
    ///
    /// while let Some(item) = stream.next().await {
    ///     println!("Chunk: {:?}", item?);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Optional
    ///
    /// This requires the optional `stream` feature to be enabled.
    #[inline]
    #[cfg(feature = "stream")]
    #[cfg_attr(docsrs, doc(cfg(feature = "stream")))]
    pub fn bytes_stream(self) -> impl Stream<Item = crate::Result<Bytes>> {
        http_body_util::BodyDataStream::new(self.res.into_body())
    }

    // extension methods

    /// Returns a reference to the associated extensions.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::{Client, tls::TlsInfo};
    /// # async fn run() -> wreq::Result<()> {
    /// // Build a client that records TLS information.
    /// let client = Client::builder()
    ///     .tls_info(true)
    ///     .build()?;
    ///
    /// // Make a request.
    /// let resp = client.get("https://www.google.com").send().await?;
    ///
    /// // Take the TlsInfo extension to inspect it.
    /// if let Some(tls_info) = resp.extensions().get::<TlsInfo>() {
    ///     // Now you own the TlsInfo and can process it.
    ///     println!("Peer certificate: {:?}", tls_info.peer_certificate());
    /// }
    ///
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn extensions(&self) -> &http::Extensions {
        self.res.extensions()
    }

    /// Returns a mutable reference to the associated extensions.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::{Client, tls::TlsInfo};
    /// # async fn run() -> wreq::Result<()> {
    /// // Build a client that records TLS information.
    /// let client = Client::builder()
    ///     .tls_info(true)
    ///     .build()?;
    ///
    /// // Make a request.
    /// let mut resp = client.get("https://www.google.com").send().await?;
    ///
    /// // Take the TlsInfo extension to inspect it.
    /// if let Some(tls_info) = resp.extensions_mut().remove::<TlsInfo>() {
    ///     // Now you own the TlsInfo and can process it.
    ///     println!("Peer certificate: {:?}", tls_info.peer_certificate());
    /// }
    ///
    /// # Ok(())
    /// # }
    /// ```
    #[inline]
    pub fn extensions_mut(&mut self) -> &mut http::Extensions {
        self.res.extensions_mut()
    }

    /// Forbids the [`Response`] connection from being recycled back into the pool.
    ///
    /// This marks the underlying connection as "poisoned." Once marked, the connection
    /// will be discarded instead of reused after the current request-response cycle completes.
    ///
    /// # Note on Lifecycle
    /// Marking the connection does not trigger an immediate shutdown. For pooled
    /// connections, the physical closure is deferred until the `Response` body
    /// is dropped or the pool's background cleaner reclaims the resource.
    #[inline]
    pub fn forbid_recycle(&self) {
        self.res
            .extensions()
            .get::<Connected>()
            .map(Connected::poison);
    }

    // util methods

    /// Turn a response into an error if the server returned an error.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::Response;
    /// fn on_response(res: Response) {
    ///     match res.error_for_status() {
    ///         Ok(_res) => (),
    ///         Err(err) => {
    ///             // asserting a 400 as an example
    ///             // it could be any status between 400...599
    ///             assert_eq!(err.status(), Some(wreq::StatusCode::BAD_REQUEST));
    ///         }
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    pub fn error_for_status(mut self) -> crate::Result<Self> {
        let status = self.status();
        if status.is_client_error() || status.is_server_error() {
            let reason = self.res.extensions_mut().remove::<ReasonPhrase>();
            Err(Error::status_code(self.uri, status, reason))
        } else {
            Ok(self)
        }
    }

    /// Turn a reference to a response into an error if the server returned an error.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::Response;
    /// fn on_response(res: &Response) {
    ///     match res.error_for_status_ref() {
    ///         Ok(_res) => (),
    ///         Err(err) => {
    ///             // asserting a 400 as an example
    ///             // it could be any status between 400...599
    ///             assert_eq!(err.status(), Some(wreq::StatusCode::BAD_REQUEST));
    ///         }
    ///     }
    /// }
    /// # fn main() {}
    /// ```
    pub fn error_for_status_ref(&self) -> crate::Result<&Self> {
        let status = self.status();
        if status.is_client_error() || status.is_server_error() {
            let reason = self.res.extensions().get::<ReasonPhrase>().cloned();
            Err(Error::status_code(self.uri.clone(), status, reason))
        } else {
            Ok(self)
        }
    }
}

/// I'm not sure this conversion is that useful... People should be encouraged
/// to use [`http::Response`], not `wreq::Response`.
impl<T: Into<Body>> From<http::Response<T>> for Response {
    fn from(r: http::Response<T>) -> Response {
        let mut res = r.map(Into::into);
        let uri = res
            .extensions_mut()
            .remove::<RequestUri>()
            .unwrap_or_else(|| RequestUri(Uri::from_static("http://no.url.provided.local")));
        Response { res, uri: uri.0 }
    }
}

/// A [`Response`] can be converted into a [`http::Response`].
// It's supposed to be the inverse of the conversion above.
impl From<Response> for http::Response<Body> {
    fn from(r: Response) -> http::Response<Body> {
        let mut res = r.res.map(Body::wrap);
        res.extensions_mut().insert(RequestUri(r.uri));
        res
    }
}

/// A [`Response`] can be piped as the [`Body`] of another request.
impl From<Response> for Body {
    #[inline]
    fn from(r: Response) -> Body {
        Body::wrap(r.res.into_body())
    }
}

/// A [`Response`] implements [`HttpBody`] to allow streaming the body.
impl HttpBody for Response {
    type Data = Bytes;

    type Error = Error;

    #[inline(always)]
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(self.res.body_mut()).poll_frame(cx)
    }

    #[inline(always)]
    fn is_end_stream(&self) -> bool {
        self.res.body().is_end_stream()
    }

    #[inline(always)]
    fn size_hint(&self) -> http_body::SizeHint {
        self.res.body().size_hint()
    }
}
