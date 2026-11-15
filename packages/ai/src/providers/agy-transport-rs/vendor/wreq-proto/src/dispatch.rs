use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
};

use http::{Request, Response};
use http_body::Body;
use pin_project_lite::pin_project;
use tokio::sync::{mpsc, oneshot};

use super::{body::Incoming, proto::http2::client::ResponseFutMap, Error};

type RetryPromise<T, U> = oneshot::Receiver<Result<U, TrySendError<T>>>;

pub(crate) fn channel<T, U>() -> (Sender<T, U>, Receiver<T, U>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (giver, taker) = want::new();
    (
        Sender {
            buffered_once: false,
            giver,
            inner: tx,
        },
        Receiver { inner: rx, taker },
    )
}

/// An error when calling `try_send_request`.
///
/// There is a possibility of an error occurring on a connection in-between the
/// time that a request is queued and when it is actually written to the IO
/// transport. If that happens, it is safe to return the request back to the
/// caller, as it was never fully sent.
#[derive(Debug)]
pub struct TrySendError<T> {
    pub(crate) error: Error,
    pub(crate) message: Option<T>,
}

/// A bounded sender of requests and callbacks for when responses are ready.
///
/// While the inner sender is unbounded, the Giver is used to determine
/// if the Receiver is ready for another request.
pub(crate) struct Sender<T, U> {
    /// One message is always allowed, even if the Receiver hasn't asked
    /// for it yet. This boolean keeps track of whether we've sent one
    /// without notice.
    buffered_once: bool,
    /// The Giver helps watch that the Receiver side has been polled
    /// when the queue is empty. This helps us know when a request and
    /// response have been fully processed, and a connection is ready
    /// for more.
    giver: want::Giver,
    /// Actually bounded by the Giver, plus `buffered_once`.
    inner: mpsc::UnboundedSender<Envelope<T, U>>,
}

/// An unbounded version.
///
/// Cannot poll the Giver, but can still use it to determine if the Receiver
/// has been dropped. However, this version can be cloned.
pub(crate) struct UnboundedSender<T, U> {
    /// Only used for `is_closed`, since mpsc::UnboundedSender cannot be checked.
    giver: want::SharedGiver,
    inner: mpsc::UnboundedSender<Envelope<T, U>>,
}

impl<T, U> Sender<T, U> {
    #[inline]
    pub(crate) fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<super::Result<()>> {
        self.giver.poll_want(cx).map_err(|_| Error::new_closed())
    }

    #[inline]
    pub(crate) fn is_ready(&self) -> bool {
        self.giver.is_wanting()
    }

    pub(crate) fn try_send(&mut self, val: T) -> Result<RetryPromise<T, U>, T> {
        if self.giver.give() || !self.buffered_once {
            // If the receiver is ready *now*, then of course we can send.
            //
            // If the receiver isn't ready yet, but we don't have anything
            // in the channel yet, then allow one message.
            self.buffered_once = true;
        } else {
            return Err(val);
        };

        let (tx, rx) = oneshot::channel();
        self.inner
            .send(Envelope(Some((val, Callback(Some(tx))))))
            .map(move |_| rx)
            .map_err(|mut e| (e.0).0.take().expect("envelope not dropped").0)
    }

    #[inline]
    pub(crate) fn unbound(self) -> UnboundedSender<T, U> {
        UnboundedSender {
            giver: self.giver.shared(),
            inner: self.inner,
        }
    }
}

impl<T, U> UnboundedSender<T, U> {
    #[inline]
    pub(crate) fn is_ready(&self) -> bool {
        !self.giver.is_canceled()
    }

    #[inline]
    pub(crate) fn is_closed(&self) -> bool {
        self.giver.is_canceled()
    }

    pub(crate) fn try_send(&mut self, val: T) -> Result<RetryPromise<T, U>, T> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .send(Envelope(Some((val, Callback(Some(tx))))))
            .map(move |_| rx)
            .map_err(|mut e| (e.0).0.take().expect("envelope not dropped").0)
    }
}

impl<T, U> Clone for UnboundedSender<T, U> {
    #[inline]
    fn clone(&self) -> Self {
        UnboundedSender {
            giver: self.giver.clone(),
            inner: self.inner.clone(),
        }
    }
}

pub(crate) struct Receiver<T, U> {
    inner: mpsc::UnboundedReceiver<Envelope<T, U>>,
    taker: want::Taker,
}

