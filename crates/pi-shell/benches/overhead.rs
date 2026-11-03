//! Overhead rows, in-proc on the kit's loop/func/strops
//! workloads (smaller iteration counts, same scripts):
//!
//! - **events**: each run with `EventMask::NONE`, `DEFAULT` and `ALL`, every
//!   event delivered to a null sink (`common::NullHost`; `FakeHost` would
//!   serialize each event to JSON). Targets: DEFAULT ≤ 5 % and ALL ≤ 25 % over
//!   NONE.
//! - **safepoint**: the NONE runs of the default build against a build without
//!   the per-op control-word check (feature `no-safepoint-check`). Target ≤ 3
//!   %.
//!
//! Timing between identical runs moves by about ±2 %, as much as the targets
//! allow, and the two builds also differ in code layout. So every run (one
//! build) appends its per-workload medians, plus the user-space instructions
//! of one counted run per mode (Linux `perf_event_open`; `-` where the
//! kernel refuses a counter), to
//! `$CARGO_TARGET_TMPDIR/pi-shell-overhead-runs.txt`, and prints the rows
//! over every run in that file: the median over runs of each run's median
//! ratio, the spread of those ratios (min..max), and the instruction ratio
//! (median over runs). A row passes when the time ratio is within its
//! target, or when the instruction ratio is within it and the time ratio
//! exceeds it by no more than the spread (the excess is noise: instructions
//! do not vary between runs). Delete the file to start a measurement;
//! alternate the builds, five runs each:
//!
//! ```text
//! rm -f target/tmp/pi-shell-overhead-runs.txt
//! for r in 1 2 3 4 5; do
//!   cango bench -p pi-shell --bench overhead
//!   cango bench -p pi-shell --features no-safepoint-check --bench overhead
//! done
//! ```
//!
//! Each sample is one run on a fresh shell and store (built untimed) over a
//! shared engine; modes rotate within each round so drift hits all three.
//! Output of a run, then of every run so far:
//!
//! ```text
//! run loop (check): NONE …ms; DEFAULT +x.x% (instructions +i.i%); ALL +y.y% (instructions +j.j%)
//! overhead loop DEFAULT: +x.x% over 5 runs (spread a..b), instructions +i.i% (target ≤ 5%) PASS|MISS
//! overhead loop ALL: +y.y% over 5 runs (spread a..b), instructions +j.j% (target ≤ 25%) PASS|MISS
//! safepoint loop: +z.z% (5 runs each, spread a..b), instructions +k.k% (target ≤ 3%) PASS|MISS
//! ```

mod common;
mod workloads;

use std::{
	fmt::Write as _,
	time::{Duration, Instant},
};

use pi_shell::{
	bash::{Engine, EngineConfig, EventMask, MemStore},
	testkit::FakeHost,
};

use crate::{
	common::{NullHost, new_shell, run, verdict},
	workloads::Workload,
};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Workloads and iterations per run (≈ 30–100 ms each in release).
const WORKLOADS: [(Workload, u32); 3] =
	[(Workload::Loop, 100_000), (Workload::Func, 60_000), (Workload::Strops, 60_000)];

/// Timed rounds; one run per mode each.
const ROUNDS: usize = 21;

const MODES: [(&str, EventMask); 3] =
	[("NONE", EventMask::NONE), ("DEFAULT", EventMask::DEFAULT), ("ALL", EventMask::ALL)];

const MAX_DEFAULT_PCT: f64 = 5.0;
const MAX_ALL_PCT: f64 = 25.0;
const MAX_SAFEPOINT_PCT: f64 = 3.0;

/// Built without the per-op control-word check.
const NO_SAFEPOINT_CHECK: bool = cfg!(feature = "no-safepoint-check");

/// The runs of both builds, one line per run and workload.
const RUNS: &str = concat!(env!("CARGO_TARGET_TMPDIR"), "/pi-shell-overhead-runs.txt");

/// User-space instruction counts of this thread (Linux performance
/// counters).
#[cfg(target_os = "linux")]
mod counter {
	/// `perf_event_attr` up to `PERF_ATTR_SIZE_VER0` (64 bytes): all a
	/// counting event needs.
	#[repr(C)]
	#[derive(Default)]
	struct Attr {
		kind:          u32,
		size:          u32,
		config:        u64,
		sample_period: u64,
		sample_type:   u64,
		read_format:   u64,
		flags:         u64,
		wakeup_events: u32,
		bp_type:       u32,
		config1:       u64,
	}

	const PERF_TYPE_HARDWARE: u32 = 0;
	const PERF_COUNT_HW_INSTRUCTIONS: u64 = 1;
	/// `disabled`, `exclude_kernel`, `exclude_hv`.
	const FLAGS: u64 = 1 | (1 << 5) | (1 << 6);
	const IOC_ENABLE: u64 = 0x2400;
	const IOC_DISABLE: u64 = 0x2401;

