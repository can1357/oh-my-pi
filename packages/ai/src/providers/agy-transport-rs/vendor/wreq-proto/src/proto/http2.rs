//! HTTP/2 protocol implementation and utilities.

pub(crate) mod client;
pub(crate) mod ping;

use std::{
    future::Future,
    io::{self, Cursor, IoSlice},
    pin::Pin,
    task::{ready, Context, Poll},
    time::Duration,
};

use bytes::{Buf, Bytes};
use http::{
    header::{HeaderName, CONNECTION, TE, TRANSFER_ENCODING, UPGRADE},
    HeaderMap,
};
pub use http2::frame::{
    Priorities, PrioritiesBuilder, Priority, PseudoId, PseudoOrder, Setting, SettingId,
    SettingsOrder, SettingsOrderBuilder, StreamDependency, StreamId,
};
use http2::{Reason, RecvStream, SendStream};
use http_body::Body;
use pin_project_lite::pin_project;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::{error::BoxError, Error, Result};

/// Default initial stream window size defined in HTTP2 spec.
const SPEC_WINDOW_SIZE: u32 = 65_535;

// Our defaults are chosen for the "majority" case, which usually are not
// resource constrained, and so the spec default of 64kb can be too limiting
// for performance.
const DEFAULT_CONN_WINDOW: u32 = 1024 * 1024 * 5; // 5mb
const DEFAULT_STREAM_WINDOW: u32 = 1024 * 1024 * 2; // 2mb
const DEFAULT_MAX_FRAME_SIZE: u32 = 1024 * 16; // 16kb
const DEFAULT_MAX_SEND_BUF_SIZE: usize = 1024 * 1024; // 1mb
const DEFAULT_MAX_HEADER_LIST_SIZE: u32 = 1024 * 16; // 16kb

// The maximum number of concurrent streams that the client is allowed to open
// before it receives the initial SETTINGS frame from the server.
// This default value is derived from what the HTTP/2 spec recommends as the
// minimum value that endpoints advertise to their peers. It means that using
// this value will minimize the chance of the failure where the local endpoint
// attempts to open too many streams and gets rejected by the remote peer with
// the `REFUSED_STREAM` error.
const DEFAULT_INITIAL_MAX_SEND_STREAMS: usize = 100;

// List of connection headers from RFC 9110 Section 7.6.1
//
// TE headers are allowed in HTTP/2 requests as long as the value is "trailers", so they're
// tested separately.
static CONNECTION_HEADERS: [HeaderName; 4] = [
    HeaderName::from_static("keep-alive"),
    HeaderName::from_static("proxy-connection"),
    TRANSFER_ENCODING,
    UPGRADE,
];

fn strip_connection_headers(headers: &mut HeaderMap, is_request: bool) {
    for header in &CONNECTION_HEADERS {
        if headers.remove(header).is_some() {
            warn!("Connection header illegal in HTTP/2: {}", header.as_str());
        }
    }

    if is_request {
        if headers
            .get(TE)
            .is_some_and(|te_header| te_header != "trailers")
        {
            warn!("TE headers not set to \"trailers\" are illegal in HTTP/2 requests");
            headers.remove(TE);
        }
    } else if headers.remove(TE).is_some() {
        warn!("TE headers illegal in HTTP/2 responses");
    }

    if let Some(header) = headers.remove(CONNECTION) {
        warn!(
            "Connection header illegal in HTTP/2: {}",
            CONNECTION.as_str()
        );

        if let Ok(header_contents) = header.to_str() {
            // A `Connection` header may have a comma-separated list of names of other headers that
            // are meant for only this specific connection.
            //
            // Iterate these names and remove them as headers. Connection-specific headers are
            // forbidden in HTTP2, as that information has been moved into frame types of the h2
            // protocol.
            for name in header_contents.split(',') {
                let name = name.trim();
                headers.remove(name);
            }
        }
    }
}

struct Peeked<D> {
    data: D,
    is_eos: bool,
}

// body adapters used by both Client
pin_project! {
    pub(crate) struct PipeToSendStream<S>
    where
        S: Body,
    {
        #[pin]
        stream: S,
        body_tx: SendStream<SendBuf<S::Data>>,
        data_done: bool,
                // A data chunk that has been polled from the body but is still waiting
        // for stream-level capacity before it can be shipped. Stored here so
        // it survives across `Poll::Pending` returns from `poll_capacity`; if
        // we left the chunk in a local, it would be dropped on every repoll.
        buffered_data: Option<Peeked<S::Data>>,
    }
}

