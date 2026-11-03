//! `cancel(TERM)` of a running shell, over [`RUNS`] fresh shells:
//!
//! - a busy loop without traps ends with status 143;
//! - with a TERM trap installed and only virtual procs (a busy loop at function
//!   depth 3 plus two busy background vprocs), the trap runs exactly once,
//!   every vproc unwinds, status 143, and nothing leaks
//!   ([`FakeHost::assert_no_leaks`]).
//!
//! Latency (the `cancel` call on another thread to `Step::Done` on the
//! stepping thread) is printed, never asserted: it measures the machine as
//! much as the engine. For representative numbers run in release:
//! `cango test --release -p pi-shell --lib testkit::suites::cancel_latency --
//! --nocapture --test-threads 1`. Each test prints `cancel(TERM) latency
//! <case> over N runs: p50 …, p99 …, max …`. Events are off (see below).

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use crate::{
	bash::{Budget, Cx, Engine, EngineConfig, EventMask, MemStore, Script, Shell, Signal, Step},
	testkit::{FakeHost, fault::skeleton_init},
};

const RUNS: usize = 300;

#[test]
fn cancel_term_ends_a_busy_loop() {
	measure("busy loop", b"while true; do :; done", b"");
}

/// The trap runs in the root vproc only: subshells reset caught signals, so
/// the background vprocs are killed without it.
#[test]
fn cancel_term_with_a_trap_unwinds_depth_3_and_background_vprocs() {
	measure(
		"trap, depth 3, 2 background vprocs",
		b"trap 'echo trapped' TERM\nf1() { f2; }; f2() { f3; }; f3() { while :; do :; done; }\n{ \
		  while :; do :; done; } &\n( while :; do :; done ) &\nf1\n",
		b"trapped\n",
	);
}

/// Cancel `src` with TERM once it runs, [`RUNS`] times; check status 143,
/// stdout `out` (the trap's output) and no leaks; print the latency.
fn measure(case: &str, src: &'static [u8], out: &[u8]) {
	let engine = Engine::new(EngineConfig::default());
	let mut lat = Vec::with_capacity(RUNS);
	for _ in 0..RUNS {
		let mut host = FakeHost::new();
		let stdout = host.stdout.clone();
		let mut store = MemStore::new();
		let mut shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
				.unwrap();
		// FakeHost keeps every event as JSON; a busy loop would make that
		// the measurement. Cancellation is checked per op regardless of mask.
		shell.set_event_mask(EventMask::NONE);
		let id = shell.submit(Script::command(src));
		let ctl = shell.control();
		let started = Arc::new(AtomicBool::new(false));
		let flag = Arc::clone(&started);
		let stepper = thread::spawn(move || {
			let mut ops = 0u64;
			loop {
				match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
					Step::Done { run, status } if run == id => {
						return (status, Instant::now(), ops, shell, host, store);
					},
					Step::Yield => {
						ops += 1;
						flag.store(true, Ordering::Release);
					},
					other => panic!("unexpected {other:?}"),
				}
			}
		});
		while !started.load(Ordering::Acquire) {
			thread::yield_now();
		}
		thread::sleep(Duration::from_micros(300));
		let t0 = Instant::now();
		ctl.cancel(Signal::Term);
		let (status, done, turns, mut shell, mut host, mut store) = stepper.join().unwrap();
		lat.push(done.duration_since(t0));
		assert_eq!(status, 143, "TERM ends the run with 128 + 15");
		assert!(turns > 0);
		assert_eq!(
			String::from_utf8_lossy(&stdout.bytes()),
			String::from_utf8_lossy(out),
			"the trap runs exactly once"
		);
		host.assert_no_leaks(&mut shell, &mut store);
	}
	lat.sort();
	let p50 = lat[RUNS / 2];
	let p99 = lat[RUNS * 99 / 100];
	println!(
		"cancel(TERM) latency {case} over {RUNS} runs: p50 {p50:?}, p99 {p99:?}, max {:?}",
		lat[RUNS - 1]
	);
}
