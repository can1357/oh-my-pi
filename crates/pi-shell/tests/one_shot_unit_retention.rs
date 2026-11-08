//! A one-shot source must not grow the retained trace with the number of
//! distinct texts it ever ran.
//!
//! `eval`, a sourced file, a trap action, the script a host callout runs and
//! the value an `env` prefix carries are each compiled fresh for every
//! distinct text, while the execution history the trace serves is capped.
//! Without collection, a poller copies a source table that grows with the
//! texts for a program whose own text never changes. These rows pin the
//! bound, and the last two pin that collection never takes a source a
//! retained history entry still has to render.
#![cfg(unix)]

use std::{
	collections::{HashMap, HashSet},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions,
	bash::{
		Budget, Cx, Engine, EngineConfig, Event, EventData, EventMask, EventSink, MemStore, Script,
		Shell as VmShell, Step, UnitId,
		trace::{
			RunTrace,
			history::{HISTORY_BYTES, HISTORY_EVENTS, HistoryData},
			viz::{Options as VizOptions, StoredVisualization},
		},
	},
	cancel::CancelToken,
	testkit::{FakeHost, fault::skeleton_init},
};

async fn trace(script: &str, files: &[(&str, &str)], expected: &str) -> Arc<RunTrace> {
	let dir = tempfile::tempdir().expect("tempdir");
	for (name, body) in files {
		std::fs::write(dir.path().join(name), body).expect("write fixture");
	}
	let shell = Shell::new(Some(ShellOptions {
		session_env: Some(HashMap::from([
			("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
			("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
		])),
		..Default::default()
	}));
	let trace = Arc::new(RunTrace::new(script));
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(300_000),
				trace: Some(Arc::clone(&trace)),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	assert_eq!(result.exit_code, Some(0));
	assert_eq!(rx.drain().collect::<String>().trim(), expected);
	trace
}

/// Run the same program past the history cap at three iteration counts.
/// Collection is amortized, so the residual may vary by one 512-unit floor
/// between samples; it must not grow with the number of distinct texts.
async fn assert_growth_bounded(kind: &str, unit_slack: usize, command: impl Fn(usize) -> String) {
	let mut baseline = None;
	for count in [2_500, 5_000, 10_000] {
		let trace = trace(&command(count), &[], &count.to_string()).await;
		let snapshot = trace.snapshot();
		let json = trace.snapshot_json();
		assert!(snapshot.history_truncated);
		let units = snapshot.units.len();
		let bytes = json.len();
		println!("RETENTION kind={kind} n={count} units={units} bytes={bytes}");
		let (first_units, first_bytes) = *baseline.get_or_insert((units, bytes));
		// In-run collection permits one sweep floor of unswept sources.
		// Exit-collected and reused sources keep their original allowance;
		// neither case may add a source for every iteration.
		assert!(
			units <= first_units + unit_slack && bytes <= first_bytes + HISTORY_BYTES,
			"retained trace grew with the iteration count: units {first_units} -> {units}, snapshot \
			 {first_bytes} -> {bytes} bytes",
		);
		StoredVisualization::from_snapshot_json(&json).expect("persisted trace remains readable");
	}
}

#[tokio::test]
async fn distinct_eval_sources_stop_growing_the_trace_after_history_truncation() {
	assert_growth_bounded("eval", 512, |count| {
		format!(
			"for ((i=0;i<{count};i++)); do eval \"printf '%0512d' $i\" >/dev/null; done; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_command_substitution_texts_stop_growing_the_trace() {
	assert_growth_bounded("command_substitution", HISTORY_EVENTS / 64, |count| {
		format!("for ((i=0;i<{count};i++)); do x=$(eval \"printf '%0512d' $i\"); done; echo {count}")
	})
	.await;
}

#[tokio::test]
async fn distinct_sourced_file_texts_stop_growing_the_trace() {
	assert_growth_bounded("source", 512, |count| {
		format!(
			"for ((i=0;i<{count};i++)); do printf \"printf '%%0512d' %d\\n\" \"$i\" > f.sh; . ./f.sh \
			 >/dev/null; done; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_trap_action_texts_stop_growing_the_trace() {
	assert_growth_bounded("trap", 512, |count| {
		format!(
			"for ((i=0;i<{count};i++)); do trap \"printf '%0512d' $i >/dev/null\" DEBUG; :; done; \
			 trap - DEBUG; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_env_prefix_values_stop_growing_the_trace() {
	assert_growth_bounded("env", HISTORY_EVENTS / 64, |count| {
		format!(
			"for ((i=0;i<{count};i++)); do printf -v w '%0512d' \"$i\"; env \"V=$w\" printf '%s' '' \
			 >/dev/null; done; echo {count}"
		)
	})
	.await;
}

/// Collection is bounded by what the history can still replay, so a one-shot
/// source whose output is still retained keeps its own text and argv.
#[tokio::test]
async fn retained_output_of_a_one_shot_source_keeps_its_own_command() {
	let trace = trace(
		"f() { printf 'function\\n'; eval 'printf \"evaluated\\n\"'; . ./lib.sh; trap 'printf \
		 \"exited\\n\"' EXIT; }; timeout 5 f",
		&[("lib.sh", "printf 'sourced\\n'\n")],
		"function\nevaluated\nsourced\nexited",
	)
	.await;
	let snapshot = trace.snapshot();
	for label in ["function", "evaluated", "sourced", "exited"] {
		let event = snapshot
			.history
			.iter()
			.find(|event| matches!(&event.data, HistoryData::Output { text, .. } if text.starts_with(label.as_bytes())))
			.expect("visible user output");
		let unit = &snapshot.units[event.u.expect("user output remains attributed") as usize];
		let node = &unit.nodes[event.n.expect("user output node") as usize];
		let source = unit.source.as_deref().unwrap_or(&snapshot.script);
		let source = if let Some(at) = unit.at {
			&source[at as usize..]
		} else {
			source
		};
		assert!(
			String::from_utf8_lossy(&source[node.lo as usize..node.hi as usize]).contains(label),
			"{label} output must resolve to its own one-shot source"
		);
	}
}

/// One source position, run once, retired while the whole replay window of
/// other sources runs, and run again: the second run must be announced
/// again and resolve to its own text rather than to a placeholder with no
/// source. The two runs are the same occurrence in the script, so they
/// share an announcement key and the row fails unless retirement really
/// forgets that key.
#[tokio::test]
async fn a_source_run_again_after_retirement_is_announced_again() {
	let count = HISTORY_EVENTS / 4;
	let script = format!(
		"repeat() {{ eval 'printf \"repeated\\n\"'; }}; repeat >/dev/null; for \
		 ((i=0;i<{count};i++)); do eval \"printf '%0512d' $i\" >/dev/null; done; repeat; echo \
		 {count}"
	);
	let trace = trace(&script, &[], &format!("repeated\n{count}")).await;
	let snapshot = trace.snapshot();
	let event = snapshot
		.history
		.iter()
		.rev()
		.find(
			|event| matches!(&event.data, HistoryData::Output { text, .. } if text.starts_with(b"repeated")),
		)
		.expect("the second run of the repeated source produced output");
	let unit = &snapshot.units[event.u.expect("the second run resolves to a source") as usize];
	let node = &unit.nodes[event.n.expect("the second run resolves to a node") as usize];
	let source = unit.source.as_deref().unwrap_or(&snapshot.script);
	let source = if let Some(at) = unit.at {
		&source[at as usize..]
	} else {
		source
	};
	assert!(
		String::from_utf8_lossy(&source[node.lo as usize..node.hi as usize]).contains("repeated"),
		"the re-announced source carries its own text, not an empty placeholder"
	);
}

/// Retirement must not take a definition's provenance with it. A function
/// defined inside an `eval` is announced again when it is called again,
/// long after the defining source was retired, and that announcement still
/// has to name where the definition came from — otherwise the presentation
/// shows the same function twice, the second time as code with no place in
/// the script.
#[tokio::test]
async fn a_function_defined_in_an_eval_keeps_its_parent_when_it_runs_again() {
	let count = HISTORY_EVENTS / 4;
	let script = format!(
		"eval 'keeper() {{ printf \"kept\\n\"; }}; keeper >/dev/null'; for ((i=0;i<{count};i++)); \
		 do eval \"printf '%0512d' $i\" >/dev/null; done; keeper; echo {count}"
	);
	let trace = trace(&script, &[], &format!("kept\n{count}")).await;
	let snapshot = trace.snapshot();
	let event = snapshot
		.history
		.iter()
		.rev()
		.find(
			|event| matches!(&event.data, HistoryData::Output { text, .. } if text.starts_with(b"kept")),
		)
		.expect("the second call of the eval-defined function produced output");
	let unit = &snapshot.units[event.u.expect("the second call resolves to a source") as usize];
	assert!(
		unit
			.syntax
			.as_ref()
			.is_some_and(|syntax| syntax.parent.is_some()),
		"the re-announced function body still names the source that defined it"
	);
}

/// The same, one level deeper and through a sourced file: a definition
/// nested inside an `eval` inside an `eval`, and one inside an `eval` in a
/// sourced file, each first called only after the whole replay window has
/// passed. The body is announced then for the first time, and the source it
/// names as its parent must still be there to be named.
#[tokio::test]
async fn a_definition_nested_in_a_retired_source_keeps_its_parent() {
	let count = HISTORY_EVENTS / 4;
	let script = format!(
		"eval 'eval '\\''nested() {{ printf \"nested\\n\"; }}'\\'''; . ./def.sh; for \
		 ((i=0;i<{count};i++)); do eval \"printf '%0512d' $i\" >/dev/null; done; nested; sourced; \
		 echo {count}"
	);
	let trace = trace(
		&script,
		&[("def.sh", "eval 'sourced() { printf \"sourced\\n\"; }'\n")],
		&format!("nested\nsourced\n{count}"),
	)
	.await;
	let snapshot = trace.snapshot();
	for label in ["nested", "sourced"] {
		let event = snapshot
			.history
			.iter()
			.rev()
			.find(|event| matches!(&event.data, HistoryData::Output { text, .. } if text.starts_with(label.as_bytes())))
			.expect("the deferred definition produced output");
		let unit = &snapshot.units[event.u.expect("it resolves to a source") as usize];
		assert!(
			unit
				.syntax
				.as_ref()
				.is_some_and(|syntax| syntax.parent.is_some()),
			"{label}'s body still names the source that defined it"
		);
	}
}

/// A row the presentation parsed ahead of the engine can be selected and
/// expanded: it names no compiled unit, so the key/index boundary must leave
/// its identity alone rather than read it as a source that has gone.
#[tokio::test]
async fn a_parsed_ahead_row_can_still_be_selected_and_expanded() {
	let trace = RunTrace::new("printf 'one'; printf '%s' 'two'");
	let first: serde_json::Value = serde_json::from_str(
		&trace
			.presentation_json(&VizOptions::default())
			.expect("present"),
	)
	.expect("presentation json");
	let node = first["rows"]
		.as_array()
		.expect("rows")
		.iter()
		.flat_map(|row| row["segments"].as_array().expect("segments"))
		.find_map(|segment| segment.get("node").filter(|node| !node.is_null()))
		.expect("a selectable parsed-ahead node")
		.clone();
	let options: VizOptions = serde_json::from_value(serde_json::json!({
		"selectedNode": node,
		"expandedNodes": [node],
	}))
	.expect("presentation options");
	let second: serde_json::Value =
		serde_json::from_str(&trace.presentation_json(&options).expect("present")).expect("json");
	assert_eq!(
		second["preferences"]["selectedNode"], node,
		"the selection the renderer offered comes back unchanged"
	);
	assert_eq!(
		second["preferences"]["expandedNodes"],
		serde_json::json!([node]),
		"the expanded row the renderer offered is kept"
	);
}

/// An origin record for an unset definition must not keep its defining
/// source in every presentation after that source leaves replay history.
#[tokio::test]
async fn dead_nested_definitions_do_not_grow_the_trace() {
	let mut counts = Vec::new();
	for count in [2_500, 5_000, 10_000] {
		let script = format!(
			"for ((i=0;i<{count};i++)); do eval \"eval 'f() {{ : $i; }}'\"; unset -f f; done; echo \
			 done"
		);
		let trace = trace(&script, &[], "done").await;
		let snapshot = trace.snapshot();
		let json = trace.snapshot_json();
		assert!(snapshot.history_truncated);
		StoredVisualization::from_snapshot_json(&json)
			.expect("stored trace decodes")
			.presentation_json(&VizOptions::default())
			.expect("stored trace renders");
		println!("DEAD_DEFINITION n={count} units={} bytes={}", snapshot.units.len(), json.len());
		counts.push(snapshot.units.len());
	}
	// The fixed live set is below the floor, so samples may differ by
	// 512 unswept announcements, but never by the iteration count.
	assert!(
		counts.iter().all(|&count| count <= counts[0] + 512),
		"dead-definition retention must stay within one sweep floor: {counts:?}"
	);
}

/// Consecutive retirement events are one sweep, not one visit per unit.
/// Other events separate sweeps because the fixture executes between them.
#[derive(Default)]
struct RetirementBatches {
	/// The preceding event was a retirement, so its batch is already counted.
	in_batch: AtomicBool,
	/// Count batches rather than units to expose a per-command collector.
	batches:  AtomicUsize,
	/// Current announcement owners expose a disabled collector without history
	/// noise.
	live:     Mutex<HashSet<UnitId>>,
}

impl EventSink for RetirementBatches {
	fn mask(&self) -> EventMask {
		EventMask::ALL
	}

	fn event(&self, event: &Event<'_>) {
		match &event.data {
			EventData::UnitCompiled(compiled) => {
				self
					.live
					.lock()
					.expect("announcement set")
					.insert(compiled.unit.id);
			},
			EventData::UnitRetired { unit } => {
				self.live.lock().expect("announcement set").remove(unit);
			},
			_ => {},
		}
		let retired = matches!(event.data, EventData::UnitRetired { .. });
		if retired && !self.in_batch.swap(true, Ordering::SeqCst) {
			self.batches.fetch_add(1, Ordering::SeqCst);
		} else if !retired {
			self.in_batch.store(false, Ordering::SeqCst);
		}
	}
}

fn fixed_live_set_sweeps(rounds: usize) -> (usize, usize) {
	let source = format!(
		"for ((i=0;i<1000;i++)); do eval \"keeper$i() {{ :; }}\"; done; for ((i=0;i<{rounds};i++)); \
		 do eval \": $i\"; done"
	);
	let batches = Arc::new(RetirementBatches::default());
	let mut host = FakeHost::new().with_event_sink(batches.clone());
	let mut store = MemStore::new();
	let engine = Engine::new(EngineConfig::default());
	let mut shell =
		VmShell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, skeleton_init(&[]))
			.expect("shell");
	shell.set_event_mask(EventMask::ALL);
	let run = shell.submit(Script::command(source.into_bytes()));
	for _ in 0..1_000_000 {
		let step = shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default());
		host.events.clear();
		match step {
			Step::Done { run: id, status } if id == run => {
				assert_eq!(status, 0);
				return (
					batches.batches.load(Ordering::SeqCst),
					batches.live.lock().expect("announcement set").len(),
				);
			},
			Step::Idle => panic!("idle before the root finished"),
			_ => {},
		}
	}
	panic!("the sweep fixture did not finish");
}

/// A per-command collector repeatedly scans the same 1,000 live functions;
/// a disabled collector instead retains every disposable one-shot source.
/// Pin both failures: at most `N / 512 + 3` sweeps at each sampled N, and
/// at most 512 unswept sources plus two loop commands retained, even after
/// four times as many distinct evals. The sweep allowance includes the
/// initial definitions and the few announcements retained at each sweep.
/// Callable bodies stay live but are never run or announced in this fixture.
#[test]
fn fixed_live_churn_amortizes_sweeps_without_unbounded_retention() {
	let small = fixed_live_set_sweeps(10_000);
	let large = fixed_live_set_sweeps(40_000);
	println!(
		"SWEEP_BATCHES n=10000 sweeps={} units={}; n=40000 sweeps={} units={}",
		small.0, small.1, large.0, large.1
	);
	for (rounds, (sweeps, units)) in [(10_000, small), (40_000, large)] {
		assert!(
			sweeps <= rounds / 512 + 3,
			"the collector swept per command: n={rounds} sweeps={sweeps}"
		);
		assert!(
			units <= 512 + 2,
			"retention must stay within the fixed live-set bound: n={rounds} units={units}"
		);
	}
}
