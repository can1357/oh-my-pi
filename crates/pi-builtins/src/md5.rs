//! `md5` builtin: BSD-style MD5 message digests.
//!
//! Matches FreeBSD/macOS `md5(1)` in BSD mode (behavior only): one
//! `MD5 (file) = hash` line per operand and a bare hash for standard input;
//! `-q` prints only hashes, `-r` reverses lines to `hash file` (`-q` wins),
//! `-s string` digests the string instead of any operand and prints its bare
//! hash (`hash string` when a `-r` follows the `-s` and no `-q` is given),
//! `-p` echoes
//! standard input to standard output ahead of its hash, and `-c string`
//! compares each hash case-insensitively, appending ` [ Failed ]` (unless
//! `-q`) and exiting 2 on a mismatch. Unreadable operands are reported, the
//! rest still digested, and the exit status is 1. The time trial (`-t`) and
//! self test (`-x`) are not supported.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
};

use clap::{ArgMatches, Args, Command, FromArgMatches, parser::ValueSource};
use uucore::checksum::SizedAlgoKind;

use crate::{
	cksum,
	host::{Host, Utility, matches_parser, os_bytes_lossy, strip_errno},
};

/// md5(1)'s synopsis, printed after usage errors found past parsing.
const USAGE: &str = "md5 [-pqrtx] [-c string] [-s string] [files ...]";

/// Parsed `md5` invocation; the matches keep option order, which decides the
/// output style as md5's sequential option handling does.
pub(crate) struct Md5 {
	matches: ArgMatches,
}

matches_parser!(Md5, app);

fn app() -> Command {
	Options::augment_args(
		Command::new("md5")
			.about("Calculate a message-digest fingerprint (checksum) for a file.")
			.override_usage(USAGE)
			.disable_version_flag(true)
			.args_override_self(true),
	)
}

/// The options of one `md5` invocation.
#[derive(Args)]
struct Options {
	/// Compare each digest against STRING; exit 2 on a mismatch
	#[arg(short = 'c', long = "check", value_name = "string", allow_hyphen_values = true)]
	check:       Option<String>,
	/// Echo standard input to standard output, then print its digest
	#[arg(short = 'p', long = "passthrough")]
	passthrough: bool,
	/// Print only the digest
	#[arg(short = 'q', long = "quiet")]
	quiet:       bool,
	/// Print the digest before the file name
	#[arg(short = 'r', long = "reverse")]
	reverse:     bool,
	/// Digest STRING instead of files
	#[arg(short = 's', long = "string", value_name = "string", allow_hyphen_values = true)]
	string:      Option<OsString>,
	/// Time trial (not supported)
	#[arg(short = 't', long = "time-trial")]
	time_trial:  bool,
	/// Self test (not supported)
	#[arg(short = 'x', long = "self-test")]
	self_test:   bool,
	/// No-op, accepted for compatibility
	#[arg(short = 'b', hide = true)]
	_binary:     bool,
	#[arg(value_name = "files")]
	files:       Vec<OsString>,
}

/// Output line shape, from `-q` and `-r`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
	/// `MD5 (name) = hash`
	Tagged,
	/// `hash name`
	Reverse,
	/// `hash`
	Bare,
}

impl Utility for Md5 {
	const NAME: &'static str = "md5";

	fn run(self, host: &mut Host) -> i32 {
		let options = match Options::from_arg_matches(&self.matches) {
			Ok(options) => options,
			Err(error) => {
				let _ = write!(host.stderr, "{error}");
				return 1;
			},
		};
		options.run(host, string_style(&self.matches))
	}
}

/// The style `-s` output takes: md5 handles options in order, `-s` and `-q`
/// selecting bare output and a later `-r` (absent `-q`) reversed output.
fn string_style(matches: &ArgMatches) -> Style {
	if matches.get_flag("quiet") {
		return Style::Bare;
	}
	if matches.value_source("reverse") != Some(ValueSource::CommandLine) {
		return Style::Bare;
	}
	match (matches.index_of("reverse"), matches.index_of("string")) {
		(Some(reverse), Some(string)) if reverse > string => Style::Reverse,
		_ => Style::Bare,
	}
}

