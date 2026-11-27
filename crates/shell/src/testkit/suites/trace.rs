//! The run trace contract: what a [`RunTrace`] attached to a run reports
//! about every statement.

use std::sync::Arc;

use bstr::BString;

use crate::{
	bash::{
		Budget, Cx, EventSink, Script, Step,
		event::{NodeKind, ResolvedKind},
		trace::{Node, RunTrace, Snapshot, State},
	},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init},
};

/// Run `src` with a trace attached; the final snapshot and the number of
/// events the host saw.
fn traced(src: &str) -> (Snapshot, usize, Arc<RunTrace>) {
	let trace = Arc::new(RunTrace::new(src));
	let sink: Arc<dyn EventSink> = Arc::clone(&trace) as Arc<dyn EventSink>;
	let mut rig = Rig::new(FakeHost::new().with_event_sink(sink), skeleton_init(&[]));
	rig.shell().set_event_mask(trace.mask());
	rig.run(Script::command(src.as_bytes()), Fault::None);
	let events = rig.host.events.len();
	(trace.snapshot(), events, trace)
}

/// The text of node `n` of unit `u`.
fn text<'a>(snap: &'a Snapshot, u: usize, n: &Node) -> &'a [u8] {
	let unit = &snap.units[u];
	let base = unit.at.expect("a located unit") as usize;
	&snap.script[base + n.lo as usize..base + n.hi as usize]
}

/// The node of `kind` whose text is `what` in unit `u`.
fn node<'a>(snap: &'a Snapshot, u: usize, kind: NodeKind, what: &str) -> &'a Node {
	snap.units[u]
		.nodes
		.iter()
		.find(|n| n.k == kind && text(snap, u, n) == what.as_bytes())
		.unwrap_or_else(|| panic!("no {kind:?} node {what:?} in unit {u}"))
}

#[test]
fn loop_body_counts_its_runs() {
	let (snap, events, _) = traced("for i in 1 2 3; do echo $i; done");
	assert_eq!(snap.status, Some(0));
	assert_eq!(snap.seq, events as u64, "every event the host saw was folded");
	assert_eq!(snap.units.len(), 1);
	let body = node(&snap, 0, NodeKind::Simple, "echo $i");
	assert_eq!((body.state, body.runs, body.st, body.live), (State::Ok, 3, Some(0), 0));
	assert_eq!(body.argv, ["echo", "3"], "the last expansion");
	let loop_node = node(&snap, 0, NodeKind::For, "for i in 1 2 3; do echo $i; done");
	assert_eq!(
		(loop_node.state, loop_node.runs, loop_node.iter, loop_node.iters),
		(State::Ok, 1, Some(3), Some(3))
	);
	assert!(
		snap.units[0]
			.nodes
			.iter()
			.all(|n| n.state != State::Pending),
		"nothing pending after RunEnd"
	);
}

#[test]
fn failing_and_operand_leaves_the_rest_pending_then_skipped() {
	let src = "false && echo no";
	let trace = Arc::new(RunTrace::new(src));
	let sink: Arc<dyn EventSink> = Arc::clone(&trace) as Arc<dyn EventSink>;
	let mut rig = Rig::new(FakeHost::new().with_event_sink(sink), skeleton_init(&[]));
	rig.shell().set_event_mask(trace.mask());
	let (shell, host, store) = rig.parts();
	let run = shell.submit(Script::command(src.as_bytes()));
	let mut seen_mid_run = false;
	let mut last_version = 0;
	loop {
		let step = shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget {
			max_ops: 1,
			max_ns:  u64::MAX,
		});
		let version = trace.version();
		assert!(version >= last_version, "version is monotonic");
		last_version = version;
		let snap = trace.snapshot();
		if snap.status.is_none() && !snap.units.is_empty() {
			let no = node(&snap, 0, NodeKind::Simple, "echo no");
			assert_eq!(no.state, State::Pending, "untouched statements stay pending while running");
			if node(&snap, 0, NodeKind::Simple, "false").st == Some(1) {
				seen_mid_run = true;
			}
		}
		match step {
			Step::Done { run: done, status } if done == run => {
				assert_eq!(status, 1);
				break;
			},
			Step::Idle => panic!("idle before the run ended"),
			_ => {},
		}
	}
	assert!(seen_mid_run, "a snapshot between `false` ending and RunEnd");
	let snap = trace.snapshot();
	assert_eq!(snap.status, Some(1), "status is set at RunEnd");
	let no = node(&snap, 0, NodeKind::Simple, "echo no");
	assert_eq!((no.state, no.runs), (State::Skipped, 0));
	let fail = node(&snap, 0, NodeKind::Simple, "false");
	assert_eq!((fail.state, fail.fails, fail.st), (State::Fail, 1, Some(1)));
	let list = node(&snap, 0, NodeKind::AndOr, src);
	assert_eq!((list.state, list.runs), (State::Fail, 0), "a list takes the last operand that ran");
	host.assert_no_leaks(shell, store);
}

