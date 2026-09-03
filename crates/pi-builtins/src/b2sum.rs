//! `b2sum` builtin: compute and check BLAKE2b digests.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::{AlgoKind, BlakeLength, parse_blake_length};

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};

/// Parsed `b2sum` invocation.
pub(crate) struct B2sum {
	matches: ArgMatches,
}

matches_parser!(B2sum, app);

impl Utility for B2sum {
	const NAME: &'static str = "b2sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		let length = self
			.matches
			.get_one::<String>("length")
			.map(|value| parse_blake_length(AlgoKind::Blake2b, BlakeLength::String(value)))
			.transpose();
		let length = match length {
			Ok(length) => length,
			Err(error) => {
				host.error(error, 1);
				return 1;
			},
		};
		cksum::run(host, AlgoKind::Blake2b, self.matches, length)
	}
}

fn app() -> clap::Command {
	cksum::command(B2sum::NAME, true)
}

/// Creates the `b2sum` builtin registration.
pub(crate) fn b2sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<B2sum, SE>()
}

#[cfg(test)]
mod tests {
	use super::B2sum;
	use crate::host::run_util;

	#[test]
	fn length_selects_the_blake2b_output_size() {
		let (code, capture) = run_util::<B2sum>(&["-l", "8"], "abc", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "6b  -\n");
	}

	#[test]
	fn length_must_be_a_multiple_of_eight() {
		let (code, capture) = run_util::<B2sum>(&["-l", "7"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("multiple of 8"), "{}", capture.err());
	}
}
