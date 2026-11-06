//! A one-shot source must not grow the persisted image with the number of
//! distinct texts it ever ran.
//!
//! `Shell::externalize` writes the unit of every live frame to
//! `BlobSlot::Unit`. A construct that compiles a fresh unit per iteration —
//! here `eval` — therefore leaves one blob per iteration behind, for ever,
//! where the same program run the same number of times from an ordinary
//! script leaves a constant number. These rows pin that the image holds what
//! a restore needs and nothing else, and that the restore still works.
#![cfg(unix)]

use std::sync::{
	Arc,
	atomic::{AtomicBool, Ordering},
};

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Event, EventData, EventMask, EventSink, MemStore,
		RestoreOpts, Script, Shell, Step,
		trace::{RunTrace, history::HISTORY_EVENTS},
	},
	testkit::{FakeHost, fault::skeleton_init},
};

/// Notices that a source was compiled, which is where a per-iteration unit
/// appears and the moment a checkpoint has it on a live frame.
struct Compiles {
	flag: Arc<AtomicBool>,
}

impl EventSink for Compiles {
	fn mask(&self) -> EventMask {
		EventMask::ALL
	}

	fn event(&self, e: &Event<'_>) {
		if matches!(e.data, EventData::UnitCompiled(_)) {
			self.flag.store(true, Ordering::SeqCst);
		}
	}
}

/// What one run of `rounds` distinct `eval` texts leaves behind.
struct Image {
	/// Bytes of the serialized store after the final `externalize`.
	store_bytes:   usize,
	/// Unit blobs written over the whole run.
	units_written: u64,
	/// Bytes of the final `Frames` blob (live execution state).
	frames_bytes:  usize,
}

/// Run `rounds` distinct `eval` texts, checkpointing whenever one of them
/// has just been compiled — so every checkpoint is taken with a one-shot
/// source on a live frame — and report what the image holds at the end.
fn run_evals(rounds: usize) -> Image {
	let source = format!(
		"keeper() {{ printf 'kept %s\\n' \"$1\"; }}; for ((i=0;i<{rounds};i++)); do printf -v w \
		 '%0512d' \"$i\"; eval \"printf '%s' '$w'\" >/dev/null; done; printf 'done\\n'"
	);
	let compiled = Arc::new(AtomicBool::new(false));
	let mut host =
		FakeHost::new().with_event_sink(Arc::new(Compiles { flag: Arc::clone(&compiled) }));
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	shell.set_event_mask(EventMask::ALL);
	let run = shell.submit(Script::command(source.into_bytes()));
	let mut units_written = 0u64;
	let mut turns = 0usize;
	let report = loop {
		turns += 1;
		assert!(turns < 50_000_000, "the run makes progress");
		let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget {
			max_ops: 1,
			max_ns:  u64::MAX,
		});
		host.events.clear();
		match step {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0, "the script succeeds");
				break shell
					.externalize(&mut Cx { host: &mut host, store: &mut store })
					.expect("final externalize");
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => {},
		}
		if compiled.swap(false, Ordering::SeqCst) {
			shell.control().request_suspend();
			assert!(matches!(
				shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
				Step::SuspendReady
			));
			let report = shell
				.externalize(&mut Cx { host: &mut host, store: &mut store })
				.expect("externalize");
			units_written += u64::from(report.units_written);
			host.events.clear();
		}
	};
	assert!(host.stdout.bytes().ends_with(b"done\n"), "every eval ran");
	Image {
		store_bytes: store.to_bytes().len(),
		units_written,
		frames_bytes: report.bytes,
	}
}

/// The same fixed program checkpointed over twice as many iterations must
/// not leave twice as much behind: the `eval`'s text is one program per
/// iteration to the compiler, but only the live one is state.
#[test]
fn a_checkpointed_eval_loop_does_not_grow_its_image_with_the_iteration_count() {
	let small = run_evals(400);
	let large = run_evals(800);
	let allowance = 64 * 1024;
	assert!(
		large.store_bytes <= small.store_bytes + allowance,
		"the checkpoint grew with the iterations: {} -> {} bytes (frames {} -> {}, blobs written \
		 {} -> {})",
		small.store_bytes,
		large.store_bytes,
		small.frames_bytes,
		large.frames_bytes,
		small.units_written,
		large.units_written,
	);
}

