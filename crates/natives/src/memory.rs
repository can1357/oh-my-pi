//! Return freed native heap pages to the OS once native work goes quiet.
//!
//! glibc gives each thread that allocates under contention its own arena (up
//! to eight per core), and an arena keeps the pages its frees leave behind.
//! Native work fans out across libuv, Tokio's blocking pool, and Rayon, so a
//! long session accumulates dozens of arenas holding memory nothing owns any
//! more: on a 32-core host, 80 rounds of reads, edits, and grep left 349 MiB
//! anonymous RSS, of which `malloc_trim(0)` returned 193 MiB in 16 ms. Capping
//! arenas instead slows that work 13-51%, and only takes effect from the
//! environment before the process starts.
//!
//! Every compute-bound native job holds a [`NativeWork`] guard: the
//! [`crate::task`] blocking paths and the edit preview pass. When the last one
//! drops, a dedicated thread waits for [`QUIET_PERIOD`] without new work and
//! then trims once. It sleeps on a condition variable in between, so an idle
//! process does nothing, and a trim never runs while counted jobs are using
//! the arenas it locks. Long-lived I/O jobs (PTY sessions, overlay mounts) are
//! not counted, since holding a guard for a whole shell command would block
//! trimming for its duration; a trim overlapping them only costs brief arena
//! lock contention. Synchronous exports on the JS thread are not counted
//! either; the next trim covers their arena too.
//!
//! Memory can also be freed after its job's guard dropped, possibly after the
//! trim that guard scheduled: a result converted or dropped on the JS thread,
//! an external `Buffer` collected by the JS GC, or edit session buffers
//! released on close. Each of those calls [`released`], which counts as
//! finished work, so the freed pages are trimmed in turn.

/// Marks one blocking native job as running for the idle trimmer.
#[must_use = "work counts as running only while the guard is alive"]
pub struct NativeWork(());

/// Count a blocking native job as running until the guard drops.
#[inline]
#[cfg_attr(
	not(all(target_os = "linux", target_env = "gnu")),
	expect(clippy::missing_const_for_fn, reason = "only the glibc build calls into the allocator")
)]
pub fn native_work() -> NativeWork {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	allocator::begin();
	NativeWork(())
}

impl Drop for NativeWork {
	#[inline]
	fn drop(&mut self) {
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		allocator::end();
	}
}

/// Report memory freed outside a running job, so the trimmer returns its pages
/// after the next quiet period.
#[inline]
#[cfg_attr(
	not(all(target_os = "linux", target_env = "gnu")),
	expect(clippy::missing_const_for_fn, reason = "only the glibc build calls into the allocator")
)]
pub fn released() {
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	allocator::settled();
}

/// Owns a job result until it leaves Rust, then reports it [`released`].
///
/// Whichever way the result goes — converted for JavaScript, unwrapped for a
/// conversion that follows immediately, or dropped on an abort or error path —
/// the trimmer schedules another trim. `Settled<()>` marks a result handed off
/// elsewhere, such as through a threadsafe function call.
pub struct Settled<T>(Option<T>);

impl<T> Settled<T> {
	pub const fn new(value: T) -> Self {
		Self(Some(value))
	}

	/// Take the result for a conversion that follows immediately, inside the
	/// trimmer's quiet period.
	pub fn into_inner(mut self) -> T {
		self.0.take().expect("a settled result is taken only once")
	}
}

impl<T> Drop for Settled<T> {
	#[inline]
	fn drop(&mut self) {
		released();
	}
}

impl<T: std::fmt::Debug> std::fmt::Debug for Settled<T> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_tuple("Settled").field(&self.0).finish()
	}
}

impl<T: napi::bindgen_prelude::ToNapiValue> napi::bindgen_prelude::ToNapiValue for Settled<T> {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		mut val: Self,
	) -> napi::Result<napi::sys::napi_value> {
		let value = val.0.take().expect("a settled result is taken only once");
		// SAFETY: forwarded unchanged from the caller's contract.
		let converted = unsafe { T::to_napi_value(env, value) };
		// Report only now that the conversion has freed the result.
		drop(val);
		converted
	}
}

#[cfg(any(all(target_os = "linux", target_env = "gnu"), test))]
mod allocator {
	use std::time::Duration;

	use parking_lot::{Condvar, Mutex, MutexGuard};

	/// Quiet time after the last job before trimming: long enough to skip the
	/// gaps inside a burst of tool calls, short enough to trim while the agent
	/// waits on the model or the user.
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	const QUIET_PERIOD: Duration = Duration::from_secs(5);

	/// Running jobs and how much finished work the last trim covered.
	struct Activity {
		running:  usize,
		finished: u64,
		trimmed:  u64,
	}

	impl Activity {
		/// Work finished since the last trim and none running: the generation a
		/// trim after the quiet period would cover.
		const fn pending(&self) -> Option<u64> {
			if self.running == 0 && self.finished != self.trimmed {
				Some(self.finished)
			} else {
				None
			}
		}
	}

	struct Trimmer {
		activity: Mutex<Activity>,
		idle:     Condvar,
	}

