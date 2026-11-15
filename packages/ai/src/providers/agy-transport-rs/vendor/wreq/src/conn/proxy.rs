//! Proxy helpers

#[cfg(feature = "socks")]
pub mod socks;
pub mod tunnel;

use std::{
    marker::PhantomData,
    pin::Pin,
    task::{Context, Poll},
};

use pin_project_lite::pin_project;

pin_project! {
    // Not publicly exported (so missing_docs doesn't trigger).
    //
    // We return this `Future` instead of the `Pin<Box<dyn Future>>` directly
    // so that users don't rely on it fitting in a `Pin<Box<dyn Future>>` slot
    // (and thus we can change the type in the future).
    #[must_use = "futures do nothing unless polled"]
    pub struct Tunneling<Fut, T, E> {
        #[pin]
        fut: Pin<Box<dyn Future<Output = Result<T, E>> + Send>>,
        _marker: PhantomData<Fut>,
    }
}

impl<F, T, E1, E2> Future for Tunneling<F, T, E2>
where
    F: Future<Output = Result<T, E1>>,
{
    type Output = Result<T, E2>;

    #[inline]
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.project().fut.poll(cx)
    }
}
