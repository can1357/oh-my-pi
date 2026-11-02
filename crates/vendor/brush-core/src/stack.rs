//! Keeps nested execution from running off the end of the thread's stack.
//!
//! The parser bounds how deeply one parse nests, but execution nests across
//! parses: a function call, an `eval`, a sourced file or a trap handler runs
//! its own program inside the command that started it, and an arithmetic
//! variable can name another expression to evaluate. Each level holds native
//! stack until it returns, and a thread's stack (2 MiB for a Tokio worker) holds
//! only a few dozen levels. Past its end the process dies with no message. So
//! nested execution continues on a stack segment allocated for it when the
//! current one runs low, and nested commands may hold at most
//! [`MAX_EXECUTION_STACK`] of such segments; past that the next command list is
//! refused with an error instead.

use std::{cell::Cell, future::Future, pin::pin, task::Poll};

use crate::error;

/// Stack left on the current segment below which nested execution continues
/// on a new one. One level of shell nesting takes tens of KiB of native stack
/// in an optimized build, and several times that in a debug build; this leaves
/// each level, and a construct nested to the parser's limit inside it, room on
/// the segment it starts on.
const RED_ZONE: usize = 1024 * 1024;

/// Size of each stack segment allocated for nested execution. Its pages are
/// committed only as they are touched, and it is freed when the call that
/// needed it returns.
const SEGMENT: usize = 8 * 1024 * 1024;

/// The most stack that nested commands may hold in allocated segments at once.
/// Recursion that never ends (a function or `eval` that calls itself) stops
/// here with an error instead of growing until the system runs out of memory.
pub(crate) const MAX_EXECUTION_STACK: usize = 32 * SEGMENT;

thread_local! {
	/// How many segments the poll running on this thread holds now. Segments
	/// are allocated and freed within one synchronous poll, so a count per
	/// thread is exact.
	static SEGMENTS_IN_USE: Cell<usize> = const { Cell::new(0) };
}

/// Whether the current stack segment has room for another level of nesting.
fn has_headroom() -> bool {
	stacker::remaining_stack().is_some_and(|remaining| remaining >= RED_ZONE)
}

/// Runs `callback` on a newly allocated stack segment, counting the segment
/// while it is in use.
fn on_new_segment<R>(callback: impl FnOnce() -> R) -> R {
	struct InUse;
	impl Drop for InUse {
		fn drop(&mut self) {
			SEGMENTS_IN_USE.set(SEGMENTS_IN_USE.get() - 1);
		}
	}
	SEGMENTS_IN_USE.set(SEGMENTS_IN_USE.get() + 1);
	let _in_use = InUse;
	stacker::grow(SEGMENT, callback)
}

/// Polls `future`, the execution of one nested command list, on a new stack
/// segment whenever the current one is nearly exhausted. If nested commands
/// already hold [`MAX_EXECUTION_STACK`], the command list is refused before it
/// starts. Once started it always runs on: a later poll needs no more stack
/// than its first.
pub(crate) async fn with_stack_headroom<T>(
	future: impl Future<Output = Result<T, error::Error>>,
) -> Result<T, error::Error> {
	let mut future = pin!(future);
	let mut started = false;
	std::future::poll_fn(|cx| {
		if has_headroom() {
			started = true;
			return future.as_mut().poll(cx);
		}
		if !started && SEGMENTS_IN_USE.get() * SEGMENT >= MAX_EXECUTION_STACK {
			return Poll::Ready(Err(
				error::ErrorKind::ExecutionStackExhausted(MAX_EXECUTION_STACK / (1024 * 1024)).into(),
			));
		}
		started = true;
		on_new_segment(|| future.as_mut().poll(cx))
	})
	.await
}

/// Runs `callback`, a synchronous nested evaluation whose depth is bounded
/// elsewhere, on a new stack segment if the current one is nearly exhausted.
pub(crate) fn with_headroom<R>(callback: impl FnOnce() -> R) -> R {
	if has_headroom() { callback() } else { on_new_segment(callback) }
}
