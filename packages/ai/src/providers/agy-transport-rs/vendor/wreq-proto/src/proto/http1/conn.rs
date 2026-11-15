use std::{
    fmt, io,
    marker::{PhantomData, Unpin},
    pin::Pin,
    task::{ready, Context, Poll},
};

use bytes::{Buf, Bytes};
use http::{
    header::{HeaderValue, CONNECTION, TE},
    HeaderMap, Method, Version,
};
use http_body::Frame;
use httparse::ParserConfig;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{
    encode::{EncodedBuf, Encoder},
    io::Buffered,
    Decoder, Encode, Http1Transaction, ParseContext, Wants,
};
use crate::{
    body::DecodedLength,
    ext::OnInformational,
    proto::{headers, BodyLength, MessageHead},
    upgrade, Error, Result,
};

/// This handles a connection, which will have been established over an
/// `AsyncRead + AsyncWrite` (like a socket), and will likely include multiple
/// `Transaction`s over HTTP.
///
/// The connection will determine when a message begins and ends as well as
/// determine if this connection can be kept alive after the message,
/// or if it is complete.
pub(crate) struct Conn<I, B, T> {
    io: Buffered<I, EncodedBuf<B>>,
    state: State,
    _marker: PhantomData<fn(T)>,
}

impl<I, B, T> Conn<I, B, T>
where
    I: AsyncRead + AsyncWrite + Unpin,
    B: Buf,
    T: Http1Transaction,
{
    pub(crate) fn new(io: I) -> Conn<I, B, T> {
        Conn {
            io: Buffered::new(io),
            state: State {
                allow_half_close: false,
                cached_headers: None,
                error: None,
                keep_alive: KA::Busy,
                method: None,
                h1_parser_config: ParserConfig::default(),
                h1_max_headers: None,
                h09_responses: false,
                on_informational: None,
                notify_read: false,
                reading: Reading::Init,
                writing: Writing::Init,
                upgrade: None,
                // We assume a modern world where the remote speaks HTTP/1.1.
                // If they tell us otherwise, we'll downgrade in `read_head`.
                version: Version::HTTP_11,
                allow_trailer_fields: false,
            },
            _marker: PhantomData,
        }
    }

    #[inline]
    pub(crate) fn set_write_strategy_queue(&mut self) {
        self.io.set_write_strategy_queue();
    }

    #[inline]
    pub(crate) fn set_max_buf_size(&mut self, max: usize) {
        self.io.set_max_buf_size(max);
    }

    #[inline]
    pub(crate) fn set_read_buf_exact_size(&mut self, sz: usize) {
        self.io.set_read_buf_exact_size(sz);
    }

    #[inline]
    pub(crate) fn set_write_strategy_flatten(&mut self) {
        self.io.set_write_strategy_flatten();
    }

    #[inline]
    pub(crate) fn set_h1_parser_config(&mut self, parser_config: ParserConfig) {
        self.state.h1_parser_config = parser_config;
    }

    #[inline]
    pub(crate) fn set_h09_responses(&mut self) {
        self.state.h09_responses = true;
    }

    #[inline]
    pub(crate) fn set_http1_max_headers(&mut self, val: usize) {
        self.state.h1_max_headers = Some(val);
    }

    #[inline]
    pub(super) fn into_inner(self) -> (I, Bytes) {
        self.io.into_inner()
    }

    #[inline]
    pub(super) fn pending_upgrade(&mut self) -> Option<upgrade::Pending> {
        self.state.upgrade.take()
    }

    #[inline]
    pub(super) fn is_read_closed(&self) -> bool {
        self.state.is_read_closed()
    }

    #[inline]
    pub(super) fn is_write_closed(&self) -> bool {
        self.state.is_write_closed()
    }

    pub(super) fn can_read_head(&self) -> bool {
        if !matches!(self.state.reading, Reading::Init) {
            return false;
        }

        !matches!(self.state.writing, Writing::Init)
    }

    #[inline]
    pub(super) fn can_read_body(&self) -> bool {
        matches!(
            self.state.reading,
            Reading::Body(..) | Reading::Continue(..)
        )
    }

    #[inline]
    fn should_error_on_eof(&self) -> bool {
        // If we're idle, it's probably just the connection closing gracefully.
        !self.state.is_idle()
    }

    #[inline]
    fn has_h2_prefix(&self) -> bool {
        const H2_PREFACE: &[u8] = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
        let read_buf = self.io.read_buf();
        read_buf.starts_with(H2_PREFACE)
    }

    #[allow(clippy::type_complexity)]
    pub(super) fn poll_read_head(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<(MessageHead<T::Incoming>, DecodedLength, Wants)>>> {
        debug_assert!(self.can_read_head());
        trace!("Conn::read_head");

        let msg = match self.io.parse::<T>(
            cx,
            ParseContext {
                cached_headers: &mut self.state.cached_headers,
                req_method: &mut self.state.method,
                h1_parser_config: &self.state.h1_parser_config,
                h1_max_headers: self.state.h1_max_headers,
                h09_responses: self.state.h09_responses,
                on_informational: &mut self.state.on_informational,
            },
        ) {
            Poll::Ready(Ok(msg)) => msg,
            Poll::Ready(Err(e)) => return self.on_read_head_error(e),
            Poll::Pending => {
                return Poll::Pending;
            }
        };

        // Note: don't deconstruct `msg` into local variables, it appears
        // the optimizer doesn't remove the extra copies.

        debug!("incoming body is {}", msg.decode);

        // Prevent accepting HTTP/0.9 responses after the initial one, if any.
        self.state.h09_responses = false;

        // Drop any OnInformational callbacks, we're done there!
        self.state.on_informational = None;

        self.state.busy();
        self.state.keep_alive &= msg.keep_alive;
        self.state.version = msg.head.version;

        let mut wants = if msg.wants_upgrade {
            Wants::UPGRADE
        } else {
            Wants::EMPTY
        };

        if msg.decode == DecodedLength::ZERO {
            if msg.expect_continue {
                debug!("ignoring expect-continue since body is empty");
            }
            self.state.reading = Reading::KeepAlive;
            self.try_keep_alive(cx);
        } else if msg.expect_continue && msg.head.version.gt(&Version::HTTP_10) {
            // TODO: remove this when we land h1_max_header_size support
            let h1_max_header_size = None;
            self.state.reading = Reading::Continue(Decoder::new(
                msg.decode,
                self.state.h1_max_headers,
                h1_max_header_size,
            ));
            wants = wants.add(Wants::EXPECT);
        } else {
            // TODO: remove this when we land h1_max_header_size support
            let h1_max_header_size = None;
            self.state.reading = Reading::Body(Decoder::new(
                msg.decode,
                self.state.h1_max_headers,
                h1_max_header_size,
            ));
        }

        self.state.allow_trailer_fields = msg
            .head
            .headers
            .get(TE)
            .is_some_and(|te_header| te_header == "trailers");

        Poll::Ready(Some(Ok((msg.head, msg.decode, wants))))
    }

    fn on_read_head_error<Z>(&mut self, e: Error) -> Poll<Option<Result<Z>>> {
        // If we are currently waiting on a message, then an empty
        // message should be reported as an error. If not, it is just
        // the connection closing gracefully.
        let must_error = self.should_error_on_eof();
        self.close_read();
        self.io.consume_leading_lines();
        let was_mid_parse = e.is_parse() || !self.io.read_buf().is_empty();
        if was_mid_parse || must_error {
            // We check if the buf contains the h2 Preface
            debug!(
                "parse error ({}) with {} bytes",
                e,
                self.io.read_buf().len()
            );
            match self.on_parse_error(e) {
                Ok(()) => Poll::Pending, // XXX: wat?
                Err(e) => Poll::Ready(Some(Err(e))),
            }
        } else {
            debug!("read eof");
            self.close_write();
            Poll::Ready(None)
        }
    }

    pub(super) fn poll_read_body(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<Option<io::Result<Frame<Bytes>>>> {
        debug_assert!(self.can_read_body());

        let (reading, ret) = match self.state.reading {
            Reading::Body(ref mut decoder) => {
                match ready!(decoder.decode(cx, &mut self.io)) {
                    Ok(frame) => {
                        if frame.is_data() {
                            let slice = frame.data_ref().unwrap_or_else(|| unreachable!());
                            let (reading, maybe_frame) = if decoder.is_eof() {
                                debug!("incoming body completed");
                                (
                                    Reading::KeepAlive,
                                    if !slice.is_empty() {
                                        Some(Ok(frame))
                                    } else {
                                        None
                                    },
                                )
                            } else if slice.is_empty() {
                                error!("incoming body unexpectedly ended");
                                // This should be unreachable, since all 3 decoders
                                // either set eof=true or return an Err when reading
                                // an empty slice...
                                (Reading::Closed, None)
                            } else {
                                return Poll::Ready(Some(Ok(frame)));
                            };
                            (reading, Poll::Ready(maybe_frame))
                        } else if frame.is_trailers() {
                            debug!("incoming body completed with trailers");
                            (Reading::KeepAlive, Poll::Ready(Some(Ok(frame))))
                        } else {
                            trace!("discarding unknown frame");
                            (Reading::Closed, Poll::Ready(None))
                        }
                    }
                    Err(e) => {
                        debug!("incoming body decode error: {}", e);
                        (Reading::Closed, Poll::Ready(Some(Err(e))))
                    }
                }
            }
            Reading::Continue(ref decoder) => {
                // Write the 100 Continue if not already responded...
                if let Writing::Init = self.state.writing {
                    trace!("automatically sending 100 Continue");
                    let cont = b"HTTP/1.1 100 Continue\r\n\r\n";
                    self.io.headers_buf().extend_from_slice(cont);
                }

                // And now recurse once in the Reading::Body state...
                self.state.reading = Reading::Body(decoder.clone());
                return self.poll_read_body(cx);
            }
            _ => unreachable!("poll_read_body invalid state: {:?}", self.state.reading),
        };

        self.state.reading = reading;
        self.try_keep_alive(cx);
        ret
    }

    #[inline]
    pub(super) fn wants_read_again(&mut self) -> bool {
        let ret = self.state.notify_read;
        self.state.notify_read = false;
        ret
    }

    pub(super) fn poll_read_keep_alive(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        debug_assert!(!self.can_read_head() && !self.can_read_body());

        if self.is_read_closed() {
            Poll::Pending
        } else if self.is_mid_message() {
            self.mid_message_detect_eof(cx)
        } else {
            self.require_empty_read(cx)
        }
    }

    #[inline]
    fn is_mid_message(&self) -> bool {
        !matches!(
            (&self.state.reading, &self.state.writing),
            (&Reading::Init, &Writing::Init)
        )
    }

    // This will check to make sure the io object read is empty.
    //
    // This should only be called for Clients wanting to enter the idle
    // state.
    fn require_empty_read(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        debug_assert!(!self.can_read_head() && !self.can_read_body() && !self.is_read_closed());
        debug_assert!(!self.is_mid_message());

        if !self.io.read_buf().is_empty() {
            debug!("received an unexpected {} bytes", self.io.read_buf().len());
            return Poll::Ready(Err(Error::new_unexpected_message()));
        }

        let num_read = ready!(self.force_io_read(cx)).map_err(Error::new_io)?;

        if num_read == 0 {
            let ret = if self.should_error_on_eof() {
                trace!("found unexpected EOF on busy connection: {:?}", self.state);
                Poll::Ready(Err(Error::new_incomplete()))
            } else {
                trace!("found EOF on idle connection, closing");
                Poll::Ready(Ok(()))
            };

            // order is important: should_error needs state BEFORE close_read
            self.state.close_read();
            return ret;
        }

        debug!(
            "received unexpected {} bytes on an idle connection",
            num_read
        );
        Poll::Ready(Err(Error::new_unexpected_message()))
    }

    fn mid_message_detect_eof(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        debug_assert!(!self.can_read_head() && !self.can_read_body() && !self.is_read_closed());
        debug_assert!(self.is_mid_message());

        if self.state.allow_half_close || !self.io.read_buf().is_empty() {
            return Poll::Pending;
        }

        let num_read = ready!(self.force_io_read(cx)).map_err(Error::new_io)?;

        if num_read == 0 {
            trace!("found unexpected EOF on busy connection: {:?}", self.state);
            self.state.close_read();
            Poll::Ready(Err(Error::new_incomplete()))
        } else {
            Poll::Ready(Ok(()))
        }
    }

    fn force_io_read(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        debug_assert!(!self.state.is_read_closed());

        let result = ready!(self.io.poll_read_from_io(cx));
        #[allow(clippy::manual_inspect)]
        Poll::Ready(result.map_err(|e| {
            trace!(error = %e, "force_io_read; io error");
            self.state.close();
            e
        }))
    }

    fn maybe_notify(&mut self, cx: &mut Context<'_>) {
        // its possible that we returned NotReady from poll() without having
        // exhausted the underlying Io. We would have done this when we
        // determined we couldn't keep reading until we knew how writing
        // would finish.

        match self.state.reading {
            Reading::Continue(..) | Reading::Body(..) | Reading::KeepAlive | Reading::Closed => {
                return;
            }
            Reading::Init => (),
        };

        match self.state.writing {
            Writing::Body(..) => return,
            Writing::Init | Writing::KeepAlive | Writing::Closed => (),
        }

        if !self.io.is_read_blocked() {
            if self.io.read_buf().is_empty() {
                match self.io.poll_read_from_io(cx) {
                    Poll::Ready(Ok(n)) => {
                        if n == 0 {
                            trace!("maybe_notify; read eof");
                            if self.state.is_idle() {
                                self.state.close();
                            } else {
                                self.close_read()
                            }
                            return;
                        }
                    }
                    Poll::Pending => {
                        trace!("maybe_notify; read_from_io blocked");
                        return;
                    }
                    Poll::Ready(Err(e)) => {
                        trace!("maybe_notify; read_from_io error: {}", e);
                        self.state.close();
                        self.state.error = Some(Error::new_io(e));
                    }
                }
            }
            self.state.notify_read = true;
        }
    }

    #[inline]
    fn try_keep_alive(&mut self, cx: &mut Context<'_>) {
        self.state.try_keep_alive::<T>();
        self.maybe_notify(cx);
    }

    #[inline]
    pub(super) fn can_write_head(&self) -> bool {
        if matches!(self.state.reading, Reading::Closed) {
            return false;
        }

        match self.state.writing {
            Writing::Init => self.io.can_headers_buf(),
            _ => false,
        }
    }

    #[inline]
    pub(super) fn can_write_body(&self) -> bool {
        match self.state.writing {
            Writing::Body(..) => true,
            Writing::Init | Writing::KeepAlive | Writing::Closed => false,
        }
    }

    #[inline]
    pub(super) fn can_buffer_body(&self) -> bool {
        self.io.can_buffer()
    }

    pub(super) fn write_head(&mut self, head: MessageHead<T::Outgoing>, body: Option<BodyLength>) {
        if let Some(encoder) = self.encode_head(head, body) {
            self.state.writing = if !encoder.is_eof() {
                Writing::Body(encoder)
            } else if encoder.is_last() {
                Writing::Closed
            } else {
                Writing::KeepAlive
            };
        }
    }

    fn encode_head(
        &mut self,
        mut head: MessageHead<T::Outgoing>,
        body: Option<BodyLength>,
    ) -> Option<Encoder> {
        debug_assert!(self.can_write_head());

        self.state.busy();

        self.enforce_version(&mut head);
        let buf = self.io.headers_buf();

        trace_span!("encode_headers");

        match T::encode(
            Encode {
                head: &mut head,
                body,
                req_method: &mut self.state.method,
            },
            buf,
        ) {
            Ok(encoder) => {
                debug_assert!(self.state.cached_headers.is_none());
                debug_assert!(head.headers.is_empty());
                self.state.cached_headers = Some(head.headers);
                self.state.on_informational = head.extensions.remove::<OnInformational>();

                Some(encoder)
            }
            Err(err) => {
                self.state.error = Some(err);
                self.state.writing = Writing::Closed;
                None
            }
        }
    }

    // Fix keep-alive when Connection: keep-alive header is not present
    fn fix_keep_alive(&mut self, head: &mut MessageHead<T::Outgoing>) {
        let outgoing_is_keep_alive = head
            .headers
            .get(CONNECTION)
            .is_some_and(headers::connection_keep_alive);

        if !outgoing_is_keep_alive {
            match head.version {
                // If response is version 1.0 and keep-alive is not present in the response,
                // disable keep-alive so the server closes the connection
                Version::HTTP_10 => self.state.disable_keep_alive(),
                // If response is version 1.1 and keep-alive is wanted, add
                // Connection: keep-alive header when not present
                Version::HTTP_11 if self.state.wants_keep_alive() => {
                    head.headers
                        .insert(CONNECTION, HeaderValue::from_static("keep-alive"));
                }
                _ => (),
            }
        }
    }

    // If we know the remote speaks an older version, we try to fix up any messages
    // to work with our older peer.
    fn enforce_version(&mut self, head: &mut MessageHead<T::Outgoing>) {
        match self.state.version {
            Version::HTTP_10 => {
                // Fixes response or connection when keep-alive header is not present
                self.fix_keep_alive(head);
                // If the remote only knows HTTP/1.0, we should force ourselves
                // to do only speak HTTP/1.0 as well.
                head.version = Version::HTTP_10;
            }
            Version::HTTP_11 => {
                if let KA::Disabled = self.state.keep_alive.status() {
                    head.headers
                        .insert(CONNECTION, HeaderValue::from_static("close"));
                }
            }
            _ => (),
        }
        // If the remote speaks HTTP/1.1, then it *should* be fine with
        // both HTTP/1.0 and HTTP/1.1 from us. So again, we just let
        // the user's headers be.
    }

    pub(super) fn write_body(&mut self, chunk: B) {
        debug_assert!(self.can_write_body() && self.can_buffer_body());
        // empty chunks should be discarded at Dispatcher level
        debug_assert!(chunk.remaining() != 0);

        let state = match self.state.writing {
            Writing::Body(ref mut encoder) => {
                self.io.buffer(encoder.encode(chunk));

                if !encoder.is_eof() {
                    return;
                }

                if encoder.is_last() {
                    Writing::Closed
                } else {
                    Writing::KeepAlive
                }
            }
            _ => unreachable!("write_body invalid state: {:?}", self.state.writing),
        };

        self.state.writing = state;
    }

    pub(super) fn write_trailers(&mut self, trailers: HeaderMap) {
        debug_assert!(self.can_write_body() && self.can_buffer_body());

        match self.state.writing {
            Writing::Body(ref encoder) => {
                if let Some(enc_buf) = encoder.encode_trailers(trailers) {
                    self.io.buffer(enc_buf);

                    self.state.writing = if encoder.is_last() || encoder.is_close_delimited() {
                        Writing::Closed
                    } else {
                        Writing::KeepAlive
                    };
                }
            }
            _ => unreachable!("write_trailers invalid state: {:?}", self.state.writing),
        }
    }

    pub(super) fn write_body_and_end(&mut self, chunk: B) {
        debug_assert!(self.can_write_body() && self.can_buffer_body());
        // empty chunks should be discarded at Dispatcher level
        debug_assert!(chunk.remaining() != 0);

        let state = match self.state.writing {
            Writing::Body(ref encoder) => {
                let can_keep_alive = encoder.encode_and_end(chunk, self.io.write_buf());
                if can_keep_alive {
                    Writing::KeepAlive
                } else {
                    Writing::Closed
                }
            }
            _ => unreachable!("write_body invalid state: {:?}", self.state.writing),
        };

        self.state.writing = state;
    }

    pub(super) fn end_body(&mut self) -> Result<()> {
        debug_assert!(self.can_write_body());

        let encoder = match self.state.writing {
            Writing::Body(ref mut enc) => enc,
            _ => return Ok(()),
        };

        // end of stream, that means we should try to eof
        match encoder.end() {
            Ok(end) => {
                if let Some(end) = end {
                    self.io.buffer(end);
                }

                self.state.writing = if encoder.is_last() || encoder.is_close_delimited() {
                    Writing::Closed
                } else {
                    Writing::KeepAlive
                };

                Ok(())
            }
            Err(not_eof) => {
                self.state.writing = Writing::Closed;
                Err(Error::new_body_write_aborted().with(not_eof))
            }
        }
    }

    // When we get a parse error, depending on what side we are, we might be able
    // to write a response before closing the connection.
    //
    // - Client: there is nothing we can do
    // - Server: if Response hasn't been written yet, we can send a 4xx response
    fn on_parse_error(&mut self, err: Error) -> Result<()> {
        if let Writing::Init = self.state.writing {
            if self.has_h2_prefix() {
                return Err(Error::new_version_h2());
            }
            if let Some(msg) = T::on_error(&err) {
                // Drop the cached headers so as to not trigger a debug
                // assert in `write_head`...
                self.state.cached_headers.take();
                self.write_head(msg, None);
                self.state.error = Some(err);
                return Ok(());
            }
        }

        // fallback is pass the error back up
        Err(err)
    }

    pub(super) fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        ready!(Pin::new(&mut self.io).poll_flush(cx))?;
        self.try_keep_alive(cx);
        trace!("flushed({}): {:?}", T::LOG, self.state);
        Poll::Ready(Ok(()))
    }

    pub(super) fn poll_shutdown(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match ready!(Pin::new(self.io.io_mut()).poll_shutdown(cx)) {
            Ok(()) => {
                trace!("shut down IO complete");
                Poll::Ready(Ok(()))
            }
            Err(e) => {
                debug!("error shutting down IO: {}", e);
                Poll::Ready(Err(e))
            }
        }
    }

    /// If the read side can be cheaply drained, do so. Otherwise, close.
    pub(super) fn poll_drain_or_close_read(&mut self, cx: &mut Context<'_>) {
        if let Reading::Continue(ref decoder) = self.state.reading {
            // skip sending the 100-continue
            // just move forward to a read, in case a tiny body was included
            self.state.reading = Reading::Body(decoder.clone());
        }

        let _ = self.poll_read_body(cx);

        // If still in Reading::Body, just give up
        match self.state.reading {
            Reading::Init | Reading::KeepAlive => {
                trace!("body drained")
            }
            _ => self.close_read(),
        }
    }

    #[inline]
    pub(super) fn close_read(&mut self) {
        self.state.close_read();
    }

    #[inline]
    pub(super) fn close_write(&mut self) {
        self.state.close_write();
    }

    pub(super) fn take_error(&mut self) -> Result<()> {
        if let Some(err) = self.state.error.take() {
            Err(err)
        } else {
            Ok(())
        }
    }

    #[inline]
    pub(super) fn on_upgrade(&mut self) -> upgrade::OnUpgrade {
        trace!("{}: prepare possible HTTP upgrade", T::LOG);
        self.state.prepare_upgrade()
    }
}

impl<I, B: Buf, T> fmt::Debug for Conn<I, B, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Conn")
            .field("state", &self.state)
            .field("io", &self.io)
            .finish()
    }
}

