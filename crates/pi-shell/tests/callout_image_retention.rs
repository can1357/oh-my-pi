//! A host callout's synthetic command must not grow the engine's persisted
//! image with the number of calls.
//!
//! The trace rows in `callout_trace_retention.rs` pin what one *live* run
//! retains. These rows pin the other consumer of a compiled unit: the
//! checkpoint. `Shell::externalize` writes every live frame's unit to
//! `BlobSlot::Unit`, a written blob is never removed, and `Kernel::written`
//! remembers it for the process's life. A representation that gives each
//! call its own compiled unit therefore grows the image by one blob per
//! call, for ever, where the same program run the same number of times from
//! an ordinary script writes a constant number.
//!
//! The rows drive the real `ToolCalls` builder — the code path the bash tool
//! uses — rather than a replacement, so they measure the shape the host
//! actually submits.
#![cfg(unix)]

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::Waker,
};

use pi_shell::{
	bash::{
		Budget, CallOutcome, Cx, Engine, EngineConfig, Event, EventData, EventMask, EventSink,
		MemStore, RestoreOpts, Script, Shell, Step, Vpid,
	},
	testkit::{FakeHost, fault::skeleton_init},
	tools::{SpawnLog, ToolCalls, ToolConfig},
};

/// Notices that a child vproc compiled a unit, which is where a per-call
/// source would appear.
struct Compiles {
	flag: Arc<AtomicBool>,
}

impl EventSink for Compiles {
	fn mask(&self) -> EventMask {
		EventMask::ALL
	}

	fn event(&self, e: &Event<'_>) {
		if e.vpid.0 != Vpid::BASE && matches!(e.data, EventData::UnitCompiled(_)) {
			self.flag.store(true, Ordering::SeqCst);
		}
	}
}

/// What one run of `calls` callouts leaves behind.
struct Image {
	/// Bytes of the serialized store after the final `externalize`.
	store_bytes:   usize,
	/// Unit blobs written over the whole run.
	units_written: u64,
	/// Bytes of the final `Frames` blob (live execution state).
	frames_bytes:  usize,
}

/// Run `calls` host callouts, each with its own 512-byte operand, through
/// the real tool builder, checkpointing whenever a child compiled
/// something, and report what the image holds at the end.
fn run_callouts(calls: usize) -> Image {
	let source = format!(
		"for ((i=0;i<{calls};i++)); do printf -v word '%0512d' \"$i\"; timeout 5 printf '%s' \
		 \"$word\"; done"
	);
	let compiled = Arc::new(AtomicBool::new(false));
	let mut host =
		FakeHost::new().with_event_sink(Arc::new(Compiles { flag: Arc::clone(&compiled) }));
	// `FakeHost` resolves tool names by table position; `timeout` is 1.
	host.tool("unused", Arc::new(|_, _| CallOutcome::Exit(99)));
	host.tool("timeout", Arc::new(|_, _| CallOutcome::Exit(99)));
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	shell.set_event_mask(EventMask::ALL);
	let run = shell.submit(Script::command(source.into_bytes()));
	let mut tools =
		ToolCalls::new(ToolConfig::default(), SpawnLog::default(), Waker::noop().clone());
	let mut units_written = 0u64;
	let mut turns = 0usize;
	loop {
		turns += 1;
		assert!(turns < 5_000_000, "the run makes progress");
		let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget {
			max_ops: 1,
			max_ns:  u64::MAX,
		});
		let done = match step {
			Step::Call { id, call } => {
				tools.on_call(&mut shell, &mut Cx { host: &mut host, store: &mut store }, id, call);
				false
			},
			Step::Done { run: id, status } => {
				tools.on_done(id, status, None);
				if id == run {
					assert_eq!(status, 0, "the script succeeds");
					true
				} else {
					false
				}
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => false,
		};
		tools.poll(&mut shell, &mut Cx { host: &mut host, store: &mut store });
		host.events.clear();
		if compiled.swap(false, Ordering::SeqCst) {
			shell.control().request_suspend();
			assert!(matches!(
				shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
				Step::SuspendReady
			));
			let report = shell
				.externalize(&mut Cx { host: &mut host, store: &mut store })
				.expect("externalize");
			assert!(report.lost.is_empty(), "nothing is lost: {report:?}");
			units_written += u64::from(report.units_written);
		}
		if done {
			break;
		}
	}
	host.assert_no_leaks(&mut shell, &mut store);
	let report = shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("final externalize");
	units_written += u64::from(report.units_written);
	assert_eq!(host.stdout.bytes().len(), calls * 512, "every operand ran");
	Image { store_bytes: store.to_bytes().len(), units_written, frames_bytes: report.bytes }
}

