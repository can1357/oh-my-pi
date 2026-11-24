//! Shared Tokio runtime for the crate's Linux D-Bus calls.
//!
//! `zbus::blocking` runs every call through `zbus::utils::block_on`, which,
//! with `zbus/tokio` enabled (`ashpd` and `atspi` turn it on), builds a
//! process-wide multi-thread runtime with one worker per CPU. Power
//! assertions, desktop application lookups, and xdg-desktop-portal calls
//! instead drive async `zbus` on this one runtime, built on the first D-Bus
//! call. Cached connections (the power buses, `ashpd`'s portal connection)
//! keep their I/O tasks on the runtime that created them, so it lives for the
//! whole process.

use std::{future::Future, sync::LazyLock};

use tokio::runtime::{Builder, Handle, Runtime, RuntimeFlavor};

static RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

/// Borrow the shared D-Bus runtime, surfacing a one-time build failure.
pub(crate) fn runtime() -> Result<&'static Runtime, &'static str> {
	RUNTIME.as_ref().map_err(String::as_str)
}

/// Drives `future` to completion on the shared D-Bus runtime.
///
/// `Runtime::block_on` panics inside another runtime's context: a
/// multi-thread caller leaves it through `block_in_place`, a current-thread
/// caller (where `block_in_place` panics) through a scoped helper thread.
pub(crate) fn block_on<F>(future: F) -> Result<F::Output, &'static str>
where
	F: Future + Send,
	F::Output: Send,
{
	let runtime = runtime()?;
	match Handle::try_current() {
		Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
			Ok(tokio::task::block_in_place(|| runtime.block_on(future)))
		},
		Ok(_) => std::thread::scope(|scope| {
			std::thread::Builder::new()
				.name("pi-dbus-sync".into())
				.stack_size(512 * 1024)
				.spawn_scoped(scope, move || runtime.block_on(future))
				.map_err(|_| "failed to spawn D-Bus helper thread")?
				.join()
				.map_err(|_| "D-Bus helper thread panicked")
		}),
		Err(_) => Ok(runtime.block_on(future)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dbus_runtime_uses_single_worker() {
		let runtime = runtime().expect("shared D-Bus runtime should initialize");
		assert_eq!(runtime.metrics().num_workers(), 1);
	}
}
