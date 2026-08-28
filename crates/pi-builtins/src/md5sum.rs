//! `md5sum` builtin: compute and check MD5 digests.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::ArgMatches;
use uucore::checksum::AlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, util},
};

/// Parsed `md5sum` invocation.
pub(crate) struct Md5sum {
	matches: ArgMatches,
}

matches_parser!(Md5sum, app);

impl Utility for Md5sum {
	const NAME: &'static str = "md5sum";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		cksum::run(host, AlgoKind::Md5, self.matches, None)
	}
}

fn app() -> clap::Command {
	cksum::command(Md5sum::NAME, false)
}

/// Creates the `md5sum` builtin registration.
pub(crate) fn md5sum_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Md5sum, SE>()
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Md5sum;
	use crate::host::run_util;

	#[test]
	fn computes_stdin_digest() {
		let (code, capture) = run_util::<Md5sum>(&[], "abc", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "900150983cd24fb0d6963f7d28e17f72  -\n");
	}

	#[test]
	fn resolves_operand_but_prints_user_supplied_name() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();

		let (code, capture) = run_util::<Md5sum>(&["data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "900150983cd24fb0d6963f7d28e17f72  data\n");
	}

	#[test]
	fn resolves_checklist_and_checked_paths() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		fs::write(
			dir.path().join("checksums"),
			b"900150983cd24fb0d6963f7d28e17f72  data\n",
		)
		.unwrap();

		let (code, capture) = run_util::<Md5sum>(&["-c", "checksums"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "data: OK\n");
	}

	#[test]
	fn status_suppresses_mismatch_output() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		let checklist = "00000000000000000000000000000000  data\n";

		let (code, capture) = run_util::<Md5sum>(&["-c", "--status"], checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn quiet_suppresses_success_output() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		let checklist = "900150983cd24fb0d6963f7d28e17f72  data\n";

		let (code, capture) = run_util::<Md5sum>(&["-c", "--quiet"], checklist, dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "");
	}

	#[test]
	fn strict_rejects_an_improper_line() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		let checklist = concat!(
			"not a checksum line\n",
			"900150983cd24fb0d6963f7d28e17f72  data\n",
		);

		let (code, capture) = run_util::<Md5sum>(&["-c", "--strict"], checklist, dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "data: OK\n");
		assert!(capture.err().contains("1 line(s) are improperly formatted"));
	}
}
