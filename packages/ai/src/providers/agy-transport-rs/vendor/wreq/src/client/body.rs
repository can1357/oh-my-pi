use std::{
    pin::Pin,
    task::{Context, Poll, ready},
};

use bytes::Bytes;
use http_body::{Body as HttpBody, SizeHint};
use http_body_util::{BodyExt, Either, Full, combinators::BoxBody};
use pin_project_lite::pin_project;

use crate::error::{BoxError, Error};

/// An request body.
#[derive(Debug)]
pub struct Body(Either<Full<Bytes>, BoxBody<Bytes, BoxError>>);

pin_project! {
    /// We can't use `map_frame()` because that loses the hint data (for good reason).
    /// But we aren't transforming the data.
    struct IntoBytesBody<B> {
        #[pin]
        inner: B,
    }
}

// ===== impl Body =====

impl Body {
    /// Wrap a [`HttpBody`] in a box inside `Body`.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::Body;
    /// # use futures_util;
    /// # fn main() {
    /// let content = "hello,world!".to_string();
    ///
    /// let body = Body::wrap(content);
    /// # }
    /// ```
    pub fn wrap<B>(inner: B) -> Body
    where
        B: HttpBody + Send + Sync + 'static,
        B::Data: Into<Bytes>,
        B::Error: Into<BoxError>,
    {
        Body(Either::Right(
            IntoBytesBody { inner }.map_err(Into::into).boxed(),
        ))
    }

    /// Wrap a futures `Stream` in a box inside `Body`.
    ///
    /// # Example
    ///
    /// ```
    /// # use wreq::Body;
    /// # use futures_util;
    /// # fn main() {
    /// let chunks: Vec<Result<_, ::std::io::Error>> = vec![Ok("hello"), Ok(" "), Ok("world")];
    ///
    /// let stream = futures_util::stream::iter(chunks);
    ///
    /// let body = Body::wrap_stream(stream);
    /// # }
    /// ```
    ///
    /// # Optional
    ///
    /// This requires the `stream` feature to be enabled.
    #[cfg(feature = "stream")]
    #[cfg_attr(docsrs, doc(cfg(feature = "stream")))]
    pub fn wrap_stream<S>(stream: S) -> Body
    where
        S: futures_util::stream::TryStream + Send + 'static,
        S::Error: Into<BoxError>,
        Bytes: From<S::Ok>,
    {
        Body::stream(stream)
    }

    #[cfg(any(feature = "stream", feature = "multipart"))]
    pub(crate) fn stream<S>(stream: S) -> Body
    where
        S: futures_util::stream::TryStream + Send + 'static,
        S::Error: Into<BoxError>,
        Bytes: From<S::Ok>,
    {
        use futures_util::TryStreamExt;
        use http_body::Frame;
        use http_body_util::StreamBody;
        use sync_wrapper::SyncStream;

        let body = StreamBody::new(SyncStream::new(
            stream
                .map_ok(Bytes::from)
                .map_ok(Frame::data)
                .map_err(Into::into),
        ));
        Body(Either::Right(body.boxed()))
    }

    #[inline]
    pub(crate) fn empty() -> Body {
        Body::reusable(Bytes::new())
    }

    #[inline]
    pub(crate) fn reusable(chunk: Bytes) -> Body {
        Body(Either::Left(Full::new(chunk)))
    }

    #[inline]
    #[cfg(feature = "multipart")]
    pub(crate) fn content_length(&self) -> Option<u64> {
        self.0.size_hint().exact()
    }

    #[inline]
    pub(crate) fn try_clone(&self) -> Option<Body> {
        match self.0 {
            Either::Left(ref chunk) => Some(Body(Either::Left(chunk.clone()))),
            Either::Right { .. } => None,
        }
    }
}

impl Default for Body {
    #[inline]
    fn default() -> Body {
        Body::empty()
    }
}

impl From<BoxBody<Bytes, BoxError>> for Body {
    #[inline]
    fn from(body: BoxBody<Bytes, BoxError>) -> Self {
        Self(Either::Right(body))
    }
}

impl From<Bytes> for Body {
    #[inline]
    fn from(bytes: Bytes) -> Body {
        Body::reusable(bytes)
    }
}

impl From<Vec<u8>> for Body {
    #[inline]
    fn from(vec: Vec<u8>) -> Body {
        Body::reusable(vec.into())
    }
}

impl From<&'static [u8]> for Body {
    #[inline]
    fn from(s: &'static [u8]) -> Body {
        Body::reusable(Bytes::from_static(s))
    }
}

impl From<String> for Body {
    #[inline]
    fn from(s: String) -> Body {
        Body::reusable(s.into())
    }
}

impl From<&'static str> for Body {
    #[inline]
    fn from(s: &'static str) -> Body {
        s.as_bytes().into()
    }
}

#[cfg(all(feature = "tokio-rt", feature = "stream"))]
impl From<tokio::fs::File> for Body {
    #[inline]
    fn from(file: tokio::fs::File) -> Body {
        Body::wrap_stream(tokio_util::io::ReaderStream::new(file))
    }
}

impl HttpBody for Body {
    type Data = Bytes;
    type Error = Error;

    #[inline(always)]
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.0).poll_frame(cx).map_err(|err| {
            err.downcast::<Error>()
                .map_or_else(Error::request, |err| *err)
        })
    }

    #[inline(always)]
    fn size_hint(&self) -> SizeHint {
        self.0.size_hint()
    }

    #[inline(always)]
    fn is_end_stream(&self) -> bool {
        self.0.is_end_stream()
    }
}

// ===== impl IntoBytesBody =====

impl<B> HttpBody for IntoBytesBody<B>
where
    B: HttpBody,
    B::Data: Into<Bytes>,
{
    type Data = Bytes;
    type Error = B::Error;

    #[inline(always)]
    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context,
    ) -> Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        match ready!(self.project().inner.poll_frame(cx)) {
            Some(Ok(f)) => Poll::Ready(Some(Ok(f.map_data(Into::into)))),
            Some(Err(e)) => Poll::Ready(Some(Err(e))),
            None => Poll::Ready(None),
        }
    }

    #[inline(always)]
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }

    #[inline(always)]
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
}

#[cfg(test)]
mod tests {
    use http_body::Body as _;

    use super::Body;

    #[test]
    fn body_exact_length() {
        let empty_body = Body::empty();
        assert!(empty_body.is_end_stream());
        assert_eq!(empty_body.size_hint().exact(), Some(0));

        let bytes_body = Body::reusable("abc".into());
        assert!(!bytes_body.is_end_stream());
        assert_eq!(bytes_body.size_hint().exact(), Some(3));

        // can delegate even when wrapped
        let stream_body = Body::wrap(empty_body);
        assert!(stream_body.is_end_stream());
        assert_eq!(stream_body.size_hint().exact(), Some(0));
    }
}