#[test]
fn or_list_is_ok_when_the_fallback_ran() {
	let (snap, ..) = traced("false || true");
	let list = node(&snap, 0, NodeKind::AndOr, "false || true");
	assert_eq!(list.state, State::Ok);
	assert_eq!(node(&snap, 0, NodeKind::Simple, "false").state, State::Fail);
}

#[test]
fn pipeline_stages_report_their_own_states() {
	let (snap, ..) = traced("true | false");
	let pipe = node(&snap, 0, NodeKind::Pipeline, "true | false");
	assert_eq!((pipe.state, pipe.runs), (State::Fail, 0), "no CmdStart for the pipeline itself");
	assert_eq!(node(&snap, 0, NodeKind::Simple, "true").state, State::Ok);
	let last = node(&snap, 0, NodeKind::Simple, "false");
	assert_eq!((last.state, last.st), (State::Fail, Some(1)));
}

#[test]
fn assignment_keeps_its_value_and_the_substitution_its_argv() {
	let (snap, ..) = traced("x=$(echo 5)");
	let assign = node(&snap, 0, NodeKind::Simple, "x=$(echo 5)");
	assert!(assign.argv.is_empty());
	assert_eq!(assign.env, [(BString::from("x"), BString::from("5"))]);
	assert_eq!(assign.res, Some(ResolvedKind::None));
	assert_eq!(assign.state, State::Ok);
	let inner = node(&snap, 0, NodeKind::Simple, "echo 5");
	assert_eq!(inner.argv, ["echo", "5"]);
	assert_eq!(inner.res, Some(ResolvedKind::Intrinsic));
}

#[test]
fn function_body_merges_into_its_definition() {
	let (snap, ..) = traced("f() { echo in-f; }\nf\nf 1");
	assert_eq!(snap.units.len(), 3, "the body re-announcement joins the definition");
	let def = &snap.units[0];
	assert_eq!(def.at, Some(0));
	let brace = node(&snap, 0, NodeKind::Brace, "{ echo in-f; }");
	assert_eq!((brace.state, brace.runs), (State::Ok, 2));
	let body = node(&snap, 0, NodeKind::Simple, "echo in-f");
	assert_eq!(body.runs, 2);
	let call = node(&snap, 1, NodeKind::Simple, "f");
	assert_eq!((call.state, call.res), (State::Ok, Some(ResolvedKind::Function)));
}

#[test]
fn eval_string_is_an_unlocated_unit() {
	let (snap, ..) = traced("eval 'echo hi'");
	assert_eq!(snap.units.len(), 2);
	let evaled = &snap.units[1];
	assert_eq!(evaled.at, None);
	assert_eq!(evaled.source.as_ref().map(|s| s.as_slice()), Some(&b"echo hi"[..]));
	let hi = evaled
		.nodes
		.iter()
		.find(|node| node.k == NodeKind::Simple)
		.unwrap();
	assert_eq!((hi.k, hi.state), (NodeKind::Simple, State::Ok));
	assert_eq!(hi.argv, ["echo", "hi"]);
}

#[test]
fn deferred_function_setters_replace_equal_length_word_placeholders() {
	use crate::bash::trace::history::HistoryData;
	let source = "f() { local x=local; read x <<< changed; }; f";
	let (snapshot, ..) = traced(source);
	for (value, expected) in [("local", "local x=local"), ("changed", "read x <<< changed")] {
		let entry = snapshot
			.history
			.iter()
			.find(|entry| {
				matches!(&entry.data,
			HistoryData::Assign { name, value: actual, .. }
				if name.as_slice() == b"x" && actual.as_slice() == value.as_bytes())
			})
			.unwrap_or_else(|| panic!("missing function setter {value}"));
		let u = entry.u.expect("setter unit") as usize;
		let n = &snapshot.units[u].nodes[entry.n.expect("setter node") as usize];
		assert_ne!(n.k, NodeKind::Word, "deferred word placeholder must be populated");
		assert_eq!(text(&snapshot, u, n), expected.as_bytes());
	}
}

#[test]
fn snapshot_json_preserves_execution_state_and_history() {
	let (snap, _, trace) = traced("# first\necho a\n# last\n");
	let json: serde_json::Value = serde_json::from_str(&trace.snapshot_json()).unwrap();
	assert_eq!(json["v"], 1);
	assert_eq!(json["status"], 0);
	assert_eq!(json["units"][0]["nodes"][0]["k"], "and_or");
	assert_eq!(json["units"][0]["nodes"][0]["state"], "ok");
	assert!(json["units"][0]["nodes"][0].get("runs").is_none(), "zero counters are omitted");
	assert_eq!(json["history"][0]["kind"], "RunStart");
	assert_eq!(json["history"][0]["t_ns"], 0, "history uses the snapshot's run-relative clock");
	let history = json["history"].as_array().unwrap();
	assert_eq!(history.last().unwrap()["kind"], "RunEnd");
	assert!(
		history
			.iter()
			.any(|entry| entry["kind"] == "CmdExpanded" && entry.get("command").is_some())
	);
	assert!(json.get("historyTruncated").is_none(), "untrimmed journals omit the flag");
	assert_eq!(json, serde_json::to_value(&snap).unwrap(), "borrowed and owned JSON agree");
}
