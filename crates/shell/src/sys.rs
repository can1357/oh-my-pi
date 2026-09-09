//! Platform abstraction facilities

#![allow(unused, reason = "platform modules are selected by target configuration")]

#[cfg(unix)]
pub(crate) mod unix;
#[cfg(unix)]
pub(crate) use unix as platform;

#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
pub(crate) use windows as platform;

#[cfg(not(unix))]
pub(crate) mod stubs;

#[cfg(any(unix, windows))]
pub(crate) mod hostname;
#[cfg(any(unix, windows))]
pub mod tokio_process;

pub mod fs;

pub use platform::{
	PlatformError, async_pipe, commands, fd, poll, process, resource, signal, terminal,
};
pub(crate) use platform::{env, input, network, users};
