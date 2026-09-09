//! `sha1sum` builtin: compute and check SHA-1 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};

/// Parsed `sha1sum` invocation.
pub(crate) struct Sha1sum {
	matches: ArgMatches,
}

matches_parser!(Sha1sum, app);

impl Utility for Sha1sum {
	const NAME: &'static str = "sha1sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Sha1, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha1sum::NAME, false)
}

/// Creates the `sha1sum` builtin registration.
pub(crate) fn sha1sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha1sum, SE>()
}
