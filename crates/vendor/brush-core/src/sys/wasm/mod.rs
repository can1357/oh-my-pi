pub(crate) use crate::sys::stubs::env;
pub use crate::sys::stubs::{async_pipe, commands, fd};
pub(crate) mod fs;
pub use crate::sys::stubs::{input, poll, process, resource, signal, terminal};
pub(crate) use crate::sys::stubs::{network, pipes, users};

/// Platform-specific errors.
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {}
