//! `sha224sum` builtin: compute and check SHA-224 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};

/// Parsed `sha224sum` invocation.
pub(crate) struct Sha224sum {
	matches: ArgMatches,
}

matches_parser!(Sha224sum, app);

impl Utility for Sha224sum {
	const NAME: &'static str = "sha224sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha224, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha224sum::NAME, false)
}

/// Creates the `sha224sum` builtin registration.
pub(crate) fn sha224sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha224sum, SE>()
}
