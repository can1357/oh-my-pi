//! Driving provider futures from synchronous code, cancellation, and
//! deferred-close tracking.

use std::{
	future::Future,
	io,
	pin::pin,
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread::{self, Thread},
};

use parking_lot::{Mutex, MutexGuard};
use tokio::{runtime::Handle, sync::Notify};
use tokio_util::sync::CancellationToken;

use crate::error::cancelled;

/// Runs a provider future to completion on the calling (synchronous) thread.
///
/// Inside a runtime context the current handle drives it through
/// `block_in_place`, which is a plain call on blocking-pool and foreign
/// threads and hands the worker off on a multi-thread runtime; tokio panics
/// on a current-thread runtime's own thread, which is a contract violation
/// (async code must use the async API) and never a deadlock. Outside any
/// runtime the handle captured when the facade or file was created drives it,
/// and with no runtime at all a thread-park executor does.
pub(crate) fn block_on<F: Future>(fallback: Option<&Handle>, fut: F) -> F::Output {
	if let Ok(handle) = Handle::try_current() {
		return tokio::task::block_in_place(|| handle.block_on(fut));
	}
	match fallback {
		Some(handle) => handle.block_on(fut),
		None => park_on(fut),
	}
}

struct ThreadWaker(Thread);

impl Wake for ThreadWaker {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.0.unpark();
	}
}

/// Minimal executor for futures that need no runtime (or are already ready,
/// like host-backed canonicalization steps).
pub(crate) fn park_on<F: Future>(fut: F) -> F::Output {
	let mut fut = pin!(fut);
	let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
	let mut cx = Context::from_waker(&waker);
	loop {
		if let Poll::Ready(output) = fut.as_mut().poll(&mut cx) {
			return output;
		}
		thread::park();
	}
}

/// Per-facade state inherited by everything opened through it.
#[derive(Clone, Debug, Default)]
pub(crate) struct Scope {
	pub(crate) cancel: Option<CancellationToken>,
	pub(crate) closes: Option<Arc<CloseTracker>>,
}

impl Scope {
	/// Races `fut` against the scope's cancellation token.
	pub(crate) async fn guard<T>(
		cancel: Option<&CancellationToken>,
		fut: impl Future<Output = io::Result<T>>,
	) -> io::Result<T> {
		match cancel {
			None => fut.await,
			Some(token) => token
				.run_until_cancelled(fut)
				.await
				.unwrap_or_else(|| Err(cancelled())),
		}
	}
}

/// Counts background closes of dropped virtual files and remembers the first
/// failure for [`crate::Fs::drain_closes`].
#[derive(Debug, Default)]
pub(crate) struct CloseTracker {
	state: Mutex<TrackerState>,
	idle:  Notify,
}

#[derive(Debug, Default)]
struct TrackerState {
	in_flight:   usize,
	first_error: Option<io::Error>,
}

impl CloseTracker {
	fn lock(&self) -> MutexGuard<'_, TrackerState> {
		self.state.lock()
	}

	pub(crate) fn begin(&self) {
		self.lock().in_flight += 1;
	}

	pub(crate) fn finish(&self, result: io::Result<()>) {
		let mut state = self.lock();
		state.in_flight -= 1;
		if let Err(err) = result {
			state.first_error.get_or_insert(err);
		}
		if state.in_flight == 0 {
			self.idle.notify_waiters();
		}
	}

	/// Records the result of a close that completed synchronously.
	pub(crate) fn record(&self, result: io::Result<()>) {
		if let Err(err) = result {
			self.lock().first_error.get_or_insert(err);
		}
	}

	fn take_if_idle(&self) -> Option<io::Result<()>> {
		let mut state = self.lock();
		(state.in_flight == 0).then(|| state.first_error.take().map_or(Ok(()), Err))
	}

	pub(crate) async fn drain(&self) -> io::Result<()> {
		loop {
			let notified = self.idle.notified();
			let mut notified = pin!(notified);
			notified.as_mut().enable();
			if let Some(result) = self.take_if_idle() {
				return result;
			}
			notified.await;
		}
	}

	pub(crate) fn drain_blocking(&self, fallback: Option<&Handle>) -> io::Result<()> {
		if let Some(result) = self.take_if_idle() {
			return result;
		}
		block_on(fallback, self.drain())
	}
}

/// Finishes a tracked close exactly once, even if the runtime drops the
/// close task without polling it to completion.
pub(crate) struct CloseTicket {
	tracker: Option<Arc<CloseTracker>>,
}

impl CloseTicket {
	pub(crate) fn new(tracker: Option<Arc<CloseTracker>>) -> Self {
		if let Some(tracker) = &tracker {
			tracker.begin();
		}
		Self { tracker }
	}

	pub(crate) fn finish(mut self, result: io::Result<()>) {
		if let Some(tracker) = self.tracker.take() {
			tracker.finish(result);
		}
	}
}

impl Drop for CloseTicket {
	fn drop(&mut self) {
		if let Some(tracker) = self.tracker.take() {
			tracker.finish(Err(io::Error::other("file close abandoned by runtime shutdown")));
		}
	}
}
