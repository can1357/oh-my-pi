//! An SPSC broadcast channel.
//!
//! - The value can only be a `u8`.
//! - The consumer is only notified if the value is different.
//! - The value `0` is reserved for closed.

use std::{
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    task::{self, Poll},
};

use futures_util::task::AtomicWaker;

use crate::Error;

type Value = u8;
const READY: Value = 2;
const PENDING: Value = 1;
const CLOSED: Value = 0;

pub(super) fn channel(wanter: bool) -> (Sender, Receiver) {
    let initial = if wanter { PENDING } else { READY };
    let shared = Arc::new(Shared {
        value: AtomicU8::new(initial),
        waker: AtomicWaker::new(),
    });

    (
        Sender {
            shared: shared.clone(),
        },
        Receiver { shared },
    )
}

struct Shared {
    value: AtomicU8,
    waker: AtomicWaker,
}

pub(super) struct Sender {
    shared: Arc<Shared>,
}

pub(super) struct Receiver {
    shared: Arc<Shared>,
}

// ===== impl Sender =====

impl Sender {
    #[inline(always)]
    pub(super) fn ready(&self) {
        self.send(READY);
    }

    fn send(&self, value: Value) {
        if self.shared.value.swap(value, Ordering::SeqCst) != value {
            self.shared.waker.wake();
        }
    }
}

impl Drop for Sender {
    #[inline(always)]
    fn drop(&mut self) {
        self.send(CLOSED);
    }
}

// ===== impl Receiver =====

impl Receiver {
    #[inline(always)]
    pub(super) fn poll_ready(&self, cx: &mut task::Context<'_>) -> Poll<Result<(), Error>> {
        self.shared.waker.register(cx.waker());
        match self.shared.value.load(Ordering::SeqCst) {
            READY => Poll::Ready(Ok(())),
            PENDING => Poll::Pending,
            CLOSED => Poll::Ready(Err(Error::new_closed())),
            unexpected => unreachable!("watch value: {}", unexpected),
        }
    }
}