impl Options {
	/// Runs the invocation; `string_style` is how a `-s` digest prints.
	fn run(self, host: &mut Host, string_style: Style) -> i32 {
		if self.time_trial || self.self_test {
			let what = if self.time_trial { "time trial (-t)" } else { "self test (-x)" };
			let _ = writeln!(host.stderr, "md5: {what} is not supported\nusage: {USAGE}");
			return 1;
		}
		let style = if self.quiet {
			Style::Bare
		} else if self.reverse {
			Style::Reverse
		} else {
			Style::Tagged
		};
		let mut report = Report { check: self.check.as_deref(), quiet: self.quiet, failed: false, mismatches: 0 };

		if let Some(string) = &self.string {
			let mut digest = SizedAlgoKind::Md5.create_digest();
			digest.hash_update(&os_bytes_lossy(string));
			let hash = cksum::finish_hex(&mut *digest);
			report.line(host, &hash, string_style, &os_bytes_lossy(string));
		} else if !self.files.is_empty() && !self.passthrough {
			for file in &self.files {
				if host.is_cancelled() {
					break;
				}
				match digest_input(host, file, false) {
					Ok(hash) => report.line(host, &hash, style, &os_bytes_lossy(file)),
					Err(message) => {
						host.error(format_args!("{}: {message}", file.to_string_lossy()), 1);
						report.failed = true;
					},
				}
			}
		} else if self.check.is_none() {
			match digest_input(host, OsStr::new("-"), self.passthrough) {
				Ok(hash) => report.line(host, &hash, Style::Bare, b"-"),
				Err(message) => {
					host.error(format_args!("-: {message}"), 1);
					report.failed = true;
				},
			}
		}

		if report.failed {
			1
		} else if report.mismatches > 0 {
			2
		} else {
			0
		}
	}
}

/// Output settings and the outcome so far.
struct Report<'a> {
	/// The `-c` digest every hash is compared against.
	check:      Option<&'a str>,
	quiet:      bool,
	/// Whether an input could not be read.
	failed:     bool,
	/// How many hashes differed from `check`.
	mismatches: usize,
}

impl Report<'_> {
	/// Prints one digest line for `name` and records a `-c` mismatch.
	fn line(&mut self, host: &mut Host, hash: &str, style: Style, name: &[u8]) {
		let mut line = Vec::with_capacity(hash.len() + name.len() + 24);
		match style {
			Style::Tagged => {
				line.extend_from_slice(b"MD5 (");
				line.extend_from_slice(name);
				line.extend_from_slice(b") = ");
				line.extend_from_slice(hash.as_bytes());
			},
			Style::Reverse => {
				line.extend_from_slice(hash.as_bytes());
				line.push(b' ');
				line.extend_from_slice(name);
			},
			Style::Bare => line.extend_from_slice(hash.as_bytes()),
		}
		if let Some(expected) = self.check
			&& !expected.eq_ignore_ascii_case(hash)
		{
			self.mismatches += 1;
			if !self.quiet {
				line.extend_from_slice(b" [ Failed ]");
			}
		}
		line.push(b'\n');
		let _ = host.stdout.write_all(&line);
	}
}

