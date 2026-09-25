//! `tee` builtin: copy standard input to standard output and each named file.
//!
//! Ported from uutils coreutils 0.8.0. The standalone utility manipulates
//! process-global signal disposition for `-i` and SIGPIPE. An in-process builtin
//! cannot do that safely: `-i` is accepted without changing the shell's signal
//! policy. Default mode relies on [`crate::host::Sigpipe`]; `-p` and every
//! `--output-error` mode opt out via [`Host::ignore_sigpipe`] so `tee` can handle
//! broken pipes and continue writing to its remaining outputs.

use std::{
	ffi::OsString,
	fs::{File, OpenOptions},
	io::{self, Error, ErrorKind, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::PossibleValue};
use uucore::display::Quotable;

use crate::host::{Host, Utility, matches_parser, util};

mod options {
	pub const APPEND: &str = "append";
	pub const IGNORE_INTERRUPTS: &str = "ignore-interrupts";
	pub const FILE: &str = "file";
	pub const IGNORE_PIPE_ERRORS: &str = "ignore-pipe-errors";
	pub const OUTPUT_ERROR: &str = "output-error";
}

#[derive(Clone, Debug)]
enum OutputErrorMode {
	Warn,
	WarnNoPipe,
	Exit,
	ExitNoPipe,
}

struct Options {
	append:       bool,
	files:        Vec<OsString>,
	output_error: Option<OutputErrorMode>,
}

/// Parsed `tee` invocation.
pub(crate) struct Tee {
	matches: ArgMatches,
}

matches_parser!(Tee, app);

impl Utility for Tee {
	const NAME: &'static str = "tee";

	fn run(self, host: &mut Host) -> i32 {
		let output_error = self
			.matches
			.get_one::<String>(options::OUTPUT_ERROR)
			.map(|value| match value.as_str() {
				"warn" => OutputErrorMode::Warn,
				"warn-nopipe" => OutputErrorMode::WarnNoPipe,
				"exit" => OutputErrorMode::Exit,
				"exit-nopipe" => OutputErrorMode::ExitNoPipe,
				_ => unreachable!("clap validates output-error"),
			})
			.or_else(|| {
				self.matches
					.get_flag(options::IGNORE_PIPE_ERRORS)
					.then_some(OutputErrorMode::WarnNoPipe)
			});
		if output_error.is_some() {
			host.ignore_sigpipe();
		}
		let files = self
			.matches
			.get_many::<OsString>(options::FILE)
			.map(|values| values.cloned().collect())
			.unwrap_or_default();
		let options = Options {
			append: self.matches.get_flag(options::APPEND),
			files,
			output_error,
		};

		match tee(&options, host) {
			Ok(()) => 0,
			Err(err) => {
				let _ = writeln!(host.stderr, "tee: {err}");
				1
			},
		}
	}
}

fn tee(options: &Options, host: &mut Host) -> io::Result<()> {
	let mut writers = Vec::with_capacity(options.files.len() + 1);
	writers.push(NamedWriter {
		name:  OsString::from("standard output"),
		inner: Writer::Stdout(host.stdout_clone()),
	});
	let mut had_open_errors = false;
	for name in &options.files {
		if name == "-" {
			writers.push(NamedWriter {
				name:  OsString::from("standard output"),
				inner: Writer::Stdout(host.stdout_clone()),
			});
			continue;
		}
		match open(name, &host.resolve(name), options.append) {
			Ok(writer) => writers.push(writer),
			Err(err) => {
				let _ = writeln!(host.stderr, "tee: {}: {err}", name.maybe_quote());
				had_open_errors = true;
				if matches!(
					options.output_error.as_ref(),
					Some(OutputErrorMode::Exit | OutputErrorMode::ExitNoPipe)
				) {
					return Err(err);
				}
			},
		}
	}

	let mut output = MultiWriter::new(writers, options.output_error.clone(), host.stderr_clone());
	let copy_result = copy(&mut host.stdin, &mut output, &mut host.stderr);
	let flush_result = output.flush();
	if had_open_errors || copy_result.is_err() || flush_result.is_err() || output.error_occurred() {
		Err(
			copy_result
				.err()
				.or_else(|| flush_result.err())
				.unwrap_or_else(|| Error::other("output error")),
		)
	} else {
		Ok(())
	}
}

fn copy(mut input: impl Read, mut output: impl Write, stderr: &mut impl Write) -> io::Result<usize> {
	const FIRST_BUF_SIZE: usize = 8 * 1024;
	let mut buffer = [0_u8; FIRST_BUF_SIZE];
	let mut len = 0;
	loop {
		match input.read(&mut buffer) {
			Ok(0) => return Ok(len),
			Ok(received) => {
				output.write_all(&buffer[..received])?;
				output.flush()?;
				len += received;
			},
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => {
				let _ = writeln!(stderr, "tee: error reading standard input: {err}");
				return Err(err);
			},
		}
	}
}

fn open(name: &OsString, path: &std::path::Path, append: bool) -> io::Result<NamedWriter> {
	let mut options = OpenOptions::new();
	if append {
		options.append(true);
	} else {
		options.truncate(true);
	}
	let file = options.write(true).create(true).open(path)?;
	Ok(NamedWriter { inner: Writer::File(file), name: name.clone() })
}

struct MultiWriter {
	writers:           Vec<NamedWriter>,
	output_error_mode: Option<OutputErrorMode>,
	ignored_errors:    usize,
	stderr:            OpenFile,
}

impl MultiWriter {
	fn new(
		writers: Vec<NamedWriter>,
		output_error_mode: Option<OutputErrorMode>,
		stderr: OpenFile,
	) -> Self {
		Self { writers, output_error_mode, ignored_errors: 0, stderr }
	}

	fn error_occurred(&self) -> bool {
		self.ignored_errors != 0
	}

	fn process(&mut self, flush: bool, buf: &[u8]) -> io::Result<()> {
		let mode = self.output_error_mode.clone();
		let mut aborted = None;
		let mut errors = 0;
		let stderr = &mut self.stderr;
		self.writers.retain_mut(|writer| {
			let result = if flush { writer.flush() } else { writer.write_all(buf) };
			match result {
				Ok(()) => true,
				Err(err) => {
					let is_pipe = err.kind() == ErrorKind::BrokenPipe;
					let report = matches!(
						mode.as_ref(),
						Some(OutputErrorMode::Warn | OutputErrorMode::Exit)
					) || !is_pipe;
					if report {
						let _ = writeln!(stderr, "tee: {}: {err}", writer.name.maybe_quote());
						errors += 1;
					}
					let exit = matches!(mode.as_ref(), Some(OutputErrorMode::Exit))
						|| (matches!(mode.as_ref(), Some(OutputErrorMode::ExitNoPipe)) && !is_pipe);
					if exit && aborted.is_none() {
						aborted = Some(err);
					}
					false
				},
			}
		});
		self.ignored_errors += errors;
		if let Some(err) = aborted {
			Err(err)
		} else if self.writers.is_empty() {
			Err(Error::other("all outputs failed"))
		} else {
			Ok(())
		}
	}
}

impl Write for MultiWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.process(false, buf)?;
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		self.process(true, &[])
	}
}

