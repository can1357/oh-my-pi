use std::{
    fmt,
    future::Future,
    pin::Pin,
    task::{ready, Context, Poll},
};

use bytes::Bytes;
use futures_channel::{mpsc, oneshot};
use futures_util::{stream::FusedStream, Stream};
use http::HeaderMap;
use http_body::{Body, Frame, SizeHint};

use super::{watch, DecodedLength};
use crate::{proto::http2::ping, Error, Result};

/// A stream of [`Bytes`], used when receiving bodies from the network.
///
/// Note that Users should not instantiate this struct directly. When working with the client,
/// [`Incoming`] is returned to you in responses.
#[must_use = "streams do nothing unless polled"]
pub struct Incoming {
    kind: Kind,
}

enum Kind {
    H1 {
        want_tx: watch::Sender,
        data_rx: mpsc::Receiver<Result<Bytes, Error>>,
        trailers_rx: oneshot::Receiver<HeaderMap>,
        content_length: DecodedLength,
    },
    H2 {
        ping: ping::Recorder,
        recv: http2::RecvStream,
        content_length: DecodedLength,
        data_done: bool,
    },
    Empty,
}

/// A sender half created through [`Body::channel()`].
///
/// Useful when wanting to stream chunks from another thread.
///
/// ## Body Closing
///
/// Note that the request body will always be closed normally when the sender is dropped (meaning
/// that the empty terminating chunk will be sent to the remote). If you desire to close the
/// connection with an incomplete response (e.g. in the case of an error during asynchronous
/// processing), call the [`Sender::abort()`] method to abort the body in an abnormal fashion.
///
/// [`Body::channel()`]: struct.Body.html#method.channel
/// [`Sender::abort()`]: struct.Sender.html#method.abort
#[must_use = "Sender does nothing unless sent on"]
pub(crate) struct Sender {
    want_rx: watch::Receiver,
    data_tx: mpsc::Sender<Result<Bytes, Error>>,
    trailers_tx: Option<oneshot::Sender<HeaderMap>>,
}

// ===== impl Incoming =====

impl Incoming {
    #[inline]
    pub(crate) fn empty() -> Incoming {
        Incoming { kind: Kind::Empty }
    }

    pub(crate) fn h1(content_length: DecodedLength, wanter: bool) -> (Sender, Incoming) {
        let (data_tx, data_rx) = mpsc::channel(0);
        let (trailers_tx, trailers_rx) = oneshot::channel();
        // If wanter is true, `Sender::poll_ready()` won't becoming ready
        // until the `Body` has been polled for data once.
        let (want_tx, want_rx) = watch::channel(wanter);

        (
            Sender {
                want_rx,
                data_tx,
                trailers_tx: Some(trailers_tx),
            },
            Incoming {
                kind: Kind::H1 {
                    want_tx,
                    data_rx,
                    trailers_rx,
                    content_length,
                },
            },
        )
    }

    pub(crate) fn h2(
        recv: http2::RecvStream,
        mut content_length: DecodedLength,
        ping: ping::Recorder,
    ) -> Self {
        // If the stream is already EOS, then the "unknown length" is clearly
        // actually ZERO.
        if !content_length.is_exact() && recv.is_end_stream() {
            content_length = DecodedLength::ZERO;
        }

        Incoming {
            kind: Kind::H2 {
                ping,
                recv,
                content_length,
                data_done: false,
            },
        }
    }
}

