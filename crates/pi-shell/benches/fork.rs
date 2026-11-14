//! Fork cost against the size of the shell state.
//!
//! Each row runs one loop on a shell holding [`SMALL`] and then [`LARGE`]
//! global variables (plus one function per ten), and reports the time per
//! iteration (median over [`ROUNDS`] runs, each on a fresh shell and store
//! built untimed). The fork rows subtract the same loop without the fork
//! (`:` for `( : )`, `x=` for `x=$(:)`), leaving the fork's own cost. A fork
//! must not copy the parent's state, so a row passes when the large state costs
//! at most [`MAX_RATIO`] times the small one.
//!
//! - **subshell**: `( : )` per iteration.
//! - **cmdsub**: `x=$(:)` per iteration.
//! - **cmdsub+bg**: the same while a background job forked first is still
//!   running and the loop writes a global each iteration (a child holding an
//!   old view of the state must not make the next fork copy it).
//! - **child loop**: one subshell reading two globals and writing one per
//!   iteration (a child's own reads and writes; not net of anything).
//! - **store clone**: `MemStore::clone` of the populated store (a session's
//!   published image), per clone.
//!
//! Run (release): `cargo bench -p pi-shell --bench fork`.
//! Output: one `fork <row>: N=… …µs, N=… …µs (×r, target ≤ ×…) PASS|MISS`
//! line per row.

mod common;
#[path = "common/statistics.rs"]
mod statistics;

use std::{
	fmt::Write as _,
	hint::black_box,
	sync::Arc,
	task::{Context, Poll, Waker},
	time::{Duration, Instant},
};

use bstr::BString;
use pi_shell::{
	bash::{
		Cx, Engine, EngineConfig, EventMask, MemStore, Platform, Script, Shell, Signal, Step, Task,
	},
	testkit::{FakeHost, NativeFn},
};

use crate::{
	common::{NullHost, UNBOUNDED, new_shell, run, verdict},
	statistics::quantiles,
};

const SMALL: u32 = 10;
const LARGE: u32 = 5_000;
const ITERS: u32 = 2_000;
const ROUNDS: usize = 15;
const MAX_RATIO: f64 = 1.5;

/// A background job that stays pending until signalled.
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

fn host() -> NullHost {
	let mut host = FakeHost::new();
	let make: NativeFn =
		Arc::new(|_: &[BString]| Box::new(Idle { waker: None, status: None }) as Box<dyn Task>);
	host.native("idle", make, None);
	NullHost(host)
}

/// `n` globals and `n / 10` functions.
fn populate(n: u32) -> Vec<u8> {
	let mut src = String::new();
	for i in 0..n {
		let _ = write!(src, "v{i}=value{i}; ");
		if i % 10 == 0 {
			let _ = write!(src, "f{i}() {{ echo {i}; }}; ");
		}
	}
	src.push(':');
	src.into_bytes()
}

/// A shell holding `n` globals, its host and store.
fn shell(engine: &Arc<Engine>, n: u32) -> (Shell, NullHost, MemStore) {
	let mut host = host();
	let mut store = MemStore::new();
	let mut shell = new_shell(engine, &mut host, &mut store);
	shell.set_event_mask(EventMask::NONE);
	assert_eq!(run(&mut shell, &mut host, &mut store, &populate(n)), 0, "populate");
	(shell, host, store)
}

/// Run `src` to its end, ignoring background vprocs left blocked.
fn run_to_done(shell: &mut Shell, host: &mut NullHost, store: &mut MemStore, src: &[u8]) {
	let id = shell.submit(Script::command(src));
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, UNBOUNDED) {
			Step::Done { run, status } if run == id => {
				assert_eq!(status, 0, "the loop succeeds");
				return;
			},
			Step::Done { .. } | Step::Yield | Step::Blocked => {},
			other => panic!("{other:?} while running the loop"),
		}
	}
}

/// Median time per iteration of `src` on a shell holding `n` globals;
/// `prelude` runs untimed first.
fn per_iter(engine: &Arc<Engine>, n: u32, prelude: &[u8], src: &[u8]) -> Duration {
	let mut samples = Vec::with_capacity(ROUNDS);
	for _ in 0..ROUNDS + 2 {
		let (mut sh, mut host, mut store) = shell(engine, n);
		if !prelude.is_empty() {
			run_to_done(&mut sh, &mut host, &mut store, prelude);
		}
		let t = Instant::now();
		run_to_done(&mut sh, &mut host, &mut store, src);
		samples.push(t.elapsed() / ITERS);
		drop(black_box(sh));
	}
	samples.drain(..2);
	quantiles(&mut samples).0
}

/// Median time of one `MemStore::clone` of a store holding `n` globals.
fn clone_time(engine: &Arc<Engine>, n: u32) -> Duration {
	let (_sh, _host, store) = shell(engine, n);
	let mut samples: Vec<Duration> = (0..ROUNDS * 20)
		.map(|_| {
			let t = Instant::now();
			let copy = black_box(store.clone());
			let elapsed = t.elapsed();
			drop(copy);
			elapsed
		})
		.collect();
	quantiles(&mut samples).0
}

fn report(row: &str, small: Duration, large: Duration) {
	let ratio = large.as_secs_f64() / small.as_secs_f64().max(1e-12);
	println!(
		"fork {row}: N={SMALL} {:.2}µs, N={LARGE} {:.2}µs (×{ratio:.2}, target ≤ ×{MAX_RATIO}) {}",
		small.as_secs_f64() * 1e6,
		large.as_secs_f64() * 1e6,
		verdict(ratio <= MAX_RATIO)
	);
}

fn main() {
	let engine = Engine::new(EngineConfig::default());
	let lp = |body: &str| format!(r#"i=0; while [ "$i" -lt {ITERS} ]; do {body}; i=$((i+1)); done"#);
	let net = |n: u32, prelude: &str, body: &str, control: &str| {
		let with = per_iter(&engine, n, prelude.as_bytes(), lp(body).as_bytes());
		let without = per_iter(&engine, n, prelude.as_bytes(), lp(control).as_bytes());
		with.saturating_sub(without)
	};
	let forks: [(&str, &str, &str, &str); 3] = [
		("subshell", "", "( : )", ":"),
		("cmdsub", "", "x=$(:)", "x="),
		("cmdsub+bg", "idle &", "g=$i; x=$(:)", "g=$i; x="),
	];
	for (row, prelude, body, control) in forks {
		report(row, net(SMALL, prelude, body, control), net(LARGE, prelude, body, control));
	}
	let child = format!("( {} )", lp(r"y=$v1$v7; g=$i"));
	report(
		"child loop",
		per_iter(&engine, SMALL, b"", child.as_bytes()),
		per_iter(&engine, LARGE, b"", child.as_bytes()),
	);
	report("store clone", clone_time(&engine, SMALL), clone_time(&engine, LARGE));
}
