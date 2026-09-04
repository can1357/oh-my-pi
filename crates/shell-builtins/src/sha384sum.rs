//! `sha384sum` builtin: compute and check SHA-384 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
	support::checksum::AlgoKind,
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
		let algo =
			AlgoKind::from_bin_name(Self::NAME).expect("sha384sum is a supported checksum utility");
		cksum::run(host, algo, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha384sum::NAME, false)
}

/// Creates the `sha384sum` builtin registration.
pub(crate) fn sha384sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha384sum, SE>()
}