impl<S> PipeToSendStream<S>
where
    S: Body,
{
    #[inline]
    fn new(stream: S, body_tx: SendStream<SendBuf<S::Data>>) -> PipeToSendStream<S> {
        PipeToSendStream {
            stream,
            body_tx,
            data_done: false,
            buffered_data: None,
        }
    }

    #[inline]
    fn send_reset(self: Pin<&mut Self>, reason: http2::Reason) {
        self.project().body_tx.send_reset(reason);
    }
}

impl<S> Future for PipeToSendStream<S>
where
    S: Body,
    S::Error: Into<BoxError>,
{
    type Output = Result<()>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut me = self.project();
        loop {
            // Register for RST_STREAM notification while we wait for the next
            // body chunk or for send capacity, so the task wakes up if the
            // peer resets the stream.
            if let Poll::Ready(reason) = me
                .body_tx
                .poll_reset(cx)
                .map_err(crate::Error::new_body_write)?
            {
                debug!("stream received RST_STREAM: {:?}", reason);
                return Poll::Ready(Err(Error::new_body_write(::http2::Error::from(reason))));
            }

            // If a previously-polled chunk is still waiting for stream-level
            // send capacity, drive that to completion before touching the
            // body again.
            if me.buffered_data.is_some() {
                while me.body_tx.capacity() == 0 {
                    match ready!(me.body_tx.poll_capacity(cx)) {
                        Some(Ok(0)) => {}
                        Some(Ok(_)) => break,
                        Some(Err(e)) => {
                            return Poll::Ready(Err(Error::new_body_write(e)));
                        }
                        None => {
                            // None means the stream is no longer in a
                            // streaming state, we either finished it
                            // somehow, or the remote reset us.
                            return Poll::Ready(Err(Error::new_body_write(
                                "send stream capacity unexpectedly closed",
                            )));
                        }
                    }
                }

                let peeked = me.buffered_data.take().expect("checked is_some above");
                let buf = SendBuf::Buf(peeked.data);
                me.body_tx
                    .send_data(buf, peeked.is_eos)
                    .map_err(Error::new_body_write)?;

                if peeked.is_eos {
                    return Poll::Ready(Ok(()));
                }
                continue;
            }

            // Poll for the next body frame *before* reserving any connection
            // flow-control capacity. Reserving capacity speculatively (even a
            // single byte) pins that capacity on the connection-level window,
            // which can deadlock a second stream when talking to peers that
            // only emit WINDOW_UPDATE once their receive window is fully
            // exhausted. See https://github.com/hyperium/hyper/issues/4003.
            match ready!(me.stream.as_mut().poll_frame(cx)) {
                Some(Ok(frame)) => {
                    if frame.is_data() {
                        let chunk = frame.into_data().unwrap_or_else(|_| unreachable!());
                        let is_eos = me.stream.is_end_stream();
                        let len = chunk.remaining();
                        trace!("send body chunk: {} bytes, eos={}", len, is_eos);

                        if len == 0 {
                            // Zero-length data frames need no capacity; send
                            // them straight through so trailing empty frames
                            // (e.g. an explicit end-of-stream marker) are
                            // delivered.
                            let buf = SendBuf::Buf(chunk);
                            me.body_tx
                                .send_data(buf, is_eos)
                                .map_err(Error::new_body_write)?;

                            if is_eos {
                                return Poll::Ready(Ok(()));
                            }
                            continue;
                        }

                        // Reserve exactly the chunk size so we never pin more
                        // connection-level flow-control window than we are
                        // about to consume. Stash the chunk in `self` so it
                        // survives the upcoming `poll_capacity` wait even if
                        // it returns `Poll::Pending`.
                        me.body_tx.reserve_capacity(len);
                        *me.buffered_data = Some(Peeked {
                            data: chunk,
                            is_eos,
                        });
                    } else if frame.is_trailers() {
                        // no more DATA, so give any capacity back
                        me.body_tx.reserve_capacity(0);
                        me.body_tx
                            .send_trailers(frame.into_trailers().unwrap_or_else(|_| unreachable!()))
                            .map_err(Error::new_body_write)?;
                        return Poll::Ready(Ok(()));
                    } else {
                        trace!("discarding unknown frame");
                        // loop again
                    }
                }
                Some(Err(e)) => return Poll::Ready(Err(me.body_tx.on_user_err(e))),
                None => {
                    // no more frames means we're done here
                    // but at this point, we haven't sent an EOS DATA, or
                    // any trailers, so send an empty EOS DATA.
                    return Poll::Ready(me.body_tx.send_eos_frame());
                }
            }
        }
    }
}

