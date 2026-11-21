//! `dirname` builtin: strip the last component from a file name.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{ffi::OsString, io::Write};

use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{display::Quotable, line_ending::LineEnding};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes};

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
/// On Windows `\` is a separator too, and a drive prefix (`C:`) stays put:
/// `C:\a\b` → `C:\a`, `C:\a` → `C:\`, `C:a` → `C:`. The shell spells host
/// paths natively (`realpath`, `$0` of a `PATH` script), so scripts taking
/// `"$(dirname "$(realpath "$0")")"` need this.
///
/// Examples:
/// - `foo/.` → `foo`
/// - `foo/./bar` → `foo/.`
/// - `foo/bar` → `foo`
/// - `a/b/c` → `a/b`
///
/// Per the POSIX.1-2017 dirname specification:
/// <https://pubs.opengroup.org/onlinepubs/9699919799/utilities/dirname.html>
///
/// See issue #8910 and similar fix in basename (#8373, commit c5268a897).
fn dirname_string_manipulation(path_bytes: &[u8]) -> &[u8] {
	let prefix_len = drive_prefix_len(path_bytes);
	let path = &path_bytes[prefix_len..];
	match parent(path) {
		Parent::Dot if prefix_len > 0 => &path_bytes[..prefix_len],
		Parent::Dot => b".",
		// The root keeps its own spelling (`/` or `\`).
		Parent::Root => &path_bytes[..=prefix_len],
		Parent::Within(end) => &path_bytes[..prefix_len + end],
	}
}

/// Where the parent of a prefix-less path lies.
enum Parent {
	/// No separator: the current directory.
	Dot,
	/// The root, spelled by the path's first byte.
	Root,
	/// The path's first `n` bytes.
	Within(usize),
}

/// `/`, and on Windows also `\`.
const fn is_sep(b: u8) -> bool {
	b == b'/' || (cfg!(windows) && b == b'\\')
}

/// Length of a Windows drive prefix (`C:`); 0 elsewhere.
fn drive_prefix_len(bytes: &[u8]) -> usize {
	if cfg!(windows) && bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		2
	} else {
		0
	}
}

fn parent(bytes: &[u8]) -> Parent {
	if bytes.is_empty() {
		return Parent::Dot;
	}

	// Step 1: Strip trailing slashes (but not if the entire path is slashes)
	if bytes.iter().all(|&b| is_sep(b)) {
		return Parent::Root;
	}
	let mut end = bytes.len();
	while end > 1 && is_sep(bytes[end - 1]) {
		end -= 1;
	}
	let bytes = &bytes[..end];

	// Step 2: Check if it ends with `/.` and strip the `/+.` pattern
	if end >= 2 && bytes[end - 1] == b'.' && is_sep(bytes[end - 2]) {
		let mut slash_start = end - 2;
		while slash_start > 0 && is_sep(bytes[slash_start - 1]) {
			slash_start -= 1;
		}
		return if slash_start == 0 {
			Parent::Root
		} else {
			Parent::Within(slash_start)
		};
	}

	// Step 3: Normal dirname - find last / and remove everything after it,
	// then strip trailing slashes from the result (keeping a leading one)
	let Some(mut result_end) = bytes.iter().rposition(|&b| is_sep(b)) else {
		return Parent::Dot;
	};
	while result_end > 1 && is_sep(bytes[result_end - 1]) {
		result_end -= 1;
	}
	if result_end == 0 {
		Parent::Root
	} else {
		Parent::Within(result_end)
	}
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
			 NAME contains no /'s (or \\'s on Windows), output '.' (meaning the current directory).",
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

	#[cfg(windows)]
	#[test]
	fn test_windows_separators_and_drive() {
		let (code, stdout, _) = run_test(&[
			r"C:\Program Files\Microsoft VS Code\bin\code",
			r"C:\Program Files\Microsoft VS Code\bin/code",
			r"C:\a",
			r"C:\",
			"C:a",
		]);
		assert_eq!(code, 0);
		assert_eq!(
			stdout,
			"C:\\Program Files\\Microsoft VS Code\\bin\nC:\\Program Files\\Microsoft VS \
			 Code\\bin\nC:\\\nC:\\\nC:\n"
		);
	}
}
