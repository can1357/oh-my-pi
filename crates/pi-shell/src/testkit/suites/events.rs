//! Event stream contract: goldens, span validity, mask gating, and verdicts.

use std::{fs, path::PathBuf};

use serde_json::Value;

use crate::{
	bash::{EventKind, EventMask, Script, Verdict},
	testkit::{FakeHost, Fault, Rig, fault::skeleton_init, golden, run_script},
};

fn fixture(name: &str) -> PathBuf {
	super::fixtures("events").join(name)
}

#[test]
fn events_golden_for_loop() {
	let src = fs::read(fixture("for-loop.sh")).unwrap();
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(src), Fault::None), 0);
	let actual = golden::normalize(&rig.host.events);
	let expected =
		golden::parse_jsonl(&fs::read_to_string(fixture("for-loop.jsonl")).unwrap()).unwrap();
	if let Some(d) = golden::diff(&actual, &expected) {
		panic!("{d}");
	}
}

/// Every node event's span lies inside its unit's bytes, the unit was
/// announced before, and `node` is below the unit's node count.
#[test]
fn events_spans_are_within_announced_units() {
	let src = b"x=1\nif true; then\n  for i in a b; do echo \"$i$x\" && false || :; done\nfi\n{ echo z; }\n";
	let o = run_script(FakeHost::new(), src, &[], Fault::None);
	let mut units: Vec<(String, usize, u64)> = Vec::new();
	let mut node_events = 0;
	for e in &o.events {
		if e["kind"] == "UnitCompiled" {
			let d = &e["data"];
			units.push((
				d["unit"].as_str().unwrap().to_owned(),
				d["source"].as_str().unwrap().len(),
				d["node_count"].as_u64().unwrap(),
			));
			continue;
		}
		let Value::Object(node) = &e["node"] else {
			continue;
		};
		node_events += 1;
		let unit = node["unit"].as_str().unwrap();
		let (_, len, count) = units
			.iter()
			.find(|(u, ..)| u == unit)
			.expect("unit announced before use");
		assert!(node["node"].as_u64().unwrap() < *count);
		let span = &e["span"];
		let (lo, hi) = (span["lo"].as_u64().unwrap() as usize, span["hi"].as_u64().unwrap() as usize);
		assert!(lo <= hi && hi <= *len, "span {lo}..{hi} outside a {len}-byte unit");
		assert_eq!(span["origin"]["links"][0]["origin"], "Command");
	}
	assert_eq!(units.len(), 3, "one unit per top-level command");
	assert!(node_events > 10);
	assert_eq!(o.stdout, b"a1\nb1\nz\n");
}

/// `FuncEnter` points at the calling command in the caller's announced
/// unit; `FuncExit` shares the clock reading of the body's last `CmdEnd`
/// (only the frame's end ran since), and the call's own `CmdEnd` reads it.
#[test]
fn events_function_call_points_at_the_call_and_shares_the_exit_clock() {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(&b"f() { :; }\nf a\n"[..]), Fault::None), 0);
	let events = &rig.host.events;
	let at = |kind: &str| {
		events
			.iter()
			.position(|e| e["kind"] == kind)
			.unwrap_or_else(|| panic!("no {kind} event"))
	};
	let enter = &events[at("FuncEnter")];
	let source = events
		.iter()
		.filter(|e| e["kind"] == "UnitCompiled" && e["data"]["unit"] == enter["node"]["unit"])
		.find_map(|e| e["data"]["source"].as_str())
		.expect("FuncEnter's unit announced before it");
	let span = &enter["span"];
	let (lo, hi) = (span["lo"].as_u64().unwrap() as usize, span["hi"].as_u64().unwrap() as usize);
	assert_eq!(&source[lo..hi], "f a");
	let exit = at("FuncExit");
	let t = |i: usize| events[i]["t_ns"].as_u64().unwrap();
	assert_eq!(events[exit - 1]["kind"], "CmdEnd", "the body ends just before");
	assert_eq!(t(exit), t(exit - 1));
	assert_eq!(events[exit + 1]["kind"], "CmdEnd", "the call ends just after");
	assert!(t(exit + 1) > t(exit), "the call's CmdEnd reads the clock");
}

