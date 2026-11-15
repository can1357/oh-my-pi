use std::{error::Error as StdError, fmt, io};

use http::Uri;
use wreq_proto::ext::ReasonPhrase;

use crate::{StatusCode, util::Escape};

/// A `Result` alias where the `Err` case is `wreq::Error`.
pub type Result<T> = std::result::Result<T, Error>;

/// A boxed error type that can be used for dynamic error handling.
pub type BoxError = Box<dyn StdError + Send + Sync>;

/// The Errors that may occur when processing a `Request`.
///
/// Note: Errors may include the full URI used to make the `Request`. If the URI
/// contains sensitive information (e.g. an API key as a query parameter), be
/// sure to remove it ([`without_uri`](Error::without_uri))
pub struct Error {
    inner: Box<Inner>,
}

struct Inner {
    kind: Kind,
    source: Option<BoxError>,
    uri: Option<Uri>,
}

#[derive(Debug)]
enum Kind {
    Builder,
    Request,
    Tls,
    Redirect,
    Status(StatusCode, Option<ReasonPhrase>),
    Body,
    Decode,
    Upgrade,
    #[cfg(feature = "ws")]
    WebSocket,
}

impl Error {
    fn new<E>(kind: Kind, source: Option<E>) -> Error
    where
        E: Into<BoxError>,
    {
        Error {
            inner: Box::new(Inner {
                kind,
                source: source.map(Into::into),
                uri: None,
            }),
        }
    }

    #[inline]
    pub(crate) fn builder<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Builder, Some(e))
    }

    #[inline]
    pub(crate) fn body<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Body, Some(e))
    }

    #[inline]
    pub(crate) fn tls<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Tls, Some(e))
    }

    #[inline]
    pub(crate) fn decode<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Decode, Some(e))
    }

    #[inline]
    pub(crate) fn request<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Request, Some(e))
    }

    #[inline]
    pub(crate) fn redirect<E: Into<BoxError>>(e: E, uri: Uri) -> Error {
        Error::new(Kind::Redirect, Some(e)).with_uri(uri)
    }

    #[inline]
    pub(crate) fn upgrade<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::Upgrade, Some(e))
    }

    #[inline]
    #[cfg(feature = "ws")]
    pub(crate) fn websocket<E: Into<BoxError>>(e: E) -> Error {
        Error::new(Kind::WebSocket, Some(e))
    }

    #[inline]
    pub(crate) fn status_code(uri: Uri, status: StatusCode, reason: Option<ReasonPhrase>) -> Error {
        Error::new(Kind::Status(status, reason), None::<Error>).with_uri(uri)
    }

    #[inline]
    pub(crate) fn uri_bad_scheme(uri: Uri) -> Error {
        Error::new(Kind::Builder, Some(BadScheme)).with_uri(uri)
    }
}

impl Error {
    /// Returns a possible URI related to this error.
    ///
    /// # Examples
    ///
    /// ```
    /// # async fn run() {
    /// // displays last stop of a redirect loop
    /// let response = wreq::get("http://site.with.redirect.loop")
    ///     .send()
    ///     .await;
    /// if let Err(e) = response {
    ///     if e.is_redirect() {
    ///         if let Some(final_stop) = e.uri() {
    ///             println!("redirect loop at {}", final_stop);
    ///         }
    ///     }
    /// }
    /// # }
    /// ```
    #[inline]
    pub fn uri(&self) -> Option<&Uri> {
        self.inner.uri.as_ref()
    }

    /// Returns a mutable reference to the URI related to this error
    ///
    /// This is useful if you need to remove sensitive information from the URI
    /// (e.g. an API key in the query), but do not want to remove the URI
    /// entirely.
    #[inline]
    pub fn uri_mut(&mut self) -> Option<&mut Uri> {
        self.inner.uri.as_mut()
    }

    /// Add a uri related to this error (overwriting any existing)
    #[inline]
    pub fn with_uri(mut self, uri: Uri) -> Self {
        self.inner.uri = Some(uri);
        self
    }

    /// Strip the related uri from this error (if, for example, it contains
    /// sensitive information)
    #[inline]
    pub fn without_uri(mut self) -> Self {
        self.inner.uri = None;
        self
    }

    /// Returns true if the error is from a type Builder.
    #[inline]
    pub fn is_builder(&self) -> bool {
        matches!(self.inner.kind, Kind::Builder)
    }

    /// Returns true if the error is from a `RedirectPolicy`.
    #[inline]
    pub fn is_redirect(&self) -> bool {
        matches!(self.inner.kind, Kind::Redirect)
    }

