//! Tools for customizing the behavior of a [`FollowRedirect`][super::FollowRedirect] middleware.

use std::{fmt, pin::Pin};

use http::{HeaderMap, StatusCode, Uri};

use crate::error::BoxError;

/// A type that holds information on a redirection attempt.
pub struct Attempt<'a> {
    pub(crate) status: StatusCode,
    pub(crate) headers: &'a HeaderMap,
    pub(crate) location: &'a Uri,
    pub(crate) previous: &'a Uri,
}

/// A value which indicates the action
/// [`FollowRedirect`][super::FollowRedirect] should take for a redirection response.
pub enum Action {
    /// Follow the redirection.
    Follow,
    /// Do not follow the redirection, and return the redirection response as-is.
    Stop,
    /// Pending async decision. The async task will be awaited to determine the final action.
    Pending(Pin<Box<dyn Future<Output = Action> + Send>>),
    /// An error occurred while determining the redirection action.
    Error(BoxError),
}

impl fmt::Debug for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Action::Follow => f.debug_tuple("Follow").finish(),
            Action::Stop => f.debug_tuple("Stop").finish(),
            Action::Pending(_) => f.debug_tuple("Pending").finish(),
            Action::Error(_) => f.debug_tuple("Error").finish(),
        }
    }
}