trait SendStreamExt {
    fn on_user_err<E>(&mut self, err: E) -> Error
    where
        E: Into<BoxError>;

    fn send_eos_frame(&mut self) -> Result<()>;
}

impl<B: Buf> SendStreamExt for SendStream<SendBuf<B>> {
    fn on_user_err<E>(&mut self, err: E) -> Error
    where
        E: Into<BoxError>,
    {
        let err = Error::new_user_body(err);
        debug!("send body user stream error: {}", err);
        self.send_reset(err.h2_reason());
        err
    }

    fn send_eos_frame(&mut self) -> Result<()> {
        trace!("send body eos");
        self.send_data(SendBuf::None, true)
            .map_err(Error::new_body_write)
    }
}

#[repr(usize)]
enum SendBuf<B> {
    Buf(B),
    Cursor(Cursor<Box<[u8]>>),
    None,
}

impl<B: Buf> Buf for SendBuf<B> {
    #[inline]
    fn remaining(&self) -> usize {
        match *self {
            Self::Buf(ref b) => b.remaining(),
            Self::Cursor(ref c) => Buf::remaining(c),
            Self::None => 0,
        }
    }

    #[inline]
    fn chunk(&self) -> &[u8] {
        match *self {
            Self::Buf(ref b) => b.chunk(),
            Self::Cursor(ref c) => c.chunk(),
            Self::None => &[],
        }
    }

    #[inline]
    fn advance(&mut self, cnt: usize) {
        match *self {
            Self::Buf(ref mut b) => b.advance(cnt),
            Self::Cursor(ref mut c) => c.advance(cnt),
            Self::None => {}
        }
    }

    fn chunks_vectored<'a>(&'a self, dst: &mut [IoSlice<'a>]) -> usize {
        match *self {
            Self::Buf(ref b) => b.chunks_vectored(dst),
            Self::Cursor(ref c) => c.chunks_vectored(dst),
            Self::None => 0,
        }
    }
}

struct H2Upgraded<B>
where
    B: Buf,
{
    ping: ping::Recorder,
    send_stream: SendStream<SendBuf<B>>,
    recv_stream: RecvStream,
    buf: Bytes,
}

impl<B> AsyncRead for H2Upgraded<B>
where
    B: Buf,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        read_buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.buf.is_empty() {
            self.buf = loop {
                match ready!(self.recv_stream.poll_data(cx)) {
                    None => return Poll::Ready(Ok(())),
                    Some(Ok(buf)) if buf.is_empty() && !self.recv_stream.is_end_stream() => {
                        continue;
                    }
                    Some(Ok(buf)) => {
                        self.ping.record_data(buf.len());
                        break buf;
                    }
                    Some(Err(e)) => {
                        return Poll::Ready(match e.reason() {
                            Some(Reason::NO_ERROR) | Some(Reason::CANCEL) => Ok(()),
                            Some(Reason::STREAM_CLOSED) => {
                                Err(io::Error::new(io::ErrorKind::BrokenPipe, e))
                            }
                            _ => Err(h2_to_io_error(e)),
                        });
                    }
                }
            };
        }
        let cnt = std::cmp::min(self.buf.len(), read_buf.remaining());
        read_buf.put_slice(&self.buf[..cnt]);
        self.buf.advance(cnt);
        let _ = self.recv_stream.flow_control().release_capacity(cnt);
        Poll::Ready(Ok(()))
    }
}