    /// Returns true if the error is from `Response::error_for_status`.
    #[inline]
    pub fn is_status(&self) -> bool {
        matches!(self.inner.kind, Kind::Status(_, _))
    }

    /// Returns true if the error is related to a timeout.
    pub fn is_timeout(&self) -> bool {
        let mut source = self.source();

        while let Some(err) = source {
            if err.is::<TimedOut>() {
                return true;
            }

            if let Some(core_err) = err.downcast_ref::<wreq_proto::Error>()
                && core_err.is_timeout()
            {
                return true;
            }

            if let Some(io) = err.downcast_ref::<io::Error>()
                && io.kind() == io::ErrorKind::TimedOut
            {
                return true;
            }

            source = err.source();
        }

        false
    }

    /// Returns true if the error is related to the request
    #[inline]
    pub fn is_request(&self) -> bool {
        matches!(self.inner.kind, Kind::Request)
    }

    /// Returns true if the error is related to connect
    pub fn is_connect(&self) -> bool {
        use crate::client::layer::client::Error;

        let mut source = self.source();

        while let Some(err) = source {
            if let Some(err) = err.downcast_ref::<Error>()
                && err.is_connect()
            {
                return true;
            }

            source = err.source();
        }

        false
    }

    /// Returns true if the error is related to proxy connect
    pub fn is_proxy_connect(&self) -> bool {
        use crate::client::layer::client::Error;

        let mut source = self.source();

        while let Some(err) = source {
            if let Some(err) = err.downcast_ref::<Error>()
                && err.is_proxy_connect()
            {
                return true;
            }

            source = err.source();
        }

        false
    }

    /// Returns true if the error is related to a connection reset.
    pub fn is_connection_reset(&self) -> bool {
        let mut source = self.source();

        while let Some(err) = source {
            if let Some(io) = err.downcast_ref::<io::Error>()
                && io.kind() == io::ErrorKind::ConnectionReset
            {
                return true;
            }
            source = err.source();
        }

        false
    }

    /// Returns true if the error is related to DNS resolution.
    pub fn is_dns(&self) -> bool {
        let mut source = self.source();

        while let Some(err) = source {
            if err.is::<DnsError>() {
                return true;
            }

            source = err.source();
        }

        false
    }

    /// Returns true if the error is related to the request or response body
    #[inline]
    pub fn is_body(&self) -> bool {
        matches!(self.inner.kind, Kind::Body)
    }

    /// Returns true if the error is related to TLS
    #[inline]
    pub fn is_tls(&self) -> bool {
        matches!(self.inner.kind, Kind::Tls)
    }

    /// Returns true if the error is related to decoding the response's body
    #[inline]
    pub fn is_decode(&self) -> bool {
        matches!(self.inner.kind, Kind::Decode)
    }

    /// Returns true if the error is related to upgrading the connection
    #[inline]
    pub fn is_upgrade(&self) -> bool {
        matches!(self.inner.kind, Kind::Upgrade)
    }

    /// Returns true if the error is related to WebSocket operations
    #[inline]
    #[cfg(feature = "ws")]
    pub fn is_websocket(&self) -> bool {
        matches!(self.inner.kind, Kind::WebSocket)
    }

    /// Returns the status code, if the error was generated from a response.
    pub fn status(&self) -> Option<StatusCode> {
        match self.inner.kind {
            Kind::Status(code, _) => Some(code),
            _ => None,
        }
    }
}

/// Maps external timeout errors (such as `tower::timeout::error::Elapsed`)
/// to the internal `TimedOut` error type used for connector operations.
/// Returns the original error if it is not a timeout.
#[inline]
pub(crate) fn map_timeout_to_connector_error(error: BoxError) -> BoxError {
    if error.is::<tower::timeout::error::Elapsed>() {
        Box::new(TimedOut)
    } else {
        error
    }
}

