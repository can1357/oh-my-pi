//! `sha256sum` builtin: compute and check SHA-256 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use clap::ArgMatches;
use omp_shell::{ShellExtensions, builtins::Registration};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
	support::checksum::AlgoKind,
};

/// Parsed `sha256sum` invocation.
pub(crate) struct Sha256sum {
	matches: ArgMatches,
}

matches_parser!(Sha256sum, app);

impl Utility for Sha256sum {
	const NAME: &'static str = "sha256sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let algo =
			AlgoKind::from_bin_name(Self::NAME).expect("sha256sum is a supported checksum utility");
		cksum::run(host, algo, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Sha256sum::NAME, false)
}

/// Creates the `sha256sum` builtin registration.
pub(crate) fn sha256sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Sha256sum, SE>()
}
