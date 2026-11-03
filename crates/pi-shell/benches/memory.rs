//! Memory rows and allocation counts, with a counting global
//! allocator (mimalloc underneath, as `obash`):
//!
//! - **shell**: live bytes the `Shell` owns after `Shell::create` + `:`,
//!   measured as the bytes its drop frees (the shared engine's unit cache and
//!   the store are not the shell's). Target ≤ 64 KiB. The store's growth and
//!   the allocations of create + `:` are printed beside it.
//! - **idle vprocs**: `idle &` in a loop, where `idle` is a host task that
//!   stays pending until signalled (a `sleep` without a timer). Once every
//!   vproc is blocked, the shell's bytes are measured as above, for [`FEW`] and
//!   [`MANY`] vprocs; per vproc = difference / ([`MANY`] − [`FEW`]) (vproc, job
//!   entry, task handle). Target ≤ 2 KiB. The line after it breaks the
//!   difference down by allocation size (8-byte classes, live allocations per
//!   vproc), which names the structures that cost the bytes; the `memory
//!   sizes:` line gives `size_of` of the engine structures an idle vproc holds
//!   (`pi_shell::bash::vproc_layout`), to match against those classes.
//! - **allocs**: allocations, reallocations and bytes per iteration of the
//!   loop/func/strops workloads with `EventMask::NONE` (the event-off path) and
//!   `DEFAULT` into a null sink, from two runs of different length on a warm
//!   engine (so compilation cancels out).
//!
//! Run (release): `cango bench -p pi-shell --bench memory`.
//! Output:
//!
//! ```text
//! memory shell: … bytes after create + `:` (target ≤ 65536) PASS|MISS; store +… bytes; create + `:` … allocs, … bytes
//! memory idle vprocs: 16 → … bytes, 272 → … bytes; … bytes per vproc (target ≤ 2048) PASS|MISS
//! memory idle vproc allocations by size: 24-31 B ×1.00, …
//! memory sizes: Vproc … B, Frame … B, Scratch … B, ScratchIo … B, ExecState … B…
//! allocs loop NONE: … allocs/iter, … reallocs/iter, … bytes/iter; per run … allocs
//! …
//! ```

mod common;
mod workloads;

use std::{
	alloc::{GlobalAlloc, Layout},
	fmt::Write as _,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	task::{Context, Poll, Waker},
};

use bstr::BString;
use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, EventMask, MemStore, Platform, Script, Shell, Signal, Step, Task,
		vproc_layout,
	},
	testkit::{FakeHost, NativeFn},
};

use crate::{
	common::{NullHost, UNBOUNDED, new_shell, run, verdict},
	workloads::Workload,
};

static ALLOCS: AtomicUsize = AtomicUsize::new(0);
static REALLOCS: AtomicUsize = AtomicUsize::new(0);
static BYTES: AtomicUsize = AtomicUsize::new(0);
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// Size classes of [`SIZES`]: 8 bytes wide, the last one holds everything
/// from `8 * (CLASSES - 1)` bytes up.
const CLASSES: usize = 129;

/// Live allocations per size class.
static SIZES: [AtomicUsize; CLASSES] = [const { AtomicUsize::new(0) }; CLASSES];

/// Size class of an allocation of `size` bytes.
const fn class(size: usize) -> usize {
	let c = size / 8;
	if c < CLASSES { c } else { CLASSES - 1 }
}

/// The live allocations per size class now.
fn sizes() -> [usize; CLASSES] {
	std::array::from_fn(|c| SIZES[c].load(Ordering::Relaxed))
}

/// mimalloc with counters.
struct Counting(mimalloc::MiMalloc);

