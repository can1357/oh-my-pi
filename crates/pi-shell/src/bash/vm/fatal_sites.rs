//! The coverage gate of the fatal-jump site matrix.
//!
//! `crates/pi-shell/tests/fatal-site-matrix.json` carries measured samples of
//! every element of every axis the fatal-jump model has, and
//! `tests/fatal_site_matrix.rs` runs them. The axis lists in that file are not
//! written by hand: `tools/gen-fatal-sites.py` reads them out of these enums'
//! declarations and out of the engine's own (`Opcode`, `DeclareKind`,
//! [`Stop`], [`FrameKind`]), crosses them with the samples it holds and
//! measures every row against Bash 5.2.21 and 5.3.0. The tests below compare
//! the lists the fixture was measured for with the crate's own and check that
//! every element — and, on the carrier matrix, every combination of elements —
//! still has a sample, so a new `Opcode`, a new declaration builtin kind, a new
//! expansion stop, a new frame kind, a new carrier, context or raiser fails
//! here until the pass is re-run and the fixture gains its rows.
//!
//! The three axes declared here exist only to be enumerated by name. They are
//! the shape of a generated row, not state the VM keeps: a failing command
//! ([`Raiser`]) inside a substitution shape ([`Carrier`]) under a set of shell
//! options ([`FatalContext`]), run directly and again inside an EXIT trap
//! ([`TrapReplication`]).

use std::collections::HashSet;

use strum::VariantNames;

use super::{builtins::vars::DeclareKind, expand::Stop, proc::FrameKind};
use crate::bash::ir::Opcode;

/// The substitution shape a generated row's failing command is carried by.
///
/// `${ ;}` and `${| ;}` run the body in the current shell, so a fatal error
/// raised inside one is caught by the no-fork frame rather than by a child
/// vproc. The compositions appear in both orders because the order of the two
/// frames decides which one catches.
#[derive(strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
#[expect(dead_code, reason = "a generated axis: enumerated by name, never constructed")]
enum Carrier {
	/// No substitution: the failing command on its own.
	Plain,
	/// `${ cmd; }`.
	Nofork,
	/// `${| cmd; }` (the body's `REPLY`).
	Reply,
	/// `eval` outside, `${ ;}` inside.
	EvalNofork,
	/// `${ ;}` outside, `eval` inside.
	NoforkEval,
	/// `${ ;}` outside, a forked `( )` subshell inside.
	NoforkSubshell,
	/// A forked `( )` subshell outside, `${ ;}` inside.
	SubshellNofork,
	/// A forked `$( )` substitution outside, `${ ;}` inside.
	ForkNofork,
	/// `${ ;}` inside `${ ;}`.
	NestedNofork,
	/// `.` outside, `${ ;}` inside.
	SourceNofork,
	/// `${ ;}` as the condition of an `if`.
	Condition,
}

/// The shell options in force around a generated carrier row.
#[derive(strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
#[expect(dead_code, reason = "a generated axis: enumerated by name, never constructed")]
enum FatalContext {
	/// Defaults.
	Normal,
	/// `set -e`.
	Errexit,
	/// `set -e` with `shopt -s inherit_errexit`, so a substitution's body
	/// inherits it.
	Inherit,
	/// `set -o posix`.
	Posix,
	/// `set -o posix` and `set -e` together.
	PosixE,
	/// `set -u`.
	Nounset,
}

/// The failing command a generated carrier row raises its error with.
#[derive(strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
#[expect(dead_code, reason = "a generated axis: enumerated by name, never constructed")]
enum Raiser {
	/// An invalid parameter name (`${bad.name}`).
	Badsub,
	/// An arithmetic error in a word (`$((1/0))`).
	Wordarith,
	/// An arithmetic error in an arithmetic command's assignment subscript.
	Subarith,
	/// An invalid subscript in a declaration's assignment.
	Declsub,
	/// An arithmetic error in a declaration's value.
	Declval,
	/// An assignment to a readonly variable.
	Readonly,
	/// An unset parameter under `set -u`.
	Nounset,
	/// `${x?word}` on an unset parameter.
	Fatal,
	/// An arithmetic error in an array READ subscript (`${A[1/0]}`), which
	/// no write-subscript sample reaches.
	Readsub,
	/// An ordinary failing command, as the control the error rows are read
	/// against.
	False,
}

