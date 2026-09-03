//! `dirname` builtin: strip the last component from a file name.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{borrow::Cow, ffi::OsString, io::Write};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

mod options {
	pub const ZERO: &str = "zero";
	pub const DIR: &str = "dir";
}

/// Parsed `dirname` invocation.
pub(crate) struct Dirname {
	matches: ArgMatches,
}

matches_parser!(Dirname, app);

impl Utility for Dirname {
	const NAME: &'static str = "dirname";

	fn run(self, host: &mut Host) -> i32 {
		let dirnames = self
			.matches
			.get_many::<OsString>(options::DIR)
			.unwrap_or_default()
			.collect::<Vec<_>>();

		if dirnames.is_empty() {
			host.error("missing operand", 1);
			return 1;
		}

		let line_ending = LineEnding::from_zero_flag(self.matches.get_flag(options::ZERO));
		for path in dirnames {
			let Some(path_bytes) = os_bytes(path.as_os_str()) else {
				host.error(
					format!(
						"invalid UTF-8 input {} encountered when converting to bytes on a platform that doesn't expose byte arguments",
						path.quote()
					),
					1,
				);
				return 1;
			};
			let result = dirname_string_manipulation(path_bytes);

			if host.stdout.write_all(&result).is_err()
				|| write!(host.stdout, "{line_ending}").is_err()
			{
				return 1;
			}
		}
		if host.stdout.flush().is_err() {
			return 1;
		}
		0
	}
}

/// Perform dirname as pure string manipulation per POSIX/GNU behavior.
///
/// dirname should NOT normalize paths. It does simple string manipulation:
/// 1. Strip trailing slashes (unless path is all slashes)
/// 2. If ends with `/.` (possibly `//.` or `///.`), strip the `/+.` pattern
/// 3. Otherwise, remove everything after the last `/`
/// 4. If no `/` found, return `.`
/// 5. Strip trailing slashes from result (unless result would be empty)
///
/// Examples:
/// - `foo/.` → `foo`
/// - `foo/./bar` → `foo/.`
/// - `foo/bar` → `foo`
/// - `a/b/c` → `a/b`
///
/// Per POSIX.1-2017 dirname specification and GNU coreutils manual:
/// - POSIX: <https://pubs.opengroup.org/onlinepubs/9699919799/utilities/dirname.html>
/// - GNU: <https://www.gnu.org/software/coreutils/manual/html_node/dirname-invocation.html>
///
/// See issue #8910 and similar fix in basename (#8373, commit c5268a897).
fn dirname_string_manipulation(path_bytes: &[u8]) -> Cow<'_, [u8]> {
	if path_bytes.is_empty() {
		return Cow::Borrowed(b".");
	}

	let mut bytes = path_bytes;

	// Step 1: Strip trailing slashes (but not if the entire path is slashes)
	let all_slashes = bytes.iter().all(|&b| b == b'/');
	if all_slashes {
		return Cow::Borrowed(b"/");
	}

	while bytes.len() > 1 && bytes.ends_with(b"/") {
		bytes = &bytes[..bytes.len() - 1];
	}

	// Step 2: Check if it ends with `/.` and strip the `/+.` pattern
	if bytes.ends_with(b".") && bytes.len() >= 2 {
		let dot_pos = bytes.len() - 1;
		if bytes[dot_pos - 1] == b'/' {
			// Find where the slashes before the dot start
			let mut slash_start = dot_pos - 1;
			while slash_start > 0 && bytes[slash_start - 1] == b'/' {
				slash_start -= 1;
			}
			// Return the stripped result
			if slash_start == 0 {
				// Result would be empty
				return if path_bytes.starts_with(b"/") {
					Cow::Borrowed(b"/")
				} else {
					Cow::Borrowed(b".")
				};
			}
			return Cow::Borrowed(&bytes[..slash_start]);
		}
	}

	// Step 3: Normal dirname - find last / and remove everything after it
	if let Some(last_slash_pos) = bytes.iter().rposition(|&b| b == b'/') {
		// Found a slash, remove everything after it
		let mut result = &bytes[..last_slash_pos];

		// Strip trailing slashes from result (but keep at least one if at the start)
		while result.len() > 1 && result.ends_with(b"/") {
			result = &result[..result.len() - 1];
		}

		if result.is_empty() {
			return Cow::Borrowed(b"/");
		}

		return Cow::Borrowed(result);
	}

	// No slash found, return "."
	Cow::Borrowed(b".")
}

/// The `dirname` argument model.
fn app() -> Command {
	Command::new(Dirname::NAME)
		.about("Strip last component from file name")
		.version("0.8.0")
		.override_usage(format_usage("dirname [OPTION] NAME..."))
		.args_override_self(true)
		.infer_long_args(true)
		.after_help(
			"Output each NAME with its last non-slash component and trailing slashes\n  removed; if \
			 NAME contains no /'s, output '.' (meaning the current directory).",
		)
		.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.short('z')
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIR)
				.hide(true)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString)),
		)
}

/// Creates the `dirname` builtin registration.
pub(crate) fn dirname_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Dirname, SE>()
}

#[cfg(test)]
mod tests {
	use super::Dirname;
	use crate::host::run_util;

	fn run_test(args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Dirname>(args, "", "/");
		(code, capture.out(), capture.err())
	}

	#[test]
	fn test_normal() {
		let (code, stdout, stderr) = run_test(&["foo/bar"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "foo\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_trailing_slash() {
		let (code, stdout, stderr) = run_test(&["foo/bar/"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "foo\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_root() {
		let (code, stdout, stderr) = run_test(&["/"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "/\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_multiple() {
		let (code, stdout, stderr) = run_test(&["a/b", "c/d/e"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\nc/d\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_zero_delimited() {
		let (code, stdout, stderr) = run_test(&["-z", "a/b", "c/d/e"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\0c/d\0");
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_help() {
		let (code, stdout, stderr) = run_test(&["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("Strip last component"));
		assert_eq!(stderr, "");
	}

	#[test]
	fn test_invalid_arg() {
		let (code, stdout, stderr) = run_test(&["--invalid-flag"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("unexpected argument"));
	}

	#[test]
	fn test_missing_operand() {
		let (code, stdout, stderr) = run_test(&[]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("missing operand"));
	}
}
