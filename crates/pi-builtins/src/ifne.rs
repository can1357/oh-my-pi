//! moreutils-inspired `ifne` builtin: run a command iff stdin is non-empty
//! (`-n` inverts the condition).
//!
//! This is one of the selected moreutils tools kept in-process so its standard
//! streams, working directory, environment, and cancellation come from the
//! invoking shell. The command runs through the shell's own dispatch
//! ([`Host::run_command`](crate::host::Host::run_command)): builtins first, and
//! its words are never re-parsed.

use std::{
	ffi::OsString,
	io::{self, ErrorKind, Read, Write},
	sync::atomic::{AtomicBool, Ordering},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{Arg, ArgAction, ArgMatches, Command as ClapCommand, builder::ValueParser};

use crate::host::{Host, ShellCommand, Utility, matches_parser, util};

const USAGE: &str = "usage: ifne [-n] command [args...]";
const CHUNK: usize = 64 * 1024;

/// Parsed `ifne` invocation.
pub(crate) struct Ifne {
	matches: ArgMatches,
}

matches_parser!(Ifne, app);

impl Utility for Ifne {
	const NAME: &'static str = "ifne";
	const RUNS_COMMANDS: bool = true;

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

		run_with_input(host, command, if empty { None } else { Some(first[0]) })
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

/// Runs `command` through the shell with the rest of stdin (after the probed
/// `first` byte) piped in, returning its status.
fn run_with_input(host: &mut Host, command: Vec<OsString>, first: Option<u8>) -> i32 {
	let name = command[0].to_string_lossy().into_owned();
	let pumped = io::pipe().and_then(|(reader, writer)| Ok((reader, writer, host.stdin.try_clone()?)));
	let (reader, mut writer, mut input) = match pumped {
		Ok(pumped) => pumped,
		Err(err) => {
			host.error(err, 1);
			return 1;
		},
	};
	let cancel = host.cancel_flag();
	let pump = std::thread::spawn(move || {
		// A command that exits without reading all its input (`ifne head -1`)
		// closes the pipe; that is not an error.
		match copy_cancellable(&mut input, &mut writer, first, &cancel) {
			Err(CopyError::Io(err)) if err.kind() == ErrorKind::BrokenPipe => Ok(()),
			result => result,
		}
	});
	let status = host.run_command(ShellCommand::new(command).stdin(OpenFile::from(reader)));
	let pumped = pump.join().unwrap_or(Ok(()));

	let status = match status {
		Ok(status) => status,
		Err(err) => {
			let code = match err.kind() {
				ErrorKind::NotFound => 127,
				ErrorKind::PermissionDenied => 126,
				ErrorKind::Interrupted => return 130,
				_ => 1,
			};
			host.error(format!("{name}: {err}"), code);
			return code;
		},
	};
	match pumped {
		Err(CopyError::Cancelled) => 130,
		Err(CopyError::Io(err)) => {
			host.error(err, 1);
			1
		},
		Ok(()) => status.code(),
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


/// Creates the `ifne` builtin registration.
pub(crate) fn ifne_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ifne, SE>()
}

#[cfg(test)]
mod tests {
	/// Runs `ifne ARGS` in a real shell with `stdin` on fd 0.
	async fn run_in(stdin: &str, args: &[&str]) -> (i32, String, String) {
		let script = std::iter::once("ifne")
			.chain(args.iter().copied())
			.map(crate::host::quote_arg)
			.collect::<Vec<_>>()
			.join(" ");
		crate::host::run_script(&script, stdin, &std::env::temp_dir()).await
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn nonempty_stdin_runs_command_with_stdin() {
		let result = run_in("hello world\n", &["/bin/cat"]).await;
		assert_eq!(result, (0, "hello world\n".to_string(), String::new()));
	}

	/// Contract: the command dispatches like one typed at the prompt, so an
	/// in-process builtin receives the probed input intact.
	#[tokio::test]
	async fn builtin_command_receives_all_input() {
		let result = run_in("hello world\n", &["wc", "-c"]).await;
		assert_eq!(result, (0, "12\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn empty_stdin_skips_command() {
		let result = run_in("", &["sh", "-c", "echo ran"]).await;
		assert_eq!(result, (0, String::new(), String::new()));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn invert_runs_command_on_empty_stdin() {
		let result = run_in("", &["-n", "sh", "-c", "echo ran"]).await;
		assert_eq!(result, (0, "ran\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn invert_passes_nonempty_stdin_through() {
		let result = run_in("data\n", &["-n", "sh", "-c", "echo ran"]).await;
		assert_eq!(result, (0, "data\n".to_string(), String::new()));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn child_exit_code_propagates() {
		let result = run_in("x", &["sh", "-c", "exit 3"]).await;
		assert_eq!(result, (3, String::new(), String::new()));
	}

	#[tokio::test]
	async fn unknown_command_exits_127() {
		let (code, stdout, stderr) = run_in("x", &["definitely-not-a-command-xyz"]).await;
		assert_eq!(code, 127);
		assert_eq!(stdout, "");
		assert!(stderr.starts_with("ifne: definitely-not-a-command-xyz: "), "stderr: {stderr}");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn early_exiting_child_is_not_an_error() {
		let big = "a".repeat(1 << 20);
		let result = run_in(&big, &["/usr/bin/head", "-c", "1"]).await;
		assert_eq!(result, (0, "a".to_string(), String::new()));
	}

	#[tokio::test]
	async fn missing_command_is_usage_error() {
		let (code, stdout, stderr) = run_in("", &[]).await;
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("usage: ifne"));
	}
}
