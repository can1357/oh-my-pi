//! `sha384sum` builtin: compute and check SHA-384 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};

/// Parsed `sha384sum` invocation.
pub(crate) struct Sha384sum {
	matches: ArgMatches,
}

matches_parser!(Sha384sum, app);

impl Utility for Sha384sum {
	const NAME: &'static str = "sha384sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha384, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha384sum::NAME, false)
}

/// Creates the `sha384sum` builtin registration.
pub(crate) fn sha384sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha384sum, SE>()
}
