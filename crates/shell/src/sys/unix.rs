pub mod async_pipe;
pub mod commands;
pub(crate) mod env;
pub mod fd;
pub mod fs;
pub mod input;
pub(crate) mod network;
pub mod poll;
use nix::errno::Errno;

use crate::error;
pub use crate::sys::tokio_process as process;
pub mod resource;
pub mod signal;
pub mod terminal;
pub(crate) mod users;

/// Platform-specific errors.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
	/// A system error occurred.
	#[error("system error: {0}")]
	ErrnoError(#[from] Errno),
}

impl From<Errno> for error::ErrorKind {
	fn from(err: Errno) -> Self {
		PlatformError::ErrnoError(err).into()
	}
}
