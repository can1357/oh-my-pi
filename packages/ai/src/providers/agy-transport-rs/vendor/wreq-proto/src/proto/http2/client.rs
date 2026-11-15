use std::{
    convert::Infallible,
    future::Future,
    marker::PhantomData,
    pin::Pin,
    task::{ready, Context, Poll},
};

use bytes::Bytes;
use futures_channel::{
    mpsc,
    mpsc::{Receiver, Sender},
    oneshot,
};
use futures_util::{
    future::{Either, FusedFuture},
    stream::{FusedStream, Stream},
};
use http::{Method, Request, Response, StatusCode};
use http2::{
    client::{Builder, Connection, ResponseFuture, SendRequest},
    SendStream,
};
use http_body::Body;
use pin_project_lite::pin_project;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{
    ping,
    ping::{Ponger, Recorder},
    H2Upgraded, PipeToSendStream, SendBuf,
};
use crate::{
    body::{self, Incoming},
    dispatch::{self, Callback, SendWhen, TrySendError},
    error::BoxError,
    ext::OnPreserveHeader,
    proto::{headers, Dispatched},
    rt::{bounds::Http2ClientConnExec, Time},
    upgrade::{self, Upgraded},
    Error, Result,
};

/// Receiver for HTTP/2 client requests
type ClientRx<B> = dispatch::Receiver<Request<B>, Response<Incoming>>;

///// An mpsc channel is used to help notify the `Connection` task when *all*
///// other handles to it have been dropped, so that it can shutdown.
type ConnDropRef = mpsc::Sender<Infallible>;

///// A oneshot channel watches the `Connection` task, and when it completes,
///// the "dispatch" task will be notified and can shutdown sooner.
type ConnEof = oneshot::Receiver<Infallible>;

pub(crate) async fn handshake<T, B, E>(
    io: T,
    req_rx: ClientRx<B>,
    builder: Builder,
    ping_config: ping::Config,
    mut exec: E,
    timer: Time,
) -> Result<ClientTask<B, E, T>>
where
    T: AsyncRead + AsyncWrite + Unpin,
    B: Body + 'static,
    B::Data: Send + 'static,
    E: Http2ClientConnExec<B, T> + Unpin,
    B::Error: Into<BoxError>,
{
    let (h2_tx, mut conn) = builder
        .handshake::<_, SendBuf<B::Data>>(io)
        .await
        .map_err(Error::new_h2)?;

    // An mpsc channel is used entirely to detect when the
    // 'Client' has been dropped. This is to get around a bug
    // in h2 where dropping all SendRequests won't notify a
    // parked Connection.
    let (conn_drop_ref, conn_drop_rx) = mpsc::channel(1);
    let (cancel_tx, conn_eof) = oneshot::channel();

    let (conn, ping) = if ping_config.is_enabled() {
        let pp = conn.ping_pong().expect("conn.ping_pong");
        let (recorder, ponger) = ping::channel(pp, ping_config, timer);

        let conn: Conn<_, B> = Conn { ponger, conn };
        (Either::Left(conn), recorder)
    } else {
        (Either::Right(conn), ping::Recorder::disabled())
    };
    let conn: ConnMapErr<T, B> = ConnMapErr {
        conn,
        is_terminated: false,
    };

    exec.execute_h2_future(H2ClientFuture::Task {
        task: ConnTask::new(conn, conn_drop_rx, cancel_tx),
    });

    Ok(ClientTask {
        ping,
        conn_drop_ref,
        conn_eof,
        executor: exec,
        h2_tx,
        req_rx,
        fut_ctx: None,
        marker: PhantomData,
    })
}

pin_project! {
    struct Conn<T, B>
    where
        B: Body,
    {
        #[pin]
        ponger: Ponger,
        #[pin]
        conn: Connection<T, SendBuf<<B as Body>::Data>>,
    }
}

