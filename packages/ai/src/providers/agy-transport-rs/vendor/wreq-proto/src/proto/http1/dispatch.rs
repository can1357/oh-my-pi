use std::{
    convert::Infallible,
    future::Future,
    marker::Unpin,
    pin::Pin,
    task::{ready, Context, Poll},
};

use bytes::{Buf, Bytes};
use http::Request;
use http_body::Body;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{BodyLength, Conn, Http1Transaction, MessageHead, Wants};
use crate::{
    body::{self, DecodedLength, Incoming},
    dispatch::{self, TrySendError},
    error::BoxError,
    proto::{self, Dispatched, RequestHead},
    upgrade::OnUpgrade,
    Error, Result,
};

pub(crate) struct Dispatcher<D, Bs: Body, I, T> {
    conn: Conn<I, Bs::Data, T>,
    dispatch: D,
    body_tx: SenderGuard,
    body_rx: Pin<Box<Option<Bs>>>,
    is_closing: bool,
}

pub(crate) trait Dispatch {
    type PollItem;
    type PollBody;
    type PollError;
    type RecvItem;

    #[allow(clippy::type_complexity)]
    fn poll_msg(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<(Self::PollItem, Self::PollBody), Self::PollError>>>;

    fn recv_msg(&mut self, msg: Result<(Self::RecvItem, Incoming)>) -> Result<()>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), ()>>;

    fn should_poll(&self) -> bool;
}

pin_project_lite::pin_project! {
    pub(crate) struct Client<B> {
        callback: Option<dispatch::Callback<Request<B>, http::Response<Incoming>>>,
        #[pin]
        rx: ClientRx<B>,
        rx_closed: bool,
    }
}

type ClientRx<B> = dispatch::Receiver<Request<B>, http::Response<Incoming>>;

