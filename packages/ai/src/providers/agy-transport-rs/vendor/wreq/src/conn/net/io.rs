//! I/O types and utilities for network connections.

#![cfg(feature = "compio-rt")]

use std::{
    io,
    net::SocketAddr,
    pin::Pin,
    task::{Context, Poll, ready},
};

use compio::io::{AsyncRead, AsyncWrite, util::Splittable};
use wreq_rt::rt::compio::io::CompioIO;

/// [`compio`] with peer and local socket addresses.
#[derive(Debug)]
pub struct CompioConnection<T: Splittable> {
    pub(super) inner: CompioIO<T>,
    pub(super) peer_addr: Option<SocketAddr>,
    pub(super) local_addr: Option<SocketAddr>,
}

// ===== impl CompioConnection =====

impl<S> tokio::io::AsyncRead for CompioConnection<S>
where
    S: Splittable + 'static,
    S::ReadHalf: AsyncRead + Unpin,
    S::WriteHalf: AsyncWrite + Unpin,
{
    #[inline(always)]
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Flush any buffered writes before reading. This is necessary
        // because code like hyper_util::rt::write_all (used by Tunnel
        // and SOCKS handshakes) and hyper's own body encoder may call
        // poll_write without poll_flush, leaving data buffered in
        // compio's AsyncWriteStream. Since HTTP/1.1 is half-duplex
        // (write then read), flushing here ensures the remote peer
        // receives our data before we wait for its response.
        // In HTTP/2 the stream is split, so this combined poll_read
        // is not called and concurrent reads/writes are unaffected.
        ready!(tokio::io::AsyncWrite::poll_flush(self.as_mut(), cx))?;
        Pin::new(&mut self.get_mut().inner).poll_read(cx, buf)
    }
}

impl<S> tokio::io::AsyncWrite for CompioConnection<S>
where
    S: Splittable + 'static,
    S::ReadHalf: AsyncRead + Unpin,
    S::WriteHalf: AsyncWrite + Unpin,
{
    #[inline(always)]
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }

    #[inline(always)]
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    #[inline(always)]
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}
