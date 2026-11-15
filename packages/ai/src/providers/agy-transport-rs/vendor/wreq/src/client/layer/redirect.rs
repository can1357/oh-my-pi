//! Middleware for following redirections.

mod future;
mod policy;

use std::{
    mem,
    task::{Context, Poll},
};

use futures_util::future::Either;
use http::{Request, Response};
use http_body::Body as HttpBody;
use tower::{BoxError, Layer, Service};

use self::future::ResponseFuture;
pub use self::policy::{Action, Attempt};
use crate::{client::body::Body, redirect::FollowRedirectPolicy};

enum BodyRepr<B> {
    Some(B),
    Empty,
    None,
}

impl BodyRepr<Body> {
    fn take(&mut self) -> Option<Body> {
        match mem::replace(self, BodyRepr::None) {
            BodyRepr::Some(body) => Some(body),
            BodyRepr::Empty => {
                *self = BodyRepr::Empty;
                Some(Body::default())
            }
            BodyRepr::None => None,
        }
    }

    fn try_clone_from(&mut self, body: &Body) {
        match self {
            BodyRepr::Some(_) | BodyRepr::Empty => {}
            BodyRepr::None => {
                if body.size_hint().exact() == Some(0) {
                    *self = BodyRepr::Some(Body::default());
                } else if let Some(cloned) = body.try_clone() {
                    *self = BodyRepr::Some(cloned);
                }
            }
        }
    }
}

/// [`Layer`] for retrying requests with a [`Service`] to follow redirection responses.
#[derive(Clone)]
pub struct FollowRedirectLayer {
    policy: FollowRedirectPolicy,
}

impl FollowRedirectLayer {
    /// Create a new [`FollowRedirectLayer`] with the given redirection policy.
    #[inline(always)]
    pub(crate) fn with_policy(policy: FollowRedirectPolicy) -> Self {
        FollowRedirectLayer { policy }
    }
}

impl<S> Layer<S> for FollowRedirectLayer
where
    S: Clone,
{
    type Service = FollowRedirect<S>;

    #[inline(always)]
    fn layer(&self, inner: S) -> Self::Service {
        FollowRedirect::with_policy(inner, self.policy.clone())
    }
}

/// Middleware that retries requests with a [`Service`] to follow redirection responses.
#[derive(Clone)]
pub struct FollowRedirect<S> {
    inner: S,
    policy: FollowRedirectPolicy,
}

impl<S> FollowRedirect<S> {
    /// Create a new [`FollowRedirect`] with the given redirection policy.
    #[inline(always)]
    fn with_policy(inner: S, policy: FollowRedirectPolicy) -> Self {
        FollowRedirect { inner, policy }
    }
}

impl<ResBody, S> Service<Request<Body>> for FollowRedirect<S>
where
    S: Service<Request<Body>, Response = Response<ResBody>> + Clone,
    S::Error: From<BoxError>,
{
    type Response = Response<ResBody>;
    type Error = S::Error;
    type Future = ResponseFuture<S>;

    #[inline(always)]
    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, mut req: Request<Body>) -> Self::Future {
        let Some(mut policy) = self.policy.for_request(&mut req) else {
            return ResponseFuture::Direct {
                future: self.inner.call(req),
            };
        };

        let service = self.inner.clone();
        let mut service = mem::replace(&mut self.inner, service);

        let mut body_repr = BodyRepr::None;
        body_repr.try_clone_from(req.body());

        policy.on_request(&mut req);
        let (parts, body) = req.into_parts();
        let request = Request::from_parts(parts, ());
        ResponseFuture::Redirect {
            future: Either::Left(service.call(request.clone().map(|_| body))),
            pending_future: None,
            service,
            policy,
            request,
            body_repr,
        }
    }
}
