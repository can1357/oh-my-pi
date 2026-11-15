//! HTTP/2 client connections

use std::{
    future::Future,
    marker::PhantomData,
    pin::Pin,
    sync::Arc,
    task::{ready, Context, Poll},
};

use http::{Request, Response};
use http_body::Body;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{
    body::Incoming,
    dispatch::{self, TrySendError},
    error::{BoxError, Error},
    proto::{
        self,
        http2::{ping, Http2Options},
    },
    rt::{bounds::Http2ClientConnExec, Time, Timer},
    Result,
};

/// The sender side of an established connection.
pub struct SendRequest<B> {
    dispatch: dispatch::UnboundedSender<Request<B>, Response<Incoming>>,
}

impl<B> Clone for SendRequest<B> {
    #[inline]
    fn clone(&self) -> SendRequest<B> {
        SendRequest {
            dispatch: self.dispatch.clone(),
        }
    }
}

/// A future that processes all HTTP state for the IO object.
///
/// In most cases, this should just be spawned into an executor, so that it
/// can process incoming and outgoing messages, notice hangups, and the like.
#[must_use = "futures do nothing unless polled"]
pub struct Connection<T, B, E>
where
    T: AsyncRead + AsyncWrite + Unpin,
    B: Body + 'static,
    E: Http2ClientConnExec<B, T> + Unpin,
    B::Error: Into<BoxError>,
{
    inner: (PhantomData<T>, proto::http2::client::ClientTask<B, E, T>),
}

/// A builder to configure an HTTP connection.
///
/// After setting options, the builder is used to create a handshake future.
///
/// **Note**: The default values of options are *not considered stable*. They
/// are subject to change at any time.
#[derive(Clone)]
pub struct Builder<Ex> {
    exec: Ex,
    timer: Time,
    opts: Http2Options,
}

// ===== impl SendRequest

impl<B> SendRequest<B> {
    /// Polls to determine whether this sender can be used yet for a request.
    ///
    /// If the associated connection is closed, this returns an Error.
    #[inline]
    pub fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<()>> {
        if self.is_closed() {
            Poll::Ready(Err(Error::new_closed()))
        } else {
            Poll::Ready(Ok(()))
        }
    }

    /// Waits until the dispatcher is ready
    ///
    /// If the associated connection is closed, this returns an Error.
    #[inline]
    pub async fn ready(&mut self) -> Result<()> {
        std::future::poll_fn(|cx| self.poll_ready(cx)).await
    }

    /// Checks if the connection is currently ready to send a request.
    ///
    /// # Note
    ///
    /// This is mostly a hint. Due to inherent latency of networks, it is
    /// possible that even after checking this is ready, sending a request
    /// may still fail because the connection was closed in the meantime.
    #[inline]
    pub fn is_ready(&self) -> bool {
        self.dispatch.is_ready()
    }

    /// Checks if the connection side has been closed.
    #[inline]
    pub fn is_closed(&self) -> bool {
        self.dispatch.is_closed()
    }
}

impl<B> SendRequest<B>
where
    B: Body + 'static,
{
    /// Sends a `Request` on the associated connection.
    ///
    /// Returns a future that if successful, yields the `Response`.
    ///
    /// # Error
    ///
    /// If there was an error before trying to serialize the request to the
    /// connection, the message will be returned as part of this error.
    pub fn try_send_request(
        &mut self,
        req: Request<B>,
    ) -> impl Future<Output = Result<Response<Incoming>, TrySendError<Request<B>>>> {
        let sent = self.dispatch.try_send(req);
        async move {
            match sent {
                Ok(rx) => match rx.await {
                    Ok(Ok(res)) => Ok(res),
                    Ok(Err(err)) => Err(err),
                    // this is definite bug if it happens, but it shouldn't happen!
                    Err(_) => panic!("dispatch dropped without returning error"),
                },
                Err(req) => {
                    debug!("connection was not ready");
                    let error = Error::new_canceled().with("connection was not ready");
                    Err(TrySendError {
                        error,
                        message: Some(req),
                    })
                }
            }
        }
    }
}

// ===== impl Connection

impl<T, B, E> Future for Connection<T, B, E>
where
    T: AsyncRead + AsyncWrite + Unpin + 'static,
    B: Body + 'static + Unpin,
    B::Data: Send,
    E: Unpin,
    B::Error: Into<BoxError>,
    E: Http2ClientConnExec<B, T> + Unpin,
{
    type Output = Result<()>;

    #[inline]
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match ready!(Pin::new(&mut self.inner.1).poll(cx))? {
            proto::Dispatched::Shutdown => Poll::Ready(Ok(())),
            proto::Dispatched::Upgrade(_pending) => unreachable!("http2 cannot upgrade"),
        }
    }
}

