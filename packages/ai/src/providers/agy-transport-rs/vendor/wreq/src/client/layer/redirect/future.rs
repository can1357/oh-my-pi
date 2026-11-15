use std::{
    future::Future,
    pin::Pin,
    str,
    task::{Context, Poll, ready},
};

use futures_util::future::Either;
use http::{
    HeaderMap, Method, Request, Response, StatusCode, Uri,
    header::{CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, TRANSFER_ENCODING},
};
use pin_project_lite::pin_project;
use tower::{BoxError, Service, util::Oneshot};
use url::Url;

use super::{
    BodyRepr,
    policy::{Action, Attempt},
};
use crate::{Body, ext::RequestUri, into_uri::IntoUriSealed, redirect::FollowRedirectPolicy};

/// Pending future state for handling redirects.
pub struct Pending<Response> {
    future: Pin<Box<dyn Future<Output = Action> + Send>>,
    location: Uri,
    body: Body,
    res: Response,
}

pin_project! {
    /// Response future for [`FollowRedirect`].
    #[project = ResponseFutureProj]
    pub enum ResponseFuture<S>
    where
        S: Service<Request<Body>>,
    {
        Redirect {
            #[pin]
            future: Either<S::Future, Oneshot<S, Request<Body>>>,
            pending_future: Option<Pending<S::Response>>,
            service: S,
            policy: FollowRedirectPolicy,
            request: Request<()>,
            body_repr: BodyRepr<Body>,
        },

        Direct {
            #[pin]
            future: S::Future,
        },
    }
}

impl<S, B> Future for ResponseFuture<S>
where
    S: Service<Request<Body>, Response = Response<B>> + Clone,
    S::Error: From<BoxError>,
{
    type Output = Result<Response<B>, S::Error>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match self.project() {
            ResponseFutureProj::Direct { mut future } => future.as_mut().poll(cx),
            ResponseFutureProj::Redirect {
                mut future,
                pending_future,
                service,
                policy,
                request,
                body_repr,
            } => {
                // Check if we have a pending action to resolve
                if let Some(mut state) = pending_future.take() {
                    let action = match state.future.as_mut().poll(cx) {
                        Poll::Ready(action) => action,
                        Poll::Pending => {
                            *pending_future = Some(state);
                            return Poll::Pending;
                        }
                    };

                    return handle_action(
                        cx,
                        RedirectAction {
                            action,
                            future: &mut future,
                            service,
                            policy,
                            request,
                            body: state.body,
                            body_repr,
                            res: state.res,
                            location: state.location,
                        },
                    );
                }

                // Poll the current future to get the response
                let mut res = {
                    let mut res = ready!(future.as_mut().poll(cx)?);
                    res.extensions_mut()
                        .insert(RequestUri(request.uri().clone()));
                    res
                };

                // Determine if the response is a redirect
                match res.status() {
                    StatusCode::MOVED_PERMANENTLY | StatusCode::FOUND => {
                        // User agents MAY change the request method from POST to GET
                        // (RFC 7231 section 6.4.2. and 6.4.3.).
                        if request.method() == Method::POST {
                            *request.method_mut() = Method::GET;
                            *body_repr = BodyRepr::Empty;
                            drop_payload_headers(request.headers_mut());
                        }
                    }
                    StatusCode::SEE_OTHER => {
                        // A user agent can perform a GET or HEAD request (RFC 7231 section 6.4.4.).
                        if request.method() != Method::HEAD {
                            *request.method_mut() = Method::GET;
                        }
                        *body_repr = BodyRepr::Empty;
                        drop_payload_headers(request.headers_mut());
                    }
                    StatusCode::TEMPORARY_REDIRECT | StatusCode::PERMANENT_REDIRECT => {}
                    _ => {
                        // Not a redirect status code, return the response as is.
                        policy.on_response(&mut res);
                        return Poll::Ready(Ok(res));
                    }
                };

                // Extract the request body for potential reuse
                let Some(body) = body_repr.take() else {
                    return Poll::Ready(Ok(res));
                };

                // Get and resolve the Location header
                let Some(location) = res
                    .headers()
                    .get(LOCATION)
                    .and_then(|loc| std::str::from_utf8(loc.as_bytes()).ok())
                    .and_then(|loc| resolve_uri(loc, request.uri()))
                else {
                    return Poll::Ready(Ok(res));
                };

                // Prepare the attempt for the policy decision
                let attempt = Attempt {
                    status: res.status(),
                    headers: res.headers(),
                    location: &location,
                    previous: request.uri(),
                };

                // Resolve the action, awaiting if it's pending
                let action = match policy.redirect(attempt)? {
                    Action::Pending(future) => {
                        // Save the task and necessary state for next poll
                        *pending_future = Some(Pending {
                            future,
                            location,
                            body,
                            res,
                        });
                        cx.waker().wake_by_ref();
                        return Poll::Pending;
                    }
                    action => action,
                };

                handle_action(
                    cx,
                    RedirectAction {
                        action,
                        future: &mut future,
                        service,
                        policy,
                        request,
                        body,
                        body_repr,
                        res,
                        location,
                    },
                )
            }
        }
    }
}

/// Try to resolve a URI reference `relative` against a base URI `base`.
fn resolve_uri(relative: &str, base: &Uri) -> Option<Uri> {
    Url::parse(&base.to_string())
        .ok()?
        .join(relative)
        .map(String::from)
        .ok()?
        .into_uri()
        .ok()
}

/// Handle the response based on its status code
fn drop_payload_headers(headers: &mut HeaderMap) {
    for header in &[
        CONTENT_TYPE,
        CONTENT_LENGTH,
        CONTENT_ENCODING,
        TRANSFER_ENCODING,
    ] {
        headers.remove(header);
    }
}

type RedirectFuturePin<'a, S> =
    Pin<&'a mut Either<<S as Service<Request<Body>>>::Future, Oneshot<S, Request<Body>>>>;

struct RedirectAction<'a, S, B>
where
    S: Service<Request<Body>, Response = Response<B>> + Clone,
{
    action: Action,
    future: &'a mut RedirectFuturePin<'a, S>,
    service: &'a S,
    policy: &'a mut FollowRedirectPolicy,
    request: &'a mut Request<()>,
    body: Body,
    body_repr: &'a mut BodyRepr<Body>,
    res: Response<B>,
    location: Uri,
}

fn handle_action<S, B>(
    cx: &mut Context<'_>,
    redirect: RedirectAction<'_, S, B>,
) -> Poll<Result<Response<B>, S::Error>>
where
    S: Service<Request<Body>, Response = Response<B>> + Clone,
    S::Error: From<BoxError>,
{
    match redirect.action {
        Action::Follow => {
            *redirect.request.uri_mut() = redirect.location;
            redirect.body_repr.try_clone_from(&redirect.body);
            redirect.policy.on_request(redirect.request);

            redirect.future.set(Either::Right(Oneshot::new(
                redirect.service.clone(),
                redirect.request.clone().map(|_| redirect.body),
            )));

            cx.waker().wake_by_ref();
            Poll::Pending
        }
        Action::Stop => Poll::Ready(Ok(redirect.res)),
        Action::Error(err) => Poll::Ready(Err(err.into())),
        Action::Pending(_) => unreachable!(),
    }
}
