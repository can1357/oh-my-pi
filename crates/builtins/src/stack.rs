//! Native stack headroom for synchronous Perl callbacks and recursive AST walks.

use std::cell::Cell;

thread_local! {
	/// Low address of the current thread's stack, or 0 before it is computed.
	static STACK_LOW: Cell<usize> = const { Cell::new(0) };
}

/// Bytes between the current stack pointer and the low end of the current
/// thread's stack, or `None` when the platform's stack bounds cannot be read.
pub(crate) fn remaining() -> Option<usize> {
	let marker = 0u8;
	let sp = (&raw const marker).addr();
	let low = STACK_LOW.with(|cached| match cached.get() {
		0 => stack_low().inspect(|&low| cached.set(low)),
		low => Some(low),
	})?;
	// Stacks grow downward on every supported target.
	Some(sp.saturating_sub(low))
}

/// Runs `f`, panicking before it starts when less than `red_zone` bytes of
/// stack are left.
pub(crate) fn guard<R>(red_zone: usize, f: impl FnOnce() -> R) -> R {
	if let Some(left) = remaining()
		&& left < red_zone
	{
		panic!("stack exhausted: input nests too deeply");
	}
	f()
}


/// Low end of the current thread's stack, or `None` when it cannot be read.
#[cfg(target_os = "linux")]
fn stack_low() -> Option<usize> {
	// SAFETY: `attr` is initialized by `pthread_getattr_np`, read by
	// `pthread_attr_getstack`, then destroyed by `pthread_attr_destroy`; no
	// other thread touches it.
	unsafe {
		let mut attr: libc::pthread_attr_t = std::mem::zeroed();
		if libc::pthread_getattr_np(libc::pthread_self(), &mut attr) != 0 {
			return None;
		}
		let mut addr = std::ptr::null_mut();
		let mut size = 0usize;
		let rc = libc::pthread_attr_getstack(&attr, &mut addr, &mut size);
		libc::pthread_attr_destroy(&mut attr);
		if rc != 0 {
			return None;
		}
		Some(addr.addr())
	}
}

/// Low end of the current thread's stack, or `None` when it cannot be read.
#[cfg(target_os = "macos")]
fn stack_low() -> Option<usize> {
	// SAFETY: both calls are read-only queries about the current thread.
	unsafe {
		let high = libc::pthread_get_stackaddr_np(libc::pthread_self()).addr();
		let size = libc::pthread_get_stacksize_np(libc::pthread_self());
		Some(high.saturating_sub(size))
	}
}

/// Low end of the current thread's stack, or `None` when it cannot be read.
#[cfg(windows)]
fn stack_low() -> Option<usize> {
	// SAFETY: the call writes the two bounds of the current thread's stack
	// into the out-parameters; nothing else is touched.
	unsafe {
		let mut low = 0usize;
		let mut high = 0usize;
		windows_sys::Win32::System::Threading::GetCurrentThreadStackLimits(&mut low, &mut high);
		Some(low)
	}
}

/// Low end of the current thread's stack, or `None` when it cannot be read.
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn stack_low() -> Option<usize> {
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[cfg(any(target_os = "linux", target_os = "macos", windows))]
	#[test]
	#[should_panic(expected = "stack exhausted: input nests too deeply")]
	fn refuses_a_callback_without_native_headroom() {
		guard(usize::MAX, || unreachable!("callback cannot enter"));
	}
}
