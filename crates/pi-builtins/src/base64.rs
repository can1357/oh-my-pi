//! `base64` builtin: encode or decode data using the Base64 alphabet.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{ArgMatches, Command};
use uucore::encoding::Format;

use crate::{
	base32::{base_app, run_base},
	host::{Host, Utility, matches_parser, util},
};

const ABOUT: &str = "encode/decode data and print to standard output\nWith no FILE, or when FILE is -, read standard input.\n\nThe data are encoded as described for the base64 alphabet in RFC 3548.\nWhen decoding, the input may contain newlines in addition to the bytes of the formal base64 alphabet. Use --ignore-garbage to attempt to recover from any other non-alphabet bytes in the encoded stream.";

/// Parsed `base64` invocation.
pub(crate) struct Base64 {
	matches: ArgMatches,
}

matches_parser!(Base64, app);

impl Utility for Base64 {
	const NAME: &'static str = "base64";

	fn run(self, host: &mut Host) -> i32 {
		run_base(&self.matches, Format::Base64, host)
	}
}

/// The `base64` argument model.
fn app() -> Command {
	base_app(Base64::NAME, ABOUT, "base64 [OPTION]... [FILE]")
}

/// Creates the `base64` builtin registration.
pub(crate) fn base64_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Base64, SE>()
}

#[cfg(test)]
mod tests {
	use super::Base64;
	use crate::host::run_util;

	#[test]
	fn macos_decode_alias_round_trips_and_gnu_alias_still_works() {
		let (code, encoded) = run_util::<Base64>(&[], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(encoded.out(), "aGVsbG8=\n");
		assert_eq!(encoded.err(), "");

		let (code, decoded) = run_util::<Base64>(&["-D"], &encoded.out(), "/");
		assert_eq!(code, 0);
		assert_eq!(decoded.out(), "hello");
		assert_eq!(decoded.err(), "");

		let (code, decoded) = run_util::<Base64>(&["-d"], &encoded.out(), "/");
		assert_eq!(code, 0);
		assert_eq!(decoded.out(), "hello");
		assert_eq!(decoded.err(), "");
	}

	#[test]
	fn wrap_controls_encoded_line_width() {
		let (code, capture) = run_util::<Base64>(&["-w", "4"], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "aGVs\nbG8=\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn ignore_garbage_recovers_non_alphabet_bytes() {
		let (code, capture) = run_util::<Base64>(&["-d", "-i"], "aG$Vs$bG8=\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "hello");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn dash_operand_reads_standard_input() {
		let (code, capture) = run_util::<Base64>(&["-"], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "aGVsbG8=\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn invalid_encoded_input_exits_one() {
		let (code, capture) = run_util::<Base64>(&["-d"], "!", "/");
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "base64: error: invalid input\n");
	}

	#[test]
	fn file_operand_resolves_against_shell_working_directory() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("input"), b"hello").unwrap();

		let (code, capture) = run_util::<Base64>(&["input"], "ignored", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "aGVsbG8=\n");
		assert_eq!(capture.err(), "");
	}
}
