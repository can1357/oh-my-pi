//! `yes` builtin: repeatedly write a line assembled from its operands.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	io::{self, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

// It's possible that using a smaller or larger buffer might provide better
// performance on some systems, but honestly this is good enough.
const BUF_SIZE: usize = 16 * 1024;

/// Parsed `yes` invocation.
pub(crate) struct Yes {
	matches: ArgMatches,
}

matches_parser!(Yes, app);

impl Utility for Yes {
	const NAME: &'static str = "yes";

	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		// GNU yes (gnulib `parse_gnu_standard_options_only`) recognizes
		// `--help`/`--version` only as the sole argument; everything else —
		// `yes -n`, `yes --no`, even `yes --help me` — is echoed verbatim.
		// Insert `--` so clap treats every remaining argument as an operand.
		if argv.is_empty()
			|| (argv.len() == 2 && matches!(argv[1].to_str(), Some("--help" | "--version")))
		{
			return Ok(argv);
		}
		// GNU consumes one leading `--` as the operand separator; ours replaces it.
		if argv.get(1).is_some_and(|arg| arg.to_str() == Some("--")) {
			argv.remove(1);
		}
		argv.insert(1, OsString::from("--"));
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let Some(strings) = self.matches.get_many::<OsString>("STRING") else {
			host.error("missing default operand", 1);
			return 1;
		};
		let _ = args_into_buffer(&mut buffer, strings);
		prepare_buffer(&mut buffer);

		match exec(&buffer, host) {
			// Stop the infinite producer once the reader is gone.
			ExecStop::Io(error) if error.kind() == io::ErrorKind::BrokenPipe => {
				crate::host::SIGPIPE_EXIT_CODE
			},
			ExecStop::Io(error) => {
				host.error(format!("standard output: {}", strip_errno(&error)), 1);
				1
			},
			// The adapter reports status 130 when shell cancellation triggered this.
			ExecStop::Cancelled => 1,
		}
	}
}

/// The `yes` argument model.
fn app() -> Command {
	Command::new(Yes::NAME)
		.version("0.8.0")
		.about("Repeatedly display a line with STRING (or 'y')")
		.override_usage(format_usage("yes [STRING]..."))
		.arg(
			Arg::new("STRING")
				.default_value("y")
				.value_parser(ValueParser::os_string())
				.action(ArgAction::Append)
				.allow_hyphen_values(true)
				.trailing_var_arg(true),
		)
		.infer_long_args(true)
}

/// Copies words from `strings` into `buffer`, separated by spaces.
fn args_into_buffer<'a>(
	buffer: &mut Vec<u8>,
	strings: impl Iterator<Item = &'a OsString>,
) -> Result<(), &'static str> {
	// On Unix (and WASI), OsStrs are just &[u8] underneath.
	#[cfg(any(unix, target_os = "wasi"))]
	{
		#[cfg(unix)]
		use std::os::unix::ffi::OsStrExt;
		#[cfg(target_os = "wasi")]
		use std::os::wasi::ffi::OsStrExt;

		for part in itertools::intersperse(strings.map(|argument| argument.as_bytes()), b" ") {
			buffer.extend_from_slice(part);
		}
	}

	// On Windows, we must hop through a String.
	#[cfg(not(any(unix, target_os = "wasi")))]
	{
		for part in itertools::intersperse(strings.map(|argument| argument.to_str()), Some(" ")) {
			let Some(part) = part else {
				return Err("arguments contain invalid UTF-8");
			};
			buffer.extend_from_slice(part.as_bytes());
		}
	}

	buffer.push(b'\n');
	Ok(())
}

/// Expands the single output line to the largest whole-line batch under [`BUF_SIZE`].
fn prepare_buffer(buffer: &mut Vec<u8>) {
	let line_len = buffer.len();
	debug_assert!(line_len > 0, "buffer is not empty since we have newline");
	let target_size = line_len * (BUF_SIZE / line_len);

	while buffer.len() < target_size {
		let to_copy = std::cmp::min(target_size - buffer.len(), buffer.len());
		debug_assert_eq!(to_copy % line_len, 0);
		buffer.extend_from_within(..to_copy);
	}
}