impl<T, U> Receiver<T, U> {
    pub(crate) fn poll_recv(&mut self, cx: &mut Context<'_>) -> Poll<Option<(T, Callback<T, U>)>> {
        match self.inner.poll_recv(cx) {
            Poll::Ready(item) => {
                Poll::Ready(item.map(|mut env| env.0.take().expect("envelope not dropped")))
            }
            Poll::Pending => {
                self.taker.want();
                Poll::Pending
            }
        }
    }

    #[inline]
    pub(crate) fn close(&mut self) {
        self.taker.cancel();
        self.inner.close();
    }

    #[inline]
    pub(crate) fn try_recv(&mut self) -> Option<(T, Callback<T, U>)> {
        use futures_util::FutureExt;
        match self.inner.recv().now_or_never() {
            Some(Some(mut env)) => env.0.take(),
            _ => None,
        }
    }
}

impl<T, U> Drop for Receiver<T, U> {
    #[inline]
    fn drop(&mut self) {
        // Notify the giver about the closure first, before dropping
        // the mpsc::Receiver.
        self.taker.cancel();
    }
}

struct Envelope<T, U>(Option<(T, Callback<T, U>)>);

impl<T, U> Drop for Envelope<T, U> {
    fn drop(&mut self) {
        if let Some((val, cb)) = self.0.take() {
            cb.send(Err(TrySendError {
                error: Error::new_canceled().with("connection closed"),
                message: Some(val),
            }));
        }
    }
}

pub(crate) struct Callback<T, U>(Option<oneshot::Sender<Result<U, TrySendError<T>>>>);

impl<T, U> Drop for Callback<T, U> {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(Err(TrySendError {
                error: dispatch_gone(),
                message: None,
            }));
        }
    }
}

#[cold]
fn dispatch_gone() -> Error {
    // FIXME(nox): What errors do we want here?
    Error::new_user_dispatch_gone().with(if std::thread::panicking() {
        "user code panicked"
    } else {
        "runtime dropped the dispatch task"
    })
}

impl<T, U> Callback<T, U> {
    const MISSING_SENDER: &'static str = "callback sender missing";

    #[inline]
    pub(crate) fn is_canceled(&self) -> bool {
        self.0.as_ref().expect(Self::MISSING_SENDER).is_closed()
    }

    #[inline]
    pub(crate) fn poll_canceled(&mut self, cx: &mut Context<'_>) -> Poll<()> {
        self.0.as_mut().expect(Self::MISSING_SENDER).poll_closed(cx)
    }

    #[inline]
    pub(crate) fn send(mut self, val: Result<U, TrySendError<T>>) {
        let _ = self.0.take().expect(Self::MISSING_SENDER).send(val);
    }
}

impl<T> TrySendError<T> {
    /// Take the message from this error.
    ///
    /// The message will not always have been recovered. If an error occurs
    /// after the message has been serialized onto the connection, it will not
    /// be available here.
    #[inline]
    pub fn take_message(&mut self) -> Option<T> {
        self.message.take()
    }

    /// Consumes this to return the inner error.
    #[inline]
    pub fn into_error(self) -> Error {
        self.error
    }
}

pin_project! {
    pub(crate) struct SendWhen<B>
    where
        B: Body,
        B: 'static,
    {
        #[pin]
        pub(crate) when: ResponseFutMap<B>,
        #[pin]
        pub(crate) call_back: Option<Callback<Request<B>, Response<Incoming>>>,
    }
}

impl<B> Future for SendWhen<B>
where
    B: Body + 'static,
    B::Data: Send,
{
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut this = self.project();
        let mut call_back = this.call_back.take().expect("polled after complete");

        match Pin::new(&mut this.when).poll(cx) {
            Poll::Ready(Ok(res)) => {
                call_back.send(Ok(res));
                Poll::Ready(())
            }
            Poll::Pending => {
                // check if the callback is canceled
                match call_back.poll_canceled(cx) {
                    Poll::Ready(v) => v,
                    Poll::Pending => {
                        // Move call_back back to struct before return
                        this.call_back.set(Some(call_back));
                        return Poll::Pending;
                    }
                };
                trace!("send_when canceled");
                // Tell pipe_task to reset the h2 stream so that
                // RST_STREAM is sent and flow-control capacity freed.
                this.when.as_mut().cancel();
                Poll::Ready(())
            }
            Poll::Ready(Err((error, message))) => {
                call_back.send(Err(TrySendError { error, message }));
                Poll::Ready(())
            }
        }
    }
}