impl<T, B> Future for Conn<T, B>
where
    B: Body,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Output = Result<(), http2::Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();
        match this.ponger.poll(cx) {
            Poll::Ready(ping::Ponged::SizeUpdate(wnd)) => {
                this.conn.set_target_window_size(wnd);
                this.conn.set_initial_window_size(wnd)?;
            }
            Poll::Ready(ping::Ponged::KeepAliveTimedOut) => {
                debug!("connection keep-alive timed out");
                return Poll::Ready(Ok(()));
            }
            Poll::Pending => {}
        }

        Pin::new(&mut this.conn).poll(cx)
    }
}

pin_project! {
    struct ConnMapErr<T, B>
    where
        B: Body,
        T: AsyncRead,
        T: AsyncWrite,
        T: Unpin,
    {
        #[pin]
        conn: Either<Conn<T, B>, Connection<T, SendBuf<<B as Body>::Data>>>,
        #[pin]
        is_terminated: bool,
    }
}

impl<T, B> Future for ConnMapErr<T, B>
where
    B: Body,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Output = Result<(), ()>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();

        if *this.is_terminated {
            return Poll::Pending;
        }
        let polled = this.conn.poll(cx);
        if polled.is_ready() {
            *this.is_terminated = true;
        }
        polled.map_err(|_e| {
            debug!(error = %_e, "connection error");
        })
    }
}

impl<T, B> FusedFuture for ConnMapErr<T, B>
where
    B: Body,
    T: AsyncRead + AsyncWrite + Unpin,
{
    #[inline]
    fn is_terminated(&self) -> bool {
        self.is_terminated
    }
}

pin_project! {
    pub struct ConnTask<T, B>
    where
        B: Body,
        T: AsyncRead,
        T: AsyncWrite,
        T: Unpin,
    {
        #[pin]
        drop_rx: Receiver<Infallible>,
        #[pin]
        cancel_tx: Option<oneshot::Sender<Infallible>>,
        #[pin]
        conn: ConnMapErr<T, B>,
    }
}

impl<T, B> ConnTask<T, B>
where
    B: Body,
    T: AsyncRead + AsyncWrite + Unpin,
{
    #[inline]
    fn new(
        conn: ConnMapErr<T, B>,
        drop_rx: Receiver<Infallible>,
        cancel_tx: oneshot::Sender<Infallible>,
    ) -> Self {
        Self {
            drop_rx,
            cancel_tx: Some(cancel_tx),
            conn,
        }
    }
}

impl<T, B> Future for ConnTask<T, B>
where
    B: Body,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();

        if !this.conn.is_terminated() && Pin::new(&mut this.conn).poll(cx).is_ready() {
            // ok or err, the `conn` has finished.
            return Poll::Ready(());
        }

        if !this.drop_rx.is_terminated() && Pin::new(&mut this.drop_rx).poll_next(cx).is_ready() {
            // mpsc has been dropped, hopefully polling
            // the connection some more should start shutdown
            // and then close.
            trace!("send_request dropped, starting conn shutdown");
            drop(this.cancel_tx.take().expect("ConnTask Future polled twice"));
        }

        Poll::Pending
    }
}

pin_project! {
    #[project = H2ClientFutureProject]
    pub enum H2ClientFuture<B, T>
    where
        B: http_body::Body,
        B: 'static,
        B::Error: Into<BoxError>,
        T: AsyncRead,
        T: AsyncWrite,
        T: Unpin,
    {
        Pipe {
            #[pin]
            pipe: PipeMap<B>,
        },
        Send {
            #[pin]
            send_when: SendWhen<B>,
        },
        Task {
            #[pin]
            task: ConnTask<T, B>,
        },
    }
}

impl<B, T> Future for H2ClientFuture<B, T>
where
    B: Body + 'static,
    B::Data: Send,
    B::Error: Into<BoxError>,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> std::task::Poll<Self::Output> {
        let this = self.project();

        match this {
            H2ClientFutureProject::Pipe { pipe } => pipe.poll(cx),
            H2ClientFutureProject::Send { send_when } => send_when.poll(cx),
            H2ClientFutureProject::Task { task } => task.poll(cx),
        }
    }
}