impl<B> AsyncWrite for H2Upgraded<B>
where
    B: Buf,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        self.send_stream.reserve_capacity(buf.len());

        // We ignore all errors returned by `poll_capacity` and `write`, as we
        // will get the correct from `poll_reset` anyway.
        let cnt = match ready!(self.send_stream.poll_capacity(cx)) {
            None => Some(0),
            Some(Ok(cnt)) => self
                .send_stream
                .send_data(SendBuf::Cursor(Cursor::new(buf[..cnt].into())), false)
                .ok()
                .map(|()| cnt),
            Some(Err(_)) => None,
        };

        if let Some(cnt) = cnt {
            return Poll::Ready(Ok(cnt));
        }

        Poll::Ready(Err(h2_to_io_error(
            match ready!(self.send_stream.poll_reset(cx)) {
                Ok(Reason::NO_ERROR) | Ok(Reason::CANCEL) | Ok(Reason::STREAM_CLOSED) => {
                    return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
                }
                Ok(reason) => reason.into(),
                Err(e) => e,
            },
        )))
    }

    #[inline]
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self
            .send_stream
            .send_data(SendBuf::Cursor(Cursor::new([].into())), true)
            .is_ok()
        {
            return Poll::Ready(Ok(()));
        }

        Poll::Ready(Err(h2_to_io_error(
            match ready!(self.send_stream.poll_reset(cx)) {
                Ok(Reason::NO_ERROR) => return Poll::Ready(Ok(())),
                Ok(Reason::CANCEL) | Ok(Reason::STREAM_CLOSED) => {
                    return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
                }
                Ok(reason) => reason.into(),
                Err(e) => e,
            },
        )))
    }
}

fn h2_to_io_error(e: http2::Error) -> std::io::Error {
    if e.is_io() {
        e.into_io()
            .expect("[BUG] http2::Error::is_io() is true, but into_io() failed")
    } else {
        std::io::Error::other(e)
    }
}

/// Builder for `Http2Options`.
#[must_use]
#[derive(Debug)]
pub struct Http2OptionsBuilder {
    opts: Http2Options,
}

/// Options for tuning HTTP/2 connections.
///
/// `Http2Options` lets you adjust how HTTP/2 works—stream limits, window sizes, frame and header
/// settings, and more. Most fields are optional and have sensible defaults. See each field for
/// details.
#[non_exhaustive]
#[derive(Debug, Clone)]
pub struct Http2Options {
    /// Whether to use adaptive flow control.
    pub adaptive_window: bool,

    /// The initial stream ID for the connection.
    pub initial_stream_id: Option<u32>,

    /// The initial window size for HTTP/2 connection-level flow control.
    pub initial_conn_window_size: u32,

    /// The initial window size for HTTP/2 streams.
    pub initial_window_size: u32,

    /// The initial maximum number of locally initiated (send) streams.
    pub initial_max_send_streams: usize,

    /// The maximum frame size to use for HTTP/2.
    pub max_frame_size: Option<u32>,

    /// The interval for HTTP/2 keep-alive ping frames.
    pub keep_alive_interval: Option<Duration>,

    /// The timeout for receiving an acknowledgement of the keep-alive ping.
    pub keep_alive_timeout: Duration,

    /// Whether HTTP/2 keep-alive should apply while the connection is idle.
    pub keep_alive_while_idle: bool,

    /// The maximum number of concurrent locally reset streams.
    pub max_concurrent_reset_streams: Option<usize>,

    /// The maximum size of the send buffer for HTTP/2 streams.
    pub max_send_buffer_size: usize,

    /// The maximum number of concurrent streams initiated by the remote peer.
    pub max_concurrent_streams: Option<u32>,

    /// The maximum size of the header list.
    pub max_header_list_size: Option<u32>,

    /// The maximum number of pending accept reset streams.
    pub max_pending_accept_reset_streams: Option<usize>,

    /// Whether to enable push promises.
    pub enable_push: Option<bool>,

    /// The header table size for HPACK compression.
    pub header_table_size: Option<u32>,

    /// Whether to enable the CONNECT protocol.
    pub enable_connect_protocol: Option<bool>,

    /// Whether to disable RFC 7540 Stream Priorities.
    pub no_rfc7540_priorities: Option<bool>,

    /// The HTTP/2 pseudo-header field order for outgoing HEADERS frames.
    pub headers_pseudo_order: Option<PseudoOrder>,

    /// The stream dependency for the outgoing HEADERS frame.
    pub headers_stream_dependency: Option<StreamDependency>,

    /// The order of settings parameters in the initial SETTINGS frame.
    pub settings_order: Option<SettingsOrder>,

