//! Environment variable retrieval (stub implementation).

use std::iter;
/// Retrieves environment variables from the host process.
///
/// Stub implementation that returns no variables.
pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (String, String)> {
	iter::empty()
}
