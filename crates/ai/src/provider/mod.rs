//! Private built-in provider composition and the single erased service
//! boundary.

use tower::util::BoxCloneSyncService;

use crate::{answer::Answer, call::Call, error::Error};

pub mod builtin;
pub mod copilot;
pub(crate) mod http;

#[cfg(any(test, feature = "test-support"))]
pub mod fake;

/// Construction-time type erasure for the outer logical-execution service.
///
/// Route-local services use [`crate::layer::stack::RouteProviderService`] so
/// every fallback receives the same [`crate::layer::ExecutionContext`].
pub type ProviderService = BoxCloneSyncService<Call, Answer, Error>;