/// The same fixed program run twice as many times must not leave twice as
/// much behind: the callout's own source is one program, not `calls`
/// programs. The small allowance is the per-call process bookkeeping the
/// engine does keep (about 15 bytes a call at upstream main).
#[test]
fn a_checkpointed_callout_loop_does_not_grow_its_image_with_the_call_count() {
	let small = run_callouts(1500);
	let large = run_callouts(3000);
	let allowance = 1500 * 64;
	assert!(
		large.store_bytes <= small.store_bytes + allowance,
		"the checkpoint grew with the calls: {} -> {} bytes (frames {} -> {})",
		small.store_bytes,
		large.store_bytes,
		small.frames_bytes,
		large.frames_bytes,
	);
}

/// The blobs themselves, counted by the report the host reads: a callout's
/// command is compiled once, not once per call.
#[test]
fn a_callout_loop_writes_a_bounded_number_of_unit_blobs() {
	let small = run_callouts(1500);
	let large = run_callouts(3000);
	assert!(
		large.units_written <= small.units_written + 16,
		"unit blobs grew with the calls: {} -> {}",
		small.units_written,
		large.units_written,
	);
}

/// What the live frames need is unrelated to the call count, at every
/// shape: the guard that the rows above are measuring retention and not a
/// run that simply kept more work alive.
#[test]
fn a_callout_loops_live_frames_stay_small() {
	let large = run_callouts(3000);
	assert!(
		large.frames_bytes < 4096,
		"the live frame blob is not where the growth is: {} bytes",
		large.frames_bytes,
	);
}

/// A checkpoint taken after many callouts must still restore. The engine's
/// compiled-unit cache is a fixed byte budget; `externalize` writes a
/// function body only while that body is still cached, so enough one-shot
/// callout units evict a function defined earlier and the image loses the
/// definition it still has a record for.
#[test]
fn a_function_defined_before_many_callouts_survives_the_checkpoint() {
	// Operands big enough that their units alone exceed the unit cache.
	let calls = 600usize;
	let width = 65536usize;
	let source = format!(
		"keeper() {{ printf 'kept %s\\n' \"$1\"; }}; for ((i=0;i<{calls};i++)); do printf -v word \
		 '%0{width}d' \"$i\"; timeout 5 printf '%s' \"$word\"; done"
	);
	let mut host = FakeHost::new();
	host.tool("unused", Arc::new(|_, _| CallOutcome::Exit(99)));
	host.tool("timeout", Arc::new(|_, _| CallOutcome::Exit(99)));
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	let run = shell.submit(Script::command(source.into_bytes()));
	let mut tools =
		ToolCalls::new(ToolConfig::default(), SpawnLog::default(), Waker::noop().clone());
	let mut turns = 0usize;
	loop {
		turns += 1;
		assert!(turns < 50_000_000, "the run makes progress");
		let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default());
		match step {
			Step::Call { id, call } => {
				tools.on_call(&mut shell, &mut Cx { host: &mut host, store: &mut store }, id, call);
			},
			Step::Done { run: id, status } => {
				tools.on_done(id, status, None);
				if id == run {
					assert_eq!(status, 0, "the script succeeds");
					break;
				}
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => {},
		}
		tools.poll(&mut shell, &mut Cx { host: &mut host, store: &mut store });
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
	.expect("a checkpoint written after many callouts restores");
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
