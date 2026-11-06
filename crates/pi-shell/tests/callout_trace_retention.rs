//! Host-generated callout commands must not grow the retained source table.
#![cfg(unix)]

use std::{collections::HashMap, sync::Arc};

use pi_shell::{
	Shell, ShellOptions, ShellRunOptions,
	bash::trace::{
		RunTrace,
		history::{HISTORY_BYTES, HISTORY_EVENTS, HistoryData},
		viz::{Options, StoredVisualization},
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
				timeout_ms: Some(60_000),
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

async fn assert_growth_bounded(command: impl Fn(usize) -> String) {
	let small_count = HISTORY_EVENTS / 4;
	let large_count = HISTORY_EVENTS / 2;
	let small = trace(&command(small_count), &[], &small_count.to_string()).await;
	let large = trace(&command(large_count), &[], &large_count.to_string()).await;
	let small_snapshot = small.snapshot();
	let large_snapshot = large.snapshot();
	assert!(small_snapshot.history_truncated && large_snapshot.history_truncated);
	// Pollers must not copy ever-growing source tables for work whose
	// executions have already fallen out of their bounded replay window.
	assert!(
		large_snapshot.units.len() <= small_snapshot.units.len() + HISTORY_EVENTS / 64,
		"retained units kept growing: {} -> {}",
		small_snapshot.units.len(),
		large_snapshot.units.len()
	);
	let small_json = small.snapshot_json();
	let large_json = large.snapshot_json();
	assert!(
		large_json.len() <= small_json.len() + HISTORY_BYTES,
		"snapshot kept growing beyond another replay payload: {} -> {} bytes",
		small_json.len(),
		large_json.len()
	);
	StoredVisualization::from_snapshot_json(&large_json).expect("persisted trace remains readable");
}

#[tokio::test]
async fn distinct_xargs_operands_stop_growing_the_trace_after_history_truncation() {
	assert_growth_bounded(|count| {
		format!("printf '%0512d\\n' {{1..{count}}} | xargs -n 1 printf '%s\\n' | wc -l")
	})
	.await;
}

#[tokio::test]
async fn distinct_timeout_operands_stop_growing_the_trace_after_history_truncation() {
	assert_growth_bounded(|count| {
		format!("for ((i=0;i<{count};i++)); do timeout 5 printf '%s\\n' \"$i\"; done | wc -l")
	})
	.await;
}

#[tokio::test]
async fn retained_callout_history_resolves_to_its_own_operand_after_source_eviction() {
	let count = HISTORY_EVENTS / 2;
	let trace = trace(
		&format!("printf '%s\\n' {{1..{count}}} | xargs -n 1 printf '%s\\n' | wc -l"),
		&[],
		&count.to_string(),
	)
	.await;
	let snapshot = trace.snapshot();
	assert!(snapshot.history_truncated);
	// Replay must still show the actual execution's argv, not a newer
	// operand that took the evicted source's old table slot.
	for event in &snapshot.history {
		if let Some(unit) = event.u {
			let unit = &snapshot.units[unit as usize];
			let node = &unit.nodes[event.n.expect("attributed node") as usize];
			assert!(node.hi > node.lo);
			if let HistoryData::CmdExpanded { argv, .. } = &event.data {
				assert_eq!(&node.argv, argv);
			}
		} else {
			assert!(
				!matches!(event.data, HistoryData::CmdExpanded { .. }),
				"a retained command lost its source"
			);
		}
	}
}

#[tokio::test]
async fn visible_callout_output_keeps_the_operands_own_argv() {
	let trace = trace("timeout 5 /usr/bin/printf 'operand\\n'", &[], "operand").await;
	let snapshot = trace.snapshot();
	let event = snapshot
		.history
		.iter()
		.find(|event| matches!(event.data, HistoryData::Output { .. }))
		.expect("operand output");
	let unit = &snapshot.units[event.u.expect("output producer unit") as usize];
	let node = &unit.nodes[event.n.expect("output producer node") as usize];
	assert_eq!(node.argv, ["/usr/bin/printf", "operand\\n"]);
}

#[tokio::test]
async fn callouts_keep_user_function_eval_source_and_exit_trap_output_attributed() {
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
			"{label} output must resolve to its own user command"
		);
	}
}

#[tokio::test]
async fn compacted_snapshots_keep_selection_and_expansion_on_the_same_source() {
	let trace = trace("printf first\nprintf second", &[], "firstsecond").await;
	let mut snapshot: serde_json::Value = serde_json::from_str(&trace.snapshot_json()).unwrap();
	for (index, unit) in snapshot["units"]
		.as_array_mut()
		.unwrap()
		.iter_mut()
		.enumerate()
	{
		unit["key"] = ((index + 1) * HISTORY_EVENTS).into();
	}
	let second = snapshot["history"]
		.as_array()
		.unwrap()
		.iter()
		.find(|event| event["kind"] == "CmdExpanded" && event["argv"][1] == "second")
		.unwrap();
	let selected = format!("{}:0:{}", 2 * HISTORY_EVENTS, second["n"]);
	let options: Options = serde_json::from_value(serde_json::json!({
		"view": "raw", "selectedNode": selected, "expandedNodes": [selected]
	}))
	.unwrap();
	// The UI keeps these opaque keys between polls. Removing an earlier
	// unit must not move its selection or expansion to another command.
	for compacted in [false, true] {
		if compacted {
			snapshot["units"].as_array_mut().unwrap().remove(0);
			snapshot["history"]
				.as_array_mut()
				.unwrap()
				.retain_mut(|event| match event["u"].as_u64() {
					Some(0) => false,
					Some(unit) => {
						event["u"] = (unit - 1).into();
						true
					},
					None => true,
				});
		}
		let stored = StoredVisualization::from_snapshot_json(&snapshot.to_string()).unwrap();
		let presented: serde_json::Value =
			serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
		assert!(
			presented["rows"].as_array().unwrap().iter().any(|row| {
				row["segments"].as_array().unwrap().iter().any(|segment| {
					segment["node"] == selected
						&& segment["text"]
							.as_str()
							.is_some_and(|text| text.contains("second"))
				})
			}),
			"selection must resolve to second before and after compaction: {presented}"
		);
		assert_eq!(presented["preferences"]["selectedNode"], selected);
		assert_eq!(presented["preferences"]["expandedNodes"][0], selected);
	}
}