struct FutCtx<B>
where
    B: Body,
{
    is_connect: bool,
    eos: bool,
    fut: ResponseFuture,
    body_tx: SendStream<SendBuf<B::Data>>,
    body: B,
    cb: Callback<Request<B>, Response<Incoming>>,
}

impl<B: Body> Unpin for FutCtx<B> {}

pub(crate) struct ClientTask<B, E, T>
where
    B: Body,
    E: Unpin,
{
    ping: ping::Recorder,
    conn_drop_ref: ConnDropRef,
    conn_eof: ConnEof,
    executor: E,
    h2_tx: SendRequest<SendBuf<B::Data>>,
    req_rx: ClientRx<B>,
    fut_ctx: Option<FutCtx<B>>,
    marker: PhantomData<T>,
}

pin_project! {
    pub struct PipeMap<S>
    where
        S: Body,
    {
        #[pin]
        pipe: PipeToSendStream<S>,
        #[pin]
        conn_drop_ref: Option<Sender<Infallible>>,
        #[pin]
        ping: Option<Recorder>,
        cancel_rx: Option<oneshot::Receiver<()>>,
    }
}

impl<B> Future for PipeMap<B>
where
    B: http_body::Body,
    B::Error: Into<BoxError>,
{
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> std::task::Poll<Self::Output> {
        const EXPECT_TAKEN_ONCE_MSG: &str = "Future polled twice";

        let mut this = self.project();

        // Check if the client cancelled the request (e.g. dropped the
        // response future due to a timeout). If so, reset the h2 stream
        // so that a RST_STREAM is sent and flow-control capacity is freed.
        match this.cancel_rx.as_mut().map(|rx| Pin::new(rx).poll(cx)) {
            Some(Poll::Ready(Ok(()))) => {
                debug!("client request body send cancelled, resetting stream");
                this.pipe.as_mut().send_reset(http2::Reason::CANCEL);
                this.conn_drop_ref.take().expect(EXPECT_TAKEN_ONCE_MSG);
                this.ping.take().expect(EXPECT_TAKEN_ONCE_MSG);
                return Poll::Ready(());
            }
            Some(Poll::Ready(Err(_))) => {
                // Sender dropped without cancelling (normal response or error).
                // Stop polling the receiver.
                *this.cancel_rx = None;
            }
            Some(Poll::Pending) | None => {}
        }

        match Pin::new(&mut this.pipe).poll(cx) {
            Poll::Ready(result) => {
                if let Err(_e) = result {
                    debug!("client request body error: {}", _e);
                }
                drop(this.conn_drop_ref.take().expect(EXPECT_TAKEN_ONCE_MSG));
                drop(this.ping.take().expect(EXPECT_TAKEN_ONCE_MSG));
                return Poll::Ready(());
            }
            Poll::Pending => (),
        };
        Poll::Pending
    }
}

impl<B, E, T> ClientTask<B, E, T>
where
    B: Body + 'static + Unpin,
    B::Data: Send,
    E: Http2ClientConnExec<B, T> + Unpin,
    B::Error: Into<BoxError>,
    T: AsyncRead + AsyncWrite + Unpin,
{
    fn poll_pipe(&mut self, f: FutCtx<B>, cx: &mut Context<'_>) {
        let ping = self.ping.clone();

        // A one-shot channel so that send_task can tell pipe_task to
        // reset the stream when the client cancels the request.
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

        let send_stream = if !f.is_connect {
            if !f.eos {
                let mut pipe = PipeToSendStream::new(f.body, f.body_tx);

                // eagerly see if the body pipe is ready and
                // can thus skip allocating in the executor
                match Pin::new(&mut pipe).poll(cx) {
                    Poll::Ready(_) => (),
                    Poll::Pending => {
                        let conn_drop_ref = self.conn_drop_ref.clone();
                        // keep the ping recorder's knowledge of an
                        // "open stream" alive while this body is
                        // still sending...
                        let ping = ping.clone();

                        let pipe = PipeMap {
                            pipe,
                            conn_drop_ref: Some(conn_drop_ref),
                            ping: Some(ping),
                            cancel_rx: Some(cancel_rx),
                        };
                        // Clear send task
                        self.executor
                            .execute_h2_future(H2ClientFuture::Pipe { pipe });
                    }
                }
            }

            None
        } else {
            Some(f.body_tx)
        };

        self.executor.execute_h2_future(H2ClientFuture::Send {
            send_when: SendWhen {
                when: ResponseFutMap {
                    fut: f.fut,
                    ping: Some(ping),
                    send_stream: Some(send_stream),
                    cancel_tx: Some(cancel_tx),
                },
                call_back: Some(f.cb),
            },
        });
    }
}

