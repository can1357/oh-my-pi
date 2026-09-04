//! `sha512sum` builtin: compute and check SHA-512 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
	support::checksum::AlgoKind,
};

/// Parsed `sha512sum` invocation.
pub(crate) struct Sha512sum {
	matches: ArgMatches,
}

matches_parser!(Sha512sum, app);

impl Utility for Sha512sum {
	const NAME: &'static str = "sha512sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let algo =
			AlgoKind::from_bin_name(Self::NAME).expect("sha512sum is a supported checksum utility");
		cksum::run(host, algo, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha512sum::NAME, false)
}

/// Creates the `sha512sum` builtin registration.
pub(crate) fn sha512sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha512sum, SE>()
}
