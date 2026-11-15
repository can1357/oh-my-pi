//! Error and Result module.
use std::{error::Error as StdError, fmt};

/// Result type often returned from methods that can have crate::core: `Error`s.
pub type Result<T, E = Error> = std::result::Result<T, E>;

pub type BoxError = Box<dyn StdError + Send + Sync>;

type Cause = BoxError;

/// Represents errors that can occur handling HTTP streams.
///
/// # Formatting
///
/// The `Display` implementation of this type will only print the details of
/// this level of error, even though it may have been caused by another error
/// and contain that error in its source. To print all the relevant
/// information, including the source chain, using something like
/// `std::error::Report`, or equivalent 3rd party types.
///
/// The contents of the formatted error message of this specific `Error` type
/// is unspecified. **You must not depend on it.** The wording and details may
/// change in any version, with the goal of improving error messages.
///
/// # Source
///
/// A `wreq_proto::Error` may be caused by another error. To aid in debugging,
/// those are exposed in `Error::source()` as erased types. While it is
/// possible to check the exact type of the sources, they **can not be depended
/// on**. They may come from private internal dependencies, and are subject to
/// change at any moment.
pub struct Error {
    inner: Box<ErrorImpl>,
}

struct ErrorImpl {
    kind: Kind,
    cause: Option<Cause>,
}

#[derive(Debug)]
pub(super) enum Kind {
    Parse(Parse),
    User(User),
    /// A message reached EOF, but is not complete.
    IncompleteMessage,
    /// A connection received a message (or bytes) when not waiting for one.
    UnexpectedMessage,
    /// A pending item was dropped before ever being processed.
    Canceled,
    /// Indicates a channel (client or body sender) is closed.
    ChannelClosed,
    /// An `io::Error` that occurred while trying to read or write to a network stream.
    Io,
    /// Error while reading a body from connection.
    Body,
    /// Error while writing a body to connection.
    BodyWrite,
    /// Error calling AsyncWrite::shutdown()
    Shutdown,
    /// A general error from h2.
    Http2,
}

#[derive(Debug)]
pub(crate) enum Parse {
    Method,
    Version,
    VersionH2,
    Uri,
    Header(Header),
    TooLarge,
    Status,
    Internal,
}

#[derive(Debug)]
pub(crate) enum Header {
    Token,
    ContentLengthInvalid,
    TransferEncodingUnexpected,
}

#[derive(Debug)]
pub(super) enum User {
    /// Error calling user's Body::poll_data().
    Body,
    /// The user aborted writing of the outgoing body.
    BodyWriteAborted,
    /// User tried to send a connect request with a nonzero body
    InvalidConnectWithBody,
    /// Error from future of user's Service.
    Service,
    /// User tried polling for an upgrade that doesn't exist.
    NoUpgrade,
    /// User polled for an upgrade, but low-level API is not using upgrades.
    ManualUpgrade,
    /// The dispatch task is gone.
    DispatchGone,
}

// Sentinel type to indicate the error was caused by a timeout.
#[derive(Debug)]
pub(super) struct TimedOut;

impl Error {
    /// Returns true if this was an HTTP parse error.
    #[inline]
    pub fn is_parse(&self) -> bool {
        matches!(self.inner.kind, Kind::Parse(_))
    }

    /// Returns true if this was an HTTP parse error caused by an invalid response status code or
    /// reason phrase.
    #[inline]
    pub fn is_parse_status(&self) -> bool {
        matches!(self.inner.kind, Kind::Parse(Parse::Status))
    }

    /// Returns true if this error was caused by user code.
    #[inline]
    pub fn is_user(&self) -> bool {
        matches!(self.inner.kind, Kind::User(_))
    }

    /// Returns true if this was about a `Request` that was canceled.
    #[inline]
    pub fn is_canceled(&self) -> bool {
        matches!(self.inner.kind, Kind::Canceled)
    }

    /// Returns true if a sender's channel is closed.
    #[inline]
    pub fn is_closed(&self) -> bool {
        matches!(self.inner.kind, Kind::ChannelClosed)
    }

    /// Returns true if the connection closed before a message could complete.
    #[inline]
    pub fn is_incomplete_message(&self) -> bool {
        matches!(self.inner.kind, Kind::IncompleteMessage)
    }

    /// Returns true if the body write was aborted.
    #[inline]
    pub fn is_body_write_aborted(&self) -> bool {
        matches!(self.inner.kind, Kind::User(User::BodyWriteAborted))
    }

    /// Returns true if the error was caused by a timeout.
    #[inline]
    pub fn is_timeout(&self) -> bool {
        self.find_source::<TimedOut>().is_some()
    }