impl<B, E, T> ClientTask<B, E, T>
where
    B: Body + 'static,
    E: Http2ClientConnExec<B, T> + Unpin,
    B::Error: Into<BoxError>,
    T: AsyncRead + AsyncWrite + Unpin,
{
    pub(crate) fn current_max_send_streams(&self) -> usize {
        self.h2_tx.current_max_send_streams()
    }

    pub(crate) fn current_max_recv_streams(&self) -> usize {
        self.h2_tx.current_max_recv_streams()
    }
}

pin_project! {
    pub(crate) struct ResponseFutMap<B>
    where
        B: Body,
        B: 'static,
    {
        #[pin]
        fut: ResponseFuture,
        #[pin]
        ping: Option<Recorder>,
        #[pin]
        send_stream: Option<Option<SendStream<SendBuf<<B as Body>::Data>>>>,
        cancel_tx: Option<oneshot::Sender<()>>,
    }
}

impl<B: Body + 'static> ResponseFutMap<B> {
    /// Signal the pipe_task to reset the stream (e.g. on client cancellation).
    pub(crate) fn cancel(self: Pin<&mut Self>) {
        if let Some(cancel_tx) = self.project().cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
    }
}

impl<B> Future for ResponseFutMap<B>
where
    B: Body + 'static,
    B::Data: Send,
{
    type Output = Result<Response<body::Incoming>, (Error, Option<Request<B>>)>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();

        let result = ready!(this.fut.poll(cx));

        let ping = this.ping.take().expect("Future polled twice");
        let send_stream = this.send_stream.take().expect("Future polled twice");

        match result {
            Ok(res) => {
                // record that we got the response headers
                ping.record_non_data();

                let content_length = headers::content_length_parse_all(res.headers());
                if let (Some(mut send_stream), StatusCode::OK) = (send_stream, res.status()) {
                    if content_length.is_some_and(|len| len != 0) {
                        warn!("h2 connect response with non-zero body not supported");

                        send_stream.send_reset(http2::Reason::INTERNAL_ERROR);
                        return Poll::Ready(Err((
                            Error::new_h2(http2::Reason::INTERNAL_ERROR.into()),
                            None::<Request<B>>,
                        )));
                    }
                    let (parts, recv_stream) = res.into_parts();
                    let mut res = Response::from_parts(parts, Incoming::empty());

                    let (pending, on_upgrade) = upgrade::pending();
                    let io = H2Upgraded {
                        ping,
                        send_stream,
                        recv_stream,
                        buf: Bytes::new(),
                    };
                    let upgraded = Upgraded::new(io, Bytes::new());

                    pending.fulfill(upgraded);
                    res.extensions_mut().insert(on_upgrade);

                    Poll::Ready(Ok(res))
                } else {
                    let res = res.map(|stream| {
                        let ping = ping.for_stream(&stream);
                        Incoming::h2(stream, content_length.into(), ping)
                    });
                    Poll::Ready(Ok(res))
                }
            }
            Err(err) => {
                ping.ensure_not_timed_out().map_err(|e| (e, None))?;

                debug!("client response error: {}", err);
                Poll::Ready(Err((Error::new_h2(err), None::<Request<B>>)))
            }
        }
    }
}

