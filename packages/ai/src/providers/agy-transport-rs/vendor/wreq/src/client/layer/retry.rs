//! Middleware for retrying requests.

mod classify;
mod scope;

use std::{error::Error as StdError, future::Ready, sync::Arc, time::Duration};

use http::{Request, Response};
use tower::{
    BoxError,
    retry::{
        Policy,
        budget::{Budget, TpsBudget},
    },
};
use wreq_proto::body::Incoming;

pub(crate) use self::{
    classify::{Action, Classifier, ClassifyFn, ReqRep},
    scope::{ScopeFn, Scoped},
};
use crate::{Body, retry};

/// A retry policy for HTTP requests.
#[derive(Clone)]
pub struct RetryPolicy {
    budget: Option<Arc<TpsBudget>>,
    classifier: Classifier,
    max_retries_per_request: u32,
    retry_cnt: u32,
    scope: Scoped,
}

impl RetryPolicy {
    /// Create a new `RetryPolicy`.
    #[inline]
    pub fn new(policy: retry::Policy) -> Self {
        Self {
            budget: policy
                .budget
                .map(|budget| Arc::new(TpsBudget::new(Duration::from_secs(10), 10, budget))),
            classifier: policy.classifier,
            max_retries_per_request: policy.max_retries_per_request,
            retry_cnt: 0,
            scope: policy.scope,
        }
    }
}

type Req = Request<Body>;

type Res = Response<Incoming>;

impl Policy<Req, Res, BoxError> for RetryPolicy {
    type Future = Ready<()>;

    fn retry(&mut self, req: &mut Req, result: &mut Result<Res, BoxError>) -> Option<Self::Future> {
        match self.classifier.classify(req, result) {
            Action::Success => {
                trace!(
                    "Request successful, no retry needed: {} {}",
                    req.method(),
                    req.uri()
                );

                if let Some(ref budget) = self.budget {
                    budget.deposit();
                    trace!("Token deposited back to retry budget");
                }
                None
            }
            Action::Retryable => {
                if self.budget.as_ref().map(|b| b.withdraw()).unwrap_or(true) {
                    self.retry_cnt += 1;

                    trace!(
                        "Retrying request ({}/{} attempts): {} {} - {}",
                        self.retry_cnt,
                        self.max_retries_per_request,
                        req.method(),
                        req.uri(),
                        match result {
                            Ok(res) => format!("HTTP {}", res.status()),
                            Err(e) => format!("Error: {}", e),
                        }
                    );

                    Some(std::future::ready(()))
                } else {
                    debug!(
                        "Request is retryable but retry budget exhausted: {} {}",
                        req.method(),
                        req.uri()
                    );
                    None
                }
            }
        }
    }

    fn clone_request(&mut self, req: &Req) -> Option<Req> {
        if self.retry_cnt > 0 && !self.scope.applies_to(req) {
            trace!("not in scope, not retrying");
            return None;
        }

        if self.retry_cnt >= self.max_retries_per_request {
            trace!("max_retries_per_request hit");
            return None;
        }

        let body = req.body().try_clone()?;
        let mut new = http::Request::new(body);
        *new.method_mut() = req.method().clone();
        *new.uri_mut() = req.uri().clone();
        *new.version_mut() = req.version();
        *new.headers_mut() = req.headers().clone();
        *new.extensions_mut() = req.extensions().clone();

        Some(new)
    }
}

/// Determines whether the given error is considered retryable for HTTP/2 requests.
///
/// Returns `true` if the error type or content indicates that the request can be retried,
/// otherwise returns `false`.
fn is_retryable_error(err: &(dyn StdError + 'static)) -> bool {
    let err = if let Some(err) = err.source() {
        err
    } else {
        return false;
    };

    if let Some(cause) = err.source()
        && let Some(err) = cause.downcast_ref::<http2::Error>()
    {
        // They sent us a graceful shutdown, try with a new connection!
        if err.is_go_away() && err.is_remote() && err.reason() == Some(http2::Reason::NO_ERROR) {
            return true;
        }

        // REFUSED_STREAM was sent from the server, which is safe to retry.
        // https://www.rfc-editor.org/rfc/rfc9113.html#section-8.7-3.2
        if err.is_reset() && err.is_remote() && err.reason() == Some(http2::Reason::REFUSED_STREAM)
        {
            return true;
        }
    }
    false
}