// B and T are never pinned
impl<I: Unpin, B, T> Unpin for Conn<I, B, T> {}

struct State {
    allow_half_close: bool,
    /// Re-usable HeaderMap to reduce allocating new ones.
    cached_headers: Option<HeaderMap>,
    /// If an error occurs when there wasn't a direct way to return it
    /// back to the user, this is set.
    error: Option<Error>,
    /// Current keep-alive status.
    keep_alive: KA,
    /// If mid-message, the HTTP Method that started it.
    ///
    /// This is used to know things such as if the message can include
    /// a body or not.
    method: Option<Method>,
    h1_parser_config: ParserConfig,
    h1_max_headers: Option<usize>,
    h09_responses: bool,
    /// If set, called with each 1xx informational response received for
    /// the current request. MUST be unset after a non-1xx response is
    /// received.
    on_informational: Option<OnInformational>,
    /// Set to true when the Dispatcher should poll read operations
    /// again. See the `maybe_notify` method for more.
    notify_read: bool,
    /// State of allowed reads
    reading: Reading,
    /// State of allowed writes
    writing: Writing,
    /// An expected pending HTTP upgrade.
    upgrade: Option<upgrade::Pending>,
    /// Either HTTP/1.0 or 1.1 connection
    version: Version,
    /// Flag to track if trailer fields are allowed to be sent
    allow_trailer_fields: bool,
}

