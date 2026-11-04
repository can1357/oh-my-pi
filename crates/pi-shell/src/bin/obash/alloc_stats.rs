//! Allocation counters for benchmarks (cargo feature `alloc-stats`,
//! measurement only).
//!
//! With the feature, the global allocator is [`Counting`]: the system allocator
//! plus relaxed process-wide counters. When `PI_SHELL_ALLOC_STATS=PATH` is set,
//! [`Report`] appends one line of totals to PATH as `main` returns:
//!
//! ```text
//! allocs=<n> reallocs=<n> frees=<n> bytes=<n> live=<n> peak_live=<n> argv=<obash arguments>
//! ```
//!
//! `bytes` is every byte requested by an allocation plus the growth of every
//! `realloc`; `live` is what is still allocated at exit, `peak_live` its
//! maximum over the run. Nested obash instances append their own lines (the
//! write is a single `O_APPEND` write). The default build keeps the plain
//! allocator, so timings never pay for the counters.

use std::{
	alloc::{GlobalAlloc, Layout, System},
	ffi::OsString,
	fs::OpenOptions,
	io::Write,
	sync::atomic::{AtomicUsize, Ordering},
};

/// Successful `alloc`/`alloc_zeroed` calls.
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
/// Successful `realloc` calls.
static REALLOCS: AtomicUsize = AtomicUsize::new(0);
/// `dealloc` calls.
static FREES: AtomicUsize = AtomicUsize::new(0);
/// Bytes requested by allocations plus `realloc` growth.
static BYTES: AtomicUsize = AtomicUsize::new(0);
/// Bytes currently allocated.
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// Maximum of [`LIVE`].
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(n: usize) {
	BYTES.fetch_add(n, Ordering::Relaxed);
	let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
	PEAK.fetch_max(live, Ordering::Relaxed);
}

fn shrank(n: usize) {
	LIVE.fetch_sub(n, Ordering::Relaxed);
}

/// System allocator with allocation counters under the `alloc-stats` feature.
pub struct Counting(pub System);

// SAFETY: every method forwards to System with its arguments unchanged and
// returns its result; the counter updates beside it never allocate.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc`'s contract.
		let ptr = unsafe { self.0.alloc(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			grew(layout.size());
		}
		ptr
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc_zeroed`'s
		// contract.
		let ptr = unsafe { self.0.alloc_zeroed(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			grew(layout.size());
		}
		ptr
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		FREES.fetch_add(1, Ordering::Relaxed);
		shrank(layout.size());
		// SAFETY: forwarded unchanged; `ptr` came from this allocator with
		// `layout` (the caller's `dealloc` contract).
		unsafe { self.0.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `realloc`'s
		// contract.
		let new = unsafe { self.0.realloc(ptr, layout, new_size) };
		if !new.is_null() {
			REALLOCS.fetch_add(1, Ordering::Relaxed);
			let old = layout.size();
			if new_size >= old {
				grew(new_size - old);
			} else {
				shrank(old - new_size);
			}
		}
		new
	}
}

/// Appends the counters to `PI_SHELL_ALLOC_STATS` when dropped; `main`
/// holds one for its whole body, so every return path reports.
pub struct Report {
	path: Option<OsString>,
}

impl Report {
	/// Reads `PI_SHELL_ALLOC_STATS`; unset means no report.
	pub fn from_env() -> Self {
		Self { path: std::env::var_os("PI_SHELL_ALLOC_STATS") }
	}
}

impl Drop for Report {
	fn drop(&mut self) {
		let Some(path) = self.path.take() else {
			return;
		};
		let (allocs, reallocs, frees, bytes, live, peak) = (
			ALLOCS.load(Ordering::Relaxed),
			REALLOCS.load(Ordering::Relaxed),
			FREES.load(Ordering::Relaxed),
			BYTES.load(Ordering::Relaxed),
			LIVE.load(Ordering::Relaxed),
			PEAK.load(Ordering::Relaxed),
		);
		let argv: Vec<String> = std::env::args_os()
			.skip(1)
			.map(|a| a.to_string_lossy().into_owned())
			.collect();
		let line = format!(
			"allocs={allocs} reallocs={reallocs} frees={frees} bytes={bytes} live={live} \
			 peak_live={peak} argv={}\n",
			argv.join(" ")
		);
		// A measurement aid: a failed write must not change the exit status.
		if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
			let _ = file.write_all(line.as_bytes());
		}
	}
}