/// Maps external timeout errors (such as `tower::timeout::error::Elapsed`)
/// to the internal request-level `Error` type.
/// Returns the original error if it is not a timeout.
#[inline]
pub(crate) fn map_timeout_to_request_error(error: BoxError) -> BoxError {
    if error.is::<tower::timeout::error::Elapsed>() {
        Box::new(Error::request(TimedOut))
    } else {
        error
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        let mut builder = f.debug_struct("wreq::Error");

        builder.field("kind", &self.inner.kind);

        if let Some(ref uri) = self.inner.uri {
            builder.field("uri", uri);
        }

        if let Some(ref source) = self.inner.source {
            builder.field("source", source);
        }

        builder.finish()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self.inner.kind {
            Kind::Builder => f.write_str("builder error")?,
            Kind::Request => f.write_str("error sending request")?,
            Kind::Body => f.write_str("request or response body error")?,
            Kind::Tls => f.write_str("tls error")?,
            Kind::Decode => f.write_str("error decoding response body")?,
            Kind::Redirect => f.write_str("error following redirect")?,
            Kind::Upgrade => f.write_str("error upgrading connection")?,
            #[cfg(feature = "ws")]
            Kind::WebSocket => f.write_str("websocket error")?,
            Kind::Status(ref code, ref reason) => {
                let prefix = if code.is_client_error() {
                    "HTTP status client error"
                } else {
                    debug_assert!(code.is_server_error());
                    "HTTP status server error"
                };
                if let Some(reason) = reason {
                    write!(
                        f,
                        "{prefix} ({} {})",
                        code.as_str(),
                        Escape::new(reason.as_ref())
                    )?;
                } else {
                    write!(f, "{prefix} ({code})")?;
                }
            }
        };

        if let Some(uri) = &self.inner.uri {
            write!(f, " for uri ({})", uri)?;
        }

        if let Some(e) = &self.inner.source {
            write!(f, ": {e}")?;
        }

        Ok(())
    }
}

impl StdError for Error {
    #[inline]
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.inner.source.as_ref().map(|e| &**e as _)
    }
}

#[derive(Debug)]
pub(crate) struct TimedOut;

#[derive(Debug)]
pub(crate) struct BadScheme;

#[derive(Debug)]
pub(crate) struct ProxyConnect(pub(crate) BoxError);

#[derive(Debug)]
pub(crate) struct DnsError(pub(crate) BoxError);

// ==== impl TimedOut ====

impl StdError for TimedOut {}

impl fmt::Display for TimedOut {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("operation timed out")
    }
}

// ==== impl BadScheme ====

impl StdError for BadScheme {}

impl fmt::Display for BadScheme {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("URI scheme is not allowed")
    }
}

// ==== impl ProxyConnect ====

impl StdError for ProxyConnect {
    #[inline]
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(&*self.0)
    }
}

impl fmt::Display for ProxyConnect {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "proxy connect error: {}", self.0)
    }
}

// ==== impl DnsError ====

impl StdError for DnsError {
    #[inline]
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        Some(&*self.0)
    }
}

impl fmt::Display for DnsError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "dns resolution error: {}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_send<T: Send>() {}
    fn assert_sync<T: Sync>() {}

    impl super::Error {
        fn into_io(self) -> io::Error {
            io::Error::other(self)
        }
    }

    fn decode_io(e: io::Error) -> Error {
        if e.get_ref().map(|r| r.is::<Error>()).unwrap_or(false) {
            *e.into_inner()
                .expect("io::Error::get_ref was Some(_)")
                .downcast::<Error>()
                .expect("StdError::is() was true")
        } else {
            Error::decode(e)
        }
    }

    #[test]
    fn test_source_chain() {
        let root = Error::new(Kind::Request, None::<Error>);
        assert!(root.source().is_none());

        let link = Error::body(root);
        assert!(link.source().is_some());
        assert_send::<Error>();
        assert_sync::<Error>();
    }

    #[test]
    fn mem_size_of() {
        use std::mem::size_of;
        assert_eq!(size_of::<Error>(), size_of::<usize>());
    }

    #[test]
    fn roundtrip_io_error() {
        let orig = Error::request("orig");
        // Convert wreq::Error into an io::Error...
        let io = orig.into_io();
        // Convert that io::Error back into a wreq::Error...
        let err = decode_io(io);
        // It should have pulled out the original, not nested it...
        match err.inner.kind {
            Kind::Request => (),
            _ => panic!("{err:?}"),
        }
    }

    #[test]
    fn from_unknown_io_error() {
        let orig = io::Error::other("orly");
        let err = decode_io(orig);
        match err.inner.kind {
            Kind::Decode => (),
            _ => panic!("{err:?}"),
        }
    }

    #[test]
    fn is_timeout() {
        let err = Error::request(super::TimedOut);
        assert!(err.is_timeout());

        let io = io::Error::from(io::ErrorKind::TimedOut);
        let nested = Error::request(io);
        assert!(nested.is_timeout());
    }

    #[test]
    fn is_connection_reset() {
        let err = Error::request(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "connection reset",
        ));
        assert!(err.is_connection_reset());

        let io = io::Error::other(err);
        let nested = Error::request(io);
        assert!(nested.is_connection_reset());
    }
}