/// How a generated carrier row is replicated.
#[derive(strum::VariantNames)]
#[strum(serialize_all = "snake_case")]
#[expect(dead_code, reason = "a generated axis: enumerated by name, never constructed")]
enum TrapReplication {
	/// Run as the script's own command.
	Direct,
	/// Run as the body of an EXIT trap.
	Exit,
}

const FIXTURE: &str = include_str!("../../../tests/fatal-site-matrix.json");

const REGENERATE: &str = "re-run tools/gen-fatal-sites.py, tools/measure-fatal-sites.py and \
                          tools/emit-fatal-site-fixture.py so every element keeps a sample";

fn fixture() -> serde_json::Value {
	serde_json::from_str(FIXTURE).expect("the site-matrix fixture parses")
}

/// The `axis:element` tags of every row.
fn axis_tags(fixture: &serde_json::Value) -> HashSet<&str> {
	fixture
		.get("rows")
		.and_then(serde_json::Value::as_array)
		.expect("the site matrix has rows")
		.iter()
		.filter_map(|row| row.get("axes").and_then(serde_json::Value::as_array))
		.flatten()
		.filter_map(serde_json::Value::as_str)
		.collect()
}

#[test]
fn the_site_matrix_covers_every_variant_of_the_model() {
	let fixture = fixture();
	let enums = fixture.get("enums").expect("the fixture records the axis lists");
	for (name, variants) in [
		("Opcode", Opcode::VARIANTS),
		("DeclareKind", DeclareKind::VARIANTS),
		("Stop", Stop::VARIANTS),
		("FrameKind", FrameKind::VARIANTS),
		("Carrier", Carrier::VARIANTS),
		("FatalContext", FatalContext::VARIANTS),
		("Raiser", Raiser::VARIANTS),
		("TrapReplication", TrapReplication::VARIANTS),
	] {
		let recorded: Vec<&str> = enums
			.get(name)
			.and_then(serde_json::Value::as_array)
			.unwrap_or_else(|| panic!("the site matrix has no {name} axis"))
			.iter()
			.filter_map(serde_json::Value::as_str)
			.collect();
		assert_eq!(
			recorded, variants,
			"{name} is no longer what the site matrix was measured for; {REGENERATE}"
		);
	}
}

/// Every element of the three axes the carrier matrix adds has at least one
/// measured row, in both replications.
#[test]
fn every_carrier_axis_element_has_a_sample() {
	let fixture = fixture();
	let tags = axis_tags(&fixture);
	let mut missing = Vec::new();
	for (axis, variants) in [
		("carrier", Carrier::VARIANTS),
		("fatalContext", FatalContext::VARIANTS),
		("gateRaiser", Raiser::VARIANTS),
		("trap", TrapReplication::VARIANTS),
	] {
		for element in variants {
			if !tags.contains(format!("{axis}:{element}").as_str()) {
				missing.push(format!("{axis}:{element}"));
			}
		}
	}
	assert!(missing.is_empty(), "the site matrix has no row for {missing:?}; {REGENERATE}");
}

/// A fatal error is caught by whichever frame is innermost, so the carrier
/// matrix is a cross product, not a cover: every combination of context,
/// carrier and raiser has its own measured row in each replication.
#[test]
fn every_carrier_combination_has_a_sample() {
	let fixture = fixture();
	let ids: HashSet<&str> = fixture
		.get("rows")
		.and_then(serde_json::Value::as_array)
		.expect("the site matrix has rows")
		.iter()
		.filter_map(|row| row.get("id").and_then(serde_json::Value::as_str))
		.collect();
	let mut missing = Vec::new();
	for trap in TrapReplication::VARIANTS {
		for context in FatalContext::VARIANTS {
			for carrier in Carrier::VARIANTS {
				for raiser in Raiser::VARIANTS {
					let id = format!("carrier-{trap}-{context}-{carrier}-{raiser}");
					if !ids.contains(id.as_str()) {
						missing.push(id);
					}
				}
			}
		}
	}
	assert!(
		missing.is_empty(),
		"the site matrix is missing {} carrier combinations, the first being {:?}; {REGENERATE}",
		missing.len(),
		&missing[..missing.len().min(5)]
	);
}