    /// The list of PRIORITY frames to be sent after connection establishment.
    pub priorities: Option<Priorities>,
}

impl Http2OptionsBuilder {
    /// Sets the [`SETTINGS_INITIAL_WINDOW_SIZE`][spec] option for HTTP2
    /// stream-level flow control.
    ///
    /// Passing `None` will do nothing.
    ///
    /// If not set, crate::core: will use a default.
    ///
    /// [spec]: https://httpwg.org/specs/rfc9113.html#SETTINGS_INITIAL_WINDOW_SIZE
    #[inline]
    pub fn initial_window_size(mut self, sz: impl Into<Option<u32>>) -> Self {
        if let Some(sz) = sz.into() {
            self.opts.adaptive_window = false;
            self.opts.initial_window_size = sz;
        }
        self
    }

    /// Sets the max connection-level flow control for HTTP2
    ///
    /// Passing `None` will do nothing.
    ///
    /// If not set, crate::core: will use a default.
    #[inline]
    pub fn initial_connection_window_size(mut self, sz: impl Into<Option<u32>>) -> Self {
        if let Some(sz) = sz.into() {
            self.opts.adaptive_window = false;
            self.opts.initial_conn_window_size = sz;
        }
        self
    }

    /// Sets the initial maximum of locally initiated (send) streams.
    ///
    /// This value will be overwritten by the value included in the initial
    /// SETTINGS frame received from the peer as part of a [connection preface].
    ///
    /// Passing `None` will do nothing.
    ///
    /// If not set, crate::core: will use a default.
    ///
    /// [connection preface]: https://httpwg.org/specs/rfc9113.html#preface
    #[inline]
    pub fn initial_max_send_streams(mut self, initial: impl Into<Option<usize>>) -> Self {
        if let Some(initial) = initial.into() {
            self.opts.initial_max_send_streams = initial;
        }
        self
    }

    /// Sets the initial stream id for the connection.
    #[inline]
    pub fn initial_stream_id(mut self, id: impl Into<Option<u32>>) -> Self {
        if let Some(id) = id.into() {
            self.opts.initial_stream_id = Some(id);
        }
        self
    }

    /// Sets whether to use an adaptive flow control.
    ///
    /// Enabling this will override the limits set in
    /// `initial_stream_window_size` and
    /// `initial_connection_window_size`.
    #[inline]
    pub fn adaptive_window(mut self, enabled: bool) -> Self {
        self.opts.adaptive_window = enabled;
        if enabled {
            self.opts.initial_window_size = SPEC_WINDOW_SIZE;
            self.opts.initial_conn_window_size = SPEC_WINDOW_SIZE;
        }
        self
    }

    /// Sets the maximum frame size to use for HTTP2.
    ///
    /// Default is currently 16KB, but can change.
    #[inline]
    pub fn max_frame_size(mut self, sz: impl Into<Option<u32>>) -> Self {
        if let Some(sz) = sz.into() {
            self.opts.max_frame_size = Some(sz);
        }
        self
    }

    /// Sets the max size of received header frames.
    ///
    /// Default is currently 16KB, but can change.
    #[inline]
    pub fn max_header_list_size(mut self, max: u32) -> Self {
        self.opts.max_header_list_size = Some(max);
        self
    }

    /// Sets the header table size.
    ///
    /// This setting informs the peer of the maximum size of the header compression
    /// table used to encode header blocks, in octets. The encoder may select any value
    /// equal to or less than the header table size specified by the sender.
    ///
    /// The default value of crate `h2` is 4,096.
    #[inline]
    pub fn header_table_size(mut self, size: impl Into<Option<u32>>) -> Self {
        if let Some(size) = size.into() {
            self.opts.header_table_size = Some(size);
        }
        self
    }

