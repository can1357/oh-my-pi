//! HTTP/1 protocol implementation and utilities.

mod buf;
mod decode;
mod encode;
mod io;

pub(crate) mod conn;
pub(crate) mod dispatch;
pub(crate) mod role;

use bytes::BytesMut;
use http::{HeaderMap, Method};
use httparse::ParserConfig;

use self::{conn::Conn, decode::Decoder, encode::Encoder, io::MINIMUM_MAX_BUFFER_SIZE};
use super::{BodyLength, MessageHead};
use crate::{
    body::DecodedLength,
    error::{Error, Parse, Result},
    ext::OnInformational,
};

pub(crate) trait Http1Transaction {
    type Incoming;

    type Outgoing: Default;

    #[cfg(feature = "tracing")]
    const LOG: &'static str;

    fn parse(
        bytes: &mut BytesMut,
        ctx: ParseContext<'_>,
    ) -> Result<Option<ParsedMessage<Self::Incoming>>, Parse>;

    fn encode(enc: Encode<'_, Self::Outgoing>, dst: &mut Vec<u8>) -> Result<Encoder>;

    fn on_error(err: &Error) -> Option<MessageHead<Self::Outgoing>>;

    fn update_date() {}
}

#[derive(Debug)]
pub(crate) struct ParsedMessage<T> {
    head: MessageHead<T>,
    decode: DecodedLength,
    expect_continue: bool,
    keep_alive: bool,
    wants_upgrade: bool,
}

pub(crate) struct ParseContext<'a> {
    cached_headers: &'a mut Option<HeaderMap>,
    req_method: &'a mut Option<Method>,
    h1_parser_config: &'a ParserConfig,
    h1_max_headers: Option<usize>,
    h09_responses: bool,
    on_informational: &'a mut Option<OnInformational>,
}

/// Passed to Http1Transaction::encode
pub(crate) struct Encode<'a, T> {
    head: &'a mut MessageHead<T>,
    body: Option<BodyLength>,
    req_method: &'a mut Option<Method>,
}

/// Extra flags that a request "wants", like expect-continue or upgrades.
#[derive(Clone, Copy, Debug)]
struct Wants(u8);

impl Wants {
    const EMPTY: Wants = Wants(0b00);
    const EXPECT: Wants = Wants(0b01);
    const UPGRADE: Wants = Wants(0b10);

    #[inline]
    #[must_use]
    fn add(self, other: Wants) -> Wants {
        Wants(self.0 | other.0)
    }

    #[inline]
    fn contains(&self, other: Wants) -> bool {
        (self.0 & other.0) == other.0
    }
}

/// Builder for `Http1Options`.
#[must_use]
#[derive(Debug)]
pub struct Http1OptionsBuilder {
    opts: Http1Options,
}

/// Options for tweaking HTTP/1 connection behavior.
///
/// Use `Http1Options` to adjust how HTTP/1 connections work—things like allowing HTTP/0.9
/// responses, controlling header handling, buffer sizes, and more. Most settings are optional and
/// have reasonable defaults.
#[non_exhaustive]
#[derive(Debug, Default, Clone)]
pub struct Http1Options {
    /// Enable support for HTTP/0.9 responses.
    pub h09_responses: bool,

    /// Whether to use vectored writes for HTTP/1 connections.
    pub h1_writev: Option<bool>,

    /// Maximum number of headers allowed in HTTP/1 responses.
    pub h1_max_headers: Option<usize>,

    /// Exact size of the read buffer to use for HTTP/1 connections.
    pub h1_read_buf_exact_size: Option<usize>,

    /// Maximum buffer size for HTTP/1 connections.
    pub h1_max_buf_size: Option<usize>,

    /// Whether to ignore invalid headers in HTTP/1 responses.
    pub ignore_invalid_headers_in_responses: bool,

    /// Whether to allow spaces after header names in HTTP/1 responses.
    pub allow_spaces_after_header_name_in_responses: bool,

    /// Whether to allow obsolete multiline headers in HTTP/1 responses.
    pub allow_obsolete_multiline_headers_in_responses: bool,
}

impl Http1OptionsBuilder {
    /// Set the `http09_responses` field.
    #[inline]
    pub fn http09_responses(mut self, enabled: bool) -> Self {
        self.opts.h09_responses = enabled;
        self
    }

