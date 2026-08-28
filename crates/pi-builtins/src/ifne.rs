//! moreutils-inspired `ifne` builtin: run a command iff stdin is non-empty
//! (`-n` inverts the condition).
//!
//! This is one of the selected moreutils tools kept in-process so its standard
//! streams, working directory, environment, and cancellation come from the
//! invoking shell. The command is executed directly, without shell
//! interpretation.

use std::{
	ffi::OsString,
	io::{self, ErrorKind, Read, Write},
	process::{Command, Stdio},
	sync::atomic::{AtomicBool, Ordering},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command as ClapCommand, builder::ValueParser};

use crate::host::{Host, Utility, matches_parser, util};

const USAGE: &str = "usage: ifne [-n] command [args...]";
const CHUNK: usize = 64 * 1024;

/// Parsed `ifne` invocation.
pub(crate) struct Ifne {
	matches: ArgMatches,
}

matches_parser!(Ifne, app);

impl Utility for Ifne {
	const NAME: &'static str = "ifne";

	fn run(self, host: &mut Host) -> i32 {
		let invert = self.matches.get_flag("invert");
		let command: Vec<OsString> = self
			.matches
			.get_many::<OsString>("command")
			.unwrap_or_default()
			.cloned()
			.collect();
		if command.is_empty() {
			let _ = writeln!(host.stderr, "{USAGE}");
			return 1;
		}

		// Probe stdin: one byte decides which mode acts. Check cancellation both
		// before the potentially blocking read and after cancellation-induced EOF.
		let mut first = [0u8; 1];
		let got = loop {
			if host.is_cancelled() {
				return 130;
			}
			match host.stdin.read(&mut first) {
				Ok(n) => break n,
				Err(err) if err.kind() == ErrorKind::Interrupted => {
					if host.is_cancelled() {
						return 130;
					}
				},
				Err(err) => {
					host.error(format!("stdin: {err}"), 1);
					return 1;
				},
			}
		};
		if got == 0 && host.is_cancelled() {
			return 130;
		}
		let empty = got == 0;

		if empty != invert {
			if empty {
				// Default mode, empty stdin: do nothing.
				return 0;
			}
			// -n mode, non-empty stdin: pass stdin through, don't run the command.
			let cancel = host.cancel_flag();
			return match copy_cancellable(
				&mut host.stdin,
				&mut host.stdout,
				Some(first[0]),
				&cancel,
			) {
				Ok(()) => 0,
				Err(CopyError::Cancelled) => 130,
				Err(CopyError::Io(err)) => {
					host.error(err, 1);
					1
				},
			};
		}

		spawn_and_pump(host, &command, if empty { None } else { Some(first[0]) })
	}
}

/// The `ifne` argument model.
fn app() -> ClapCommand {
	ClapCommand::new(Ifne::NAME)
		.disable_version_flag(true)
		.override_usage("ifne [-n] command [args...]")
		.arg(
			Arg::new("invert")
				.short('n')
				.action(ArgAction::SetTrue)
				.help("run the command when standard input is empty"),
		)
		.arg(
			Arg::new("command")
				.value_name("command [args...]")
				.value_parser(ValueParser::os_string())
				.allow_hyphen_values(true)
				.trailing_var_arg(true)
				.num_args(0..),
		)
}