impl<D, Bs, I, T> Dispatcher<D, Bs, I, T>
where
    D: Dispatch<
            PollItem = MessageHead<T::Outgoing>,
            PollBody = Bs,
            RecvItem = MessageHead<T::Incoming>,
        > + Unpin,
    D::PollError: Into<BoxError>,
    I: AsyncRead + AsyncWrite + Unpin,
    T: Http1Transaction + Unpin,
    Bs: Body + 'static,
    Bs::Error: Into<BoxError>,
{
    #[inline]
    pub(crate) fn new(dispatch: D, conn: Conn<I, Bs::Data, T>) -> Self {
        Dispatcher {
            conn,
            dispatch,
            body_tx: SenderGuard(None),
            body_rx: Box::pin(None),
            is_closing: false,
        }
    }

    #[inline]
    pub(crate) fn into_inner(self) -> (I, Bytes, D) {
        let (io, buf) = self.conn.into_inner();
        (io, buf, self.dispatch)
    }

    /// Run this dispatcher until HTTP says this connection is done,
    /// but don't call `Write::shutdown` on the underlying IO.
    ///
    /// This is useful for old-style HTTP upgrades, but ignores
    /// newer-style upgrade API.
    pub(crate) fn poll_without_shutdown(
        &mut self,
        cx: &mut Context<'_>,
    ) -> Poll<crate::Result<()>> {
        Pin::new(self).poll_catch(cx, false).map_ok(|ds| {
            if let Dispatched::Upgrade(pending) = ds {
                pending.manual();
            }
        })
    }

    fn poll_catch(
        &mut self,
        cx: &mut Context<'_>,
        should_shutdown: bool,
    ) -> Poll<Result<Dispatched>> {
        Poll::Ready(ready!(self.poll_inner(cx, should_shutdown)).or_else(|e| {
            // Be sure to alert a streaming body of the failure.
            if let Some(mut body) = self.body_tx.take() {
                body.send_error(Error::new_body("connection error"))
            }
            // An error means we're shutting down either way.
            // We just try to give the error to the user,
            // and close the connection with an Ok. If we
            // cannot give it to the user, then return the Err.
            self.dispatch.recv_msg(Err(e))?;
            Ok(Dispatched::Shutdown)
        }))
    }

    fn poll_inner(
        &mut self,
        cx: &mut Context<'_>,
        should_shutdown: bool,
    ) -> Poll<Result<Dispatched>> {
        T::update_date();

        ready!(self.poll_loop(cx))?;

        if self.is_done() {
            if let Some(pending) = self.conn.pending_upgrade() {
                self.conn.take_error()?;
                return Poll::Ready(Ok(Dispatched::Upgrade(pending)));
            } else if should_shutdown {
                ready!(self.conn.poll_shutdown(cx)).map_err(Error::new_shutdown)?;
            }
            self.conn.take_error()?;
            Poll::Ready(Ok(Dispatched::Shutdown))
        } else {
            Poll::Pending
        }
    }

    fn poll_loop(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        // Limit the looping on this connection, in case it is ready far too
        // often, so that other futures don't starve.
        //
        // 16 was chosen arbitrarily, as that is number of pipelined requests
        // benchmarks often use. Perhaps it should be a config option instead.
        for _ in 0..16 {
            let _ = self.poll_read(cx)?;
            let write_ready = self.poll_write(cx)?.is_ready();
            let flush_ready = self.poll_flush(cx)?.is_ready();

            // If we can write more body and the connection is ready, we should
            // write again. If we return `Ready(Ok(())` here, we will yield
            // without a guaranteed wake-up from the write side of the connection.
            // This would lead to a deadlock if we also don't expect reads.
            let wants_write_again = self.can_write_again() && (write_ready || flush_ready);

            // This could happen if reading paused before blocking on IO,
            // such as getting to the end of a framed message, but then
            // writing/flushing set the state back to Init. In that case,
            // if the read buffer still had bytes, we'd want to try poll_read
            // again, or else we wouldn't ever be woken up again.
            //
            // Using this instead of task::current() and notify() inside
            // the Conn is noticeably faster in pipelined benchmarks.
            let wants_read_again = self.conn.wants_read_again();

            // If we cannot write or read again, we yield and rely on the
            // wake-up from the connection futures.
            if !(wants_write_again || wants_read_again) {
                return Poll::Ready(Ok(()));
            }

            // If we are continuing only because "wants_write_again", re-check whether a second
            // write poll can make progress. `poll_flush` can be ready even when there is no
            // buffered data and the request body is still pending, so relying on the previous
            // readiness can hot-loop.
            if !wants_read_again && wants_write_again {
                // Write was previously pending, but may have become ready since polling flush, so
                // we need to check it again. If it is still pending, it is safe to yield and rely
                // on wake-up from the connection futures.
                if self.poll_write(cx)?.is_pending() {
                    return Poll::Ready(Ok(()));
                }
            }
        }

        trace!("poll_loop yielding (self = {:p})", self);

        // Now we yield to allow other tasks to run.
        cx.waker().wake_by_ref();
        Poll::Pending
    }

    fn poll_read(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        loop {
            if self.is_closing {
                return Poll::Ready(Ok(()));
            } else if self.conn.can_read_head() {
                ready!(self.poll_read_head(cx))?;
            } else if let Some(mut body) = self.body_tx.take() {
                if self.conn.can_read_body() {
                    match body.poll_ready(cx) {
                        Poll::Ready(Ok(())) => (),
                        Poll::Pending => {
                            self.body_tx.set(body);
                            return Poll::Pending;
                        }
                        Poll::Ready(Err(_canceled)) => {
                            // user doesn't care about the body
                            // so we should stop reading
                            trace!("body receiver dropped before eof, draining or closing");
                            self.conn.poll_drain_or_close_read(cx);
                            continue;
                        }
                    }
                    match self.conn.poll_read_body(cx) {
                        Poll::Ready(Some(Ok(frame))) => {
                            if frame.is_data() {
                                let chunk = frame.into_data().unwrap_or_else(|_| unreachable!());
                                match body.send_data(chunk) {
                                    Ok(()) => {
                                        self.body_tx.set(body);
                                    }
                                    Err(_canceled) => {
                                        if self.conn.can_read_body() {
                                            trace!("body receiver dropped before eof, closing");
                                            self.conn.close_read();
                                        }
                                    }
                                }
                            } else if frame.is_trailers() {
                                let trailers =
                                    frame.into_trailers().unwrap_or_else(|_| unreachable!());
                                match body.send_trailers(trailers) {
                                    Ok(()) => {
                                        self.body_tx.set(body);
                                    }
                                    Err(_canceled) => {
                                        if self.conn.can_read_body() {
                                            trace!("body receiver dropped before eof, closing");
                                            self.conn.close_read();
                                        }
                                    }
                                }
                            } else {
                                // we should have dropped all unknown frames in poll_read_body
                                error!("unexpected frame");
                            }
                        }
                        Poll::Ready(None) => {
                            // just drop, the body will close automatically
                        }
                        Poll::Pending => {
                            self.body_tx.set(body);
                            return Poll::Pending;
                        }
                        Poll::Ready(Some(Err(e))) => {
                            body.send_error(Error::new_body(e));
                        }
                    }
                } else {
                    // just drop, the body will close automatically
                }
            } else {
                return self.conn.poll_read_keep_alive(cx);
            }
        }
    }

    fn poll_read_head(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        // can dispatch receive, or does it still care about other incoming message?
        match ready!(self.dispatch.poll_ready(cx)) {
            Ok(()) => (),
            Err(()) => {
                trace!("dispatch no longer receiving messages");
                self.close();
                return Poll::Ready(Ok(()));
            }
        }

        // dispatch is ready for a message, try to read one
        match ready!(self.conn.poll_read_head(cx)) {
            Some(Ok((mut head, body_len, wants))) => {
                let body = match body_len {
                    DecodedLength::ZERO => Incoming::empty(),
                    other => {
                        let (tx, rx) = Incoming::h1(other, wants.contains(Wants::EXPECT));
                        self.body_tx.set(tx);
                        rx
                    }
                };
                if wants.contains(Wants::UPGRADE) {
                    let upgrade = self.conn.on_upgrade();
                    debug_assert!(!upgrade.is_none(), "empty upgrade");
                    debug_assert!(
                        head.extensions.get::<OnUpgrade>().is_none(),
                        "OnUpgrade already set"
                    );
                    head.extensions.insert(upgrade);
                }
                self.dispatch.recv_msg(Ok((head, body)))?;
                Poll::Ready(Ok(()))
            }
            Some(Err(err)) => {
                debug!("read_head error: {}", err);
                self.dispatch.recv_msg(Err(err))?;
                // if here, the dispatcher gave the user the error
                // somewhere else. we still need to shutdown, but
                // not as a second error.
                self.close();
                Poll::Ready(Ok(()))
            }
            None => {
                // read eof, the write side will have been closed too unless
                // allow_read_close was set to true, in which case just do
                // nothing...
                debug_assert!(self.conn.is_read_closed());
                if self.conn.is_write_closed() {
                    self.close();
                }
                Poll::Ready(Ok(()))
            }
        }
    }

    fn poll_write(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        loop {
            if self.is_closing {
                return Poll::Ready(Ok(()));
            } else if self.body_rx.is_none()
                && self.conn.can_write_head()
                && self.dispatch.should_poll()
            {
                if let Some(msg) = ready!(Pin::new(&mut self.dispatch).poll_msg(cx)) {
                    let (head, body) = msg.map_err(Error::new_user_service)?;

                    let body_type = if body.is_end_stream() {
                        self.body_rx.set(None);
                        None
                    } else {
                        let btype = body
                            .size_hint()
                            .exact()
                            .map(BodyLength::Known)
                            .or(Some(BodyLength::Unknown));
                        self.body_rx.set(Some(body));
                        btype
                    };
                    self.conn.write_head(head, body_type);
                } else {
                    self.close();
                    return Poll::Ready(Ok(()));
                }
            } else if !self.conn.can_buffer_body() {
                ready!(self.poll_flush(cx))?;
            } else {
                // A new scope is needed :(
                if let (Some(mut body), clear_body) =
                    OptGuard::new(self.body_rx.as_mut()).guard_mut()
                {
                    debug_assert!(!*clear_body, "opt guard defaults to keeping body");
                    if !self.conn.can_write_body() {
                        trace!(
                            "no more write body allowed, user body is_end_stream = {}",
                            body.is_end_stream(),
                        );
                        *clear_body = true;
                        continue;
                    }

                    let item = ready!(body.as_mut().poll_frame(cx));
                    if let Some(item) = item {
                        let frame = item.map_err(|e| {
                            *clear_body = true;
                            Error::new_user_body(e)
                        })?;

                        if frame.is_data() {
                            let chunk = frame.into_data().unwrap_or_else(|_| unreachable!());
                            let eos = body.is_end_stream();
                            if eos {
                                *clear_body = true;
                                if chunk.remaining() == 0 {
                                    trace!("discarding empty chunk");
                                    self.conn.end_body()?;
                                } else {
                                    self.conn.write_body_and_end(chunk);
                                }
                            } else {
                                if chunk.remaining() == 0 {
                                    trace!("discarding empty chunk");
                                    continue;
                                }
                                self.conn.write_body(chunk);
                            }
                        } else if frame.is_trailers() {
                            *clear_body = true;
                            self.conn.write_trailers(
                                frame.into_trailers().unwrap_or_else(|_| unreachable!()),
                            );
                        } else {
                            trace!("discarding unknown frame");
                            continue;
                        }
                    } else {
                        *clear_body = true;
                        self.conn.end_body()?;
                    }
                } else {
                    // If there's no body_rx, end the body
                    if self.conn.can_write_body() {
                        self.conn.end_body()?;
                    } else {
                        return Poll::Pending;
                    }
                }
            }
        }
    }

    #[inline]
    fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<Result<()>> {
        self.conn.poll_flush(cx).map_err(|err| {
            debug!("error writing: {}", err);
            Error::new_body_write(err)
        })
    }

    #[inline]
    fn close(&mut self) {
        self.is_closing = true;
        self.conn.close_read();
        self.conn.close_write();
    }

    /// If there is pending data in `body_rx`, and the connection is still in a body-writing state,
    /// we can make progress writing if the connection is ready.
    fn can_write_again(&mut self) -> bool {
        !self.is_closing && self.body_rx.is_some() && self.conn.can_write_body()
    }

    fn is_done(&self) -> bool {
        if self.is_closing {
            return true;
        }

        let read_done = self.conn.is_read_closed();

        if read_done {
            // a client that cannot read may was well be done.
            true
        } else {
            let write_done = self.conn.is_write_closed()
                || (!self.dispatch.should_poll() && self.body_rx.is_none());
            read_done && write_done
        }
    }
}