    /// Set whether HTTP/1 connections should try to use vectored writes,
    /// or always flatten into a single buffer.
    ///
    /// Note that setting this to false may mean more copies of body data,
    /// but may also improve performance when an IO transport doesn't
    /// support vectored writes well, such as most TLS implementations.
    ///
    /// Setting this to true will force crate::core: to use queued strategy
    /// which may eliminate unnecessary cloning on some TLS backends
    ///
    /// Default is `auto`. In this mode crate::core: will try to guess which
    /// mode to use
    #[inline]
    pub fn writev(mut self, writev: Option<bool>) -> Self {
        self.opts.h1_writev = writev;
        self
    }

    /// Set the maximum number of headers.
    ///
    /// When a response is received, the parser will reserve a buffer to store headers for optimal
    /// performance.
    ///
    /// If client receives more headers than the buffer size, the error "message header too large"
    /// is returned.
    ///
    /// Note that headers is allocated on the stack by default, which has higher performance. After
    /// setting this value, headers will be allocated in heap memory, that is, heap memory
    /// allocation will occur for each response, and there will be a performance drop of about 5%.
    ///
    /// Default is 100.
    #[inline]
    pub fn max_headers(mut self, max_headers: usize) -> Self {
        self.opts.h1_max_headers = Some(max_headers);
        self
    }

    /// Sets the exact size of the read buffer to *always* use.
    ///
    /// Note that setting this option unsets the `max_buf_size` option.
    ///
    /// Default is an adaptive read buffer.
    #[inline]
    pub fn read_buf_exact_size(mut self, sz: Option<usize>) -> Self {
        self.opts.h1_read_buf_exact_size = sz;
        self.opts.h1_max_buf_size = None;
        self
    }

    /// Set the maximum buffer size for the connection.
    ///
    /// Default is ~400kb.
    ///
    /// Note that setting this option unsets the `read_exact_buf_size` option.
    ///
    /// # Panics
    ///
    /// The minimum value allowed is 8192. This method panics if the passed `max` is less than the
    /// minimum.
    #[inline]
    pub fn max_buf_size(mut self, max: usize) -> Self {
        assert!(
            max >= MINIMUM_MAX_BUFFER_SIZE,
            "the max_buf_size cannot be smaller than the minimum that h1 specifies."
        );

        self.opts.h1_max_buf_size = Some(max);
        self.opts.h1_read_buf_exact_size = None;
        self
    }

    /// Set whether HTTP/1 connections will accept spaces between header names
    /// and the colon that follow them in responses.
    ///
    /// You probably don't need this, here is what [RFC 7230 Section 3.2.4.] has
    /// to say about it:
    ///
    /// > No whitespace is allowed between the header field-name and colon. In
    /// > the past, differences in the handling of such whitespace have led to
    /// > security vulnerabilities in request routing and response handling. A
    /// > server MUST reject any received request message that contains
    /// > whitespace between a header field-name and colon with a response code
    /// > of 400 (Bad Request). A proxy MUST remove any such whitespace from a
    /// > response message before forwarding the message downstream.
    ///
    /// Default is false.
    ///
    /// [RFC 7230 Section 3.2.4.]: https://tools.ietf.org/html/rfc7230#section-3.2.4
    #[inline]
    pub fn allow_spaces_after_header_name_in_responses(mut self, enabled: bool) -> Self {
        self.opts.allow_spaces_after_header_name_in_responses = enabled;
        self
    }

    /// Set whether HTTP/1 connections will silently ignored malformed header lines.
    ///
    /// If this is enabled and a header line does not start with a valid header
    /// name, or does not include a colon at all, the line will be silently ignored
    /// and no error will be reported.
    ///
    /// Default is false.
    #[inline]
    pub fn ignore_invalid_headers_in_responses(mut self, enabled: bool) -> Self {
        self.opts.ignore_invalid_headers_in_responses = enabled;
        self
    }

    /// Set the `allow_obsolete_multiline_headers_in_responses` field.
    #[inline]
    pub fn allow_obsolete_multiline_headers_in_responses(mut self, value: bool) -> Self {
        self.opts.allow_obsolete_multiline_headers_in_responses = value;
        self
    }

    /// Build the [`Http1Options`] instance.
    #[inline]
    pub fn build(self) -> Http1Options {
        self.opts
    }
}

impl Http1Options {
    /// Create a new [`Http1OptionsBuilder`].
    pub fn builder() -> Http1OptionsBuilder {
        Http1OptionsBuilder {
            opts: Http1Options::default(),
        }
    }
}