impl<B, E, T> Future for ClientTask<B, E, T>
where
    B: Body + 'static + Unpin,
    B::Data: Send,
    B::Error: Into<BoxError>,
    E: Http2ClientConnExec<B, T> + Unpin,
    T: AsyncRead + AsyncWrite + Unpin,
{
    type Output = Result<Dispatched>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            match ready!(self.h2_tx.poll_ready(cx)) {
                Ok(()) => (),
                Err(err) => {
                    self.ping.ensure_not_timed_out()?;
                    return if err.reason() == Some(::http2::Reason::NO_ERROR) {
                        trace!("connection gracefully shutdown");
                        Poll::Ready(Ok(Dispatched::Shutdown))
                    } else {
                        Poll::Ready(Err(Error::new_h2(err)))
                    };
                }
            };

            // If we were waiting on pending open
            // continue where we left off.
            if let Some(f) = self.fut_ctx.take() {
                self.poll_pipe(f, cx);
                continue;
            }

            match self.req_rx.poll_recv(cx) {
                Poll::Ready(Some((req, cb))) => {
                    // Check that future hasn't been canceled already
                    if cb.is_canceled() {
                        trace!("request callback is canceled");
                        continue;
                    }
                    let (head, body) = req.into_parts();
                    let mut req = ::http::Request::from_parts(head, ());
                    super::strip_connection_headers(req.headers_mut(), true);
                    if let Some(len) = body.size_hint().exact() {
                        if len != 0 || headers::method_has_defined_payload_semantics(req.method()) {
                            headers::set_content_length_if_missing(req.headers_mut(), len);
                        }
                    }

                    // Sort headers
                    if let Some(header_sort) = req.extensions_mut().remove::<OnPreserveHeader>() {
                        header_sort.call(req.headers_mut());
                    }

                    let is_connect = req.method() == Method::CONNECT;
                    let eos = body.is_end_stream();

                    if is_connect
                        && headers::content_length_parse_all(req.headers())
                            .is_some_and(|len| len != 0)
                    {
                        debug!("h2 connect request with non-zero body not supported");
                        cb.send(Err(TrySendError {
                            error: Error::new_user_invalid_connect(),
                            message: None,
                        }));
                        continue;
                    }

                    let (fut, body_tx) = match self.h2_tx.send_request(req, !is_connect && eos) {
                        Ok(ok) => ok,
                        Err(err) => {
                            debug!("client send request error: {}", err);
                            cb.send(Err(TrySendError {
                                error: Error::new_h2(err),
                                message: None,
                            }));
                            continue;
                        }
                    };

                    let f = FutCtx {
                        is_connect,
                        eos,
                        fut,
                        body_tx,
                        body,
                        cb,
                    };

                    // Check poll_ready() again.
                    // If the call to send_request() resulted in the new stream being pending open
                    // we have to wait for the open to complete before accepting new requests.
                    match self.h2_tx.poll_ready(cx) {
                        Poll::Pending => {
                            // Save Context
                            self.fut_ctx = Some(f);
                            return Poll::Pending;
                        }
                        Poll::Ready(Ok(())) => (),
                        Poll::Ready(Err(err)) => {
                            f.cb.send(Err(TrySendError {
                                error: Error::new_h2(err),
                                message: None,
                            }));
                            continue;
                        }
                    }
                    self.poll_pipe(f, cx);
                    continue;
                }

                Poll::Ready(None) => {
                    trace!("client::dispatch::Sender dropped");
                    return Poll::Ready(Ok(Dispatched::Shutdown));
                }

                Poll::Pending => match ready!(Pin::new(&mut self.conn_eof).poll(cx)) {
                    // As of Rust 1.82, this pattern is no longer needed, and emits a warning.
                    // But we cannot remove it as long as MSRV is less than that.
                    Ok(never) => match never {},
                    Err(_conn_is_eof) => {
                        trace!("connection task is closed, closing dispatch task");
                        return Poll::Ready(Ok(Dispatched::Shutdown));
                    }
                },
            }
        }
    }
}