    /// Sets the maximum number of concurrent streams.
    ///
    /// The maximum concurrent streams setting only controls the maximum number
    /// of streams that can be initiated by the remote peer. In other words,
    /// when this setting is set to 100, this does not limit the number of
    /// concurrent streams that can be created by the caller.
    ///
    /// It is recommended that this value be no smaller than 100, so as to not
    /// unnecessarily limit parallelism. However, any value is legal, including
    /// 0. If `max` is set to 0, then the remote will not be permitted to
    /// initiate streams.
    ///
    /// Note that streams in the reserved state, i.e., push promises that have
    /// been reserved but the stream has not started, do not count against this
    /// setting.
    ///
    /// Also note that if the remote *does* exceed the value set here, it is not
    /// a protocol level error. Instead, the `h2` library will immediately reset
    /// the stream.
    ///
    /// See [Section 5.1.2] in the HTTP/2 spec for more details.
    ///
    /// [Section 5.1.2]: https://http2.github.io/http2-spec/#rfc.section.5.1.2
    #[inline]
    pub fn max_concurrent_streams(mut self, max: impl Into<Option<u32>>) -> Self {
        if let Some(max) = max.into() {
            self.opts.max_concurrent_streams = Some(max);
        }
        self
    }

    /// Sets an interval for HTTP2 Ping frames should be sent to keep a
    /// connection alive.
    ///
    /// Pass `None` to disable HTTP2 keep-alive.
    ///
    /// Default is currently disabled.
    #[inline]
    pub fn keep_alive_interval(mut self, interval: impl Into<Option<Duration>>) -> Self {
        self.opts.keep_alive_interval = interval.into();
        self
    }

    /// Sets a timeout for receiving an acknowledgement of the keep-alive ping.
    ///
    /// If the ping is not acknowledged within the timeout, the connection will
    /// be closed. Does nothing if `keep_alive_interval` is disabled.
    ///
    /// Default is 20 seconds.
    #[inline]
    pub fn keep_alive_timeout(mut self, timeout: Duration) -> Self {
        self.opts.keep_alive_timeout = timeout;
        self
    }

    /// Sets whether HTTP2 keep-alive should apply while the connection is idle.
    ///
    /// If disabled, keep-alive pings are only sent while there are open
    /// request/responses streams. If enabled, pings are also sent when no
    /// streams are active. Does nothing if `keep_alive_interval` is
    /// disabled.
    ///
    /// Default is `false`.
    #[inline]
    pub fn keep_alive_while_idle(mut self, enabled: bool) -> Self {
        self.opts.keep_alive_while_idle = enabled;
        self
    }

    /// Enables and disables the push feature for HTTP2.
    ///
    /// Passing `None` will do nothing.
    #[inline]
    pub fn enable_push(mut self, opt: bool) -> Self {
        self.opts.enable_push = Some(opt);
        self
    }

    /// Sets the enable connect protocol.
    #[inline]
    pub fn enable_connect_protocol(mut self, opt: bool) -> Self {
        self.opts.enable_connect_protocol = Some(opt);
        self
    }

    /// Disable RFC 7540 Stream Priorities (set to `true` to disable).
    /// [RFC 9218]: <https://www.rfc-editor.org/rfc/rfc9218.html#section-2.1>
    #[inline]
    pub fn no_rfc7540_priorities(mut self, opt: bool) -> Self {
        self.opts.no_rfc7540_priorities = Some(opt);
        self
    }

    /// Sets the maximum number of HTTP2 concurrent locally reset streams.
    ///
    /// See the documentation of [`http2::client::Builder::max_concurrent_reset_streams`] for more
    /// details.
    ///
    /// The default value is determined by the `h2` crate.
    ///
    /// [`http2::client::Builder::max_concurrent_reset_streams`]: https://docs.rs/h2/client/struct.Builder.html#method.max_concurrent_reset_streams
    #[inline]
    pub fn max_concurrent_reset_streams(mut self, max: usize) -> Self {
        self.opts.max_concurrent_reset_streams = Some(max);
        self
    }

    /// Set the maximum write buffer size for each HTTP/2 stream.
    ///
    /// Default is currently 1MB, but may change.
    ///
    /// # Panics
    ///
    /// The value must be no larger than `u32::MAX`.
    #[inline]
    pub fn max_send_buf_size(mut self, max: usize) -> Self {
        assert!(max <= u32::MAX as usize);
        self.opts.max_send_buffer_size = max;
        self
    }

    /// Configures the maximum number of pending reset streams allowed before a GOAWAY will be sent.
    ///
    /// See <https://github.com/hyperium/hyper/issues/2877> for more information.
    #[inline]
    pub fn max_pending_accept_reset_streams(mut self, max: impl Into<Option<usize>>) -> Self {
        if let Some(max) = max.into() {
            self.opts.max_pending_accept_reset_streams = Some(max);
        }
        self
    }

