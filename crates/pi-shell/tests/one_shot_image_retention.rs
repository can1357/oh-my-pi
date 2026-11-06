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
