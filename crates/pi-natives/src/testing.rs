//! Test-only helpers shared across `pi-natives` unit tests.
//!
//! Any state exposed here MUST be gated on `#[cfg(test)]` — it does not ship
//! in release builds.

use std::sync::{Mutex, MutexGuard};

/// Global mutex serializing tests that mutate the process-wide
/// [`std::panic`] hook.
///
/// [`std::panic::set_hook`] / [`take_hook`](std::panic::take_hook) act on a
/// single hook shared by every thread in the process. The default Rust test
/// harness runs tests in parallel, so two tests calling
/// `take_hook` + `set_hook(noop)` on their own threads can interleave: the
/// second `take_hook` captures the first test's noop, and when the drops run
/// in the opposite order the noop is restored as the global hook — silently
/// muting crash diagnostics for every later test in the crate. Serializing
/// the whole take → set → run → restore window across every hook-mutating
/// test in this crate eliminates that race.
///
/// [`take_hook`]: std::panic::take_hook
static PANIC_HOOK_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire the process-global panic-hook lock. Hold the returned guard for the
/// entire take → set → run → restore window.
///
/// Recovers from mutex poisoning (a prior test panicked while holding the
/// lock) so a single failing test does not cascade into every later test
/// panicking on `Mutex::lock`.
pub fn lock_panic_hook() -> MutexGuard<'static, ()> {
	PANIC_HOOK_MUTEX
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Boxed panic hook signature, factored out so the [`SilenceHook`] wrapper
/// stays readable — matches [`std::panic::take_hook`]'s return type.
type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

/// Suppress the global panic hook for the guard's lifetime, so injected panic
/// tests don't dump backtraces (or persist crash reports) onto the test run.
///
/// [`std::panic::set_hook`] is process-global, so `SilenceHook` holds
/// [`lock_panic_hook`] for the entire take → set → run → restore window.
/// Without that lock, two parallel tests could interleave their hook swaps and
/// permanently install the noop hook, muting crash diagnostics for every later
/// test in the crate.
pub struct SilenceHook {
	prev:   Option<PanicHook>,
	_guard: MutexGuard<'static, ()>,
}

impl SilenceHook {
	#[allow(clippy::new_without_default, reason = "Default acquiring a global lock would surprise")]
	pub fn new() -> Self {
		let guard = lock_panic_hook();
		let prev = std::panic::take_hook();
		std::panic::set_hook(Box::new(|_| {}));
		Self { prev: Some(prev), _guard: guard }
	}
}

impl Drop for SilenceHook {
	fn drop(&mut self) {
		if let Some(prev) = self.prev.take() {
			std::panic::set_hook(prev);
		}
	}
}