impl<D, Bs, I, T> Future for Dispatcher<D, Bs, I, T>
where
    D: Dispatch<
            PollItem = MessageHead<T::Outgoing>,
            PollBody = Bs,
            RecvItem = MessageHead<T::Incoming>,
        > + Unpin,
    D::PollError: Into<BoxError>,
    I: AsyncRead + AsyncWrite + Unpin,
    T: Http1Transaction + Unpin,
    Bs: Body + 'static,
    Bs::Error: Into<BoxError>,
{
    type Output = Result<Dispatched>;

    #[inline]
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.poll_catch(cx, true)
    }
}

// ===== impl OptGuard =====

/// A drop guard to allow a mutable borrow of an Option while being able to
/// set whether the `Option` should be cleared on drop.
struct OptGuard<'a, T>(Pin<&'a mut Option<T>>, bool);

impl<'a, T> OptGuard<'a, T> {
    #[inline]
    fn new(pin: Pin<&'a mut Option<T>>) -> Self {
        OptGuard(pin, false)
    }

    #[inline]
    fn guard_mut(&mut self) -> (Option<Pin<&mut T>>, &mut bool) {
        (self.0.as_mut().as_pin_mut(), &mut self.1)
    }
}

impl<T> Drop for OptGuard<'_, T> {
    #[inline]
    fn drop(&mut self) {
        if self.1 {
            self.0.set(None);
        }
    }
}

