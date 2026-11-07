use std::sync::Arc;

use serde_json::Value;

use super::{Options, StoredVisualization, model::View};
use crate::{
	Shell, ShellRunOptions,
	bash::{
		EventSink, Script,
		syntax::CommandKind,
		trace::{RunTrace, history::HistoryData, syntax::SyntaxTree},
	},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

async fn run(shell: &Shell, script: &str) -> Arc<RunTrace> {
	let trace = Arc::new(RunTrace::new(script));
	let result = shell
		.run(
			ShellRunOptions {
				command: script.into(),
				trace: Some(Arc::clone(&trace)),
				..ShellRunOptions::default()
			},
			None,
			().into(),
		)
		.await
		.unwrap();
	assert_eq!(result.exit_code, Some(0));
	trace
}
// TestKit explicitly resolves bare shell names to SelfShell; PiHost leaves
// OS shells external. Exercise native provenance without changing execution.
fn run_native_shell(script: &str) -> (Arc<RunTrace>, Vec<u8>) {
	let trace = Arc::new(RunTrace::new(script));
	let sink: Arc<dyn EventSink> = trace.clone();
	let mut rig = Rig::new(FakeHost::new().with_event_sink(sink), skeleton_init(&[]));
	rig.shell().set_event_mask(trace.mask());
	assert_eq!(rig.run(Script::command(script.as_bytes()), Fault::None), 0);
	(trace, rig.host.stdout.bytes())
}

fn present(trace: &RunTrace, options: &Options) -> Value {
	serde_json::from_str(&trace.presentation_json(options).unwrap()).unwrap()
}

fn rows(p: &Value) -> Vec<(String, &Value)> {
	p["rows"]
		.as_array()
		.unwrap()
		.iter()
		.map(|row| {
			let text = row["segments"]
				.as_array()
				.unwrap()
				.iter()
				.map(|segment| segment["text"].as_str().unwrap())
				.collect();
			(text, row)
		})
		.collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn uncompiled_script_is_parsed_ahead_without_outcomes_until_it_stops_parsing() {
	// A command still streaming in: nothing has run, its last line is
	// unfinished.
	let trace =
		RunTrace::new("cd /tmp && git add -A\nfor f in *.go; do echo \"$f\"; done\nif true; th");
	let streaming = present(&trace, &Options::default());
	let shown = rows(&streaming);
	let texts: Vec<&str> = shown.iter().map(|(text, _)| text.as_str()).collect();
	assert_eq!(texts, [
		"cwd /tmp",
		"and git add -A",
		"for f in glob(\"*.go\"):",
		"print(f\"{f}\")",
		"if true; th"
	]);
	assert!(shown.iter().all(|(_, row)| row["state"].is_null()), "{streaming}");
	assert_eq!(shown[4].1["role"], "raw", "an unfinished command stays literal");

	// The engine never reaches the last line: it is drawn, but never ran.
	let shell = Shell::new(None);
	let trace = run(&shell, "echo a\nexit 0\necho never").await;
	let ran = present(&trace, &Options::default());
	let shown = rows(&ran);
	let (text, row) = shown.last().unwrap();
	assert_eq!(text, "print(\"never\")");
	assert!(row["state"].is_null(), "{ran}");
}

#[test]
fn bare_test_bracket_without_operands_renders_instead_of_panicking() {
	// Regression for #18320: a streamed `[` with no operands sliced `words[1..0]`
	// and aborted the host process.
	for (script, expected) in [
		("[", &[""][..]),
		("a && [", &["a", "and "]),
		("! [", &["not "]),
		("x=$(a); [", &["x = ⟨a⟩", ""]),
		("test", &[""]),
	] {
		let p = present(&RunTrace::new(script), &Options::default());
		let texts: Vec<String> = rows(&p).into_iter().map(|(text, _)| text).collect();
		assert_eq!(texts, expected, "{script:?}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn callout_scripts_are_drawn_by_their_command_but_eval_code_gets_a_frame() {
	let frames = |p: &Value| {
		p["rows"]
			.as_array()
			.unwrap()
			.iter()
			.filter(|row| {
				row["id"]
					.as_str()
					.is_some_and(|id| id.starts_with("frame-"))
			})
			.count()
	};
	let shell = Shell::new(None);
	// `timeout` and `xargs` run their operands through scripts of their own.
	let trace = run(&shell, "timeout 5 true; echo a | xargs -n1 true").await;
	let live = present(&trace, &Options::default());
	assert_eq!(frames(&live), 0, "{live}");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(frames(&restored), 0, "{restored}");

	let trace = run(&shell, "x=true; eval \"$x\"").await;
	assert_eq!(frames(&present(&trace, &Options::default())), 1);
}

#[test]
fn legacy_boundary_includes_heredoc_without_parsing_unannounced_future_syntax() {
	use crate::bash::{
		ids::ModeId,
		ir,
		syntax::{Features, NO_ALIASES, Parser},
	};
	let script = "cat <<'EOF'\npayload\nEOF\nif unannounced";
	let command = Parser::new(script.as_bytes(), Features::NONE, NO_ALIASES)
		.next_command()
		.unwrap()
		.unwrap();
	let unit =
		ir::lower_deferred(&command, script.as_bytes(), ModeId::Bash, Features::NONE).unwrap();
	let nodes: Vec<_> = unit
		.nodes
		.iter()
		.map(|node| serde_json::json!({"k":node.kind,"lo":node.lo,"hi":node.hi,"state":"pending"}))
		.collect();
	let legacy = serde_json::json!({"v":1,"seq":0,"script":script,"units":[{"at":0,"line":1,"nodes":nodes}],"history":[],"t_ns":0});
	let stored = StoredVisualization::from_snapshot_json(&legacy.to_string()).unwrap();
	assert_eq!(
		stored.trace.units[0].source.as_ref().unwrap().as_slice(),
		b"cat <<'EOF'\npayload\nEOF"
	);
	let presentation: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert!(
		presentation["rows"]
			.as_array()
			.unwrap()
			.iter()
			.flat_map(|row| row["segments"].as_array().unwrap())
			.any(|segment| segment["text"]
				.as_str()
				.is_some_and(|text| text.contains("if unannounced")))
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn raw_effect_badges_follow_source_order_after_restoration() {
	let shell = Shell::new(None);
	let trace = run(&shell, "uncalled() { rm --help; ln -s --help; }\n:").await;
	let options = Options { view: View::Raw, ..Options::default() };
	let live = present(&trace, &options);
	let kinds: Vec<_> = live["rows"]
		.as_array()
		.unwrap()
		.iter()
		.flat_map(|row| row["effects"].as_array().unwrap())
		.map(|effect| effect["kind"].as_str().unwrap())
		.collect();
	assert_eq!(kinds, ["destructive", "write"]);
	assert_eq!(live["output"], "", "the fixture function is never executed");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
	assert_eq!(live["rows"], restored["rows"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn actual_shell_presentation_restores_native_archive_and_rewinds_setters() {
	let shell = Shell::new(None);
	let trace = run(&shell, "x=one; printf '%s\\n' \"$x\"; x=two; printf '%s\\n' \"$x\"").await;
	let snapshot = trace.snapshot();
	assert!(snapshot.units.iter().all(|unit| unit.syntax.is_some()));
	let saved = trace.snapshot_json();
	let encoded: Value = serde_json::from_str(&saved).unwrap();
	assert!(
		encoded["units"]
			.as_array()
			.unwrap()
			.iter()
			.all(|unit| unit["syntax"].is_string())
	);
	let stored = StoredVisualization::from_snapshot_json(&saved).unwrap();
	for view in [View::Raw, View::Pseudo] {
		let options = Options { view, ..Options::default() };
		let live = present(&trace, &options);
		let restored: Value =
			serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
		assert_eq!(live, restored);
		assert_eq!(live["output"], "one\ntwo\n");
		assert!(
			live["watches"]
				.as_array()
				.unwrap()
				.iter()
				.any(|watch| watch["name"] == "x" && watch["value"] == "two")
		);
		for row in live["rows"].as_array().unwrap() {
			if let Some(seq) = row["executionSeq"].as_u64() {
				let event = snapshot
					.history
					.iter()
					.find(|event| event.seq == seq)
					.unwrap();
				assert!(matches!(event.data, HistoryData::CmdEnd { .. }));
				assert_eq!(row["executedAtNs"].as_u64(), Some(event.t_ns));
			}
		}
	}
	let first=snapshot.history.iter().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"x"&&value.as_slice()==b"one")).unwrap();
	let options = Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(first.seq),
		..Options::default()
	};
	let replay = present(&trace, &options);
	assert_eq!(replay["output"], "");
	assert!(
		replay["watches"]
			.as_array()
			.unwrap()
			.iter()
			.any(|watch| watch["name"] == "x" && watch["value"] == "one")
	);
	let empty = present(&trace, &Options { cursor: Some(0), ..Options::default() });
	assert_eq!(empty["output"], "");
	assert!(empty["watches"].as_array().unwrap().is_empty());
	assert!(
		empty["rows"]
			.as_array()
			.unwrap()
			.iter()
			.all(|row| row.get("executionSeq").is_none())
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn previously_unobserved_alias_definition_announces_canonical_body_to_each_observer() {
	let shell = Shell::new(None);
	let setup = "shopt -s expand_aliases\nalias native_viz_say='printf retained'\nnative_viz_f() { \
	             native_viz_say; }";
	let outcome = shell
		.run(ShellRunOptions { command: setup.into(), ..ShellRunOptions::default() }, None, ().into())
		.await
		.unwrap();
	assert_eq!(outcome.exit_code, Some(0));
	for _ in 0..2 {
		let trace = run(&shell, "native_viz_f").await;
		let snapshot = trace.snapshot();
		assert!(
			snapshot
				.units
				.iter()
				.any(|unit| unit.at.is_none() && unit.syntax.is_some())
		);
		let model = present(&trace, &Options::default());
		assert_eq!(model["output"], "retained");
		let saved = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
		let restored: Value =
			serde_json::from_str(&saved.presentation_json(&Options::default()).unwrap()).unwrap();
		assert_eq!(model, restored);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn dynamic_local_setter_does_not_invent_binding_ownership_from_function_entry() {
	let shell = Shell::new(None);
	let script = "native_viz_dynamic_g() { native_viz_dynamic_x=two; }; native_viz_dynamic_f() { \
	              local native_viz_dynamic_x=one; native_viz_dynamic_g; printf '%s' \
	              \"$native_viz_dynamic_x\"; }; native_viz_dynamic_f";
	let trace = run(&shell, script).await;
	let snapshot = trace.snapshot();
	let last=snapshot.history.iter().rev().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"native_viz_dynamic_x"&&value.as_slice()==b"two")).unwrap();
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "two");
	let watches: Vec<_> = live["watches"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(
		watches.len(),
		1,
		"g updates f's dynamically scoped local, not a new binding owned by g"
	);
	assert_eq!(watches[0]["value"], "two");
	assert_eq!(watches[0]["scope"], "local");
	assert!(
		watches[0]["scopeId"]
			.as_str()
			.unwrap()
			.ends_with(":binding:unknown")
	);
	assert_eq!(watches[0]["setterSeq"].as_u64(), Some(last.seq));
	let annotations: Vec<_> = live["rows"]
		.as_array()
		.unwrap()
		.iter()
		.filter_map(|row| row["annotations"].as_array())
		.flatten()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(annotations.len(), 1);
	assert_eq!(annotations[0]["setterSeq"].as_u64(), Some(last.seq));
	let first=snapshot.history.iter().find(|event|matches!(&event.data,HistoryData::Assign{name,value,..} if name.as_slice()==b"native_viz_dynamic_x"&&value.as_slice()==b"one")).unwrap();
	let replay = present(&trace, &Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(first.seq),
		..Options::default()
	});
	let replayed: Vec<_> = replay["watches"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|watch| watch["name"] == "native_viz_dynamic_x")
		.collect();
	assert_eq!(replayed.len(), 1);
	assert_eq!(replayed[0]["value"], "one");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn local_eval_literal_child_uses_actual_origin_and_native_node_ids() {
	let shell = Shell::new(None);
	let script = "eval 'child=inside; printf \"%s\\n\" \"$child\"'";
	let trace = run(&shell, script).await;
	let snapshot = trace.snapshot();
	let child = snapshot
		.units
		.iter()
		.enumerate()
		.find(|(_, unit)| {
			unit
				.syntax
				.as_ref()
				.is_some_and(|syntax| syntax.parent.is_some())
		})
		.expect("native literal source provenance");
	let parent = child.1.syntax.as_ref().unwrap().parent.unwrap();
	assert_ne!(parent.unit, child.0 as u32);
	let parent_syntax = snapshot.units[parent.unit as usize]
		.syntax
		.as_ref()
		.unwrap();
	let SyntaxTree::List(parent_list) = &parent_syntax.tree else {
		panic!("native parent list");
	};
	let CommandKind::Simple(parent_command) = &parent_list.items[0].and_or.first.stages[0].cmd.kind
	else {
		panic!("native shell invocation");
	};
	let word = &parent_command.words[1];
	assert_eq!(parent.node, word.id.0);
	assert_eq!(
		(parent.lo, parent.hi),
		(word.span.lo - parent_syntax.offset, word.span.hi - parent_syntax.offset)
	);
	assert_eq!(
		&script.as_bytes()[parent.lo as usize..parent.hi as usize],
		b"'child=inside; printf \"%s\\n\" \"$child\"'"
	);
	let child_syntax = child.1.syntax.as_ref().unwrap();
	let SyntaxTree::List(child_list) = &child_syntax.tree else {
		panic!("native child list");
	};
	let CommandKind::Simple(setter) = &child_list.items[0].and_or.first.stages[0].cmd.kind else {
		panic!("native child assignment");
	};
	let assignment = &setter.assigns[0];
	let key = format!("{}:0:{}", child.0, assignment.id.0);
	let owner = format!("{}:0:{}", child.0, child_list.items[0].and_or.first.stages[0].cmd.id.0);
	let range =
		serde_json::json!([parent.lo + 1 + assignment.span.lo, parent.lo + 1 + assignment.span.hi,]);
	let model = present(&trace, &Options::default());
	assert_eq!(model["output"], "inside\n");
	assert!(
		model["rows"]
			.as_array()
			.unwrap()
			.iter()
			.flat_map(|row| row["segments"].as_array().unwrap())
			.any(|segment| segment["node"] == key && segment["range"] == range)
	);
	assert!(snapshot.history.iter().any(|event| {
		event.u == Some(child.0 as u32)
			&& matches!(&event.data, HistoryData::Assign { name, value, .. }
			if name.as_slice() == b"child" && value.as_slice() == b"inside")
	}));
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(model, restored);
	let setter = snapshot
		.history
		.iter()
		.find(|event| {
			event.u == Some(child.0 as u32) && matches!(event.data, HistoryData::Assign { .. })
		})
		.unwrap();
	assert!(model["watches"].as_array().unwrap().iter().any(|watch| {
		watch["name"] == "child"
			&& watch["value"] == "inside"
			&& watch["node"] == owner
			&& watch["range"] == range
			&& watch["setterSeq"].as_u64() == Some(setter.seq)
	}));
	let options = Options {
		cursor: Some(snapshot.history.len()),
		cursor_seq: Some(setter.seq),
		..Options::default()
	};
	let replay = present(&trace, &options);
	let restored_replay: Value =
		serde_json::from_str(&stored.presentation_json(&options).unwrap()).unwrap();
	assert_eq!(replay, restored_replay);
	assert_eq!(replay["output"], "");
}

#[test]
fn same_native_child_unit_at_two_real_origins_keeps_distinct_trace_identity() {
	let (trace, stdout) = run_native_shell("bash -c 'printf same' & bash -c 'printf same' & wait");
	assert_eq!(stdout, b"samesame");
	let snapshot = trace.snapshot();
	let children: Vec<_> = snapshot
		.units
		.iter()
		.filter_map(|unit| unit.syntax.as_ref().and_then(|syntax| syntax.parent))
		.collect();
	assert_eq!(children.len(), 2);
	assert_eq!(children[0].unit, children[1].unit);
	assert_ne!(children[0].node, children[1].node);
	let parent_syntax = snapshot.units[children[0].unit as usize]
		.syntax
		.as_ref()
		.unwrap();
	let SyntaxTree::List(parent_list) = &parent_syntax.tree else {
		panic!("native parent list");
	};
	let mut expected = parent_list.items[..2]
		.iter()
		.map(|item| {
			let CommandKind::Simple(command) = &item.and_or.first.stages[0].cmd.kind else {
				panic!("native shell invocation");
			};
			command.words[2].id.0
		})
		.collect::<Vec<_>>();
	let mut actual = children
		.iter()
		.map(|parent| parent.node)
		.collect::<Vec<_>>();
	actual.sort_unstable();
	expected.sort_unstable();
	assert_eq!(actual, expected);
	let live = present(&trace, &Options::default());
	for (index, unit) in snapshot.units.iter().enumerate().filter(|(_, unit)| {
		unit
			.syntax
			.as_ref()
			.is_some_and(|syntax| syntax.parent.is_some())
	}) {
		assert_eq!(unit.source.as_ref().unwrap().as_slice(), b"printf same");
		let syntax = unit.syntax.as_ref().unwrap();
		let parent = syntax.parent.unwrap();
		let SyntaxTree::List(list) = &syntax.tree else {
			panic!("native child list");
		};
		let command = &list.items[0].and_or.first.stages[0].cmd;
		let key = format!("{index}:0:{}", command.id.0);
		let range = serde_json::json!([parent.lo + 1, parent.hi - 1]);
		let completion = snapshot
			.history
			.iter()
			.find(|event| {
				event.u == Some(index as u32) && matches!(event.data, HistoryData::CmdEnd { .. })
			})
			.unwrap();
		assert!(live["rows"].as_array().unwrap().iter().any(|row| {
			row["node"] == key
				&& row["range"] == range
				&& row["executionSeq"].as_u64() == Some(completion.seq)
		}));
	}
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn expanded_script_equal_to_a_literal_does_not_borrow_its_origin() {
	let shell = Shell::new(None);
	let trace = run(&shell, "script='printf same'; eval \"$script\"; eval 'printf same'").await;
	let snapshot = trace.snapshot();
	let children = snapshot
		.units
		.iter()
		.filter(|unit| unit.at.is_none())
		.collect::<Vec<_>>();
	assert_eq!(children.len(), 2);
	assert!(children[0].syntax.as_ref().unwrap().parent.is_none());
	assert!(children[1].syntax.as_ref().unwrap().parent.is_some());
	assert_eq!(children[0].source, children[1].source);
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "samesame");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn external_shell_literal_is_rendered_without_inventing_native_child_outcomes() {
	let shell = Shell::new(None);
	let trace = run(&shell, "bash -c 'native_viz_external=inside; printf outside'").await;
	let snapshot = trace.snapshot();
	assert_eq!(snapshot.units.len(), 1);
	assert!(snapshot.units[0].syntax.as_ref().unwrap().parent.is_none());
	assert!(snapshot.history.iter().all(|event| {
		!matches!(&event.data, HistoryData::Assign { name, .. }
			if name.as_slice() == b"native_viz_external")
	}));
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "outside");
	assert!(
		live["watches"]
			.as_array()
			.unwrap()
			.iter()
			.all(|watch| { watch["name"] != "native_viz_external" })
	);
	for row in live["rows"].as_array().unwrap() {
		if row["node"]
			.as_str()
			.is_some_and(|key| key.split(':').nth(1).is_some_and(|source| source != "0"))
		{
			assert!(row.get("executionSeq").is_none());
			assert!(row.get("executedAtNs").is_none());
		}
	}
	assert!(live["rows"].as_array().unwrap().iter().any(|row| {
		row["detail"]
			.as_str()
			.is_some_and(|detail| detail.contains("external/untraced"))
			|| row["segments"].as_array().unwrap().iter().any(|segment| {
				segment["text"]
					.as_str()
					.is_some_and(|text| text.contains("external/untraced"))
			})
	}));
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn pipeline_and_forked_function_body_share_the_original_canonical_occurrence() {
	let shell = Shell::new(None);
	let trace =
		run(&shell, "native_viz_pipe_f() { printf pipeline; }; native_viz_pipe_f | cat").await;
	let snapshot = trace.snapshot();
	assert_eq!(
		snapshot.units.len(),
		1,
		"vproc lookup context must not duplicate a static source occurrence"
	);
	assert!(
		snapshot
			.history
			.iter()
			.filter(|event| event.n.is_some())
			.all(|event| event.u == Some(0))
	);
	let live = present(&trace, &Options::default());
	assert_eq!(live["output"], "pipeline");
	let stored = StoredVisualization::from_snapshot_json(&trace.snapshot_json()).unwrap();
	let restored: Value =
		serde_json::from_str(&stored.presentation_json(&Options::default()).unwrap()).unwrap();
	assert_eq!(live, restored);
}

#[tokio::test(flavor = "multi_thread")]
async fn branch_badges_follow_real_negated_and_elif_decisions() {
	let shell = Shell::new(None);
	let trace = run(
		&shell,
		"if ! false; then printf yes; else printf no; fi; if false; then :; elif ! false; then \
		 printf second; fi",
	)
	.await;
	let presentation = present(&trace, &Options::default());
	assert_eq!(presentation["output"], "yessecond");
	let heads: Vec<_> = presentation["rows"]
		.as_array()
		.unwrap()
		.iter()
		.filter(|row| row["role"] == "head")
		.collect();
	assert!(heads.iter().filter(|row| row["meta"] == "↳").count() >= 2);
	assert!(heads.iter().any(|row| row["meta"] == "↷"));
}
