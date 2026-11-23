//! Output work that outlives the `ExtProc` that polled it.
//!
//! An output pump or a relay delivers until the end of its stream, as a pipe
//! does for whoever still writes into it: a detached (`nohup`) or abandoned
//! external, or a process a finished program left running, may write long
//! after the `ExtProc` polling its pumps is gone. That remaining work (output
//! only: input ends with its child) is adopted here, still the same polled
//! state machines:
//!
//! - inside a Tokio runtime (an embedded session drops its `ExtProc`s on that
//!   runtime's task) it becomes a task of that runtime;
//! - elsewhere (`obash`, synchronous suites) it is kept in a process-wide set
//!   that [`poll`] advances: every external's `poll_wait` and `Relayed`'s do,
//!   and a drive loop does before it parks
//!   ([`NativeSpawner::poll_orphans`](crate::sys::NativeSpawner::poll_orphans)).

use std::{
	future::Future,
	pin::Pin,
	sync::{Arc, LazyLock},
	task::{Context, Waker},
};

use parking_lot::Mutex;

use super::Wakers;

type Work = Pin<Box<dyn Future<Output = ()> + Send>>;

/// The retained work, and the wakers of everyone who polls it.
struct Orphans {
	work:   Mutex<Vec<Work>>,
	wakers: Arc<Wakers>,
	waker:  Waker,
}

static ORPHANS: LazyLock<Orphans> = LazyLock::new(|| {
	let wakers = Arc::new(Wakers::default());
	Orphans { work: Mutex::new(Vec::new()), waker: Waker::from(Arc::clone(&wakers)), wakers }
});

/// Run `work` to its end without the `ExtProc` that polled it: on the
/// current Tokio runtime if there is one, else in the retained set (whoever
/// polled it before is woken to take it on).
pub fn adopt(work: impl Future<Output = ()> + Send + 'static) {
	if let Ok(runtime) = tokio::runtime::Handle::try_current() {
		drop(runtime.spawn(work));
		return;
	}
	ORPHANS.work.lock().push(Box::pin(work));
	ORPHANS.waker.wake_by_ref();
}

/// Advance the retained work; `cx`'s task is woken when it can go on. Work
/// adopted while none is retained wakes nobody: it is adopted while its
/// adopter is being polled, whose drive loop polls this next.
pub fn poll(cx: &Context<'_>) {
	let orphans = &*ORPHANS;
	let mut work = std::mem::take(&mut *orphans.work.lock());
	if work.is_empty() {
		return;
	}
	orphans.wakers.add(cx.waker());
	// Polled outside the lock: work finishing here may adopt more.
	let mut ocx = Context::from_waker(&orphans.waker);
	work.retain_mut(|w| w.as_mut().poll(&mut ocx).is_pending());
	let settled = {
		let mut retained = orphans.work.lock();
		retained.append(&mut work);
		retained.is_empty()
	};
	if settled {
		// Nothing left to wake anyone for: forget the pollers' wakers (they
		// would keep their tasks alive).
		drop(orphans.wakers.take());
	}
}