    #[inline]
    pub(super) fn new(kind: Kind) -> Error {
        Error {
            inner: Box::new(ErrorImpl { kind, cause: None }),
        }
    }

    #[inline]
    pub(super) fn with<C: Into<Cause>>(mut self, cause: C) -> Error {
        self.inner.cause = Some(cause.into());
        self
    }

    pub(crate) fn find_source<E: StdError + 'static>(&self) -> Option<&E> {
        let mut cause = self.source();
        while let Some(err) = cause {
            if let Some(typed) = err.downcast_ref() {
                return Some(typed);
            }
            cause = err.source();
        }

        // else
        None
    }

    pub(super) fn h2_reason(&self) -> http2::Reason {
        // Find an http2::Reason somewhere in the cause stack, if it exists,
        // otherwise assume an INTERNAL_ERROR.
        self.find_source::<http2::Error>()
            .and_then(|h2_err| h2_err.reason())
            .unwrap_or(http2::Reason::INTERNAL_ERROR)
    }

    #[inline]
    pub(super) fn new_canceled() -> Error {
        Error::new(Kind::Canceled)
    }

    #[inline]
    pub(super) fn new_incomplete() -> Error {
        Error::new(Kind::IncompleteMessage)
    }

    #[inline]
    pub(super) fn new_too_large() -> Error {
        Error::new(Kind::Parse(Parse::TooLarge))
    }

    #[inline]
    pub(super) fn new_version_h2() -> Error {
        Error::new(Kind::Parse(Parse::VersionH2))
    }

    #[inline]
    pub(super) fn new_unexpected_message() -> Error {
        Error::new(Kind::UnexpectedMessage)
    }

    #[inline]
    pub(super) fn new_io(cause: std::io::Error) -> Error {
        Error::new(Kind::Io).with(cause)
    }

    #[inline]
    pub(super) fn new_closed() -> Error {
        Error::new(Kind::ChannelClosed)
    }

    #[inline]
    pub(super) fn new_body<E: Into<Cause>>(cause: E) -> Error {
        Error::new(Kind::Body).with(cause)
    }

    #[inline]
    pub(super) fn new_body_write<E: Into<Cause>>(cause: E) -> Error {
        Error::new(Kind::BodyWrite).with(cause)
    }

    #[inline]
    pub(super) fn new_body_write_aborted() -> Error {
        Error::new(Kind::User(User::BodyWriteAborted))
    }

    #[inline]
    fn new_user(user: User) -> Error {
        Error::new(Kind::User(user))
    }

    #[inline]
    pub(super) fn new_user_no_upgrade() -> Error {
        Error::new_user(User::NoUpgrade)
    }

    #[inline]
    pub(super) fn new_user_manual_upgrade() -> Error {
        Error::new_user(User::ManualUpgrade)
    }

    #[inline]
    pub(super) fn new_user_service<E: Into<Cause>>(cause: E) -> Error {
        Error::new_user(User::Service).with(cause)
    }

    #[inline]
    pub(super) fn new_user_body<E: Into<Cause>>(cause: E) -> Error {
        Error::new_user(User::Body).with(cause)
    }

    #[inline]
    pub(super) fn new_user_invalid_connect() -> Error {
        Error::new_user(User::InvalidConnectWithBody)
    }

    #[inline]
    pub(super) fn new_shutdown(cause: std::io::Error) -> Error {
        Error::new(Kind::Shutdown).with(cause)
    }

    #[inline]
    pub(super) fn new_user_dispatch_gone() -> Error {
        Error::new(Kind::User(User::DispatchGone))
    }

    pub(super) fn new_h2(cause: ::http2::Error) -> Error {
        if cause.is_io() {
            Error::new_io(cause.into_io().expect("http2::Error::is_io"))
        } else {
            Error::new(Kind::Http2).with(cause)
        }
    }

    fn description(&self) -> &str {
        match self.inner.kind {
            Kind::Parse(Parse::Method) => "invalid HTTP method parsed",
            Kind::Parse(Parse::Version) => "invalid HTTP version parsed",
            Kind::Parse(Parse::VersionH2) => "invalid HTTP version parsed (found HTTP2 preface)",
            Kind::Parse(Parse::Uri) => "invalid URI",
            Kind::Parse(Parse::Header(Header::Token)) => "invalid HTTP header parsed",
            Kind::Parse(Parse::Header(Header::ContentLengthInvalid)) => {
                "invalid content-length parsed"
            }
            Kind::Parse(Parse::Header(Header::TransferEncodingUnexpected)) => {
                "unexpected transfer-encoding parsed"
            }
            Kind::Parse(Parse::TooLarge) => "message head is too large",
            Kind::Parse(Parse::Status) => "invalid HTTP status-code parsed",
            Kind::Parse(Parse::Internal) => {
                "internal error inside wreq and/or its dependencies, please report"
            }

            Kind::IncompleteMessage => "connection closed before message completed",
            Kind::UnexpectedMessage => "received unexpected message from connection",
            Kind::ChannelClosed => "channel closed",
            Kind::Canceled => "operation was canceled",
            Kind::Body => "error reading a body from connection",
            Kind::BodyWrite => "error writing a body to connection",
            Kind::Shutdown => "error shutting down connection",
            Kind::Http2 => "http2 error",
            Kind::Io => "connection error",

            Kind::User(User::Body) => "error from user's Body stream",
            Kind::User(User::BodyWriteAborted) => "user body write aborted",
            Kind::User(User::InvalidConnectWithBody) => {
                "user sent CONNECT request with non-zero body"
            }
            Kind::User(User::Service) => "error from user's Service",
            Kind::User(User::NoUpgrade) => "no upgrade available",
            Kind::User(User::ManualUpgrade) => "upgrade expected but low level API in use",
            Kind::User(User::DispatchGone) => "dispatch task is gone",
        }
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut f = f.debug_tuple("wreq_proto::Error");
        f.field(&self.inner.kind);
        if let Some(ref cause) = self.inner.cause {
            f.field(cause);
        }
        f.finish()
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.description())
    }
}