/// Why the otherwise-infinite output loop stopped.
enum ExecStop {
	Io(io::Error),
	Cancelled,
}

/// Writes one prepared batch at a time until output fails or the host is cancelled.
fn exec(bytes: &[u8], host: &mut Host) -> ExecStop {
	loop {
		// Poll immediately before every batch write. This is the flush boundary of
		// the batching fast path and keeps abort/timeout latency bounded by a batch.
		if host.is_cancelled() {
			return ExecStop::Cancelled;
		}
		if let Err(error) = host.stdout.write_all(bytes) {
			return ExecStop::Io(error);
		}
	}
}

/// Formats an I/O error without its platform-specific numeric errno suffix.
fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

/// Creates the `yes` builtin registration.
pub(crate) fn yes_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Yes, SE>()
}

#[cfg(test)]
mod tests {
	use std::{
		io::{self, Read, Write},
		path::Path,
		sync::Arc,
	};

	use brush_core::openfiles::{OpenFile, Stream};
	use clap::Parser;
	use parking_lot::Mutex;

	use super::*;
	use crate::host::{Host, run_util};

	#[derive(Clone)]
	struct FailingWriter {
		state:     Arc<Mutex<WriterState>>,
		fail_kind: io::ErrorKind,
	}

	struct WriterState {
		bytes:     Vec<u8>,
		remaining: usize,
	}

