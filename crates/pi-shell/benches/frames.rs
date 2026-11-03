//! The `Frames` record of a shell stopped inside a `for`
//! loop at function depth 3, and the cost of writing and reading it.
//!
//! The case is `f1(){ f2; }; f2(){ f3; }; f3(){ for i in 1 2 3 4 5 6 7 8; do
//! :; done; }; f1`, stepped one op at a time to the safepoint right after the
//! loop's third `IterStart` inside `f3`, then suspended (`request_suspend` →
//! `SuspendReady`). Events are off while measuring (`FakeHost` would record
//! them as JSON).
//!
//! - **size**: `ExternalizeReport::bytes`, the `Frames` blob (header + image;
//!   unit blobs are separate records). Target ≤ 1 KiB.
//! - **externalize**: [`ITERS`] calls on the suspended shell (units are already
//!   written after the first). Target ≤ 30 µs median and p99.
//! - **restore**: [`ITERS`] `Shell::restore` calls, each into a fresh `Engine`
//!   (so the function and loop units are decoded from their blobs, as in a new
//!   process) over a fresh copy of the store image; the copy, the engine and
//!   the host are built outside the timed region. Target ≤ 60 µs median and
//!   p99.
//! - **validation**: one restored shell finishes the loop (iterations 4..=8)
//!   and the run with status 0, and holds no leaked tasks.
//! - **breakdown**: the blob size of the same loop at depths 0–3 and of a shell
//!   with no run, so a miss shows whether the per-shell base or the per-frame
//!   cost dominates.
//!
//! Run (release): `cango bench -p pi-shell --bench frames`.
//! Output: one `frames …` line per measurement with `PASS`/`MISS` against its
//! target, then the breakdown.

use std::{
	hint::black_box,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	time::{Duration, Instant},
};

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Event, EventData, EventKind, EventMask, MemStore,
		RestoreOpts, RunId, Script, Shell, Step, Verdict,
	},
	testkit::{
		FakeHost,
		fault::skeleton_init,
		run::{Stop, advance},
	},
};

/// The gate's case: a `for` loop at function depth 3.
const DEPTH_3: &[u8] =
	b"f1(){ f2; }; f2(){ f3; }; f3(){ for i in 1 2 3 4 5 6 7 8; do :; done; }; f1";

/// The same loop at depths 0, 1 and 2 (breakdown).
const SHALLOWER: [&[u8]; 3] = [
	b"for i in 1 2 3 4 5 6 7 8; do :; done",
	b"f3(){ for i in 1 2 3 4 5 6 7 8; do :; done; }; f3",
	b"f2(){ f3; }; f3(){ for i in 1 2 3 4 5 6 7 8; do :; done; }; f2",
];

/// The loop iteration the snapshot is taken in.
const AT_ITER: u32 = 3;

/// Timed calls per measurement.
const ITERS: usize = 2_000;

const MAX_BYTES: usize = 1024;
const MAX_EXTERNALIZE: Duration = Duration::from_micros(30);
const MAX_RESTORE: Duration = Duration::from_micros(60);

/// Function depth and loop iteration seen in events.
#[derive(Clone, Default)]
struct Seen {
	depth: Arc<AtomicU32>,
	iter:  Arc<AtomicU32>,
}

impl Seen {
	/// A host that records the depth and iteration of the events it sees.
	fn host(&self) -> FakeHost {
		let mut host = FakeHost::new();
		let seen = self.clone();
		host.on_event(Box::new(move |ev: &Event<'_>| {
			match ev.data {
				EventData::FuncEnter { depth, .. } => seen.depth.store(depth, Ordering::Relaxed),
				EventData::IterStart { n, .. } => seen.iter.store(n, Ordering::Relaxed),
				_ => {},
			}
			Verdict::Continue
		}));
		host
	}
}

/// The events [`Seen`] needs.
const TRACKED: EventMask = EventMask::of(EventKind::FuncEnter).with(EventKind::IterStart);

/// A suspended shell running `src`, stopped right after iteration
/// [`AT_ITER`] of its loop started at function depth `depth`.
fn at_safepoint(
	engine: &Arc<Engine>,
	src: &'static [u8],
	depth: u32,
) -> (Shell, FakeHost, MemStore, RunId) {
	let seen = Seen::default();
	let mut host = seen.host();
	let mut store = MemStore::new();
	let mut shell =
		Shell::create(engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("create");
	shell.set_event_mask(TRACKED);
	let run = shell.submit(Script::command(src));
	let one_op = Budget { max_ops: 1, max_ns: u64::MAX };
	loop {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, one_op) {
			Step::Yield
				if seen.depth.load(Ordering::Relaxed) == depth
					&& seen.iter.load(Ordering::Relaxed) == AT_ITER =>
			{
				break;
			},
			Step::Yield => {},
			other => panic!("{other:?} before the safepoint"),
		}
	}
	shell.set_event_mask(EventMask::NONE);
	shell.control().request_suspend();
	let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default());
	assert!(matches!(step, Step::SuspendReady), "suspend at the safepoint, got {step:?}");
	(shell, host, store, run)
}