enum Writer {
	File(File),
	Stdout(OpenFile),
	#[cfg(test)]
	Test(Box<dyn Write + Send>),
}

impl Write for Writer {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::File(file) => file.write(buf),
			Self::Stdout(stdout) => stdout.write(buf),
			#[cfg(test)]
			Self::Test(writer) => writer.write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::File(file) => file.flush(),
			Self::Stdout(stdout) => stdout.flush(),
			#[cfg(test)]
			Self::Test(writer) => writer.flush(),
		}
	}
}

struct NamedWriter {
	inner: Writer,
	name:  OsString,
}

impl Write for NamedWriter {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.inner.write(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner.flush()
	}
}

fn app() -> Command {
	Command::new(Tee::NAME)
		.version("0.8.0")
		.about("Copy standard input to each FILE, and also to standard output.")
		.override_usage("tee [OPTION]... [FILE]...")
		.after_help("If a FILE is -, copy again to standard output.")
		.infer_long_args(true)
		.disable_help_flag(true)
		.arg(
			Arg::new("--help")
				.short('h')
				.long("help")
				.help("Print help")
				.action(ArgAction::HelpLong),
		)
		.arg(
			Arg::new(options::APPEND)
				.long(options::APPEND)
				.short('a')
				.help("append to the given FILEs, do not overwrite")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::IGNORE_INTERRUPTS)
				.long(options::IGNORE_INTERRUPTS)
				.short('i')
				.help("ignore interrupt signals (accepted without installing a process-global handler)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FILE)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(options::IGNORE_PIPE_ERRORS)
				.short('p')
				.help("diagnose errors writing to non pipes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OUTPUT_ERROR)
				.long(options::OUTPUT_ERROR)
				.require_equals(true)
				.num_args(0..=1)
				.default_missing_value("warn-nopipe")
				.value_parser([
					PossibleValue::new("warn").help("diagnose errors writing to any output"),
					PossibleValue::new("warn-nopipe")
						.help("diagnose errors writing to any output not a pipe"),
					PossibleValue::new("exit").help("exit on error writing to any output"),
					PossibleValue::new("exit-nopipe")
						.help("exit on error writing to any output not a pipe"),
				])
				.help("set behavior on write error"),
		)
}

/// Creates the `tee` builtin registration.
pub(crate) fn tee_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tee, SE>()
}

