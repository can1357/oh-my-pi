//! HTTP Upgrades
//!
//! This module deals with managing [HTTP Upgrades][mdn] in crate::core:. Since
//! several concepts in HTTP allow for first talking HTTP, and then converting
//! to a different protocol, this module conflates them into a single API.
//! Those include:
//!
//! - HTTP/1.1 Upgrades
//! - HTTP `CONNECT`
//!
//! You are responsible for any other pre-requisites to establish an upgrade,
//! such as sending the appropriate headers, methods, and status codes. You can
//! then use [`on`][] to grab a `Future` which will resolve to the upgraded
//! connection object, or an error if the upgrade fails.
//!
//! [mdn]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Protocol_upgrade_mechanism
//!
//! Sending an HTTP upgrade from the client involves setting
//! either the appropriate method, if wanting to `CONNECT`, or headers such as
//! `Upgrade` and `Connection`, on the `http::Request`. Once receiving the
//! `http::Response` back, you must check for the specific information that the
//! upgrade is agreed upon by the server (such as a `101` status code), and then
//! get the `Future` from the `Response`.

use std::{
    error::Error as StdError,
    fmt,
    future::Future,
    io,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
};

use bytes::Bytes;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::oneshot,
};

use self::rewind::Rewind;
use super::{Error, Result};
use crate::lock::LockResultExt;

/// An upgraded HTTP connection.
///
/// This type holds a trait object internally of the original IO that
/// was used to speak HTTP before the upgrade. It can be used directly
/// as a [`AsyncRead`] or [`AsyncWrite`] for convenience.
///
/// Alternatively, if the exact type is known, this can be deconstructed
/// into its parts.
pub struct Upgraded {
    io: Rewind<Box<dyn Io + Send>>,
}

/// A future for a possible HTTP upgrade.
///
/// If no upgrade was available, or it doesn't succeed, yields an `Error`.
#[derive(Clone)]
pub struct OnUpgrade {
    rx: Option<Arc<Mutex<oneshot::Receiver<Result<Upgraded>>>>>,
}

/// Gets a pending HTTP upgrade from this message.
///
/// This can be called on the following types:
///
/// - `http::Request<B>`
/// - `http::Response<B>`
/// - `&mut http::Request<B>`
/// - `&mut http::Response<B>`
#[inline]
pub fn on<T: sealed::CanUpgrade>(msg: T) -> OnUpgrade {
    msg.on_upgrade()
}

pub(crate) struct Pending {
    tx: oneshot::Sender<Result<Upgraded>>,
}

pub(crate) fn pending() -> (Pending, OnUpgrade) {
    let (tx, rx) = oneshot::channel();
    (
        Pending { tx },
        OnUpgrade {
            rx: Some(Arc::new(Mutex::new(rx))),
        },
    )
}

// ===== impl Upgraded =====

impl Upgraded {
    #[inline]
    pub(crate) fn new<T>(io: T, read_buf: Bytes) -> Self
    where
        T: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        Upgraded {
            io: Rewind::new_buffered(Box::new(io), read_buf),
        }
    }
}

impl AsyncRead for Upgraded {
    #[inline]
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for Upgraded {
    #[inline]
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    #[inline]
    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.io).poll_write_vectored(cx, bufs)
    }

    #[inline]
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    #[inline]
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }

    #[inline]
    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }
}

impl fmt::Debug for Upgraded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Upgraded").finish()
    }
}

// ===== impl OnUpgrade =====

impl OnUpgrade {
    #[inline]
    pub(super) fn none() -> Self {
        OnUpgrade { rx: None }
    }

    #[inline]
    pub(super) fn is_none(&self) -> bool {
        self.rx.is_none()
    }
}

impl Future for OnUpgrade {
    type Output = Result<Upgraded, Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match self.rx {
            Some(ref rx) => Pin::new(&mut *rx.lock().panic_if_poisoned())
                .poll(cx)
                .map(|res| match res {
                    Ok(Ok(upgraded)) => Ok(upgraded),
                    Ok(Err(err)) => Err(err),
                    Err(_oneshot_canceled) => Err(Error::new_canceled().with(UpgradeExpected)),
                }),
            None => Poll::Ready(Err(Error::new_user_no_upgrade())),
        }
    }
}

// ===== impl Pending =====

impl Pending {
    #[inline]
    pub(super) fn fulfill(self, upgraded: Upgraded) {
        trace!("pending upgrade fulfill");
        let _ = self.tx.send(Ok(upgraded));
    }

    /// Don't fulfill the pending Upgrade, but instead signal that
    /// upgrades are handled manually.
    #[inline]
    pub(super) fn manual(self) {
        trace!("pending upgrade handled manually");
        let _ = self.tx.send(Err(Error::new_user_manual_upgrade()));
    }
}

// ===== impl UpgradeExpected =====

/// Error cause returned when an upgrade was expected but canceled
/// for whatever reason.
///
/// This likely means the actual `Conn` future wasn't polled and upgraded.
#[derive(Debug)]
struct UpgradeExpected;