/// Median and p99 of `samples`.
fn quantiles(samples: &mut [Duration]) -> (Duration, Duration) {
	samples.sort_unstable();
	(samples[samples.len() / 2], samples[samples.len() * 99 / 100])
}

const fn verdict(ok: bool) -> &'static str {
	if ok { "PASS" } else { "MISS" }
}

fn report_time(what: &str, samples: &mut [Duration], max: Duration) {
	let (p50, p99) = quantiles(samples);
	println!(
		"frames {what}: median {p50:?}, p99 {p99:?} over {} calls (target ≤ {max:?}) {}",
		samples.len(),
		verdict(p50 <= max && p99 <= max)
	);
}

/// Blob size of a fresh externalize of `shell`.
fn blob_bytes(shell: &mut Shell, host: &mut FakeHost, store: &mut MemStore) -> usize {
	shell
		.externalize(&mut Cx { host, store })
		.expect("externalize")
		.bytes
}

fn main() {
	let engine = Engine::new(EngineConfig::default());
	let (mut shell, mut host, mut store, run) = at_safepoint(&engine, DEPTH_3, 3);

	let first = shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("externalize");
	println!(
		"frames blob: {} bytes (target ≤ {MAX_BYTES}) {}; first externalize wrote {} unit blobs, {} \
		 lost entries (host stdio)",
		first.bytes,
		verdict(first.bytes <= MAX_BYTES),
		first.units_written,
		first.lost.len()
	);

	let mut samples = Vec::with_capacity(ITERS);
	for _ in 0..ITERS {
		let t = Instant::now();
		let report = shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.expect("externalize");
		samples.push(t.elapsed());
		black_box(report);
	}
	report_time("externalize", &mut samples, MAX_EXTERNALIZE);

	let image = store.to_bytes();
	samples.clear();
	for _ in 0..ITERS {
		let mut store = MemStore::from_bytes(&image).expect("store image decodes");
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let t = Instant::now();
		let restored = Shell::restore(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.expect("restore");
		samples.push(t.elapsed());
		black_box(&restored.1);
		drop(restored);
	}
	report_time("restore (fresh engine)", &mut samples, MAX_RESTORE);

	// Validation: the restored loop goes on from iteration 4 to 8 and the run
	// ends normally.
	let mut store = MemStore::from_bytes(&image).expect("store image decodes");
	let engine = Engine::new(EngineConfig::default());
	let seen = Seen::default();
	let mut host = seen.host();
	let (mut restored, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("restore");
	assert_eq!(report.runs, 1, "the run is restored");
	restored.set_event_mask(TRACKED);
	let status = advance(&mut restored, &mut host, &mut store, run, Budget::default());
	assert_eq!(status, Stop::Done(0), "the restored run finishes");
	assert_eq!(seen.iter.load(Ordering::Relaxed), 8, "the loop ran to its last iteration");
	host.assert_no_leaks(&mut restored, &mut store);
	println!("frames validation: restored run finished the loop with status 0");

	// Breakdown.
	let mut idle_host = FakeHost::new();
	let mut idle_store = MemStore::new();
	let mut idle = Shell::create(
		&engine,
		&mut Cx { host: &mut idle_host, store: &mut idle_store },
		skeleton_init(&[]),
	)
	.expect("create");
	idle.set_event_mask(EventMask::NONE);
	let base = blob_bytes(&mut idle, &mut idle_host, &mut idle_store);
	let mut sizes = Vec::with_capacity(4);
	for (depth, src) in SHALLOWER.into_iter().enumerate() {
		let (mut s, mut h, mut st, _) = at_safepoint(&engine, src, depth as u32);
		sizes.push(blob_bytes(&mut s, &mut h, &mut st));
	}
	sizes.push(first.bytes);
	println!("frames breakdown: shell without a run {base} bytes");
	for (depth, bytes) in sizes.iter().enumerate() {
		let step = if depth == 0 {
			bytes.saturating_sub(base)
		} else {
			bytes.saturating_sub(sizes[depth - 1])
		};
		println!("frames breakdown: loop at depth {depth}: {bytes} bytes (+{step})");
	}
}