impl StdError for Error {
    fn source(&self) -> Option<&(dyn StdError + 'static)> {
        self.inner
            .cause
            .as_ref()
            .map(|cause| &**cause as &(dyn StdError + 'static))
    }
}

#[doc(hidden)]
impl From<Parse> for Error {
    fn from(err: Parse) -> Error {
        Error::new(Kind::Parse(err))
    }
}

impl Parse {
    #[inline]
    pub(crate) fn content_length_invalid() -> Self {
        Parse::Header(Header::ContentLengthInvalid)
    }

    #[inline]
    pub(crate) fn transfer_encoding_unexpected() -> Self {
        Parse::Header(Header::TransferEncodingUnexpected)
    }
}

impl From<httparse::Error> for Parse {
    fn from(err: httparse::Error) -> Parse {
        match err {
            httparse::Error::HeaderName
            | httparse::Error::HeaderValue
            | httparse::Error::NewLine
            | httparse::Error::Token => Parse::Header(Header::Token),
            httparse::Error::Status => Parse::Status,
            httparse::Error::TooManyHeaders => Parse::TooLarge,
            httparse::Error::Version => Parse::Version,
        }
    }
}

impl From<http::method::InvalidMethod> for Parse {
    fn from(_: http::method::InvalidMethod) -> Parse {
        Parse::Method
    }
}

impl From<http::status::InvalidStatusCode> for Parse {
    fn from(_: http::status::InvalidStatusCode) -> Parse {
        Parse::Status
    }
}

impl From<http::uri::InvalidUri> for Parse {
    fn from(_: http::uri::InvalidUri) -> Parse {
        Parse::Uri
    }
}

impl From<http::uri::InvalidUriParts> for Parse {
    fn from(_: http::uri::InvalidUriParts) -> Parse {
        Parse::Uri
    }
}

// ===== impl TimedOut ====

impl fmt::Display for TimedOut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("operation timed out")
    }
}

impl StdError for TimedOut {}

#[cfg(test)]
mod tests {
    use std::mem;

    use super::*;

    fn assert_send_sync<T: Send + Sync + 'static>() {}

    #[test]
    fn error_satisfies_send_sync() {
        assert_send_sync::<Error>()
    }

    #[test]
    fn error_size_of() {
        assert_eq!(mem::size_of::<Error>(), mem::size_of::<usize>());
    }

    #[test]
    fn h2_reason_unknown() {
        let closed = Error::new_closed();
        assert_eq!(closed.h2_reason(), http2::Reason::INTERNAL_ERROR);
    }

    #[test]
    fn h2_reason_one_level() {
        let body_err = Error::new_user_body(http2::Error::from(http2::Reason::ENHANCE_YOUR_CALM));
        assert_eq!(body_err.h2_reason(), http2::Reason::ENHANCE_YOUR_CALM);
    }

    #[test]
    fn h2_reason_nested() {
        let recvd = Error::new_h2(http2::Error::from(http2::Reason::HTTP_1_1_REQUIRED));
        // Suppose a user were proxying the received error
        let svc_err = Error::new_user_service(recvd);
        assert_eq!(svc_err.h2_reason(), http2::Reason::HTTP_1_1_REQUIRED);
    }
}