	/// Run `f`; the user-space instructions this thread retired meanwhile,
	/// `None` when the kernel refuses a counter (`perf_event_paranoid`, no
	/// PMU in a VM).
	pub fn instructions<R>(f: impl FnOnce() -> R) -> (R, Option<u64>) {
		let attr = Attr {
			kind: PERF_TYPE_HARDWARE,
			size: size_of::<Attr>() as u32,
			config: PERF_COUNT_HW_INSTRUCTIONS,
			flags: FLAGS,
			..Attr::default()
		};
		// pid 0 and cpu -1: this thread, on any cpu; no group, no flags.
		let (pid, cpu, group, flags): (libc::c_long, libc::c_long, libc::c_long, libc::c_long) =
			(0, -1, -1, 0);
		// SAFETY: `attr` is a valid VER0 attribute, alive for the call.
		let fd = unsafe {
			libc::syscall(libc::SYS_perf_event_open, &raw const attr, pid, cpu, group, flags)
		};
		let Ok(fd) = libc::c_int::try_from(fd) else {
			return (f(), None);
		};
		if fd < 0 {
			return (f(), None);
		}
		// SAFETY: `fd` is the counter just opened; enabling takes no argument.
		unsafe { libc::ioctl(fd, IOC_ENABLE as _, 0) };
		let r = f();
		let mut n = 0_u64;
		// SAFETY: as above; `n` is valid for the 8 bytes a counter read
		// returns, and the fd is closed once.
		let read = unsafe {
			libc::ioctl(fd, IOC_DISABLE as _, 0);
			let read = libc::read(fd, (&raw mut n).cast(), 8);
			libc::close(fd);
			read
		};
		(r, (read == 8).then_some(n))
	}
}

/// No counters off Linux.
#[cfg(not(target_os = "linux"))]
mod counter {
	/// Run `f`; no count.
	pub fn instructions<R>(f: impl FnOnce() -> R) -> (R, Option<u64>) {
		(f(), None)
	}
}

/// One run of `src` under `mask` on a fresh shell: its time and, when
/// `count`, its instructions (a counted run is not timed for the medians).
fn sample(
	engine: &std::sync::Arc<Engine>,
	src: &[u8],
	mask: EventMask,
	count: bool,
) -> (Duration, Option<u64>) {
	let mut host = NullHost(FakeHost::new());
	let mut store = MemStore::new();
	let mut shell = new_shell(engine, &mut host, &mut store);
	shell.set_event_mask(mask);
	let t = Instant::now();
	let (status, instructions) = if count {
		counter::instructions(|| run(&mut shell, &mut host, &mut store, src))
	} else {
		(run(&mut shell, &mut host, &mut store, src), None)
	};
	let elapsed = t.elapsed();
	assert_eq!(status, 0, "the workload succeeds");
	(elapsed, instructions)
}

fn median<T: Copy + PartialOrd>(values: &mut [T]) -> T {
	values.sort_unstable_by(|a, b| a.partial_cmp(b).expect("no NaN"));
	values[values.len() / 2]
}

/// `a` over `b`, in percent.
fn pct(a: f64, b: f64) -> f64 {
	(a / b - 1.0) * 100.0
}

/// One run's line for a workload: the build, the NONE/DEFAULT/ALL medians
/// (ns) and instructions.
struct Run {
	check:        bool,
	workload:     String,
	ns:           [f64; 3],
	instructions: [Option<f64>; 3],
}

impl Run {
	fn line(&self) -> String {
		let mut line = format!("{} {}", if self.check { "check" } else { "nocheck" }, self.workload);
		for ns in self.ns {
			let _ = write!(line, " {ns}");
		}
		for i in self.instructions {
			let _ = write!(line, " {}", i.map_or_else(|| "-".to_owned(), |i| i.to_string()));
		}
		line
	}

	fn parse(line: &str) -> Option<Self> {
		let mut f = line.split(' ');
		let check = match f.next()? {
			"check" => true,
			"nocheck" => false,
			_ => return None,
		};
		let workload = f.next()?.to_owned();
		let mut ns = [0.0; 3];
		for slot in &mut ns {
			*slot = f.next()?.parse().ok()?;
		}
		let mut instructions = [None; 3];
		for slot in &mut instructions {
			*slot = f.next()?.parse().ok();
		}
		Some(Self { check, workload, ns, instructions })
	}
}

/// A ratio over runs: the median of the per-run time ratios, their spread,
/// the median instruction ratio (if every run counted).
struct Ratio {
	time:  f64,
	low:   f64,
	high:  f64,
	instr: Option<f64>,
	count: usize,
}

impl Ratio {
	fn of(mut times: Vec<f64>, instrs: Option<Vec<f64>>) -> Option<Self> {
		if times.is_empty() {
			return None;
		}
		let low = times.iter().copied().fold(f64::INFINITY, f64::min);
		let high = times.iter().copied().fold(f64::NEG_INFINITY, f64::max);
		let count = times.len();
		let time = median(&mut times);
		let instr = instrs.filter(|i| !i.is_empty()).map(|mut i| median(&mut i));
		Some(Self { time, low, high, instr, count })
	}

