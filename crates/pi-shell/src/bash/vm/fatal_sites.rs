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

/// The row ids of the matrix.
fn row_ids(fixture: &serde_json::Value) -> HashSet<&str> {
	fixture
		.get("rows")
		.and_then(serde_json::Value::as_array)
		.expect("the site matrix has rows")
		.iter()
		.filter_map(|row| row.get("id").and_then(serde_json::Value::as_str))
		.collect()
}

/// The string list the fixture records under `axes`.
fn axis_elements<'a>(fixture: &'a serde_json::Value, axis: &str) -> Vec<&'a str> {
	fixture
		.get("axes")
		.and_then(|a| a.get(axis))
		.and_then(serde_json::Value::as_array)
		.unwrap_or_else(|| panic!("the site matrix records no {axis} axis"))
		.iter()
		.filter_map(serde_json::Value::as_str)
		.collect()
}

/// The original matrix's axis elements, pinned HERE rather than read from the
/// fixture.
///
/// Reading the required list out of the fixture made the requirement move with
/// the generator: drop a context from `CONTEXTS`, regenerate, and the recorded
/// list shrinks with the rows, so a gate that compares the two stays green over
/// less coverage. Pinned here, removing an element is a source edit in the gate
/// — which is the decision it should be — and the fixture must still match.
const ORIGINAL_AXES: &[(&str, &[&str])] = &[
	("construct", &[
		"simple", "and", "or", "not", "pipe_head", "pipe_tail", "group", "subshell",
		"background", "cmdsub", "if_cond", "if_body", "while_cond", "until_cond", "for_in",
		"for_arith", "case_word", "case_arm", "function", "redirect", "time_pipeline",
		"cond_test", "arith_command", "eval_builtin", "source_builtin", "nested_c",
		"nested_script", "loop_continue",
	]),
	("context", &[
		"top", "top_errexit", "subshell", "subshell_errexit", "cmdsub", "eval", "source",
		"nested_script", "exit_trap", "exit_trap_errexit", "err_trap", "err_trap_from_debug",
		"debug_trap", "return_trap", "err_trap_in_exit", "debug_trap_in_exit",
		"return_trap_in_exit", "fork_in_exit", "top_posix", "top_posix_errexit",
		"exit_trap_posix",
	]),
	("raiser", &[
		"fatal_unset", "fatal_nounset", "discard_readonly", "assign_int", "assign_subscript",
		"arith_word",
	]),
];

/// Every element of every sampled axis has a measured row.
///
/// Name freshness is not coverage. Without this, the rows that exercise an axis
/// can be gone while the recorded names still agree with the crate, and a new
/// variant can be waved through by regenerating the names alone. The original
/// matrix's axes are checked here against the pinned lists above, the carrier
/// matrix's below against its enums.
#[test]
fn every_sampled_axis_element_has_a_measured_row() {
	let fixture = fixture();
	let tags = axis_tags(&fixture);
	assert_eq!(
		axis_elements(&fixture, "declareKind"),
		DeclareKind::VARIANTS,
		"the declaration axis is no longer DeclareKind; {REGENERATE}"
	);
	let mut missing = Vec::new();
	for (axis, pinned) in ORIGINAL_AXES.iter().copied() {
		assert_eq!(
			axis_elements(&fixture, axis),
			pinned,
			"the {axis} axis is no longer the one this gate requires; a dropped element is a \
			 decision, so remove it from ORIGINAL_AXES beside this test as well, and say in the \
			 pull request what stopped being covered"
		);
		for element in pinned {
			if !tags.contains(format!("{axis}:{element}").as_str()) {
				missing.push(format!("{axis}:{element}"));
			}
		}
	}
	for element in DeclareKind::VARIANTS {
		if !tags.contains(format!("declareKind:{element}").as_str()) {
			missing.push(format!("declareKind:{element}"));
		}
	}
	assert!(missing.is_empty(), "the site matrix has no row for {missing:?}; {REGENERATE}");
}

