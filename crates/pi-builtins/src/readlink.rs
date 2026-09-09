//! `readlink` builtin: print a symbolic link's value or a canonical file name.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fs,
	io::Write,
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::{
	display::Quotable,
	fs::{MissingHandling, ResolveMode, canonicalize},
	libc::EINVAL,
	line_ending::LineEnding,
};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

const OPT_CANONICALIZE: &str = "canonicalize";
const OPT_CANONICALIZE_MISSING: &str = "canonicalize-missing";
const OPT_CANONICALIZE_EXISTING: &str = "canonicalize-existing";
const OPT_NO_NEWLINE: &str = "no-newline";
const OPT_QUIET: &str = "quiet";
const OPT_SILENT: &str = "silent";
const OPT_VERBOSE: &str = "verbose";
const OPT_ZERO: &str = "zero";

const ARG_FILES: &str = "files";

/// Parsed `readlink` invocation.
pub(crate) struct Readlink {
	matches: ArgMatches,
}

matches_parser!(Readlink, app);

impl Utility for Readlink {
	const NAME: &'static str = "readlink";

	fn run(self, host: &mut Host) -> i32 {
		let mut no_trailing_delimiter = self.matches.get_flag(OPT_NO_NEWLINE);
		let use_zero = self.matches.get_flag(OPT_ZERO);
		let verbose = self.matches.get_flag(OPT_VERBOSE) || host.var("POSIXLY_CORRECT").is_some();

		// GNU readlink -f/-e/-m follows symlinks first and then applies `..`
		// (physical resolution). Logical mode would collapse `..` first.
		let resolve_mode = if self.matches.get_flag(OPT_CANONICALIZE)
			|| self.matches.get_flag(OPT_CANONICALIZE_EXISTING)
			|| self.matches.get_flag(OPT_CANONICALIZE_MISSING)
		{
			ResolveMode::Physical
		} else {
			ResolveMode::None
		};

		let missing_handling = if self.matches.get_flag(OPT_CANONICALIZE_EXISTING) {
			MissingHandling::Existing
		} else if self.matches.get_flag(OPT_CANONICALIZE_MISSING) {
			MissingHandling::Missing
		} else {
			MissingHandling::Normal
		};

		let files: Vec<PathBuf> = self
			.matches
			.get_many::<OsString>(ARG_FILES)
			.map(|values| values.map(PathBuf::from).collect())
			.unwrap_or_default();

		if files.is_empty() {
			host.error("missing operand", 1);
			return 1;
		}

		if no_trailing_delimiter && files.len() > 1 {
			let _ = writeln!(
				host.stderr,
				"readlink: ignoring --no-newline with multiple arguments"
			);
			no_trailing_delimiter = false;
		}

		let line_ending = if no_trailing_delimiter {
			None
		} else {
			Some(LineEnding::from_zero_flag(use_zero))
		};

		for operand in &files {
			let resolved = host.resolve(operand);
			let path_result = if resolve_mode == ResolveMode::None {
				fs::read_link(&resolved)
			} else {
				canonicalize(&resolved, missing_handling, resolve_mode)
			};

			match path_result {
				Ok(path) => {
					if show(&mut host.stdout, &path, line_ending).is_err() {
						return 1;
					}
				},
				Err(err) => {
					if verbose {
						let message = if err.raw_os_error() == Some(EINVAL) {
							format!("{}: Invalid argument", operand.maybe_quote())
						} else {
							format!("{}: {err}", operand.maybe_quote())
						};
						let _ = writeln!(host.stderr, "readlink: {message}");
					}
					return 1;
				},
			}
		}
		0
	}
}