// SAFETY: every method forwards to mimalloc with its arguments unchanged and
// returns its result; the counter updates never allocate.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc`'s contract.
		let ptr = unsafe { self.0.alloc(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			BYTES.fetch_add(layout.size(), Ordering::Relaxed);
			LIVE.fetch_add(layout.size(), Ordering::Relaxed);
			SIZES[class(layout.size())].fetch_add(1, Ordering::Relaxed);
		}
		ptr
	}

	unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `alloc_zeroed`'s
		// contract.
		let ptr = unsafe { self.0.alloc_zeroed(layout) };
		if !ptr.is_null() {
			ALLOCS.fetch_add(1, Ordering::Relaxed);
			BYTES.fetch_add(layout.size(), Ordering::Relaxed);
			LIVE.fetch_add(layout.size(), Ordering::Relaxed);
			SIZES[class(layout.size())].fetch_add(1, Ordering::Relaxed);
		}
		ptr
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
		SIZES[class(layout.size())].fetch_sub(1, Ordering::Relaxed);
		// SAFETY: forwarded unchanged; `ptr` came from this allocator with
		// `layout`.
		unsafe { self.0.dealloc(ptr, layout) }
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		// SAFETY: forwarded unchanged; the caller upholds `realloc`'s
		// contract.
		let new = unsafe { self.0.realloc(ptr, layout, new_size) };
		if !new.is_null() {
			REALLOCS.fetch_add(1, Ordering::Relaxed);
			let old = layout.size();
			SIZES[class(old)].fetch_sub(1, Ordering::Relaxed);
			SIZES[class(new_size)].fetch_add(1, Ordering::Relaxed);
			if new_size >= old {
				BYTES.fetch_add(new_size - old, Ordering::Relaxed);
				LIVE.fetch_add(new_size - old, Ordering::Relaxed);
			} else {
				LIVE.fetch_sub(old - new_size, Ordering::Relaxed);
			}
		}
		new
	}
}

#[global_allocator]
static GLOBAL: Counting = Counting(mimalloc::MiMalloc);

/// The counters at one point.
#[derive(Clone, Copy)]
struct Counts {
	allocs:   usize,
	reallocs: usize,
	bytes:    usize,
}

impl Counts {
	fn now() -> Self {
		Self {
			allocs:   ALLOCS.load(Ordering::Relaxed),
			reallocs: REALLOCS.load(Ordering::Relaxed),
			bytes:    BYTES.load(Ordering::Relaxed),
		}
	}

	/// What happened since `before`.
	const fn since(self, before: Self) -> Self {
		Self {
			allocs:   self.allocs - before.allocs,
			reallocs: self.reallocs - before.reallocs,
			bytes:    self.bytes - before.bytes,
		}
	}
}

fn live() -> usize {
	LIVE.load(Ordering::Relaxed)
}

const MAX_SHELL_BYTES: usize = 64 * 1024;
const MAX_VPROC_BYTES: usize = 2 * 1024;

/// Idle vprocs in the small and the large case.
const FEW: u32 = 16;
const MANY: u32 = 272;

/// Iterations of the short and the long allocation run.
const SHORT: u32 = 1_000;
const LONG: u32 = 3_000;

/// A task that stays pending until signalled; holds no timer and never
/// wakes itself.
struct Idle {
	waker:  Option<Waker>,
	status: Option<i32>,
}

impl Task for Idle {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<i32> {
		if let Some(status) = self.status {
			return Poll::Ready(status);
		}
		self.waker = Some(cx.waker().clone());
		Poll::Pending
	}

	fn signal(&mut self, sig: Signal) {
		self.status = Some(128 + i32::from(sig.number(Platform::Linux)));
		if let Some(w) = self.waker.take() {
			w.wake();
		}
	}
}

fn idle_host() -> NullHost {
	let mut host = FakeHost::new();
	let make: NativeFn =
		Arc::new(|_: &[BString]| Box::new(Idle { waker: None, status: None }) as Box<dyn Task>);
	host.native("idle", make, None);
	NullHost(host)
}

/// Bytes a shell owns: what dropping it frees.
fn owned(shell: Shell) -> usize {
	let before = live();
	drop(shell);
	before.saturating_sub(live())
}

/// The bytes of a shell after `:` and `n` idle background vprocs, and the
/// process's live allocations per size class just before its drop.
fn with_idle(engine: &Arc<Engine>, n: u32) -> (usize, [usize; CLASSES]) {
	let src = format!(r#"i=0; while [ "$i" -lt {n} ]; do idle & i=$((i+1)); done"#);
	let mut host = idle_host();
	let mut store = MemStore::new();
	let mut shell = new_shell(engine, &mut host, &mut store);
	shell.set_event_mask(EventMask::NONE);
	assert_eq!(run(&mut shell, &mut host, &mut store, b":"), 0, "`:` succeeds");
	let id = shell.submit(Script::command(src.into_bytes()));
	let mut done = false;
	loop {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, UNBOUNDED) {
			Step::Done { run, status } if run == id => {
				assert_eq!(status, 0, "the loop succeeds");
				done = true;
			},
			Step::Done { .. } | Step::Yield => {},
			Step::Blocked if done => break,
			other => panic!("{other:?} while starting {n} idle vprocs"),
		}
	}
	assert_eq!(host.0.live_tasks(), n as usize, "every idle vproc holds its task");
	let live = sizes();
	let bytes = owned(shell);
	host.0.assert_released();
	(bytes, live)
}

