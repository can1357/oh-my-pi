//! One timer thread shared by every [`Timer`] a process host arms (B9: `read
//! -t`, `TMOUT`).

use std::{
	cmp::Reverse,
	collections::{BinaryHeap, HashMap},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll, Waker},
	thread,
	time::Instant,
};

use parking_lot::{Condvar, Mutex, MutexGuard};

use crate::bash::Timer;

/// State of one armed timer.
#[derive(Default)]
struct Slot {
	fired: AtomicBool,
	waker: Mutex<Option<Waker>>,
}

#[derive(Default)]
struct State {
	/// Deadlines by id, earliest first; cancelled ids are skipped lazily.
	heap:    BinaryHeap<Reverse<(Instant, u64)>>,
	slots:   HashMap<u64, Arc<Slot>>,
	next_id: u64,
	started: bool,
}

#[derive(Default)]
struct Shared {
	state: Mutex<State>,
	cv:    Condvar,
}

/// The timer thread (started on the first timer).
#[derive(Clone, Default)]
pub struct Timers(Arc<Shared>);

impl Timers {
	/// Arm a timer firing at `at`.
	pub fn arm(&self, at: Instant) -> Box<dyn Timer> {
		let slot = Arc::new(Slot::default());
		let mut st = self.0.state.lock();
		let id = st.next_id;
		st.next_id += 1;
		st.slots.insert(id, Arc::clone(&slot));
		st.heap.push(Reverse((at, id)));
		if !st.started {
			st.started = true;
			let shared = Arc::clone(&self.0);
			thread::Builder::new()
				.name("shell-timers".into())
				.spawn(move || run(&shared))
				.expect("spawning the timer thread");
		}
		drop(st);
		self.0.cv.notify_one();
		Box::new(Armed { id, slot, timers: self.clone() })
	}
}

/// The timer loop: fire due timers, sleep until the earliest deadline.
fn run(shared: &Shared) {
	let mut st = shared.state.lock();
	loop {
		let Some(&Reverse((at, id))) = st.heap.peek() else {
			shared.cv.wait(&mut st);
			continue;
		};
		if !st.slots.contains_key(&id) {
			st.heap.pop();
			continue;
		}
		if Instant::now() >= at {
			st.heap.pop();
			let slot = st.slots.remove(&id);
			if let Some(slot) = slot {
				slot.fired.store(true, Ordering::Release);
				let waker = slot.waker.lock().take();
				if let Some(w) = waker {
					// Wake without the heap lock: the woken engine may arm or
					// cancel timers at once.
					MutexGuard::unlocked(&mut st, || w.wake());
				}
			}
			continue;
		}
		shared.cv.wait_until(&mut st, at);
	}
}

/// An armed timer; dropping it cancels it.
struct Armed {
	id:     u64,
	slot:   Arc<Slot>,
	timers: Timers,
}

impl Timer for Armed {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<()> {
		if self.slot.fired.load(Ordering::Acquire) {
			return Poll::Ready(());
		}
		*self.slot.waker.lock() = Some(cx.waker().clone());
		// The thread may have fired between the check and the store.
		if self.slot.fired.load(Ordering::Acquire) {
			Poll::Ready(())
		} else {
			Poll::Pending
		}
	}
}

impl Drop for Armed {
	fn drop(&mut self) {
		self.timers.0.state.lock().slots.remove(&self.id);
	}
}