/// Digests operand `name` (`-` is standard input, echoed to standard output
/// when `tee`), returning the hex digest or the text of the error.
fn digest_input(host: &mut Host, name: &OsStr, tee: bool) -> Result<String, String> {
	let mut digest = SizedAlgoKind::Md5.create_digest();
	let cancel = host.cancel_flag();
	let read = if name == "-" {
		cksum::read_chunks(&mut host.stdin, &cancel, |chunk| {
			if tee {
				let _ = host.stdout.write_all(chunk);
			}
			digest.hash_update(chunk);
		})
	} else {
		let path = host.resolve(name);
		if host.fs().is_dir(&path) {
			return Err("Is a directory".to_owned());
		}
		let mut file = host.fs().open(&path).map_err(|error| strip_errno(&error))?;
		cksum::read_chunks(&mut file, &cancel, |chunk| digest.hash_update(chunk))
	};
	read.map_err(|error| strip_errno(&error))?;
	Ok(cksum::finish_hex(&mut *digest))
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Md5;
	use crate::host::run_util;

	const ABC: &str = "900150983cd24fb0d6963f7d28e17f72";

	fn tree_with_abc() -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("data"), b"abc").unwrap();
		dir
	}

	#[test]
	fn tags_each_file() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["data", "-"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("MD5 (data) = {ABC}\nMD5 (-) = d41d8cd98f00b204e9800998ecf8427e\n"));
	}

	#[test]
	fn stdin_prints_the_bare_hash() {
		let (code, capture) = run_util::<Md5>(&[], "abc", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));
	}

	#[test]
	fn quiet_and_reverse_shape_lines() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-q", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));

		let (code, capture) = run_util::<Md5>(&["-r", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC} data\n"));

		let (code, capture) = run_util::<Md5>(&["-r", "-q", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));
	}

	#[test]
	fn string_is_digested_instead_of_files() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-s", "abc", "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));

		let (code, capture) = run_util::<Md5>(&["-qs", "abc"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));

		let (code, capture) = run_util::<Md5>(&["-r", "-s", "abc"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));

		let (code, capture) = run_util::<Md5>(&["-s", "abc", "-r"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC} abc\n"));

		let (code, capture) = run_util::<Md5>(&["-q", "-s", "abc", "-r"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{ABC}\n"));
	}

	#[test]
	fn passthrough_echoes_stdin_before_its_hash() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-p", "data"], "abc", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("abc{ABC}\n"));
	}

	#[test]
	fn missing_file_is_reported_and_the_rest_digested() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["nope", "data"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), format!("MD5 (data) = {ABC}\n"));
		assert_eq!(capture.err(), "md5: nope: No such file or directory\n");
	}

	#[test]
	fn check_compares_case_insensitively() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-c", &ABC.to_uppercase(), "data"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("MD5 (data) = {ABC}\n"));
	}

	#[test]
	fn check_mismatch_exits_2() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-c", "0123", "data"], "", dir.path());
		assert_eq!(code, 2);
		assert_eq!(capture.out(), format!("MD5 (data) = {ABC} [ Failed ]\n"));

		let (code, capture) = run_util::<Md5>(&["-q", "-c", "0123", "data"], "", dir.path());
		assert_eq!(code, 2);
		assert_eq!(capture.out(), format!("{ABC}\n"));

		let (code, capture) = run_util::<Md5>(&["-c", "0123", "-s", "abc"], "", "/");
		assert_eq!(code, 2);
		assert_eq!(capture.out(), format!("{ABC} [ Failed ]\n"));

		let (code, capture) = run_util::<Md5>(&["-s", "abc", "-c", "0123"], "", "/");
		assert_eq!(code, 2);
		assert_eq!(capture.out(), format!("{ABC} [ Failed ]\n"));
	}

	#[test]
	fn unreadable_input_outranks_a_mismatch() {
		let dir = tree_with_abc();
		let (code, capture) = run_util::<Md5>(&["-c", "0123", "data", "nope"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), format!("MD5 (data) = {ABC} [ Failed ]\n"));
	}

	#[test]
	fn check_without_files_reads_nothing() {
		let (code, capture) = run_util::<Md5>(&["-c", ABC], "abc", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "");
	}

	#[test]
	fn rejects_time_trial_and_self_test() {
		let (code, capture) = run_util::<Md5>(&["-t"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"md5: time trial (-t) is not supported\nusage: md5 [-pqrtx] [-c string] [-s string] [files ...]\n"
		);
	}
}
