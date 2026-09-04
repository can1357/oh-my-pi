//! `sha224sum` builtin: compute and check SHA-224 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
	support::checksum::AlgoKind,
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
		let algo =
			AlgoKind::from_bin_name(Self::NAME).expect("sha224sum is a supported checksum utility");
		cksum::run(host, algo, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha224sum::NAME, false)
}

/// Creates the `sha224sum` builtin registration.
pub(crate) fn sha224sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha224sum, SE>()
}
