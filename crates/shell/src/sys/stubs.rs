#![allow(
	dead_code,
	clippy::missing_const_for_fn,
	clippy::needless_pass_by_ref_mut,
	clippy::needless_pass_by_value,
	clippy::unnecessary_wraps,
	clippy::unused_async,
	clippy::unused_self,
	reason = "stub platform APIs mirror the native backend's fallible and stateful interface"
)]

pub mod async_pipe;
pub mod commands;
pub(crate) mod env;
pub mod fd;
pub mod fs;
pub mod input;
pub(crate) mod network;
pub(crate) mod pipes;
pub mod poll;
pub mod process;
pub mod resource;
pub mod signal;
pub mod terminal;
pub(crate) mod users;