/// A checkpoint written after many one-shot sources still restores, and the
/// function defined before them still has its body: reclaiming a source no
/// frame can reach must never reclaim one a record names.
#[test]
fn a_function_defined_before_many_evals_survives_the_checkpoint() {
	let rounds = 400usize;
	let source = format!(
		"keeper() {{ printf 'kept %s\\n' \"$1\"; }}; for ((i=0;i<{rounds};i++)); do printf -v w \
		 '%0512d' \"$i\"; eval \"printf '%s' '$w'\" >/dev/null; done; printf 'done\\n'"
	);
	let mut host = FakeHost::new();
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	let run = shell.submit(Script::command(source.into_bytes()));
	let mut turns = 0usize;
	loop {
		turns += 1;
		assert!(turns < 50_000_000, "the run makes progress");
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0, "the script succeeds");
				break;
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => {},
		}
		host.events.clear();
	}
	let report = shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("externalize");
	assert!(report.lost.is_empty(), "nothing is lost: {report:?}");
	let image = store.to_bytes();
	drop(shell);
	let mut store = MemStore::from_bytes(&image).expect("image decodes");
	let fresh = Engine::new(EngineConfig::default());
	let (mut shell, report) = Shell::restore(
		&fresh,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("a checkpoint written after many one-shot sources restores");
	assert!(report.lost.is_empty(), "the restore loses nothing: {report:?}");
	host.stdout.bytes();
	let next = shell.submit(Script::command(&b"keeper alive"[..]));
	let mut turns = 0usize;
	loop {
		turns += 1;
		assert!(turns < 1_000_000, "the restored shell makes progress");
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Done { run: id, status } if id == next => {
				assert_eq!(status, 0, "the function the image recorded still runs");
				break;
			},
			Step::Idle => panic!("idle before the restored run finished"),
			_ => {},
		}
	}
	assert!(host.stdout.bytes().ends_with(b"kept alive\n"), "the restored function has its body");
}

/// Forwards every event to the trace under test and notices the moment a
/// one-shot source has just been compiled, which is when a checkpoint
/// catches it announced and on a live frame.
struct Watch {
	trace: Arc<RunTrace>,
	flag:  Arc<AtomicBool>,
}

impl EventSink for Watch {
	fn mask(&self) -> EventMask {
		EventMask::ALL
	}

	fn event(&self, e: &Event<'_>) {
		if matches!(e.data, EventData::UnitCompiled(_)) {
			self.flag.store(true, Ordering::SeqCst);
		}
		self.trace.event(e);
	}
}

/// One cold restore per this many compiled one-shot sources.
const PER_RESTORE: usize = 50;

/// Run `rounds` distinct `eval` texts in one run, suspending every
/// `PER_RESTORE` compiled sources to write a checkpoint and restore it into
/// a fresh engine, and report how many sources the observer that was
/// attached the whole time still holds at the end.
fn evals_across_restores(rounds: usize) -> usize {
	let source = format!(
		"for ((i=0;i<{rounds};i++)); do printf -v w '%0512d' \"$i\"; eval \"printf '%s' '$w'\" \
		 >/dev/null; done; printf 'done\\n'"
	);
	let trace = Arc::new(RunTrace::new(source.as_str()));
	let compiled = Arc::new(AtomicBool::new(false));
	let watch = Arc::new(Watch { trace: Arc::clone(&trace), flag: Arc::clone(&compiled) });
	let mut host = FakeHost::new().with_event_sink(watch);
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	shell.set_event_mask(EventMask::ALL);
	let fresh = Engine::new(EngineConfig::default());
	let run = shell.submit(Script::command(source.into_bytes()));
	let (mut turns, mut compiles) = (0usize, 0usize);
	loop {
		turns += 1;
		assert!(turns < 50_000_000, "the run makes progress");
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget {
			max_ops: 1,
			max_ns:  u64::MAX,
		}) {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0, "the script succeeds");
				break;
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => {},
		}
		host.events.clear();
		if !compiled.swap(false, Ordering::SeqCst) {
			continue;
		}
		compiles += 1;
		if compiles % PER_RESTORE != 0 {
			continue;
		}
		shell.control().request_suspend();
		assert!(matches!(
			shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
			Step::SuspendReady
		));
		// A mid-run checkpoint of a live vproc cannot carry its stdout
		// device, which the restore reopens; no unit is lost.
		shell
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.expect("externalize");
		let image = store.to_bytes();
		drop(shell);
		store = MemStore::from_bytes(&image).expect("image decodes");
		let (restored, _) = Shell::restore(
			&fresh,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts::default(),
		)
		.expect("the checkpoint restores");
		shell = restored;
		shell.set_event_mask(EventMask::ALL);
		compiled.store(false, Ordering::SeqCst);
		host.events.clear();
	}
	assert!(host.stdout.bytes().ends_with(b"done\n"), "every eval ran");
	assert!(compiles / PER_RESTORE > 1, "the run restored more than once: {compiles} compiles");
	trace.snapshot().units.len()
}

/// An observer kept across cold restores must not pin the sources the
/// kernels before them announced to it. A restored kernel remembers none of
/// those announcements, so it can never retire them; unless the observer
/// forgets its own mappings when it sees the shell restored, every source
/// announced before a checkpoint stays in it for ever and the retained
/// table grows with the iteration count again — which is the growth the
/// rest of this change removes.
#[test]
fn an_observer_kept_across_restores_does_not_pin_the_sources_it_was_shown() {
	let (small_rounds, large_rounds) = (HISTORY_EVENTS / 4, HISTORY_EVENTS / 2);
	let small = evals_across_restores(small_rounds);
	let large = evals_across_restores(large_rounds);
	assert!(
		large <= small + 64,
		"the observer pinned the sources of the kernels it outlived: {small} -> {large} retained \
		 units for {small_rounds} -> {large_rounds} iterations over {} -> {} restores",
		small_rounds / PER_RESTORE,
		large_rounds / PER_RESTORE,
	);
}
