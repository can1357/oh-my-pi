//! Tokio-based unix socket connector.

use std::{
    io,
    path::Path,
    sync::Arc,
    task::{Context, Poll},
};

use http::Uri;
use tokio::net::UnixStream;

use super::BoxConnecting;
use crate::conn::{Connected, Connection, tls_info::TlsInfoFactory};

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
    type Response = UnixStream;
    type Error = io::Error;
    type Future = BoxConnecting<Self::Response>;

    #[inline]
    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    #[inline]
    fn call(&mut self, _: Uri) -> Self::Future {
        Box::pin(UnixStream::connect(self.0.clone()))
    }
}

impl Connection for UnixStream {
    #[inline]
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl TlsInfoFactory for UnixStream {}
