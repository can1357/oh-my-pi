//! `sha1sum` builtin: compute and check SHA-1 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
	support::checksum::AlgoKind,
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
		let algo =
			AlgoKind::from_bin_name(Self::NAME).expect("sha1sum is a supported checksum utility");
		cksum::run(host, algo, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha1sum::NAME, false)
}

/// Creates the `sha1sum` builtin registration.
pub(crate) fn sha1sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha1sum, SE>()
}