	impl Trimmer {
		const fn new() -> Self {
			Self {
				activity: Mutex::new(Activity { running: 0, finished: 0, trimmed: 0 }),
				idle:     Condvar::new(),
			}
		}

		fn begin(&self) {
			self.activity.lock().running += 1;
		}

		fn end(&self) {
			let mut activity = self.activity.lock();
			activity.running -= 1;
			self.finish(activity);
		}

		/// Record finished work outside any job, such as a result freed on the
		/// JS thread.
		fn settled(&self) {
			self.finish(self.activity.lock());
		}

		fn finish(&self, mut activity: MutexGuard<'_, Activity>) {
			activity.finished += 1;
			if activity.running == 0 {
				self.idle.notify_one();
			}
		}

		/// Trim after each quiet period that follows finished work; never
		/// returns.
		///
		/// Work that ends during the wait restarts it, and work still running
		/// when it expires defers the trim until that work ends.
		fn run(&self, quiet: Duration, mut release: impl FnMut()) -> ! {
			let mut activity = self.activity.lock();
			loop {
				let Some(generation) = activity.pending() else {
					self.idle.wait(&mut activity);
					continue;
				};
				if !self.idle.wait_for(&mut activity, quiet).timed_out() {
					continue;
				}
				if activity.pending() != Some(generation) {
					continue;
				}
				activity.trimmed = generation;
				MutexGuard::unlocked(&mut activity, &mut release);
			}
		}
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	static TRIMMER: Trimmer = Trimmer::new();

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn begin() {
		static STARTED: std::sync::Once = std::sync::Once::new();
		STARTED.call_once(|| {
			// Without the thread nothing is trimmed; the work itself is
			// unaffected.
			let _ = std::thread::Builder::new()
				.name("pi-heap-trim".into())
				.stack_size(64 * 1024)
				.spawn(|| TRIMMER.run(QUIET_PERIOD, release_unused_pages));
			napi::bindgen_prelude::set_external_release_hook(super::released);
		});
		TRIMMER.begin();
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn end() {
		TRIMMER.end();
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn settled() {
		TRIMMER.settled();
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	fn release_unused_pages() {
		// SAFETY: malloc_trim is thread-safe, accepts any padding size, and only
		// releases free allocator pages; live allocations remain valid.
		unsafe {
			libc::malloc_trim(0);
		}
	}

	#[cfg(test)]
	mod tests {
		use std::sync::{Arc, mpsc};

		use super::*;

		/// Run a trimmer on its own thread; the thread outlives the test, parked.
		fn spawn_trimmer(quiet: Duration, release: impl FnMut() + Send + 'static) -> Arc<Trimmer> {
			let trimmer = Arc::new(Trimmer::new());
			let runner = Arc::clone(&trimmer);
			std::thread::spawn(move || runner.run(quiet, release));
			trimmer
		}

		#[test]
		fn trims_once_per_quiet_period_after_work_and_never_while_work_runs() {
			const QUIET: Duration = Duration::from_millis(50);
			let (trimmed_tx, trimmed) = mpsc::channel();
			let trimmer = spawn_trimmer(QUIET, move || trimmed_tx.send(()).unwrap());

			// Nothing has run yet, so there is nothing to trim.
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());

			// Overlapping jobs: the first ending must not trim under the second.
			trimmer.begin();
			trimmer.begin();
			trimmer.end();
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim after the quiet period");

			// Staying idle does not trim the same work again.
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());

			// A job still running when the quiet period ends defers the trim.
			trimmer.begin();
			trimmer.end();
			trimmer.begin();
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim once that job ends");
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
		}

		#[test]
		fn work_during_a_trim_neither_blocks_nor_goes_untrimmed() {
			const QUIET: Duration = Duration::from_millis(20);
			let (entered_tx, entered) = mpsc::channel();
			let (proceed_tx, proceed) = mpsc::channel::<()>();
			let trimmer = spawn_trimmer(QUIET, move || {
				entered_tx.send(()).unwrap();
				proceed.recv().unwrap();
			});

			trimmer.begin();
			trimmer.end();
			entered
				.recv_timeout(Duration::from_secs(10))
				.expect("first trim");
			// The first trim is still running: jobs must start and finish freely.
			trimmer.begin();
			trimmer.end();
			proceed_tx.send(()).unwrap();
			entered
				.recv_timeout(Duration::from_secs(10))
				.expect("trim covering the later job");
			proceed_tx.send(()).unwrap();
		}

		#[test]
		fn a_result_settled_after_the_trim_is_trimmed_again_but_not_under_running_work() {
			const QUIET: Duration = Duration::from_millis(50);
			let (trimmed_tx, trimmed) = mpsc::channel();
			let trimmer = spawn_trimmer(QUIET, move || trimmed_tx.send(()).unwrap());

			trimmer.begin();
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim after the job");
			// The JS thread converts the result late, freeing its allocations.
			trimmer.settled();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim after the result is freed");

			// A settlement while another job runs waits for that job.
			trimmer.begin();
			trimmer.settled();
			assert!(trimmed.recv_timeout(QUIET * 4).is_err());
			trimmer.end();
			trimmed
				.recv_timeout(Duration::from_secs(10))
				.expect("trim once the job ends");
		}
	}
}
