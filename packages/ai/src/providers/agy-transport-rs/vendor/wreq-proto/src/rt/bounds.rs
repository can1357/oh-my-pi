//! Trait aliases
//!
//! Traits in this module ease setting bounds and usually automatically
//! implemented by implementing another trait.

pub use self::h2_client::Http2ClientConnExec;

mod h2_client {
    use std::future::Future;

    use tokio::io::{AsyncRead, AsyncWrite};

    use crate::{error::BoxError, proto::http2::client::H2ClientFuture, rt::Executor};

    /// An executor to spawn http2 futures for the client.
    ///
    /// This trait is implemented for any type that implements [`Executor`]
    /// trait for any future.
    ///
    /// This trait is sealed and cannot be implemented for types outside this crate.
    pub trait Http2ClientConnExec<B, T>: sealed_client::Sealed<(B, T)>
    where
        B: http_body::Body,
        B::Error: Into<BoxError>,
        T: AsyncRead + AsyncWrite + Unpin,
    {
        #[doc(hidden)]
        fn execute_h2_future(&mut self, future: H2ClientFuture<B, T>);
    }

    impl<E, B, T> Http2ClientConnExec<B, T> for E
    where
        E: Executor<H2ClientFuture<B, T>>,
        B: http_body::Body + 'static,
        B::Error: Into<BoxError>,
        H2ClientFuture<B, T>: Future<Output = ()>,
        T: AsyncRead + AsyncWrite + Unpin,
    {
        #[inline]
        fn execute_h2_future(&mut self, future: H2ClientFuture<B, T>) {
            self.execute(future)
        }
    }

    impl<E, B, T> sealed_client::Sealed<(B, T)> for E
    where
        E: Executor<H2ClientFuture<B, T>>,
        B: http_body::Body + 'static,
        B::Error: Into<BoxError>,
        H2ClientFuture<B, T>: Future<Output = ()>,
        T: AsyncRead + AsyncWrite + Unpin,
    {
    }

    mod sealed_client {
        pub trait Sealed<X> {}
    }
}