	/// Within `max`, by time or (excess inside the spread) by instructions.
	fn pass(&self, max: f64) -> bool {
		self.time <= max
			|| self
				.instr
				.is_some_and(|i| i <= max && self.time - max <= self.high - self.low)
	}

	fn show(&self, max: f64) -> String {
		let instr = self
			.instr
			.map_or_else(|| "n/a".to_owned(), |i| format!("{i:+.2}%"));
		format!(
			"{:+.1}% over {} runs (spread {:+.1}..{:+.1}), instructions {instr} (target ≤ {max}%) {}",
			self.time,
			self.count,
			self.low,
			self.high,
			verdict(self.pass(max))
		)
	}
}

fn main() {
	let engine = Engine::new(EngineConfig::default());
	let check = !NO_SAFEPOINT_CHECK;
	let build = if check { "check" } else { "nocheck" };
	let mut runs = Vec::with_capacity(WORKLOADS.len());
	for (workload, n) in WORKLOADS {
		let src = workload.script(n);
		let mut instructions = [None; 3];
		for (m, (_, mask)) in MODES.iter().enumerate() {
			instructions[m] = sample(&engine, &src, *mask, true).1.map(|i| i as f64);
		}
		let mut samples: [Vec<f64>; 3] = std::array::from_fn(|_| Vec::with_capacity(ROUNDS));
		for round in 0..ROUNDS {
			for k in 0..MODES.len() {
				let m = (round + k) % MODES.len();
				let (t, _) = sample(&engine, &src, MODES[m].1, false);
				samples[m].push(t.as_nanos() as f64);
			}
		}
		let ns = samples.each_mut().map(|s| median(s.as_mut_slice()));
		let ins = |m: usize| {
			instructions[m]
				.zip(instructions[0])
				.map_or_else(|| "n/a".to_owned(), |(i, n)| format!("{:+.2}%", pct(i, n)))
		};
		println!(
			"run {} ({build}): NONE {:.1}ms; DEFAULT {:+.1}% (instructions {}); ALL {:+.1}% \
			 (instructions {})",
			workload.name(),
			ns[0] / 1e6,
			pct(ns[1], ns[0]),
			ins(1),
			pct(ns[2], ns[0]),
			ins(2)
		);
		runs.push(Run { check, workload: workload.name().to_owned(), ns, instructions });
	}
	let text = runs
		.iter()
		.fold(std::fs::read_to_string(RUNS).unwrap_or_default(), |mut text, r| {
			let _ = writeln!(text, "{}", r.line());
			text
		});
	std::fs::write(RUNS, &text).expect("write the runs file");
	let all: Vec<Run> = text.lines().filter_map(Run::parse).collect();
	for (workload, _) in WORKLOADS {
		let name = workload.name();
		let of = |check: bool| {
			all.iter()
				.filter(move |r| r.check == check && r.workload == name)
		};
		// Events: each run's DEFAULT/ALL over its own NONE, default build.
		for (m, max) in [(1, MAX_DEFAULT_PCT), (2, MAX_ALL_PCT)] {
			let times = of(true).map(|r| pct(r.ns[m], r.ns[0])).collect();
			let instrs = of(true)
				.map(|r| Some(pct(r.instructions[m]?, r.instructions[0]?)))
				.collect::<Option<Vec<f64>>>();
			if let Some(ratio) = Ratio::of(times, instrs) {
				println!("overhead {name} {}: {}", MODES[m].0, ratio.show(max));
			}
		}
		// Safepoint: the NONE medians of the two builds.
		let none = |check: bool| {
			let mut ns: Vec<f64> = of(check).map(|r| r.ns[0]).collect();
			(!ns.is_empty()).then(|| median(&mut ns))
		};
		let none_instr = |check: bool| {
			let mut i = of(check)
				.map(|r| r.instructions[0])
				.collect::<Option<Vec<f64>>>()?;
			(!i.is_empty()).then(|| median(&mut i))
		};
		let (Some(with), Some(without)) = (none(true), none(false)) else {
			println!("safepoint {name}: needs runs of both builds in {RUNS}");
			continue;
		};
		// Each run of one build against the other build's median: the spread.
		let times: Vec<f64> = of(true)
			.map(|r| pct(r.ns[0], without))
			.chain(of(false).map(|r| pct(with, r.ns[0])))
			.collect();
		let mut ratio = Ratio::of(times, None).expect("runs of both builds");
		ratio.time = pct(with, without);
		ratio.instr = none_instr(true)
			.zip(none_instr(false))
			.map(|(w, wo)| pct(w, wo));
		println!("safepoint {name}: {}", ratio.show(MAX_SAFEPOINT_PCT));
	}
}
