//! In-proc `Shell::create` + `:` ≤ 100 µs.
//!
//! One `Engine` is shared by every iteration (as a host process would share
//! it); each iteration gets a fresh `MemStore` and host, built outside the
//! timed region. Timed: `Shell::create` (startup variables, options,
//! root vproc), then `submit(":")` stepped to `Done` (lowering hits the
//! engine's unit cache after the first iteration), then the drop of the
//! shell (reported, no target). The shell keeps its default event mask
//! (`EventMask::DEFAULT`, as a host that does not choose one), delivered to a
//! null sink. Allocator: system, as `obash`.
//!
//! Run (release): `cango bench -p pi-shell --bench create`.
//! Output:
//!
//! ```text
//! create+run: median …µs, p99 …µs over 5000 iterations (target ≤ 100µs) PASS|MISS
//! create: median …, p99 …
//! run `:`: median …, p99 …
//! drop: median …, p99 …
//! ```

mod common;
#[path = "common/statistics.rs"]
mod statistics;

use std::{
	hint::black_box,
	time::{Duration, Instant},
};

use pi_shell::{
	bash::{Engine, EngineConfig, MemStore},
	testkit::FakeHost,
};

use crate::{
	common::{NullHost, new_shell, run, verdict},
	statistics::quantiles,
};

/// Timed iterations.
const ITERS: usize = 5_000;

/// Untimed iterations first (unit cache, allocator pages, lazy statics).
const WARMUP: usize = 200;

const MAX_TOTAL: Duration = Duration::from_micros(100);

fn main() {
	let engine = Engine::new(EngineConfig::default());
	let mut create = Vec::with_capacity(ITERS);
	let mut exec = Vec::with_capacity(ITERS);
	let mut drop_t = Vec::with_capacity(ITERS);
	let mut total = Vec::with_capacity(ITERS);
	for i in 0..WARMUP + ITERS {
		let mut host = NullHost(FakeHost::new());
		let mut store = MemStore::new();
		let t0 = Instant::now();
		let mut shell = new_shell(&engine, &mut host, &mut store);
		let t1 = Instant::now();
		let status = run(&mut shell, &mut host, &mut store, b":");
		let t2 = Instant::now();
		drop(black_box(shell));
		let t3 = Instant::now();
		assert_eq!(status, 0, "`:` succeeds");
		if i >= WARMUP {
			create.push(t1 - t0);
			exec.push(t2 - t1);
			total.push(t2 - t0);
			drop_t.push(t3 - t2);
		}
	}
	let (p50, p99) = quantiles(&mut total);
	println!(
		"create+run: median {p50:?}, p99 {p99:?} over {ITERS} iterations (target ≤ {MAX_TOTAL:?}) {}",
		verdict(p50 <= MAX_TOTAL && p99 <= MAX_TOTAL)
	);
	for (what, samples) in [("create", &mut create), ("run `:`", &mut exec), ("drop", &mut drop_t)] {
		let (p50, p99) = quantiles(samples);
		println!("{what}: median {p50:?}, p99 {p99:?}");
	}
}
