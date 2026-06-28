pub use crate::sys::stubs::async_pipe;
pub mod commands;
pub(crate) mod env;
pub mod fd;
pub(crate) mod fs;
pub use crate::sys::stubs::input;
pub(crate) mod network;
pub use crate::sys::stubs::{poll, resource};

/// Signal processing utilities
pub mod signal {
	pub(crate) use tokio::signal::ctrl_c as await_ctrl_c;

	pub(crate) use crate::sys::stubs::signal::*;
}

pub use crate::sys::tokio_process as process;
pub mod terminal;
pub(crate) mod users;

/// Platform-specific errors.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {}