/// A function body is a unit of its own: it is announced when the function
/// is defined (at top level, by `eval`, inside another function), a `${ ;}`
/// body when it is parsed, and a restored shell announces again every unit
/// it can still run, so every node event names a unit announced before it
/// (since the last `Restored`: the host may be a new process).
#[test]
fn events_name_only_announced_units_also_after_restores() {
	let src = &b"f() { echo \"f $1\"; }\neval 'g() { echo g; f in-g; }'\nh() { k() { echo k; }; \
	             k; }\nf a; g; h; k; x=${ f nofork; }; echo \"$x\"\n"[..];
	for fault in [Fault::None, Fault::Snapshot { every: 1 }, Fault::Snapshot { every: 7 }] {
		let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
		assert_eq!(rig.run(Script::command(src), fault), 0);
		assert_eq!(rig.host.stdout.bytes(), b"f a\ng\nf in-g\nk\nk\nf nofork\n");
		let (missing, nodes) = golden::unannounced(&rig.host.events);
		assert!(missing.is_empty(), "{fault:?}: unannounced units in {missing:#?}");
		let bodies = rig
			.host
			.events
			.iter()
			.filter(|e| e["kind"] == "UnitCompiled")
			.filter_map(|e| e["data"]["unit"].as_str())
			.collect::<std::collections::HashSet<_>>()
			.len();
		assert!(bodies >= 6, "{fault:?}: 2 top-level units and 4 bodies, saw {bodies}");
		assert!(nodes > 20, "{fault:?}");
		if fault != Fault::None {
			assert!(rig.snapshots > 0, "{fault:?} restored nothing");
		}
	}
}

#[test]
fn events_opt_in_kinds_follow_the_mask() {
	let src = b"for i in 1 2; do true && false; done\n";
	let kinds = |mask: Option<EventMask>| {
		let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
		if let Some(m) = mask {
			rig.shell().set_event_mask(m);
		}
		rig.run(Script::command(&src[..]), Fault::None);
		rig.host
			.events
			.iter()
			.map(|e| e["kind"].as_str().unwrap().to_owned())
			.collect::<Vec<_>>()
	};
	let default = kinds(None);
	for k in ["Assign", "Branch", "IterStart", "LoopEnd"] {
		assert!(!default.iter().any(|d| d == k), "{k} is opt-in");
	}
	let all = kinds(Some(EventMask::ALL));
	assert_eq!(all.iter().filter(|k| *k == "IterStart").count(), 2);
	assert_eq!(all.iter().filter(|k| *k == "Branch").count(), 2, "one && decision per iteration");
	assert_eq!(all.iter().filter(|k| *k == "LoopEnd").count(), 1);
	assert!(kinds(Some(EventMask::NONE)).is_empty());
	let only = kinds(Some(EventMask::of(EventKind::RunEnd)));
	assert_eq!(only, ["RunEnd"]);
}

#[test]
fn events_branch_reports_taken_and_status() {
	let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
	rig.shell().set_event_mask(EventMask::of(EventKind::Branch));
	rig.run(
		Script::command(&b"if false; then :; elif true; then :; fi; false || true"[..]),
		Fault::None,
	);
	let b: Vec<(String, bool, i64)> = rig
		.host
		.events
		.iter()
		.map(|e| {
			let d = &e["data"];
			(
				d["construct"].as_str().unwrap().to_owned(),
				d["taken"].as_bool().unwrap(),
				d["status"].as_i64().unwrap(),
			)
		})
		.collect();
	assert_eq!(b, [("if".into(), false, 1), ("elif".into(), true, 0), ("or".into(), true, 1)]);
}

/// `Verdict::Pause` from the host stops the shell at that safepoint; the
/// rest of the run is unchanged after resume.
#[test]
fn events_pause_verdict_is_a_breakpoint() {
	let src = b"for i in 1 2 3; do echo $i; done";
	let mut host = FakeHost::new();
	let mut hits = 0;
	host.on_event(Box::new(move |e: &crate::bash::Event<'_>| {
		if e.kind == EventKind::CmdStart && hits < 2 {
			hits += 1;
			Verdict::Pause
		} else {
			Verdict::Continue
		}
	}));
	let mut rig = Rig::new(host, skeleton_init(&[]));
	assert_eq!(rig.run(Script::command(&src[..]), Fault::None), 0);
	assert_eq!(rig.host.stdout.bytes(), b"1\n2\n3\n");
	let stopped = rig
		.host
		.events
		.iter()
		.filter(|e| e["kind"] == "Stopped")
		.count();
	assert_eq!(stopped, 2);
}
