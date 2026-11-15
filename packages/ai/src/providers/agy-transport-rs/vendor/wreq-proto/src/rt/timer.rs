//! Provides a timer trait with timer-like functions

use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

/// A timer which provides timer-like functions.
pub trait Timer {
    /// Return a future that resolves in `duration` time.
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Sleep>>;

    /// Return a future that resolves at `deadline`.
    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Sleep>>;

    /// Return an `Instant` representing the current time.
    ///
    /// The default implementation returns [`Instant::now()`].
    fn now(&self) -> Instant {
        Instant::now()
    }

    /// Reset a future to resolve at `new_deadline` instead.
    fn reset(&self, sleep: &mut Pin<Box<dyn Sleep>>, new_deadline: Instant) {
        *sleep = self.sleep_until(new_deadline);
    }
}

/// A future returned by a `Timer`.
pub trait Sleep: Send + Sync + Future<Output = ()> {
    /// Reset the future to resolve at `new_deadline` instead.
    fn reset(self: Pin<&mut Self>, new_deadline: Instant);
}

/// A user-provided timer to time background tasks.
#[derive(Clone)]
pub enum Time {
    /// A user-provided timer.
    Timer(Arc<dyn Timer + Send + Sync>),
    /// No timer provided.
    Empty,
}

// ===== impl Time =====

impl Timer for Time {
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Sleep>> {
        match *self {
            Time::Empty => {
                panic!("You must supply a timer.")
            }
            Time::Timer(ref t) => t.sleep(duration),
        }
    }

    fn now(&self) -> Instant {
        match *self {
            Time::Empty => Instant::now(),
            Time::Timer(ref t) => t.now(),
        }
    }

    fn sleep_until(&self, deadline: Instant) -> Pin<Box<dyn Sleep>> {
        match *self {
            Time::Empty => {
                panic!("You must supply a timer.")
            }
            Time::Timer(ref t) => t.sleep_until(deadline),
        }
    }

    fn reset(&self, sleep: &mut Pin<Box<dyn Sleep>>, new_deadline: Instant) {
        match *self {
            Time::Empty => {
                panic!("You must supply a timer.")
            }
            Time::Timer(ref t) => t.reset(sleep, new_deadline),
        }
    }
}