    /// Sets the stream dependency and weight for the outgoing HEADERS frame.
    ///
    /// This configures the priority of the stream by specifying its dependency and weight,
    /// as defined by the HTTP/2 priority mechanism. This can be used to influence how the
    /// server allocates resources to this stream relative to others.
    #[inline]
    pub fn headers_stream_dependency<T>(mut self, stream_dependency: T) -> Self
    where
        T: Into<Option<StreamDependency>>,
    {
        if let Some(stream_dependency) = stream_dependency.into() {
            self.opts.headers_stream_dependency = Some(stream_dependency);
        }
        self
    }

    /// Sets the HTTP/2 pseudo-header field order for outgoing HEADERS frames.
    ///
    /// This determines the order in which pseudo-header fields (such as `:method`, `:scheme`, etc.)
    /// are encoded in the HEADERS frame. Customizing the order may be useful for interoperability
    /// or testing purposes.
    #[inline]
    pub fn headers_pseudo_order<T>(mut self, headers_pseudo_order: T) -> Self
    where
        T: Into<Option<PseudoOrder>>,
    {
        if let Some(headers_pseudo_order) = headers_pseudo_order.into() {
            self.opts.headers_pseudo_order = Some(headers_pseudo_order);
        }
        self
    }

    /// Sets the order of settings parameters in the initial SETTINGS frame.
    ///
    /// This determines the order in which settings are sent during the HTTP/2 handshake.
    /// Customizing the order may be useful for testing or protocol compliance.
    #[inline]
    pub fn settings_order<T>(mut self, settings_order: T) -> Self
    where
        T: Into<Option<SettingsOrder>>,
    {
        if let Some(settings_order) = settings_order.into() {
            self.opts.settings_order = Some(settings_order);
        }
        self
    }

    /// Sets the list of PRIORITY frames to be sent immediately after the connection is established,
    /// but before the first request is sent.
    ///
    /// This allows you to pre-configure the HTTP/2 stream dependency tree by specifying a set of
    /// PRIORITY frames that will be sent as part of the connection preface. This can be useful for
    /// optimizing resource allocation or testing custom stream prioritization strategies.
    ///
    /// Each `Priority` in the list must have a valid (non-zero) stream ID. Any priority with a
    /// stream ID of zero will be ignored.
    #[inline]
    pub fn priorities<T>(mut self, priorities: T) -> Self
    where
        T: Into<Option<Priorities>>,
    {
        if let Some(priorities) = priorities.into() {
            self.opts.priorities = Some(priorities);
        }
        self
    }

    /// Builds the `Http2Options` instance.
    #[inline]
    pub fn build(self) -> Http2Options {
        self.opts
    }
}

impl Http2Options {
    /// Creates a new `Http2OptionsBuilder` instance.
    pub fn builder() -> Http2OptionsBuilder {
        // Reset optional frame size and header size settings to None to allow explicit
        // customization This ensures users can configure these via builder methods without
        // being constrained by defaults
        Http2OptionsBuilder {
            opts: Http2Options {
                max_frame_size: None,
                max_header_list_size: None,
                ..Default::default()
            },
        }
    }
}

impl Default for Http2Options {
    #[inline]
    fn default() -> Self {
        Http2Options {
            adaptive_window: false,
            initial_stream_id: None,
            initial_conn_window_size: DEFAULT_CONN_WINDOW,
            initial_window_size: DEFAULT_STREAM_WINDOW,
            initial_max_send_streams: DEFAULT_INITIAL_MAX_SEND_STREAMS,
            max_frame_size: Some(DEFAULT_MAX_FRAME_SIZE),
            max_header_list_size: Some(DEFAULT_MAX_HEADER_LIST_SIZE),
            keep_alive_interval: None,
            keep_alive_timeout: Duration::from_secs(20),
            keep_alive_while_idle: false,
            max_concurrent_reset_streams: None,
            max_send_buffer_size: DEFAULT_MAX_SEND_BUF_SIZE,
            max_pending_accept_reset_streams: None,
            header_table_size: None,
            max_concurrent_streams: None,
            enable_push: None,
            enable_connect_protocol: None,
            no_rfc7540_priorities: None,
            settings_order: None,
            headers_pseudo_order: None,
            headers_stream_dependency: None,
            priorities: None,
        }
    }
}
