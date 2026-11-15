use super::AsyncConnWithInfo;

/// Controls whether to enable verbose tracing for connections.
///
/// When enabled (with the `tracing` feature), connections are wrapped to log I/O operations for
/// debugging.
#[derive(Clone, Copy)]
pub struct Verbose(pub(super) bool);

impl Verbose {
    pub const OFF: Verbose = Verbose(false);

    #[cfg_attr(not(feature = "tracing"), inline(always))]
    pub(super) fn wrap<T>(&self, conn: T) -> Box<dyn AsyncConnWithInfo>
    where
        T: AsyncConnWithInfo + 'static,
    {
        #[cfg(feature = "tracing")]
        if self.0 {
            return Box::new(sealed::Wrapper {
                id: crate::util::fast_random(),
                inner: conn,
            });
        }

        Box::new(conn)
    }
}

#[cfg(feature = "tracing")]
mod sealed {
    use std::{
        fmt,
        io::{self, IoSlice},
        pin::Pin,
        task::{Context, Poll},
    };

    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    use super::super::{Connected, Connection, TlsInfoFactory};
    use crate::{tls::TlsInfo, util::Escape};

    pub(super) struct Wrapper<T> {
        pub(super) id: u64,
        pub(super) inner: T,
    }

    impl<T: Connection + AsyncRead + AsyncWrite + Unpin> Connection for Wrapper<T> {
        #[inline]
        fn connected(&self) -> Connected {
            self.inner.connected()
        }
    }

    impl<T: AsyncRead + AsyncWrite + Unpin> AsyncRead for Wrapper<T> {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            match Pin::new(&mut self.inner).poll_read(cx, buf) {
                Poll::Ready(Ok(())) => {
                    trace!("{:08x} read: {:?}", self.id, Escape::new(buf.filled()));
                    Poll::Ready(Ok(()))
                }
                Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                Poll::Pending => Poll::Pending,
            }
        }
    }

    impl<T: AsyncRead + AsyncWrite + Unpin> AsyncWrite for Wrapper<T> {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            match Pin::new(&mut self.inner).poll_write(cx, buf) {
                Poll::Ready(Ok(n)) => {
                    trace!("{:08x} write: {:?}", self.id, Escape::new(&buf[..n]));
                    Poll::Ready(Ok(n))
                }
                Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                Poll::Pending => Poll::Pending,
            }
        }

        fn poll_write_vectored(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            bufs: &[IoSlice<'_>],
        ) -> Poll<io::Result<usize>> {
            match Pin::new(&mut self.inner).poll_write_vectored(cx, bufs) {
                Poll::Ready(Ok(nwritten)) => {
                    trace!(
                        "{:08x} write (vectored): {:?}",
                        self.id,
                        Vectored { bufs, nwritten }
                    );
                    Poll::Ready(Ok(nwritten))
                }
                Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                Poll::Pending => Poll::Pending,
            }
        }

        #[inline]
        fn is_write_vectored(&self) -> bool {
            self.inner.is_write_vectored()
        }

        #[inline]
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }

        #[inline]
        fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    impl<T: TlsInfoFactory> TlsInfoFactory for Wrapper<T> {
        fn tls_info(&self) -> Option<TlsInfo> {
            self.inner.tls_info()
        }
    }

    struct Vectored<'a, 'b> {
        bufs: &'a [IoSlice<'b>],
        nwritten: usize,
    }

    impl fmt::Debug for Vectored<'_, '_> {
        fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
            let mut left = self.nwritten;
            for buf in self.bufs.iter() {
                if left == 0 {
                    break;
                }
                let n = std::cmp::min(left, buf.len());
                Escape::new(&buf[..n]).fmt(f)?;
                left -= n;
            }
            Ok(())
        }
    }
}