	impl Read for FailingWriter {
		fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
			Ok(0)
		}
	}

	impl Write for FailingWriter {
		fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
			let mut state = self.state.lock();
			if state.remaining == 0 {
				return Err(io::Error::new(self.fail_kind, "consumer gone"));
			}
			let written = buffer.len().min(state.remaining);
			state.remaining -= written;
			state.bytes.extend_from_slice(&buffer[..written]);
			Ok(written)
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl Stream for FailingWriter {
		fn clone_box(&self) -> Box<dyn Stream> {
			Box::new(self.clone())
		}

		#[cfg(unix)]
		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}

		#[cfg(unix)]
		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
			Err(brush_core::error::ErrorKind::CannotConvertToNativeFd.into())
		}
	}

	fn run_with(
		arguments: &[&str],
		budget: usize,
		fail_kind: io::ErrorKind,
	) -> (i32, String, String) {
		let argv: Vec<OsString> = std::iter::once("yes")
			.chain(arguments.iter().copied())
			.map(OsString::from)
			.collect();
		let argv = Yes::rewrite_argv(argv).expect("yes rewrite is infallible");
		let parsed = Yes::try_parse_from(argv).expect("test arguments should parse");
		let (mut host, capture) = Host::for_test("yes", Vec::new(), Path::new("/"));
		let state = Arc::new(Mutex::new(WriterState { bytes: Vec::new(), remaining: budget }));
		host.set_test_stdout(OpenFile::Stream(Box::new(FailingWriter {
			state: Arc::clone(&state),
			fail_kind,
		})));

		let code = parsed.run(&mut host);
		let stdout = String::from_utf8(state.lock().bytes.clone()).expect("yes output is UTF-8");
		(code, stdout, capture.err())
	}

	#[test]
	fn hyphen_operands_are_echoed_not_parsed() {
		// Failure mode: clap rejecting `yes -n` / `yes --no` / `yes -1` as
		// unknown options where GNU yes echoes them.
		let (code, stdout, stderr) = run_with(&["-n"], 6, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "-n\n-n\n");
		assert_eq!(stderr, "");

		let (code, stdout, _) = run_with(&["--no", "-1"], 16, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "--no -1\n--no -1\n");
	}

	#[test]
	fn help_is_special_only_as_sole_argument() {
		// Failure mode: `yes --help me` rendering help; GNU echoes "--help me".
		let (code, stdout, _) = run_with(&["--help", "me"], 20, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "--help me\n--help me\n");
	}

	#[test]
	fn version_is_special_only_as_sole_argument() {
		let (code, capture) = run_util::<Yes>(&["--version"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("0.8.0"), "stdout: {:?}", capture.out());

		// Failure mode: `yes --version x` printing the version banner.
		let (code, stdout, _) = run_with(&["--version", "x"], 24, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "--version x\n--version x\n");
	}

	#[test]
	fn leading_double_dash_is_operand_separator() {
		// Failure mode: the rewrite doubling `--` so `yes --` echoes "--".
		let (code, stdout, _) = run_with(&["--"], 4, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "y\ny\n");

		let (code, stdout, _) = run_with(&["--", "--help"], 14, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout, "--help\n--help\n");
	}

	#[test]
	fn broken_pipe_stops_with_sigpipe_status() {
		let (code, stdout, stderr) = run_with(&[], 100, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert!(stdout.starts_with("y\ny\n"), "expected default 'y' lines, got {stdout:?}");
		assert_eq!(stdout.len(), 100);
		assert_eq!(stderr, "");
	}

	#[test]
	fn custom_operands_join_with_spaces_and_repeat() {
		let (code, stdout, stderr) =
			run_with(&["hello", "world"], 12 * 100, io::ErrorKind::BrokenPipe);
		assert_eq!(code, crate::host::SIGPIPE_EXIT_CODE);
		assert_eq!(stdout.lines().count(), 100);
		for line in stdout.lines() {
			assert_eq!(line, "hello world");
		}
		assert_eq!(stderr, "");
	}

	#[test]
	fn cancellation_stops_loop_promptly() {
		let parsed = Yes::try_parse_from(["yes"]).expect("default arguments should parse");
		let (mut host, capture) = Host::for_test("yes", Vec::new(), Path::new("/"));
		host.cancel_for_test();

		assert_eq!(parsed.run(&mut host), 1);
		assert_eq!(capture.out(), "");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn non_pipe_write_error_reports_and_fails() {
		let (code, stdout, stderr) = run_with(&[], 2, io::ErrorKind::Other);
		assert_eq!(code, 1);
		assert_eq!(stdout, "y\n");
		assert_eq!(stderr, "yes: standard output: consumer gone\n");
	}

	#[test]
	fn help_renders_to_stdout() {
		let (code, capture) = run_util::<Yes>(&["--help"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("Repeatedly display a line"));
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn test_prepare_buffer() {
		let tests = [
			(150, 16_350),
			(1000, 16_000),
			(4093, 16_372),
			(4099, 12_297),
			(4111, 12_333),
			(2, 16_384),
			(3, 16_383),
			(4, 16_384),
			(5, 16_380),
			(8192, 16_384),
			(8191, 16_382),
			(8193, 8193),
			(10_000, 10_000),
			(15_000, 15_000),
			(25_000, 25_000),
		];

		for (line, final_len) in tests {
			let mut buffer = std::iter::repeat_n(b'a', line).collect::<Vec<_>>();
			prepare_buffer(&mut buffer);
			assert_eq!(buffer.len(), final_len);
		}
	}

	#[test]
	fn test_args_into_buf() {
		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let default_args = ["y".into()];
		args_into_buffer(&mut buffer, default_args.iter()).unwrap();
		assert_eq!(String::from_utf8(buffer).unwrap(), "y\n");

		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let arguments = ["foo".into()];
		args_into_buffer(&mut buffer, arguments.iter()).unwrap();
		assert_eq!(String::from_utf8(buffer).unwrap(), "foo\n");

		let mut buffer = Vec::with_capacity(BUF_SIZE);
		let arguments = ["foo".into(), "bar    baz".into(), "qux".into()];
		args_into_buffer(&mut buffer, arguments.iter()).unwrap();
		assert_eq!(String::from_utf8(buffer).unwrap(), "foo bar    baz qux\n");
	}
}