impl Body for Incoming {
    type Data = Bytes;
    type Error = Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        match self.kind {
            Kind::H1 {
                ref want_tx,
                ref mut data_rx,
                ref mut trailers_rx,
                ref mut content_length,
            } => {
                want_tx.ready();

                if !data_rx.is_terminated() {
                    if let Some(chunk) = ready!(Pin::new(data_rx).poll_next(cx)?) {
                        content_length.sub_if(chunk.len() as u64);
                        return Poll::Ready(Some(Ok(Frame::data(chunk))));
                    }
                }

                // check trailers after data is terminated
                match ready!(Pin::new(trailers_rx).poll(cx)) {
                    Ok(t) => Poll::Ready(Some(Ok(Frame::trailers(t)))),
                    Err(_) => Poll::Ready(None),
                }
            }
            Kind::H2 {
                ref ping,
                ref mut recv,
                ref mut content_length,
                ref mut data_done,
            } => {
                if !*data_done {
                    match ready!(recv.poll_data(cx)) {
                        Some(Ok(bytes)) => {
                            let _ = recv.flow_control().release_capacity(bytes.len());
                            content_length.sub_if(bytes.len() as u64);
                            ping.record_data(bytes.len());
                            return Poll::Ready(Some(Ok(Frame::data(bytes))));
                        }
                        Some(Err(e)) => {
                            if let Some(http2::Reason::NO_ERROR) = e.reason() {
                                // As mentioned in RFC 7540 Section 8.1, a RST_STREAM with NO_ERROR
                                // indicates an early response, and should cause the body reading
                                // to stop, but not fail it:
                                return Poll::Ready(None);
                            } else {
                                return Poll::Ready(Some(Err(Error::new_body(e))));
                            }
                        }
                        None => {
                            // fall through to trailers
                            *data_done = true;
                        }
                    }
                }

                // after data, check trailers
                match ready!(recv.poll_trailers(cx)) {
                    Ok(t) => {
                        ping.record_non_data();
                        Poll::Ready(Ok(t.map(Frame::trailers)).transpose())
                    }
                    Err(e) => {
                        if let Some(http2::Reason::NO_ERROR) = e.reason() {
                            // Same as above, a RST_STREAM with NO_ERROR indicates an early
                            // response, and should cause reading the trailers to stop, but
                            // not fail it:
                            Poll::Ready(None)
                        } else {
                            Poll::Ready(Some(Err(Error::new_h2(e))))
                        }
                    }
                }
            }
            Kind::Empty => Poll::Ready(None),
        }
    }

    #[inline]
    fn is_end_stream(&self) -> bool {
        match self.kind {
            Kind::H1 { content_length, .. } => content_length == DecodedLength::ZERO,
            Kind::H2 { recv: ref h2, .. } => h2.is_end_stream(),
            Kind::Empty => true,
        }
    }

    #[inline]
    fn size_hint(&self) -> SizeHint {
        match self.kind {
            Kind::H1 { content_length, .. } | Kind::H2 { content_length, .. } => content_length
                .into_opt()
                .map_or_else(SizeHint::default, SizeHint::with_exact),
            Kind::Empty => SizeHint::with_exact(0),
        }
    }
}

impl fmt::Debug for Incoming {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut builder = f.debug_tuple(stringify!(Incoming));
        match self.kind {
            Kind::Empty => builder.field(&stringify!(Empty)),
            _ => builder.field(&stringify!(Streaming)),
        };
        builder.finish()
    }
}

// ===== impl Sender =====

impl Sender {
    /// Check to see if this `Sender` can send more data.
    #[inline]
    pub(crate) fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        // Check if the receiver end has tried polling for the body yet
        ready!(self.want_rx.poll_ready(cx)?);
        self.data_tx.poll_ready(cx).map_err(|_| Error::new_closed())
    }

    /// Send data on this channel.
    ///
    /// # Errors
    ///
    /// Returns `Err(Bytes)` if the channel could not (currently) accept
    /// another `Bytes`.
    #[inline]
    pub(crate) fn send_data(&mut self, chunk: Bytes) -> Result<(), Bytes> {
        self.data_tx
            .try_send(Ok(chunk))
            .map_err(|err| err.into_inner().expect("just sent Ok"))
    }

    /// Send trailers on this channel.
    ///
    /// # Errors
    ///
    /// Returns `Err(HeaderMap)` if the channel could not (currently) accept
    /// another `HeaderMap`.
    #[inline]
    pub(crate) fn send_trailers(&mut self, trailers: HeaderMap) -> Result<(), Option<HeaderMap>> {
        self.trailers_tx
            .take()
            .ok_or(None)?
            .send(trailers)
            .map_err(Some)
    }

    /// Send an error on this channel, which will cause the body stream to end with an error.
    #[inline]
    pub(crate) fn send_error(&mut self, err: Error) {
        // clone so the send works even if buffer is full
        let _ = self.data_tx.clone().try_send(Err(err));
    }
}

#[cfg(test)]
mod tests {
    use std::{mem, task::Poll};

    use http_body_util::BodyExt;

    use super::{Body, DecodedLength, Error, Incoming, Result, Sender, SizeHint};

    impl Incoming {
        /// Create a `Body` stream with an associated sender half.
        ///
        /// Useful when wanting to stream chunks from another thread.
        pub(crate) fn channel() -> (Sender, Incoming) {
            Self::h1(DecodedLength::CHUNKED, /* wanter = */ false)
        }
    }

    impl Sender {
        async fn ready(&mut self) -> Result<()> {
            std::future::poll_fn(|cx| self.poll_ready(cx)).await
        }