/// Spawns the child and pumps stdin into it while draining its stdout/stderr.
fn spawn_and_pump(host: &mut Host, command: &[OsString], first: Option<u8>) -> i32 {
	let mut child = match Command::new(&command[0])
		.args(&command[1..])
		.current_dir(host.cwd())
		.env_clear()
		.envs(host.env())
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
	{
		Ok(child) => child,
		Err(err) => {
			host.error(format!("{}: {err}", command[0].to_string_lossy()), 127);
			return 127;
		},
	};

	let mut child_stdin = child.stdin.take().expect("piped stdin");
	let mut child_stdout = child.stdout.take().expect("piped stdout");
	let mut child_stderr = child.stderr.take().expect("piped stderr");
	let cancel = host.cancel_flag();

	// Drain both child output streams while pumping its input, so no pipe can
	// fill and deadlock the others. The buffers are forwarded to the host after
	// the child exits; its in-process streams must never be inherited directly.
	let (out_buf, err_buf, pump) = std::thread::scope(|scope| {
		let out = scope.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stdout.read_to_end(&mut buf);
			buf
		});
		let err = scope.spawn(move || {
			let mut buf = Vec::new();
			let _ = child_stderr.read_to_end(&mut buf);
			buf
		});
		// Ignore BrokenPipe: the child may exit before consuming its stdin
		// (for example, `ifne head -1`).
		let pump = match copy_cancellable(&mut host.stdin, &mut child_stdin, first, &cancel) {
			Err(CopyError::Io(err)) if err.kind() != ErrorKind::BrokenPipe => {
				Err(CopyError::Io(err))
			},
			Err(CopyError::Cancelled) => Err(CopyError::Cancelled),
			_ => Ok(()),
		};
		drop(child_stdin); // EOF so the child terminates.
		if matches!(pump, Err(CopyError::Cancelled)) {
			let _ = child.kill();
		}
		(out.join().unwrap_or_default(), err.join().unwrap_or_default(), pump)
	});

	let status = child.wait();
	let _ = host.stdout.write_all(&out_buf);
	let _ = host.stderr.write_all(&err_buf);

	match pump {
		Err(CopyError::Cancelled) => return 130,
		Err(CopyError::Io(err)) => {
			host.error(err, 1);
			return 1;
		},
		Ok(()) => {},
	}

	match status {
		Ok(status) => exit_code(status),
		Err(err) => {
			host.error(err, 1);
			1
		},
	}
}

enum CopyError {
	Cancelled,
	Io(io::Error),
}

/// Copies `first` (when present) then all of `src` into `dst` in chunks.
fn copy_cancellable(
	src: &mut impl Read,
	dst: &mut impl Write,
	first: Option<u8>,
	cancel: &AtomicBool,
) -> Result<(), CopyError> {
	if let Some(byte) = first {
		dst.write_all(&[byte]).map_err(CopyError::Io)?;
	}
	let mut buf = vec![0u8; CHUNK].into_boxed_slice();
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(CopyError::Cancelled);
		}
		match src.read(&mut buf) {
			Ok(0) => return Ok(()),
			Ok(n) => dst.write_all(&buf[..n]).map_err(CopyError::Io)?,
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => return Err(CopyError::Io(err)),
		}
	}
}


/// Maps a child exit status to its code, or `128 + signal` on Unix.
fn exit_code(status: std::process::ExitStatus) -> i32 {
	if let Some(code) = status.code() {
		return code;
	}
	#[cfg(unix)]
	{
		use std::os::unix::process::ExitStatusExt;
		if let Some(signal) = status.signal() {
			return 128 + signal;
		}
	}
	1
}

/// Creates the `ifne` builtin registration.
pub(crate) fn ifne_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ifne, SE>()
}

#[cfg(test)]
mod tests {
	use super::Ifne;
	use crate::host::run_util;

	fn run_in(stdin: &str, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Ifne>(args, stdin, std::env::temp_dir());
		(code, capture.out(), capture.err())
	}

	#[cfg(unix)]
	#[test]
	fn nonempty_stdin_runs_command_with_stdin() {
		let result = run_in("hello world\n", &["cat"]);
		assert_eq!(result, (0, "hello world\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[test]
	fn empty_stdin_skips_command() {
		let result = run_in("", &["sh", "-c", "echo ran"]);
		assert_eq!(result, (0, String::new(), String::new()));
	}

	#[cfg(unix)]
	#[test]
	fn invert_runs_command_on_empty_stdin() {
		let result = run_in("", &["-n", "sh", "-c", "echo ran"]);
		assert_eq!(result, (0, "ran\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[test]
	fn invert_passes_nonempty_stdin_through() {
		let result = run_in("data\n", &["-n", "sh", "-c", "echo ran"]);
		assert_eq!(result, (0, "data\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[test]
	fn child_exit_code_propagates() {
		let result = run_in("x", &["sh", "-c", "exit 3"]);
		assert_eq!(result, (3, String::new(), String::new()));
	}

	#[test]
	fn unknown_command_exits_127() {
		let (code, stdout, stderr) = run_in("x", &["definitely-not-a-command-xyz"]);
		assert_eq!(code, 127);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("ifne: definitely-not-a-command-xyz: "), "stderr: {stderr}");
	}

	#[cfg(unix)]
	#[test]
	fn early_exiting_child_is_not_an_error() {
		let big = "a".repeat(1 << 20);
		let result = run_in(&big, &["head", "-c", "1"]);
		assert_eq!(result, (0, "a".to_string(), String::new()));
	}

	#[test]
	fn missing_command_is_usage_error() {
		let (code, stdout, stderr) = run_in("", &[]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("usage: ifne"));
	}
}
