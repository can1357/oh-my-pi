//! Runtime-neutral timeout middleware for connector services.

use std::{
    future::Future,
    pin::Pin,
    task::{Context, Poll},
    time::Duration,
};

use pin_project_lite::pin_project;
use tower::{BoxError, Layer, Service};
use wreq_proto::rt::{Sleep, Timer as _};

use crate::{error::TimedOut, rt::Timer};

/// Captures timeout configuration while the connector service graph is assembled.
///
/// Applying this layer transfers the client timer and optional duration into [`Timeout`]; it does
/// not start a timer until a connection attempt begins.
#[derive(Clone)]
pub(super) struct TimeoutLayer {
    timer: Timer,
    timeout: Option<Duration>,
}

/// Wraps a connector service with a deadline for each connection attempt.
///
/// This service remains in the client graph and creates a separate [`TimeoutFuture`] on every
/// call, so concurrent attempts do not share timeout state.
#[derive(Clone)]
pub struct Timeout<S> {
    inner: S,
    timer: Timer,
    timeout: Option<Duration>,
}

pin_project! {
    /// Owns one in-flight connection and its optional timeout sleep.
    ///
    /// The connection is polled first; while it remains pending, the sleep can end the attempt.
    /// Dropping this future drops both operations.
    pub struct TimeoutFuture<F> {
        #[pin]
        future: F,
        sleep: Option<Pin<Box<dyn Sleep>>>,
    }
}

// ===== impl TimeoutLayer =====

impl TimeoutLayer {
    pub(super) fn new(timer: Timer, timeout: Option<Duration>) -> Self {
        Self { timer, timeout }
    }
}

impl<S> Layer<S> for TimeoutLayer {
    type Service = Timeout<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Timeout {
            inner,
            timer: self.timer.clone(),
            timeout: self.timeout,
        }
    }
}

// ===== impl Timeout =====

impl<S, Request> Service<Request> for Timeout<S>
where
    S: Service<Request>,
    S::Error: Into<BoxError>,
{
    type Response = S::Response;
    type Error = BoxError;
    type Future = TimeoutFuture<S::Future>;

    #[inline]
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx).map_err(Into::into)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let future = self.inner.call(request);
        let sleep = self.timeout.map(|timeout| self.timer.sleep(timeout));
        TimeoutFuture { future, sleep }
    }
}

// ===== impl TimeoutFuture =====

impl<F, T, E> Future for TimeoutFuture<F>
where
    F: Future<Output = Result<T, E>>,
    E: Into<BoxError>,
{
    type Output = Result<T, BoxError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.project();

        match this.future.poll(cx) {
            Poll::Ready(result) => return Poll::Ready(result.map_err(Into::into)),
            Poll::Pending => {}
        }

        if let Some(sleep) = this.sleep.as_mut()
            && sleep.as_mut().poll(cx).is_ready()
        {
            return Poll::Ready(Err(Box::new(TimedOut)));
        }

        Poll::Pending
    }
}

#[cfg(test)]
mod tests {
    use std::{future::pending, task::Waker, time::Instant};

    use super::*;

    #[derive(Clone)]
    struct ReadyTimer;

    struct ReadySleep;

    impl wreq_proto::rt::Timer for ReadyTimer {
        fn sleep(&self, _duration: Duration) -> Pin<Box<dyn Sleep>> {
            Box::pin(ReadySleep)
        }

        fn sleep_until(&self, _deadline: Instant) -> Pin<Box<dyn Sleep>> {
            self.sleep(Duration::ZERO)
        }
    }

    impl Future for ReadySleep {
        type Output = ();

        fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
            Poll::Ready(())
        }
    }

    impl Sleep for ReadySleep {
        fn reset(self: Pin<&mut Self>, _new_deadline: Instant) {}
    }

    #[test]
    fn connect_timeout_uses_configured_timer_without_runtime() {
        let mut service =
            TimeoutLayer::new(Timer::new(ReadyTimer), Some(Duration::from_millis(50)))
                .layer(tower::service_fn(|()| pending::<Result<(), BoxError>>()));

        let mut future = std::pin::pin!(service.call(()));
        let mut cx = Context::from_waker(Waker::noop());
        let Poll::Ready(Err(error)) = future.as_mut().poll(&mut cx) else {
            panic!("connect timeout did not complete");
        };

        assert!(error.is::<TimedOut>());
    }
}
