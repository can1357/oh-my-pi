// This module contains the `GaiResolver` implementation for the `compio` runtime.

use std::{
    future::Future,
    io,
    net::ToSocketAddrs,
    pin::Pin,
    task::{self, Poll},
};

use tower::Service;

use super::{GaiAddrs, GaiResolver};
use crate::dns::{Addrs, Name, Resolve, Resolving, SocketAddrs};

/// A future to resolve a name returned by `GaiResolver`.
pub struct GaiFuture {
    inner: compio::runtime::JoinHandle<Result<SocketAddrs, io::Error>>,
}

// ==== impl GaiResolver ====

impl GaiResolver {
    /// Creates a new [`GaiResolver`].
    pub fn new() -> Self {
        GaiResolver { _priv: () }
    }
}

impl Service<Name> for GaiResolver {
    type Response = GaiAddrs;
    type Error = io::Error;
    type Future = GaiFuture;

    #[inline]
    fn poll_ready(&mut self, _cx: &mut task::Context<'_>) -> Poll<Result<(), io::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, name: Name) -> Self::Future {
        let blocking = compio::runtime::spawn_blocking(move || {
            debug!("resolving {}", name);
            (name.as_str(), 0)
                .to_socket_addrs()
                .map(|i| SocketAddrs::new(i.collect()))
        });
        GaiFuture { inner: blocking }
    }
}

impl Resolve for GaiResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let mut this = self.clone();
        Box::pin(async move {
            this.call(name)
                .await
                .map(|addrs| Box::new(addrs) as Addrs)
                .map_err(Into::into)
        })
    }
}

// ==== impl GaiFuture ====

impl Future for GaiFuture {
    type Output = Result<GaiAddrs, io::Error>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut task::Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.inner).poll(cx).map(|res| match res {
            Ok(Ok(addrs)) => Ok(GaiAddrs { inner: addrs }),
            Ok(Err(err)) => Err(err),
            Err(join_err) => Err(io::Error::other(format!(
                "DNS resolution blocked task panicked: {join_err}"
            ))),
        })
    }
}
