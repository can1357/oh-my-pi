//! Compio-based unix socket connector.

#![allow(dead_code)]

use std::{
    io,
    path::Path,
    sync::Arc,
    task::{Context, Poll},
};

use compio::net::UnixStream;
use http::Uri;
use wreq_rt::rt::compio::{future::SendFuture, io::CompioIO};

use super::BoxConnecting;
use crate::conn::{Connected, Connection, net::io::CompioConnection, tls_info::TlsInfoFactory};

#[derive(Clone)]
pub struct UnixConnector(Arc<Path>);

impl UnixConnector {
    /// Creates a new [`UnixConnector`] for the specified socket path.
    #[inline]
    pub fn new(path: impl Into<Arc<Path>>) -> Self {
        Self(path.into())
    }
}

impl tower::Service<Uri> for UnixConnector {
    type Response = CompioConnection<UnixStream>;
    type Error = io::Error;
    type Future = BoxConnecting<Self::Response>;

    #[inline]
    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _: Uri) -> Self::Future {
        let fut = UnixStream::connect(self.0.clone());
        Box::pin(SendFuture::new(async move {
            let io = fut.await?;
            Ok(CompioConnection {
                peer_addr: None,
                local_addr: None,
                inner: CompioIO::new(io),
            })
        }))
    }
}

impl Connection for CompioConnection<UnixStream> {
    #[inline]
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl TlsInfoFactory for CompioConnection<UnixStream> {}
