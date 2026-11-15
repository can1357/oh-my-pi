//! Runtime components — executor and timer abstractions.
//!
//! This module provides [`Executor`] and [`Timer`], the two runtime primitives
//! used by the HTTP client for spawning background tasks and driving timeouts.
//!
//! # Feature flags
//!
//! At least one of the following features must be enabled:
//!
//! - `tokio-rt` — uses [tokio] as the underlying runtime (default).
//! - `compio-rt` — uses [compio] as the underlying runtime.
//!
//! When both are enabled, `tokio-rt` takes precedence for both [`Executor`]
//! and [`Timer`].  When neither is enabled, [`Executor::default`] and
//! [`Timer::default`] return empty placeholders that panic on use, so a
//! runtime feature flag **must** be active in practice.
//!
//! [tokio]: https://docs.rs/tokio
//! [compio]: https://docs.rs/compio

use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use wreq_proto::rt::{self, Sleep, Time};

/// A heap-allocated, type-erased future that is [`Send`] and resolves to `()`.
///
/// This is the concrete future type passed to [`rt::Executor::execute`] by the
/// client's background task machinery.  Callers do not need to construct this
/// type directly; the [`rt::Executor<F>`] blanket implementation boxes and
/// pins any qualifying `F` automatically.
pub type BoxSendFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// A handle to an async task executor.
///
/// `Executor` is used by the HTTP client to spawn background tasks such as
/// connection-pool cleanup and keep-alive management, without coupling the
/// client to a specific async runtime.
///
/// # Default behavior
///
/// [`Executor::default`] picks the runtime-appropriate implementation based
/// on the active feature flags:
///
/// | Feature flags active              | Executor          |
/// |-----------------------------------|-------------------|
/// | `tokio-rt` only                   | `TokioExecutor`   |
/// | `compio-rt` only                  | `CompioExecutor`  |
/// | both `tokio-rt` and `compio-rt`   | `TokioExecutor`   |
/// | neither                           | empty (panics)    |
#[derive(Clone)]
pub struct Executor(Arc<dyn rt::Executor<BoxSendFuture> + Send + Sync>);

// ===== impl Executor =====

impl<Fut> rt::Executor<Fut> for Executor
where
    Fut: Future<Output = ()> + Send + 'static,
{
    /// Spawns `fut` on the underlying executor.
    ///
    /// The future is boxed and pinned internally, so any `F` satisfying the
    /// bounds can be passed without the caller needing to allocate first.
    #[track_caller]
    #[inline(always)]
    fn execute(&self, fut: Fut) {
        self.0.execute(Box::pin(fut))
    }
}

impl Default for Executor {
    /// Returns the runtime-appropriate default executor.
    ///
    /// See the [type-level documentation][Executor] for the feature-flag
    /// selection table.
    #[inline]
    fn default() -> Self {
        if_tokio_rt!(block: {
            return Executor(Arc::new(wreq_rt::rt::tokio::TokioExecutor::new()))
        });

        if_compio_rt!(block: {
            return Executor(Arc::new(wreq_rt::rt::compio::CompioExecutor::new()))
        });

        if_all_rt!(block: {
            return Executor(Arc::new(wreq_rt::rt::tokio::TokioExecutor::new()))
        });

        if_no_rt!(block:{
            panic!(
                "no async runtime feature enabled; at least one of `tokio-rt` or `compio-rt` must be active"
            );
        });
    }
}

// ===== Timer =====

/// A handle to an async timer.
///
/// `Timer` is used by the HTTP client to drive request and connection timeouts,
/// as well as the connection pool's idle-expiry loop.  It wraps an
/// [`rt::Timer`] implementation in a cheap-to-clone, type-erased handle.
///
/// # Default behavior
///
/// [`Timer::default`] picks the runtime-appropriate implementation based on
/// the active feature flags:
///
/// | Feature flags active              | Timer           |
/// |-----------------------------------|-----------------|
/// | `tokio-rt` only                   | `TokioTimer`    |
/// | `compio-rt` only                  | `CompioTimer`   |
/// | both `tokio-rt` and `compio-rt`   | `TokioTimer`    |
/// | neither                           | empty (panics)  |
#[derive(Clone)]
pub struct Timer(Time);

// ===== impl Timer =====

impl Timer {
    /// Creates a [`Timer`] backed by a custom implementation.
    #[cfg(test)]
    #[inline]
    pub fn new<M>(timer: M) -> Self
    where
        M: rt::Timer + Send + Sync + 'static,
    {
        Timer(Time::Timer(Arc::new(timer)))
    }

    #[cfg(test)]
    #[doc(hidden)]
    pub fn empty() -> Self {
        Timer(Time::Empty)
    }

    /// Returns `true` if no timer implementation has been configured.
    #[inline]
    pub fn is_empty(&self) -> bool {
        matches!(self.0, Time::Empty)
    }
}

impl Default for Timer {
    #[inline]
    fn default() -> Self {
        if_tokio_rt!(block: {
            return Timer(rt::Time::Timer(Arc::new(wreq_rt::rt::tokio::TokioTimer::new())))
        });

        if_compio_rt!(block: {
            return Timer(rt::Time::Timer(Arc::new(wreq_rt::rt::compio::CompioTimer::new())))
        });

        if_all_rt!(block: {
            return Timer(rt::Time::Timer(Arc::new(wreq_rt::rt::tokio::TokioTimer::new())))
        });

        if_no_rt!(block: {
            Timer(Time::Empty)
        })
    }
}

impl rt::Timer for Timer {
    /// Returns a future that resolves after `duration`.
    #[inline]
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Sleep>> {
        self.0.sleep(duration)
    }

    /// Returns the current time according to the underlying runtime.
    #[inline]
    fn now(&self) -> Instant {
        self.0.now()
    }

    /// Returns a future that resolves at `deadline`.
    #[inline]
    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Sleep>> {
        self.0.sleep_until(deadline)
    }

    /// Resets an in-flight sleep future to fire at `new_deadline` instead.
    #[inline]
    fn reset(&self, sleep: &mut Pin<Box<dyn Sleep>>, new_deadline: Instant) {
        self.0.reset(sleep, new_deadline)
    }
}