/// Opcodes no sample of this matrix lowers to, each with why not.
///
/// Two different reasons appear here, and the distinction matters: four of
/// these are perfectly reachable from bash and are simply not sampled by this
/// matrix's constructs, and the rest belong to the zsh dialect, which a
/// bash-dialect matrix cannot reach at all. An entry is a record of a sampling
/// choice, never a claim that the engine cannot get there.
///
/// This list is source, not fixture: regenerating the matrix cannot grow it,
/// so a new `Opcode` stays failing until someone writes a sample or records a
/// reason here. Every entry is checked against the measurement below, so an
/// entry a sample starts reaching fails too.
const OPCODES_WITH_NO_SAMPLE: &[(&str, &str)] = &[
	// Reachable from bash; this matrix's constructs do not sample them.
	("Redir", "a COMPOUND command's redirection list (`{ …; } > /dev/null`); a simple \
	           command's redirections are part of its `Exec`, and every construct here \
	           redirects a simple command"),
	("PopRedir", "the close of that same compound redirection"),
	("Warn", "a parse warning's diagnostic (`if ; then :; fi`); every sample parses clean"),
	("Abort", "a syntax error or a construct the engine cannot run (an unterminated \
	           here-document); every sample parses and lowers"),
	// zsh-dialect only: the bash grammar has no such construct.
	("Nop", "a zsh list marker; `lower::list` emits it only in the zsh dialect"),
	("Repeat", "zsh `repeat`"),
	("TryEnter", "zsh `always`"),
	("AlwaysEnter", "zsh `always`"),
	("AlwaysEnd", "zsh `always`"),
	("CallAnon", "a zsh anonymous function"),
];