impl fmt::Display for UpgradeExpected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("upgrade expected but not completed")
    }
}

impl StdError for UpgradeExpected {}

// ===== impl Io =====

trait Io: AsyncRead + AsyncWrite + Unpin + 'static {}

impl<T: AsyncRead + AsyncWrite + Unpin + 'static> Io for T {}

mod sealed {
    use super::OnUpgrade;

    pub trait CanUpgrade {
        fn on_upgrade(self) -> OnUpgrade;
    }

    impl<B> CanUpgrade for http::Request<B> {
        fn on_upgrade(mut self) -> OnUpgrade {
            self.extensions_mut()
                .remove::<OnUpgrade>()
                .unwrap_or_else(OnUpgrade::none)
        }
    }

    impl<B> CanUpgrade for &'_ mut http::Request<B> {
        fn on_upgrade(self) -> OnUpgrade {
            self.extensions_mut()
                .remove::<OnUpgrade>()
                .unwrap_or_else(OnUpgrade::none)
        }
    }

    impl<B> CanUpgrade for http::Response<B> {
        fn on_upgrade(mut self) -> OnUpgrade {
            self.extensions_mut()
                .remove::<OnUpgrade>()
                .unwrap_or_else(OnUpgrade::none)
        }
    }

    impl<B> CanUpgrade for &'_ mut http::Response<B> {
        fn on_upgrade(self) -> OnUpgrade {
            self.extensions_mut()
                .remove::<OnUpgrade>()
                .unwrap_or_else(OnUpgrade::none)
        }
    }
}

mod rewind {
    use std::{
        cmp, io,
        pin::Pin,
        task::{Context, Poll},
    };

    use bytes::{Buf, Bytes};
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    /// Combine a buffer with an IO, rewinding reads to use the buffer.
    #[derive(Debug)]
    pub(crate) struct Rewind<T> {
        pre: Option<Bytes>,
        inner: T,
    }

    impl<T> Rewind<T> {
        #[inline]
        pub(crate) fn new_buffered(io: T, buf: Bytes) -> Self {
            Rewind {
                pre: Some(buf),
                inner: io,
            }
        }

        #[cfg(test)]
        pub(crate) fn rewind(&mut self, bs: Bytes) {
            debug_assert!(self.pre.is_none());
            self.pre = Some(bs);
        }
    }

    impl<T> AsyncRead for Rewind<T>
    where
        T: AsyncRead + Unpin,
    {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            if let Some(mut prefix) = self.pre.take() {
                // If there are no remaining bytes, let the bytes get dropped.
                if !prefix.is_empty() {
                    let copy_len = cmp::min(prefix.len(), buf.remaining());
                    // TODO: There should be a way to do following two lines cleaner...
                    buf.put_slice(&prefix[..copy_len]);
                    prefix.advance(copy_len);
                    // Put back what's left
                    if !prefix.is_empty() {
                        self.pre = Some(prefix);
                    }

                    return Poll::Ready(Ok(()));
                }
            }
            Pin::new(&mut self.inner).poll_read(cx, buf)
        }
    }

    impl<T> AsyncWrite for Rewind<T>
    where
        T: AsyncWrite + Unpin,
    {
        #[inline]
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write(cx, buf)
        }

        #[inline]
        fn poll_write_vectored(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bufs: &[io::IoSlice<'_>],
        ) -> Poll<io::Result<usize>> {
            Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
        }

        #[inline]
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }

        #[inline]
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }

        #[inline]
        fn is_write_vectored(&self) -> bool {
            self.inner.is_write_vectored()
        }
    }

    #[cfg(test)]
    mod tests {
        use bytes::Bytes;
        use tokio::io::AsyncReadExt;

        use super::Rewind;

        #[tokio::test]
        async fn partial_rewind() {
            let underlying = [104, 101, 108, 108, 111];

            let mock = tokio_test::io::Builder::new().read(&underlying).build();

            let mut stream = Rewind::new_buffered(mock, Bytes::new());

            // Read off some bytes, ensure we filled o1
            let mut buf = [0; 2];
            stream.read_exact(&mut buf).await.expect("read1");

            // Rewind the stream so that it is as if we never read in the first place.
            stream.rewind(Bytes::copy_from_slice(&buf[..]));

            let mut buf = [0; 5];
            stream.read_exact(&mut buf).await.expect("read1");

            // At this point we should have read everything that was in the MockStream
            assert_eq!(&buf, &underlying);
        }

        #[tokio::test]
        async fn full_rewind() {
            let underlying = [104, 101, 108, 108, 111];

            let mock = tokio_test::io::Builder::new().read(&underlying).build();

            let mut stream = Rewind::new_buffered(mock, Bytes::new());

            let mut buf = [0; 5];
            stream.read_exact(&mut buf).await.expect("read1");

            // Rewind the stream so that it is as if we never read in the first place.
            stream.rewind(Bytes::copy_from_slice(&buf[..]));

            let mut buf = [0; 5];
            stream.read_exact(&mut buf).await.expect("read1");

            assert_eq!(&buf, &underlying);
        }
    }
}