#[cfg(test)]
mod tests {
	use std::{
		ffi::OsString,
		io::{self, Read, Write},
	};

	#[cfg(unix)]
	use brush_core::openfiles::OpenFile;

	use super::{MultiWriter, NamedWriter, OutputErrorMode, Tee, Writer};
	#[cfg(unix)]
	use crate::host::{SIGPIPE_EXIT_CODE, run_caught};
	use crate::host::{Host, run_util};

	struct BrokenPipe;

	impl Write for BrokenPipe {
		fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
			Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed pipe"))
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	#[test]
	fn copies_to_stdout() {
		let (code, capture) = run_util::<Tee>(&[], "hello\n", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "hello\n");
		assert_eq!(capture.err(), "");
	}

	#[cfg(unix)]
	#[test]
	fn output_error_mode_controls_sigpipe_policy() {
		fn run(args: &[&str], cwd: &std::path::Path) -> (i32, crate::host::Capture) {
			let (mut host, capture) = Host::for_test("tee", "contents", cwd);
			let (reader, writer) = std::io::pipe().unwrap();
			drop(reader);
			host.set_test_stdout(OpenFile::from(writer));
			let argv = std::iter::once(OsString::from("tee"))
				.chain(args.iter().copied().map(OsString::from))
				.collect::<Vec<_>>();
			let parsed = <Tee as clap::Parser>::try_parse_from(argv).unwrap();
			(run_caught::<Tee>(parsed, &mut host), capture)
		}

		let cwd = tempfile::tempdir().unwrap();
		let (code, capture) = run(&["default"], cwd.path());
		assert_eq!(code, SIGPIPE_EXIT_CODE);
		assert_eq!(capture.err(), "");

		let (code, capture) = run(&["-p", "nopipe"], cwd.path());
		assert_eq!(code, 0);
		assert_eq!(std::fs::read(cwd.path().join("nopipe")).unwrap(), b"contents");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn dash_copies_to_stdout_again() {
		let (code, capture) = run_util::<Tee>(&["-"], "hello", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "hellohello");
	}

	#[test]
	fn relative_output_is_resolved_under_host_cwd() {
		let cwd = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Tee>(&["output"], "contents", cwd.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(capture.out(), "contents");
		assert_eq!(std::fs::read(cwd.path().join("output")).unwrap(), b"contents");
	}

	#[test]
	fn append_preserves_existing_contents() {
		let cwd = tempfile::tempdir().unwrap();
		std::fs::write(cwd.path().join("output"), "before").unwrap();
		let (code, capture) = run_util::<Tee>(&["-a", "output"], "after", cwd.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(std::fs::read(cwd.path().join("output")).unwrap(), b"beforeafter");
	}

	#[test]
	fn default_mode_continues_after_an_output_open_error() {
		let cwd = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Tee>(&["missing/output", "good"], "contents", cwd.path());
		assert_eq!(code, 1);
		assert_eq!(std::fs::read(cwd.path().join("good")).unwrap(), b"contents");
		assert!(capture.err().contains("missing/output"));
	}

	#[test]
	fn warn_nopipe_silences_broken_stdout_and_keeps_file_output() {
		let destination = tempfile::NamedTempFile::new().unwrap();
		let file = destination.reopen().unwrap();
		let (host, capture) = Host::for_test("tee", Vec::new(), "/");
		let mut output = MultiWriter::new(
			vec![
				NamedWriter {
					name:  OsString::from("standard output"),
					inner: Writer::Test(Box::new(BrokenPipe)),
				},
				NamedWriter { name: OsString::from("file"), inner: Writer::File(file) },
			],
			Some(OutputErrorMode::WarnNoPipe),
			host.stderr_clone(),
		);

		output.write_all(b"contents").unwrap();
		assert!(!output.error_occurred());
		drop(output);
		let mut contents = Vec::new();
		destination.reopen().unwrap().read_to_end(&mut contents).unwrap();
		assert_eq!(contents, b"contents");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn warn_reports_broken_stdout_but_keeps_file_output() {
		let destination = tempfile::NamedTempFile::new().unwrap();
		let file = destination.reopen().unwrap();
		let (host, capture) = Host::for_test("tee", Vec::new(), "/");
		let mut output = MultiWriter::new(
			vec![
				NamedWriter {
					name:  OsString::from("standard output"),
					inner: Writer::Test(Box::new(BrokenPipe)),
				},
				NamedWriter { name: OsString::from("file"), inner: Writer::File(file) },
			],
			Some(OutputErrorMode::Warn),
			host.stderr_clone(),
		);

		output.write_all(b"contents").unwrap();
		assert!(output.error_occurred());
		drop(output);
		let mut contents = Vec::new();
		destination.reopen().unwrap().read_to_end(&mut contents).unwrap();
		assert_eq!(contents, b"contents");
		assert!(capture.err().contains("standard output"));
	}
}
