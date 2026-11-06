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

use std::{collections::HashMap, sync::Arc};

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions,
	bash::trace::{
		RunTrace,
		history::{HISTORY_BYTES, HISTORY_EVENTS, HistoryData},
		viz::{Options as VizOptions, StoredVisualization},
	},
	cancel::CancelToken,
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

/// Run the same program at two iteration counts, both past the history cap,
/// and require what the trace keeps to be a property of the program rather
/// than of the count.
async fn assert_growth_bounded(command: impl Fn(usize) -> String) {
	let small_count = HISTORY_EVENTS / 4;
	let large_count = HISTORY_EVENTS / 2;
	let small = trace(&command(small_count), &[], &small_count.to_string()).await;
	let large = trace(&command(large_count), &[], &large_count.to_string()).await;
	let small_snapshot = small.snapshot();
	let large_snapshot = large.snapshot();
	assert!(small_snapshot.history_truncated && large_snapshot.history_truncated);
	let small_json = small.snapshot_json();
	let large_json = large.snapshot_json();
	// Pollers must not copy ever-growing source tables for work whose
	// executions have already fallen out of their bounded replay window.
	assert!(
		large_snapshot.units.len() <= small_snapshot.units.len() + HISTORY_EVENTS / 64
			&& large_json.len() <= small_json.len() + HISTORY_BYTES,
		"retained trace grew with the iteration count: units {} -> {}, snapshot {} -> {} bytes",
		small_snapshot.units.len(),
		large_snapshot.units.len(),
		small_json.len(),
		large_json.len(),
	);
	StoredVisualization::from_snapshot_json(&large_json).expect("persisted trace remains readable");
}

#[tokio::test]
async fn distinct_eval_sources_stop_growing_the_trace_after_history_truncation() {
	assert_growth_bounded(|count| {
		format!("for ((i=0;i<{count};i++)); do eval \"printf '%0512d' $i\" >/dev/null; done; echo {count}")
	})
	.await;
}

#[tokio::test]
async fn distinct_command_substitution_texts_stop_growing_the_trace() {
	assert_growth_bounded(|count| {
		format!(
			"for ((i=0;i<{count};i++)); do x=$(eval \"printf '%0512d' $i\"); done; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_sourced_file_texts_stop_growing_the_trace() {
	assert_growth_bounded(|count| {
		format!(
			"for ((i=0;i<{count};i++)); do printf \"printf '%%0512d' %d\\n\" \"$i\" > f.sh; . \
			 ./f.sh >/dev/null; done; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_trap_action_texts_stop_growing_the_trace() {
	assert_growth_bounded(|count| {
		format!(
			"for ((i=0;i<{count};i++)); do trap \"printf '%0512d' $i >/dev/null\" DEBUG; :; done; \
			 trap - DEBUG; echo {count}"
		)
	})
	.await;
}

#[tokio::test]
async fn distinct_env_prefix_values_stop_growing_the_trace() {
	assert_growth_bounded(|count| {
		format!(
			"for ((i=0;i<{count};i++)); do printf -v w '%0512d' \"$i\"; env \"V=$w\" printf '%s' \
			 '' >/dev/null; done; echo {count}"
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

/// The same source, run once, retired while thousands of other sources run,
/// and run again: the second run must be announced again and resolve to its
/// own text rather than to a placeholder with no source.
#[tokio::test]
async fn a_source_run_again_after_retirement_is_announced_again() {
	let count = HISTORY_EVENTS / 4;
	let repeated = "eval 'printf \"repeated %s\\n\" \"$BASH_SOURCE\"'";
	let script = format!(
		"{repeated} >/dev/null; for ((i=0;i<{count};i++)); do eval \"printf '%0512d' $i\" \
		 >/dev/null; done; {repeated}; echo {count}"
	);
	let trace = trace(&script, &[], &format!("repeated \n{count}")).await;
	let snapshot = trace.snapshot();
	let event = snapshot
		.history
		.iter()
		.rev()
		.find(|event| matches!(&event.data, HistoryData::Output { text, .. } if text.starts_with(b"repeated")))
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

/// A row the presentation parsed ahead of the engine can be selected and
/// expanded: it names no compiled unit, so the key/index boundary must leave
/// its identity alone rather than read it as a source that has gone.
#[tokio::test]
async fn a_parsed_ahead_row_can_still_be_selected_and_expanded() {
	let trace = RunTrace::new("printf 'one'; printf '%s' 'two'");
	let first: serde_json::Value =
		serde_json::from_str(&trace.presentation_json(&VizOptions::default()).expect("present"))
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
