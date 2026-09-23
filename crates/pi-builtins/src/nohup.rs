//! The `nohup` command, moved from `pi-shell`.
//!
//! This builtin detaches a backgrounded operand into a new session so a server
//! survives the embedded shell's kill-on-drop teardown. A system `nohup` does
//! not escape the process-group kill, so this command intentionally shadows it.
//! Registration marks it as a transparent background wrapper, allowing brush to
//! spawn the operand directly with session reparenting.

use std::{future::Future, io::Write};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo, builtins,
};
use clap::Parser;

use crate::host::quote_arg;

/// Runs an operand with the process-group policy required by `nohup`.
#[derive(Parser)]
#[command(disable_help_flag = true)]
pub(crate) struct NohupCommand {
	/// `--help` was the first argument; set by [`NohupCommand::from_argv`].
	#[clap(skip)]
	help:    bool,
	/// `--version` was the first argument; set by [`NohupCommand::from_argv`].
	#[clap(skip)]
	version: bool,
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

impl NohupCommand {
	/// Parses `argv` (without the command name) the way GNU nohup does:
	/// `--help`/`--version` are recognized only as the first argument, and a
	/// single leading `--` ends option processing, so `nohup -- --help` runs
	/// a command named `--help` and `nohup -- --` runs one named `--`.
	fn from_argv(mut argv: Vec<String>) -> Self {
		match argv.first().map(String::as_str) {
			Some("--help") => {
				return Self { help: true, version: false, command: Vec::new() };
			},
			Some("--version") => {
				return Self { help: false, version: true, command: Vec::new() };
			},
			Some("--") => {
				argv.remove(0);
			},
			_ => {},
		}
		Self { help: false, version: false, command: argv }
	}
}

impl builtins::Command for NohupCommand {
	type Error = brush_core::Error;

	/// Bypasses clap: clap silently eats the first `--` even inside a
	/// `trailing_var_arg` capture, which loses the distinction between
	/// `nohup --help` (help) and `nohup -- --help` (run `--help`).
	fn new<I>(args: I) -> std::result::Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		// The first element is the command name itself.
		Ok(Self::from_argv(args.into_iter().skip(1).collect()))
	}

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let command = self.command.clone();
		let (help, version) = (self.help, self.version);
		async move {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if help {
				let _ = write!(context.stdout(), "{NOHUP_HELP}");
				return Ok(ExecutionResult::success());
			}
			if version {
				let _ = writeln!(
					context.stdout(),
					"nohup (pi-builtins) {}",
					env!("CARGO_PKG_VERSION")
				);
				return Ok(ExecutionResult::success());
			}
			// coreutils `nohup` with no operand fails with exit code 125.
			if command.is_empty() {
				return Ok(report_missing_operand(context.stderr()));
			}

			// `nohup <cmd>` (foreground) runs the operand directly and surfaces its
			// exit status. Persistence across the host's teardown is a *background*
			// concern that never reaches this builtin: brush's
			// `transparent_background_wrapper` unwraps `nohup <server> &` to spawn the
			// operand directly with session reparenting, double-forking it out of the
			// shell's descendant tree. Like coreutils, we run the operand here; we only
			// differ by not masking SIGHUP.
			let command_line = rebuild_command_line(&command);

			let mut params = context.params.clone();
			params.process_group_policy = ProcessGroupPolicy::NewProcessGroup;
			let source_info = SourceInfo::from("pi-natives:nohup");
			context
				.shell
				.run_string(command_line, &source_info, &params)
				.await
		}
	}
}

const NOHUP_HELP: &str = "\
Usage: nohup COMMAND [ARG]...
  or:  nohup OPTION
Run COMMAND immune to the shell's teardown, in a new process group.

      --help     display this help and exit
      --version  output version information and exit
";

fn report_missing_operand(mut stderr: impl Write) -> ExecutionResult {
	let _ = writeln!(stderr, "nohup: missing operand");
	ExecutionResult::new(125)
}

fn rebuild_command_line(command: &[String]) -> String {
	let mut command_line = String::new();
	for (idx, arg) in command.iter().enumerate() {
		if idx > 0 {
			command_line.push(' ');
		}
		command_line.push_str(&quote_arg(arg));
	}
	command_line
}

#[cfg(test)]
mod tests {
	use super::{NohupCommand, rebuild_command_line, report_missing_operand};

	fn parsed(argv: &[&str]) -> NohupCommand {
		NohupCommand::from_argv(argv.iter().map(ToString::to_string).collect())
	}

	/// `nohup -- cmd args` must run `cmd`; the leading `--` is an option
	/// terminator, not part of the operand vector.
	#[test]
	fn leading_dashdash_ends_options() {
		let cmd = parsed(&["--", "sleep", "1"]);
		assert!(!cmd.help && !cmd.version);
		assert_eq!(cmd.command, ["sleep", "1"]);
	}

	/// Only the first `--` terminates options: `nohup -- -- x` runs a command
	/// literally named `--`, and `nohup -- --help` runs one named `--help`.
	#[test]
	fn dashdash_protects_operands_including_help() {
		assert_eq!(parsed(&["--", "--", "x"]).command, ["--", "x"]);
		let cmd = parsed(&["--", "--help"]);
		assert!(!cmd.help);
		assert_eq!(cmd.command, ["--help"]);
	}

	/// A mid-command `--` belongs to the operand, never to nohup itself.
	#[test]
	fn mid_command_dashdash_is_preserved() {
		assert_eq!(parsed(&["echo", "a", "--", "b"]).command, ["echo", "a", "--", "b"]);
	}

	/// `--help`/`--version` used to be executed as commands (exit 127);
	/// GNU nohup prints to stdout and exits 0.
	#[test]
	fn leading_help_and_version_are_options() {
		let cmd = parsed(&["--help"]);
		assert!(cmd.help && !cmd.version && cmd.command.is_empty());
		let cmd = parsed(&["--version"]);
		assert!(cmd.version && !cmd.help && cmd.command.is_empty());
	}

	/// The builtin entry point receives argv including the command name and
	/// must skip it before option handling.
	#[test]
	fn new_skips_command_name() {
		use brush_core::builtins::Command as _;

		let cmd = NohupCommand::new(["nohup", "--", "sleep", "1"].map(String::from))
			.expect("nohup argv parsing is infallible");
		assert_eq!(cmd.command, ["sleep", "1"]);
	}

	#[test]
	fn missing_operand_reports_diagnostic_and_exit_code() {
		let mut stderr = Vec::new();
		let result = report_missing_operand(&mut stderr);

		assert_eq!(u8::from(result.exit_code), 125);
		assert_eq!(stderr, b"nohup: missing operand\n");
	}

	#[test]
	fn rebuilds_command_line_with_shell_quoting() {
		let command = [
			"printf".to_string(),
			"%s %s".to_string(),
			"two words".to_string(),
			"it's".to_string(),
			String::new(),
		];

		assert_eq!(
			rebuild_command_line(&command),
			"printf '%s %s' 'two words' 'it'\"'\"'s' ''"
		);
	}
}
