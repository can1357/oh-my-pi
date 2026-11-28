//! Heap stack for the interpreters' linear, input-driven recursion. A direct
//! `.await` polls inline; [`descend`] starts a new chunk from the driver's loop.

use std::{
	cell::Cell,
	future::{Future, poll_fn},
	pin::{Pin, pin},
	ptr::NonNull,
	task::{Context, Poll, Waker},
};

type Frame<'a> = Pin<Box<dyn Future<Output = ()> + 'a>>;

thread_local! {
	/// The one child the current poll can yield. Nested runs save and restore it.
	static CHILD: Cell<Option<NonNull<Option<Frame<'static>>>>> = const { Cell::new(None) };
}

/// Restores the outer poll on both return and unwind.
struct Restore(Option<NonNull<Option<Frame<'static>>>>);

impl Drop for Restore {
	fn drop(&mut self) { CHILD.set(self.0); }
}

/// Drops in dependency order on unwind: each child may borrow its parent.
#[derive(Default)]
struct Stack(Vec<Frame<'static>>);

impl Drop for Stack {
	fn drop(&mut self) { while self.0.pop().is_some() {} }
}

/// Polls one chunk without borrowing the driver's vector; reentrant polls have their own slot.
fn poll_chunk<F: Future + ?Sized>(f: Pin<&mut F>, cx: &mut Context<'_>) -> (Poll<F::Output>, Option<Frame<'static>>) {
	let mut child = None;
	let _restore = Restore(CHILD.replace(Some(NonNull::from(&mut child))));
	(f.poll(cx), child)
}

/// Drives interpreter chunks to completion on the current thread. No executor tasks or wakeups.
///
/// # Safety
/// While this driver is active, every call of [`descend`] must be directly awaited by a
/// linear chain of interpreter futures: when it yields, the entire chain returns `Pending`
/// without invalidating or detaching the child or any data it borrows. No independent polling,
/// selection, forgotten futures, or cancellation of a pending child. Only the driver may resume
/// or drop these chunks, innermost first. This is not an executor for arbitrary user futures.
pub(crate) unsafe fn run<F: Future>(f: F) -> F::Output {
	let mut root = pin!(f);
	let mut stack = Stack::default();
	let mut cx = Context::from_waker(Waker::noop());
	loop {
		let child = if let Some(frame) = stack.0.last_mut() {
			let (status, child) = poll_chunk(frame.as_mut(), &mut cx);
			if status.is_ready() {
				assert!(child.is_none(), "completed chunk left a pending child");
				stack.0.pop();
				continue;
			}
			child
		} else {
			let (status, child) = poll_chunk(root.as_mut(), &mut cx);
			if let Poll::Ready(output) = status {
				assert!(child.is_none(), "completed root left a pending child");
				return output;
			}
			child
		};
		stack.0.push(child.expect("interpreter suspended without descending"));
	}
}

/// Yields `future` to the innermost driver and resumes with its result. Each spill, not each
/// inline await, owns a boxed chunk. The suspended parent contains only the result slot.
pub(crate) async fn descend<F: Future>(future: F) -> F::Output {
	let mut output = None;
	let mut child = Some(async { output = Some(future.await) });
	poll_fn(move |_| {
		let Some(future) = child.take() else { return Poll::Ready(()) };
		let mut slot = CHILD.get().expect("descend outside an interpreter driver");
		// SAFETY: poll_chunk's restore guard installs a live, same-thread slot for this poll.
		let slot = unsafe { slot.as_mut() };
		assert!(slot.is_none(), "interpreter polled two children in one chunk");
		let frame: Frame<'_> = Box::pin(future);
		// SAFETY: run's linear-await contract keeps the parent suspended and all borrows live
		// until this child completes. On panic, poll_chunk and Stack drop children first.
		*slot = Some(unsafe { std::mem::transmute::<Frame<'_>, Frame<'static>>(frame) });
		Poll::Pending
	}).await;
	output.expect("driver resumed parent before child finished")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn count(n: usize, chunk: usize, fail: bool) -> FrameCount {
		Box::pin(async move {
			if n == 0 { assert!(!fail, "leaf panic"); return 0; }
			let next = count(n - 1, chunk, fail);
			1 + if n.is_multiple_of(chunk) { descend(next).await } else { next.await }
		})
	}
	type FrameCount = Pin<Box<dyn Future<Output = usize>>>;

	#[test]
	fn chunks_complete_and_unwind_on_a_small_stack() {
		std::thread::Builder::new().stack_size(256 << 10).spawn(|| {
			// SAFETY: count has one direct await per level and no other source of Pending.
			let failure = std::panic::catch_unwind(|| unsafe { run(count(16_384, 4, true)) });
			assert!(failure.is_err());
			// SAFETY: same chain; a nested driver must restore its parent's child slot.
			let sum = unsafe { run(async {
				let a = descend(async { run(count(16_384, 4, false)) }).await;
				a + descend(count(32, 2, false)).await
			}) };
			assert_eq!(sum, 16_416);
		}).unwrap().join().unwrap();
	}
}