// ===== impl SenderGuard =====

/// A guard for the body `Sender`.
///
/// If the `Dispatcher` future is dropped (e.g. the runtime driving the
/// connection is shut down) while it still owns a body `Sender`, the guard
/// sends an incomplete-message error so the receiver sees an error instead
/// of a silent, clean end-of-stream.
struct SenderGuard(Option<body::Sender>);

impl SenderGuard {
    #[inline]
    fn set(&mut self, sender: body::Sender) {
        self.0 = Some(sender);
    }

    #[inline]
    fn take(&mut self) -> Option<body::Sender> {
        self.0.take()
    }
}

impl Drop for SenderGuard {
    #[inline]
    fn drop(&mut self) {
        if let Some(mut sender) = self.0.take() {
            sender.send_error(Error::new_incomplete());
        }
    }
}

// ===== impl Client =====

impl<B> Client<B> {
    #[inline]
    pub(crate) fn new(rx: ClientRx<B>) -> Client<B> {
        Client {
            callback: None,
            rx,
            rx_closed: false,
        }
    }
}

impl<B> Dispatch for Client<B>
where
    B: Body,
{
    type PollItem = RequestHead;
    type PollBody = B;
    type PollError = Infallible;
    type RecvItem = proto::ResponseHead;

    fn poll_msg(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<(Self::PollItem, Self::PollBody), Infallible>>> {
        let mut this = self.as_mut();
        debug_assert!(!this.rx_closed);
        match this.rx.poll_recv(cx) {
            Poll::Ready(Some((req, mut cb))) => {
                // check that future hasn't been canceled already
                match cb.poll_canceled(cx) {
                    Poll::Ready(()) => {
                        trace!("request canceled");
                        Poll::Ready(None)
                    }
                    Poll::Pending => {
                        let (parts, body) = req.into_parts();
                        let head = RequestHead {
                            version: parts.version,
                            subject: proto::RequestLine(parts.method, parts.uri),
                            headers: parts.headers,
                            extensions: parts.extensions,
                        };
                        this.callback = Some(cb);
                        Poll::Ready(Some(Ok((head, body))))
                    }
                }
            }
            Poll::Ready(None) => {
                // user has dropped sender handle
                trace!("client tx closed");
                this.rx_closed = true;
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn recv_msg(&mut self, msg: Result<(Self::RecvItem, Incoming)>) -> Result<()> {
        match msg {
            Ok((msg, body)) => {
                if let Some(cb) = self.callback.take() {
                    let res = msg.into_response(body);
                    cb.send(Ok(res));
                    Ok(())
                } else {
                    // Getting here is likely a bug! An error should have happened
                    // in Conn::require_empty_read() before ever parsing a
                    // full message!
                    Err(Error::new_unexpected_message())
                }
            }
            Err(err) => {
                if let Some(cb) = self.callback.take() {
                    cb.send(Err(TrySendError {
                        error: err,
                        message: None,
                    }));
                    Ok(())
                } else if !self.rx_closed {
                    self.rx.close();
                    if let Some((req, cb)) = self.rx.try_recv() {
                        trace!("canceling queued request with connection error: {}", err);
                        // in this case, the message was never even started, so it's safe to tell
                        // the user that the request was completely canceled
                        cb.send(Err(TrySendError {
                            error: Error::new_canceled().with(err),
                            message: Some(req),
                        }));
                        Ok(())
                    } else {
                        Err(err)
                    }
                } else {
                    Err(err)
                }
            }
        }
    }

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), ()>> {
        match self.callback {
            Some(ref mut cb) => match cb.poll_canceled(cx) {
                Poll::Ready(()) => {
                    trace!("callback receiver has dropped");
                    Poll::Ready(Err(()))
                }
                Poll::Pending => Poll::Ready(Ok(())),
            },
            None => Poll::Ready(Err(())),
        }
    }

    #[inline]
    fn should_poll(&self) -> bool {
        self.callback.is_none()
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{proto::http1, *};

    #[test]
    fn client_read_bytes_before_writing_request() {
        let _ = pretty_env_logger::try_init();

        tokio_test::task::spawn(()).enter(|cx, _| {
            let (io, mut handle) = tokio_test::io::Builder::new().build_with_handle();

            // Block at 0 for now, but we will release this response before
            // the request is ready to write later...
            let (mut tx, rx) = dispatch::channel();
            let conn = Conn::<_, bytes::Bytes, http1::role::Client>::new(io);
            let mut dispatcher = Dispatcher::new(Client::new(rx), conn);

            // First poll is needed to allow tx to send...
            assert!(Pin::new(&mut dispatcher).poll(cx).is_pending());

            // Unblock our IO, which has a response before we've sent request!
            //
            handle.read(b"HTTP/1.1 200 OK\r\n\r\n");

            let mut res_rx = tx.try_send(http::Request::new(Incoming::empty())).unwrap();

            tokio_test::assert_ready_ok!(Pin::new(&mut dispatcher).poll(cx));
            let err = tokio_test::assert_ready_ok!(Pin::new(&mut res_rx).poll(cx))
                .expect_err("callback should send error");

            match (err.error.is_canceled(), err.message.as_ref()) {
                (true, Some(_)) => (),
                _ => panic!("expected Canceled, got {err:?}"),
            }
        });
    }

    #[tokio::test]
    async fn client_flushing_is_not_ready_for_next_request() {
        let _ = pretty_env_logger::try_init();

        let (io, _handle) = tokio_test::io::Builder::new()
            .write(b"POST / HTTP/1.1\r\ncontent-length: 4\r\n\r\n")
            .read(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n")
            .wait(std::time::Duration::from_secs(2))
            .build_with_handle();

        let (mut tx, rx) = dispatch::channel();
        let mut conn = Conn::<_, bytes::Bytes, http1::role::Client>::new(io);
        conn.set_write_strategy_queue();

        let dispatcher = Dispatcher::new(Client::new(rx), conn);
        let _dispatcher = tokio::spawn(dispatcher);

        let body = {
            let (mut tx, body) = Incoming::h1(DecodedLength::new(4), false);
            tx.send_data("reee".into()).unwrap();
            body
        };

        let req = http::Request::builder().method("POST").body(body).unwrap();

        let res = tx.try_send(req).unwrap().await.expect("response");
        drop(res);

        assert!(!tx.is_ready());
    }

    #[tokio::test]
    async fn body_empty_chunks_ignored() {
        let _ = pretty_env_logger::try_init();

        let io = tokio_test::io::Builder::new()
            // no reading or writing, just be blocked for the test...
            .wait(Duration::from_secs(5))
            .build();

        let (mut tx, rx) = dispatch::channel();
        let conn = Conn::<_, bytes::Bytes, http1::role::Client>::new(io);
        let mut dispatcher = tokio_test::task::spawn(Dispatcher::new(Client::new(rx), conn));

        // First poll is needed to allow tx to send...
        assert!(dispatcher.poll().is_pending());

        let body = {
            let (mut tx, body) = Incoming::channel();
            tx.send_data("".into()).unwrap();
            body
        };

        let _res_rx = tx.try_send(http::Request::new(body)).unwrap();

        // Ensure conn.write_body wasn't called with the empty chunk.
        // If it is, it will trigger an assertion.
        assert!(dispatcher.poll().is_pending());
    }
}
