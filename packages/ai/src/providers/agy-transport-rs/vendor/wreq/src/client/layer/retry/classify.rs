use std::{error::Error as StdError, sync::Arc};

use http::{Method, StatusCode, Uri};

use super::{Req, Res};
use crate::error::BoxError;

pub trait Classify: Send + Sync + 'static {
    fn classify(&self, req_rep: ReqRep<'_>) -> Action;
}

// For Future Whoever: making a blanket impl for any closure sounds nice,
// but it causes inference issues at the call site. Every closure would
// need to include `: ReqRep` in the arguments.
//
// An alternative is to make things like `ClassifyFn`. Slightly more
// annoying, but also more forwards-compatible. :shrug:
pub struct ClassifyFn<F>(pub(crate) F);

impl<F> Classify for ClassifyFn<F>
where
    F: Fn(ReqRep<'_>) -> Action + Send + Sync + 'static,
{
    fn classify(&self, req_rep: ReqRep<'_>) -> Action {
        (self.0)(req_rep)
    }
}

/// Represents a request-response pair for classification purposes.
#[derive(Debug)]
pub struct ReqRep<'a>(&'a Req, Result<StatusCode, &'a BoxError>);

impl ReqRep<'_> {
    /// Returns the HTTP method of the request.
    pub fn method(&self) -> &Method {
        self.0.method()
    }

    /// Returns the URI of the request.
    pub fn uri(&self) -> &Uri {
        self.0.uri()
    }

    /// Returns the HTTP status code if the response was successful.
    pub fn status(&self) -> Option<StatusCode> {
        self.1.ok()
    }

    /// Returns the error if the request failed.
    pub fn error(&self) -> Option<&(dyn StdError + 'static)> {
        self.1.as_ref().err().map(|&e| &**e as _)
    }

    /// Returns a retryable action.
    pub fn retryable(self) -> Action {
        Action::Retryable
    }

    /// Returns a success action.
    pub fn success(self) -> Action {
        Action::Success
    }
}

/// The action to take after classifying a request/response pair.
#[must_use]
pub enum Action {
    /// The request was successful and should not be retried.
    Success,
    /// The request failed but can be retried.
    Retryable,
}

/// Determines whether a request should be retried based on the response or error.
#[derive(Clone)]
pub(crate) enum Classifier {
    /// Never retry any requests.
    Never,
    /// Retry protocol-level errors (connection issues, timeouts, etc.).
    ProtocolNacks,
    /// Use custom classification logic.
    Dyn(Arc<dyn Classify>),
}

impl Classifier {
    /// Classifies a request/response pair to determine the appropriate retry action.
    pub(super) fn classify(&mut self, req: &Req, res: &Result<Res, BoxError>) -> Action {
        let req_rep = ReqRep(req, res.as_ref().map(|r| r.status()));
        match self {
            Classifier::Never => Action::Success,
            Classifier::ProtocolNacks => {
                let is_protocol_nack = req_rep
                    .error()
                    .map(super::is_retryable_error)
                    .unwrap_or(false);
                if is_protocol_nack {
                    Action::Retryable
                } else {
                    Action::Success
                }
            }
            Classifier::Dyn(c) => c.classify(req_rep),
        }
    }
}