/// Every `Opcode` the engine has is lowered to by a sample, or is recorded
/// above as one this matrix does not sample, with why not.
///
/// Measured, not declared, and STATIC: each row's script is compiled and the
/// opcodes of the resulting units — function bodies included — are collected.
/// What an `eval`'s or a sourced file's runtime text lowers to is not followed,
/// so this is coverage of what the matrix compiles, not of every op it runs.
#[test]
fn every_opcode_is_reached_by_a_measured_sample() {
	fn collect(unit: &crate::bash::ir::Unit, seen: &mut HashSet<Opcode>) {
		seen.extend(unit.ops.iter().map(|op| op.code));
		for func in &unit.funcs {
			collect(&func.body, seen);
		}
	}
	let fixture = fixture();
	let mut seen = HashSet::new();
	for row in fixture.get("rows").and_then(serde_json::Value::as_array).expect("rows") {
		let script = row.get("script").and_then(serde_json::Value::as_str).expect("script");
		for unit in crate::bash::ir::compile_all(
			script.as_bytes(),
			crate::bash::ids::ModeId::Bash,
			crate::bash::syntax::Features::NONE,
		) {
			collect(&unit, &mut seen);
		}
	}
	let reached: HashSet<&str> = seen.iter().map(|&code| <&'static str>::from(code)).collect();
	let excused: HashSet<&str> = OPCODES_WITH_NO_SAMPLE.iter().map(|&(name, _)| name).collect();
	let missing: Vec<&str> = Opcode::VARIANTS
		.iter()
		.copied()
		.filter(|name| !reached.contains(name) && !excused.contains(name))
		.collect();
	assert!(
		missing.is_empty(),
		"no sample of the site matrix lowers to {missing:?}; add one, or record it in \
		 OPCODES_WITH_NO_SAMPLE with the reason"
	);
	let stale: Vec<&str> = OPCODES_WITH_NO_SAMPLE
		.iter()
		.filter(|&&(name, _)| reached.contains(name) || !Opcode::VARIANTS.contains(&name))
		.map(|&(name, _)| name)
		.collect();
	assert!(
		stale.is_empty(),
		"OPCODES_WITH_NO_SAMPLE names {stale:?}, which a sample now reaches or which is no \
		 longer an Opcode; remove the entry"
	);
}

/// Which row exercises each `Stop`, or why none does. Source, not fixture,
/// for the same reason as `OPCODES_WITH_NO_SAMPLE`: a new variant cannot be
/// regenerated past this gate.
const STOP_SAMPLES: &[(&str, Sample)] = &[
	(
		"Sub",
		Sample::Row("carrier-direct-normal-fork_nofork-badsub", "a forked `$( )` substitution"),
	),
	("ZshSub", Sample::None("a zsh command substitution; the matrix is bash-dialect")),
	("MathCall", Sample::None("a zsh user math function; the matrix is bash-dialect")),
	("Probe", Sample::None("a zsh `=cmd` PATH probe; the matrix is bash-dialect")),
	("Wait", Sample::Row("construct-background-fatal_unset-top-clean", "`$!` of a background job")),
	("Fail", Sample::Row("carrier-direct-normal-plain-badsub", "an invalid parameter name")),
	("Fatal", Sample::Row("carrier-direct-normal-plain-fatal", "`${x?word}` on an unset name")),
	("Store", Sample::None("a state-store failure, which no script can raise")),
];

/// Which row exercises each `FrameKind`, or why none does.
const FRAME_SAMPLES: &[(&str, Sample)] = &[
	("Script", Sample::Row("carrier-direct-normal-source_nofork-badsub", "a sourced file")),
	("Function", Sample::Row("construct-function-fatal_unset-top-clean", "a function call")),
	("Subshell", Sample::Row("construct-subshell-fatal_unset-top-clean", "a forked `( )`")),
	("NoFork", Sample::Row("carrier-direct-normal-nofork-badsub", "`${ ;}` in the current shell")),
	(
		"Stage",
		Sample::None(
			"the last stage of a pipeline run in the CURRENT shell, which happens only under \
			 `shopt -s lastpipe`; no sample enables it, and an ordinary pipeline's last stage \
			 is a forked `Subshell` instead",
		),
	),
	("Job", Sample::None("the base frame of a suspended job; the matrix has no job control")),
];

/// A sample for one variant of a runtime axis: the row that exercises it, or
/// the reason the matrix has none.
enum Sample {
	/// The row id, and what about it reaches the variant.
	Row(&'static str, &'static str),
	/// Why no row reaches it.
	None(&'static str),
}

/// Each variant of the two runtime axes names the row that exercises it, or
/// records why none does, and every row it names exists.
///
/// What this does NOT do is observe the variant at run time: it checks the
/// named row is in the matrix, and the claim that the row reaches the variant
/// is carried by the note beside it. Each mapping here was confirmed by
/// instrumenting frame construction once, by hand; a mapping that silently
/// stops holding would need that instrumentation again, which is why the
/// `Stage` entry records no row rather than naming a pipeline that only
/// reaches it under `lastpipe`.
#[test]
fn every_runtime_axis_variant_names_its_sample() {
	let fixture = fixture();
	let ids = row_ids(&fixture);
	let mut wrong = Vec::new();
	for (axis, variants, samples) in [
		("Stop", Stop::VARIANTS, STOP_SAMPLES),
		("FrameKind", FrameKind::VARIANTS, FRAME_SAMPLES),
	] {
		let named: Vec<&str> = samples.iter().map(|&(name, _)| name).collect();
		assert_eq!(
			named, variants,
			"{axis} is no longer what the samples were written for; add or remove entries in \
			 the table beside this test — regenerating the fixture cannot do it for you"
		);
		for (name, sample) in samples {
			match sample {
				Sample::Row(id, _) if !ids.contains(id) => {
					wrong.push(format!("{axis}::{name} names row {id}, which the matrix has no"));
				},
				Sample::None(reason) if reason.is_empty() => {
					wrong.push(format!("{axis}::{name} has no sample and no reason"));
				},
				_ => {},
			}
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
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

/// Prints every axis's variant names as JSON to stdout.
///
/// `tools/gen-fatal-sites.py` reads this output instead of parsing Rust source
/// text.  AGENTS.md:314 bans source-grepping implementation files; this test
/// provides the same information through the crate's own [`VariantNames`] derive.
///
/// Run with:
/// ```text
/// cargo test -p pi-shell --lib -- bash::vm::fatal_sites::print_enum_names --exact --nocapture
/// ```
#[test]
fn print_enum_names() {
    let enums = serde_json::json!({
        "Opcode": Opcode::VARIANTS,
        "DeclareKind": DeclareKind::VARIANTS,
        "Stop": Stop::VARIANTS,
        "FrameKind": FrameKind::VARIANTS,
        "Carrier": Carrier::VARIANTS,
        "FatalContext": FatalContext::VARIANTS,
        "Raiser": Raiser::VARIANTS,
        "TrapReplication": TrapReplication::VARIANTS,
    });
    println!("ENUM_VARIANTS_JSON:{}", enums);
}
