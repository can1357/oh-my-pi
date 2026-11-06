//! The coverage gate of the fatal-jump site matrix.
//!
//! `crates/pi-shell/tests/fatal-site-matrix.json` carries one measured
//! sample per element of every axis the model has, and
//! `tests/fatal_site_matrix.rs` runs them. The axis lists in that file are
//! not written by hand: a generator reads them out of these enums'
//! declarations, crosses them with the samples and measures every row
//! against Bash 5.2.21 and 5.3.0. The test below compares the lists the
//! fixture was measured for with the crate's own, so a new `Opcode`, a new
//! declaration builtin kind, a new jump code or a new catch fails here
//! until the pass is re-run and the fixture gains a sample for it.

use strum::VariantNames;

use super::builtins::vars::DeclareKind;
use super::exec::JumpCode;
use super::proc::LandingCatch;
use crate::bash::ir::Opcode;

const FIXTURE: &str = include_str!("../../../tests/fatal-site-matrix.json");

#[test]
fn the_site_matrix_covers_every_variant_of_the_model() {
	let fixture: serde_json::Value =
		serde_json::from_str(FIXTURE).expect("the site-matrix fixture parses");
	let enums = fixture.get("enums").expect("the fixture records the axis lists");
	for (name, variants) in [
		("Opcode", Opcode::VARIANTS),
		("DeclareKind", DeclareKind::VARIANTS),
		("JumpCode", JumpCode::VARIANTS),
		("LandingCatch", LandingCatch::VARIANTS),
	] {
		let recorded: Vec<&str> = enums
			.get(name)
			.and_then(serde_json::Value::as_array)
			.unwrap_or_else(|| panic!("the site matrix has no {name} axis"))
			.iter()
			.filter_map(serde_json::Value::as_str)
			.collect();
		assert_eq!(
			recorded,
			variants,
			"{name} is no longer what the site matrix was measured for; re-run \
			 crates/pi-shell/scripts/fatal-site-matrix/gen-sites.py, \
			 crates/pi-shell/scripts/fatal-site-matrix/measure-sites.py and \
			 crates/pi-shell/scripts/fatal-site-matrix/emit-fixture.py to regenerate \
			 crates/pi-shell/tests/fatal-site-matrix.json so every variant keeps a sample; \
			 see crates/pi-shell/scripts/fatal-site-matrix/README.md"
		);
	}
}
