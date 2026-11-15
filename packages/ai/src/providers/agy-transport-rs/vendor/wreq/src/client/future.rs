use std::{
    pin::Pin,
    task::{Context, Poll, ready},
};

use http::{Request, Uri};
use pin_project_lite::pin_project;
use tower::util::{Either, Oneshot};

use super::{Body, BoxedClientService, ClientService, Error, Response};

pin_project! {
    /// [`Pending`] is a future representing the state of an HTTP request, which may be either
    /// an in-flight request (with its associated future and URI) or an error state.
    /// Used to drive the HTTP request to completion or report an error.
    #[project = PendingProj]
    pub enum Pending {
        Request {
            uri: Option<Uri>,
            fut: Pin<Box<Oneshot<Either<ClientService, BoxedClientService>, Request<Body>>>>,
        },
        Error {
            error: Option<Error>,
        },
    }
}

impl Future for Pending {
    type Output = Result<Response, Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let (uri, res) = match self.project() {
            PendingProj::Request { uri, fut } => (uri, fut.as_mut().poll(cx)),
            PendingProj::Error { error } => {
                let err = error
                    .take()
                    .expect("Pending::Error polled after completion");
                return Poll::Ready(Err(err));
            }
        };

        let res = ready!(res);
        let uri = uri
            .take()
            .expect("Pending::Request polled after completion");
        let res = match res {
            Ok(res) => Ok(Response::new(res, uri)),
            Err(err) => {
                let mut err = err
                    .downcast::<Error>()
                    .map_or_else(Error::request, |err| *err);
                if err.uri().is_none() {
                    err = err.with_uri(uri);
                }
                Err(err)
            }
        };

        Poll::Ready(res)
    }
}

#[cfg(test)]
mod test {

    #[test]
    fn test_future_size() {
        let s = std::mem::size_of::<super::Pending>();
        assert!(s <= 360, "size_of::<Pending>() == {s}, too big");
    }

    #[tokio::test]
    async fn error_has_url() {
        let u = "http://does.not.exist.local/ever";
        let err = crate::Client::new().get(u).send().await.unwrap_err();
        assert_eq!(err.uri().unwrap(), u, "{err:?}");
    }
}