        pub(crate) fn abort(mut self) {
            self.send_error(Error::new_body_write_aborted());
        }
    }

    #[test]
    fn test_size_of() {
        // These are mostly to help catch *accidentally* increasing
        // the size by too much.

        let body_size = mem::size_of::<Incoming>();
        let body_expected_size = mem::size_of::<u64>() * 5;
        assert!(
            body_size <= body_expected_size,
            "Body size = {body_size} <= {body_expected_size}",
        );

        //assert_eq!(body_size, mem::size_of::<Option<Incoming>>(), "Option<Incoming>");

        assert_eq!(
            mem::size_of::<Sender>(),
            mem::size_of::<usize>() * 5,
            "Sender"
        );

        assert_eq!(
            mem::size_of::<Sender>(),
            mem::size_of::<Option<Sender>>(),
            "Option<Sender>"
        );
    }

    #[test]
    fn size_hint() {
        fn eq(body: Incoming, b: SizeHint, note: &str) {
            let a = body.size_hint();
            assert_eq!(a.lower(), b.lower(), "lower for {note:?}");
            assert_eq!(a.upper(), b.upper(), "upper for {note:?}");
        }

        eq(Incoming::empty(), SizeHint::with_exact(0), "empty");

        eq(Incoming::channel().1, SizeHint::new(), "channel");

        eq(
            Incoming::h1(DecodedLength::new(4), /* wanter = */ false).1,
            SizeHint::with_exact(4),
            "channel with length",
        );
    }

    #[tokio::test]
    async fn channel_abort() {
        let (tx, mut rx) = Incoming::channel();

        tx.abort();

        let err = rx.frame().await.unwrap().unwrap_err();
        assert!(err.is_body_write_aborted(), "{err:?}");
    }

    #[tokio::test]
    async fn channel_abort_when_buffer_is_full() {
        let (mut tx, mut rx) = Incoming::channel();

        tx.send_data("chunk 1".into()).expect("send 1");
        // buffer is full, but can still send abort
        tx.abort();

        let chunk1 = rx
            .frame()
            .await
            .expect("item 1")
            .expect("chunk 1")
            .into_data()
            .unwrap();
        assert_eq!(chunk1, "chunk 1");

        let err = rx.frame().await.unwrap().unwrap_err();
        assert!(err.is_body_write_aborted(), "{err:?}");
    }

    #[test]
    fn channel_buffers_one() {
        let (mut tx, _rx) = Incoming::channel();

        tx.send_data("chunk 1".into()).expect("send 1");

        // buffer is now full
        let chunk2 = tx.send_data("chunk 2".into()).expect_err("send 2");
        assert_eq!(chunk2, "chunk 2");
    }

    #[tokio::test]
    async fn channel_empty() {
        let (_, mut rx) = Incoming::channel();
        assert!(rx.frame().await.is_none());
    }

    #[test]
    fn channel_ready() {
        let (mut tx, _rx) = Incoming::h1(DecodedLength::CHUNKED, /* wanter = */ false);

        let mut tx_ready = tokio_test::task::spawn(tx.ready());

        assert!(tx_ready.poll().is_ready(), "tx is ready immediately");
    }

    #[test]
    fn channel_wanter() {
        let (mut tx, mut rx) = Incoming::h1(DecodedLength::CHUNKED, /* wanter = */ true);

        let mut tx_ready = tokio_test::task::spawn(tx.ready());
        let mut rx_data = tokio_test::task::spawn(rx.frame());

        assert!(
            tx_ready.poll().is_pending(),
            "tx isn't ready before rx has been polled"
        );

        assert!(rx_data.poll().is_pending(), "poll rx.data");
        assert!(tx_ready.is_woken(), "rx poll wakes tx");

        assert!(
            tx_ready.poll().is_ready(),
            "tx is ready after rx has been polled"
        );
    }

    #[test]
    fn channel_notices_closure() {
        let (mut tx, rx) = Incoming::h1(DecodedLength::CHUNKED, /* wanter = */ true);

        let mut tx_ready = tokio_test::task::spawn(tx.ready());

        assert!(
            tx_ready.poll().is_pending(),
            "tx isn't ready before rx has been polled"
        );

        drop(rx);
        assert!(tx_ready.is_woken(), "dropping rx wakes tx");

        match tx_ready.poll() {
            Poll::Ready(Err(ref e)) if e.is_closed() => (),
            unexpected => panic!("tx poll ready unexpected: {unexpected:?}"),
        }
    }
}