/// The `readlink` argument model.
fn app() -> Command {
	Command::new(Readlink::NAME)
		.version("0.8.0")
		.about("Print value of a symbolic link or canonical file name.")
		.override_usage(format_usage("readlink [OPTION]... [FILE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_CANONICALIZE)
				.short('f')
				.long(OPT_CANONICALIZE)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively; all but the last component must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_EXISTING)
				.short('e')
				.long(OPT_CANONICALIZE_EXISTING)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, all components must exist",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CANONICALIZE_MISSING)
				.short('m')
				.long(OPT_CANONICALIZE_MISSING)
				.help(
					"canonicalize by following every symlink in every component of the given name \
					 recursively, without requirements on components existence",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_NEWLINE)
				.short('n')
				.long(OPT_NO_NEWLINE)
				.help("do not output the trailing delimiter")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SILENT)
				.short('s')
				.long(OPT_SILENT)
				.help("suppress most error messages")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("report error message")
				.overrides_with_all([OPT_QUIET, OPT_SILENT, OPT_VERBOSE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_ZERO)
				.short('z')
				.long(OPT_ZERO)
				.help("separate output with NUL rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(clap::value_parser!(OsString))
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// Writes a resolved path verbatim, followed by the selected delimiter.
fn show(out: &mut impl Write, path: &Path, line_ending: Option<LineEnding>) -> std::io::Result<()> {
	let bytes = os_bytes(path.as_os_str())
		.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid path"))?;
	out.write_all(bytes)?;
	if let Some(line_ending) = line_ending {
		write!(out, "{line_ending}")?;
	}
	out.flush()
}

/// Creates the `readlink` builtin registration.
pub(crate) fn readlink_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Readlink, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Readlink;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Readlink>(args, "", cwd);
		(code, capture.out(), capture.err())
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var,
	/// which -f/-e/-m resolution would otherwise expand mid-assertion).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[cfg(unix)]
	#[test]
	fn resolves_relative_operand_against_host_cwd() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("target-file", root.join("link")).unwrap();

		let (code, stdout, stderr) = run_in(root, &["link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "target-file\n");
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn canonicalize_follows_symlink_to_absolute_path() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		std::os::unix::fs::symlink("target", root.join("link")).unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), &["-f", "link"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\n", root.join("target").display()));
		assert_eq!(stderr, "");
	}

	#[test]
	fn canonicalize_missing_builds_path_from_host_cwd() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root.clone(), &["-m", "missing/sub"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, format!("{}\n", root.join("missing/sub").display()));
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn canonicalize_existing_fails_silently_on_missing_final_component() {
		let (_dir, root) = canonical_tempdir();

		let (code, stdout, stderr) = run_in(root, &["-e", "missing"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
	}

	#[cfg(unix)]
	#[test]
	fn non_symlink_is_silent_failure_by_default_and_einval_with_verbose() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("plain"), b"x").unwrap();

		let (code, stdout, stderr) = run_in(root.clone(), &["plain"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "", ""));

		let (code, stdout, stderr) = run_in(root, &["-v", "plain"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "readlink: plain: Invalid argument\n");
	}

	#[cfg(unix)]
	#[test]
	fn no_newline_with_multiple_args_warns_and_keeps_delimiter() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("a", root.join("l1")).unwrap();
		std::os::unix::fs::symlink("b", root.join("l2")).unwrap();

		let (code, stdout, stderr) = run_in(root, &["-n", "l1", "l2"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "a\nb\n");
		assert_eq!(stderr, "readlink: ignoring --no-newline with multiple arguments\n");
	}

	#[cfg(unix)]
	#[test]
	fn zero_terminates_with_nul_and_no_newline_drops_delimiter() {
		let (_dir, root) = canonical_tempdir();
		std::os::unix::fs::symlink("a", root.join("l1")).unwrap();

		let (code, stdout, _) = run_in(root.clone(), &["-z", "l1"]);
		assert_eq!((code, stdout.as_str()), (0, "a\0"));

		let (code, stdout, _) = run_in(root, &["-n", "l1"]);
		assert_eq!((code, stdout.as_str()), (0, "a"));
	}

	#[test]
	fn missing_operand_is_usage_error() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), &[]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "readlink: missing operand\n");
	}

	#[test]
	fn help_renders_to_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), &["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("canonical file name"));
		assert_eq!(stderr, "");
	}
}