impl<T, B, E> Connection<T, B, E>
where
    T: AsyncRead + AsyncWrite + Unpin + 'static,
    B: Body + Unpin + 'static,
    B::Data: Send,
    B::Error: Into<BoxError>,
    E: Http2ClientConnExec<B, T> + Unpin,
{
    /// Returns the current maximum send stream count.
    ///
    /// This setting is configured in a [`SETTINGS_MAX_CONCURRENT_STREAMS` parameter][1] in a
    /// `SETTINGS` frame, and may change throughout the connection lifetime.
    ///
    /// [1]: https://datatracker.ietf.org/doc/html/rfc7540#section-5.1.2
    pub fn current_max_send_streams(&self) -> usize {
        self.inner.1.current_max_send_streams()
    }

    /// Returns the current maximum receive stream count.
    ///
    /// This setting is configured in a [`SETTINGS_MAX_CONCURRENT_STREAMS` parameter][1] in a
    /// `SETTINGS` frame, and may change throughout the connection lifetime.
    ///
    /// [1]: https://datatracker.ietf.org/doc/html/rfc7540#section-5.1.2
    pub fn current_max_recv_streams(&self) -> usize {
        self.inner.1.current_max_recv_streams()
    }
}

// ===== impl Builder

impl<Ex> Builder<Ex>
where
    Ex: Clone,
{
    /// Creates a new connection builder.
    #[inline]
    pub fn new(exec: Ex) -> Builder<Ex> {
        Builder {
            exec,
            timer: Time::Empty,
            opts: Default::default(),
        }
    }

    /// Provide a timer to execute background HTTP2 tasks.
    #[inline]
    pub fn timer<M>(mut self, timer: M) -> Self
    where
        M: Timer + Send + Sync + 'static,
    {
        self.timer = Time::Timer(Arc::new(timer));
        self
    }

    /// Provide a options configuration for the HTTP/2 connection.
    #[inline]
    pub fn options(mut self, opts: Http2Options) -> Self {
        self.opts = opts;
        self
    }

    /// Constructs a connection with the configured options and IO.
    ///
    /// Note, if [`Connection`] is not `await`-ed, [`SendRequest`] will
    /// do nothing.
    pub async fn handshake<T, B>(self, io: T) -> Result<(SendRequest<B>, Connection<T, B, Ex>)>
    where
        T: AsyncRead + AsyncWrite + Unpin,
        B: Body + 'static,
        B::Data: Send,
        B::Error: Into<BoxError>,
        Ex: Http2ClientConnExec<B, T> + Unpin,
    {
        trace!("client handshake HTTP/2");

        // Crate the HTTP/2 client with the provided options.
        let mut builder = http2::client::Builder::default();
        builder
            .initial_max_send_streams(self.opts.initial_max_send_streams)
            .initial_window_size(self.opts.initial_window_size)
            .initial_connection_window_size(self.opts.initial_conn_window_size)
            .max_send_buffer_size(self.opts.max_send_buffer_size);
        if let Some(id) = self.opts.initial_stream_id {
            builder.initial_stream_id(id);
        }
        if let Some(max) = self.opts.max_pending_accept_reset_streams {
            builder.max_pending_accept_reset_streams(max);
        }
        if let Some(max) = self.opts.max_concurrent_reset_streams {
            builder.max_concurrent_reset_streams(max);
        }
        if let Some(max) = self.opts.max_concurrent_streams {
            builder.max_concurrent_streams(max);
        }
        if let Some(max) = self.opts.max_header_list_size {
            builder.max_header_list_size(max);
        }
        if let Some(opt) = self.opts.enable_push {
            builder.enable_push(opt);
        }
        if let Some(max) = self.opts.max_frame_size {
            builder.max_frame_size(max);
        }
        if let Some(max) = self.opts.header_table_size {
            builder.header_table_size(max);
        }
        if let Some(v) = self.opts.enable_connect_protocol {
            builder.enable_connect_protocol(v);
        }
        if let Some(v) = self.opts.no_rfc7540_priorities {
            builder.no_rfc7540_priorities(v);
        }
        if let Some(order) = self.opts.settings_order {
            builder.settings_order(order);
        }
        if let Some(stream_dependency) = self.opts.headers_stream_dependency {
            builder.headers_stream_dependency(stream_dependency);
        }
        if let Some(order) = self.opts.headers_pseudo_order {
            builder.headers_pseudo_order(order);
        }
        if let Some(priority) = self.opts.priorities {
            builder.priorities(priority);
        }

        // Create the ping configuration for the connection.
        let ping_config = ping::Config::new(
            self.opts.adaptive_window,
            self.opts.initial_window_size,
            self.opts.keep_alive_interval,
            self.opts.keep_alive_timeout,
            self.opts.keep_alive_while_idle,
        );

        let (tx, rx) = dispatch::channel();
        let h2 =
            proto::http2::client::handshake(io, rx, builder, ping_config, self.exec, self.timer)
                .await?;
        Ok((
            SendRequest {
                dispatch: tx.unbound(),
            },
            Connection {
                inner: (PhantomData, h2),
            },
        ))
    }
}