fn main() {
	let engine = Engine::new(EngineConfig::default());

	// Shell baseline. Warm first: lazy statics, the engine's unit cache.
	for _ in 0..2 {
		let mut host = NullHost(FakeHost::new());
		let mut store = MemStore::new();
		let mut shell = new_shell(&engine, &mut host, &mut store);
		run(&mut shell, &mut host, &mut store, b":");
	}
	let mut host = NullHost(FakeHost::new());
	let mut store = MemStore::new();
	let (live0, c0) = (live(), Counts::now());
	let mut shell = new_shell(&engine, &mut host, &mut store);
	assert_eq!(run(&mut shell, &mut host, &mut store, b":"), 0, "`:` succeeds");
	let work = Counts::now().since(c0);
	let shell_bytes = owned(shell);
	let store_bytes = live().saturating_sub(live0);
	println!(
		"memory shell: {shell_bytes} bytes after create + `:` (target ≤ {MAX_SHELL_BYTES}) {}; \
		 store +{store_bytes} bytes; create + `:` {} allocs, {} reallocs, {} bytes",
		verdict(shell_bytes <= MAX_SHELL_BYTES),
		work.allocs,
		work.reallocs,
		work.bytes
	);

	// Idle vprocs (each size once untimed, so its loop unit is cached).
	with_idle(&engine, FEW);
	with_idle(&engine, MANY);
	let (few, few_sizes) = with_idle(&engine, FEW);
	let (many, many_sizes) = with_idle(&engine, MANY);
	let per = many.saturating_sub(few) / (MANY - FEW) as usize;
	println!(
		"memory idle vprocs: {FEW} → {few} bytes, {MANY} → {many} bytes; {per} bytes per vproc \
		 (target ≤ {MAX_VPROC_BYTES}) {}",
		verdict(per <= MAX_VPROC_BYTES)
	);
	let mut breakdown = String::new();
	for (c, (&m, &f)) in many_sizes.iter().zip(&few_sizes).enumerate() {
		let per_vproc = (m as f64 - f as f64) / f64::from(MANY - FEW);
		if per_vproc.abs() >= 0.05 {
			let (lo, hi) = (c * 8, c * 8 + 7);
			let range = if c + 1 == CLASSES {
				format!("≥{lo} B")
			} else {
				format!("{lo}-{hi} B")
			};
			let _ = write!(breakdown, " {range} ×{per_vproc:.2},");
		}
	}
	println!("memory idle vproc allocations by size:{}", breakdown.trim_end_matches(','));
	let mut sizes = String::new();
	for (name, bytes) in vproc_layout() {
		let _ = write!(sizes, " {name} {bytes} B,");
	}
	println!("memory sizes:{}", sizes.trim_end_matches(','));

	// Allocations per iteration.
	for workload in [Workload::Loop, Workload::Func, Workload::Strops] {
		let (short, long) = (workload.script(SHORT), workload.script(LONG));
		for (mask_name, mask) in [("NONE", EventMask::NONE), ("DEFAULT", EventMask::DEFAULT)] {
			let counts = |src: &[u8]| {
				let mut host = NullHost(FakeHost::new());
				let mut store = MemStore::new();
				let mut shell = new_shell(&engine, &mut host, &mut store);
				shell.set_event_mask(mask);
				let before = Counts::now();
				assert_eq!(run(&mut shell, &mut host, &mut store, src), 0, "the workload succeeds");
				Counts::now().since(before)
			};
			counts(short.as_slice());
			counts(long.as_slice());
			let (a, b) = (counts(short.as_slice()), counts(long.as_slice()));
			let iters = f64::from(LONG - SHORT);
			let per_iter = |x: usize, y: usize| y.saturating_sub(x) as f64 / iters;
			let allocs = per_iter(a.allocs, b.allocs);
			println!(
				"allocs {} {mask_name}: {allocs:.2} allocs/iter, {:.2} reallocs/iter, {:.1} \
				 bytes/iter; per run {:.0} allocs",
				workload.name(),
				per_iter(a.reallocs, b.reallocs),
				per_iter(a.bytes, b.bytes),
				allocs.mul_add(-f64::from(SHORT), a.allocs as f64)
			);
		}
	}
}