#[derive(Debug)]
enum Reading {
    Init,
    Continue(Decoder),
    Body(Decoder),
    KeepAlive,
    Closed,
}

enum Writing {
    Init,
    Body(Encoder),
    KeepAlive,
    Closed,
}

impl fmt::Debug for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut builder = f.debug_struct("State");
        builder
            .field("reading", &self.reading)
            .field("writing", &self.writing)
            .field("keep_alive", &self.keep_alive);

        // Only show error field if it's interesting...
        if let Some(ref error) = self.error {
            builder.field("error", error);
        }

        if self.allow_half_close {
            builder.field("allow_half_close", &true);
        }

        // Purposefully leaving off other fields...
        builder.finish()
    }
}

impl fmt::Debug for Writing {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match *self {
            Writing::Init => f.write_str("Init"),
            Writing::Body(ref enc) => f.debug_tuple("Body").field(enc).finish(),
            Writing::KeepAlive => f.write_str("KeepAlive"),
            Writing::Closed => f.write_str("Closed"),
        }
    }
}

impl std::ops::BitAndAssign<bool> for KA {
    fn bitand_assign(&mut self, enabled: bool) {
        if !enabled {
            trace!("remote disabling keep-alive");
            *self = KA::Disabled;
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
enum KA {
    Idle,
    #[default]
    Busy,
    Disabled,
}

impl KA {
    #[inline]
    fn idle(&mut self) {
        *self = KA::Idle;
    }

    #[inline]
    fn busy(&mut self) {
        *self = KA::Busy;
    }

    #[inline]
    fn disable(&mut self) {
        *self = KA::Disabled;
    }

    #[inline]
    fn status(&self) -> KA {
        *self
    }
}

impl State {
    fn close(&mut self) {
        trace!("State::close()");
        self.reading = Reading::Closed;
        self.writing = Writing::Closed;
        self.keep_alive.disable();
    }

    fn close_read(&mut self) {
        trace!("State::close_read()");
        self.reading = Reading::Closed;
        self.keep_alive.disable();
    }

    fn close_write(&mut self) {
        trace!("State::close_write()");
        self.writing = Writing::Closed;
        self.keep_alive.disable();
    }

    #[inline]
    fn wants_keep_alive(&self) -> bool {
        !matches!(self.keep_alive.status(), KA::Disabled)
    }

    fn try_keep_alive<T: Http1Transaction>(&mut self) {
        match (&self.reading, &self.writing) {
            (&Reading::KeepAlive, &Writing::KeepAlive) => {
                if let KA::Busy = self.keep_alive.status() {
                    self.idle::<T>();
                } else {
                    trace!(
                        "try_keep_alive({}): could keep-alive, but status = {:?}",
                        T::LOG,
                        self.keep_alive
                    );
                    self.close();
                }
            }
            (&Reading::Closed, &Writing::KeepAlive) | (&Reading::KeepAlive, &Writing::Closed) => {
                self.close()
            }
            _ => (),
        }
    }

    #[inline]
    fn disable_keep_alive(&mut self) {
        self.keep_alive.disable()
    }

    fn busy(&mut self) {
        if let KA::Disabled = self.keep_alive.status() {
            return;
        }
        self.keep_alive.busy();
    }

    fn idle<T: Http1Transaction>(&mut self) {
        debug_assert!(!self.is_idle(), "State::idle() called while idle");

        self.method = None;
        self.keep_alive.idle();

        if !self.is_idle() {
            self.close();
            return;
        }

        self.reading = Reading::Init;
        self.writing = Writing::Init;

        // If Client connection has just gone idle, the Dispatcher
        // should try the poll loop one more time, so as to poll the
        // pending requests stream.
        self.notify_read = true;
    }

    #[inline]
    fn is_idle(&self) -> bool {
        matches!(self.keep_alive.status(), KA::Idle)
    }

    #[inline]
    fn is_read_closed(&self) -> bool {
        matches!(self.reading, Reading::Closed)
    }

    #[inline]
    fn is_write_closed(&self) -> bool {
        matches!(self.writing, Writing::Closed)
    }

    #[inline]
    fn prepare_upgrade(&mut self) -> upgrade::OnUpgrade {
        let (tx, rx) = upgrade::pending();
        self.upgrade = Some(tx);
        rx
    }
}
