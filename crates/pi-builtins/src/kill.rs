//! The `kill` builtin, moved from `pi-shell`.

use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins, sys, traps::TrapSignal, ExecutionContext,
};
use clap::Parser;

use crate::proc_snapshot::HostProcesses;

#[cfg(not(unix))]
use crate::proc_snapshot::{ProcInfo, ProcessStatus};

/// Signal a job or process.
#[derive(Parser)]
pub(crate) struct KillCommand {
	/// Name of the signal to send.
	#[arg(short = 's', value_name = "SIG_NAME")]
	signal_name:      Option<String>,
	/// Number of the signal to send.
	#[arg(short = 'n', value_name = "SIG_NUM")]
	signal_number:    Option<usize>,
	/// List known signal names.
	#[arg(short = 'l', short_alias = 'L')]
	list_signals:     bool,
	// Interpretation of these depends on whether -l is present.
	#[arg(allow_hyphen_values = true)]
	args:             Vec<String>,
	/// Process/job operands given after the `--` end-of-options marker. clap
	/// consumes `--` before `execute`, so these are captured separately and are
	/// always operands — never signal specifications (preserves negative PIDs).
	#[arg(last = true, allow_hyphen_values = true)]
	post_marker_args: Vec<String>,
}

impl builtins::Command for KillCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> std::result::Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Self::try_parse_from(rewrite_attached_short_options(args))
	}

	#[allow(unknown_lints, reason = "unused_async_trait_impl is unknown to the pinned CI nightly")]
	#[allow(
		clippy::unused_async_trait_impl,
		reason = "the builtin Command trait declares execute as async"
	)]
	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, Self::Error> {
		let default_signal = if let Some(signal_name) = &self.signal_name {
			if let Ok(signal) = KillSignal::parse(signal_name) {
				signal
			} else {
				writeln!(
					context.stderr(),
					"{}: invalid signal name: {}",
					context.command_name,
					signal_name
				)?;
				return Ok(ExecutionExitCode::InvalidUsage.into());
			}
		} else {
			KillSignal::parse("TERM")?
		};
		let mut signal = match self.signal_number {
			Some(signal_number) => {
				let Ok(signal_number) = i32::try_from(signal_number) else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				if let Ok(signal) = KillSignal::parse(&signal_number.to_string()) {
					signal
				} else {
					writeln!(
						context.stderr(),
						"{}: invalid signal number: {}",
						context.command_name,
						signal_number
					)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}
			},
			None => default_signal,
		};

		// Interpret the pre-`--` args as an optional leading `-sigspec`, followed
		// by PID/jobspec operands. Once a signal or operand has been seen, later
		// hyphen-led arguments remain operands so negative process-group IDs survive.
		let mut operands: Vec<&String> = Vec::new();
		let mut options_done = self.signal_name.is_some() || self.signal_number.is_some();
		let mut consumed_marker = false;
		for arg in &self.args {
			if !consumed_marker && arg == "--" {
				consumed_marker = true;
				options_done = true;
				continue;
			}
			if !options_done && let Some(spec) = arg.strip_prefix('-').filter(|spec| !spec.is_empty())
			{
				signal = if let Ok(signal) = KillSignal::parse(spec) {
					signal
				} else {
					writeln!(context.stderr(), "{}: invalid signal name", context.command_name)?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				};
				options_done = true;
				continue;
			}
			options_done = true;
			operands.push(arg);
		}
		operands.extend(&self.post_marker_args);

		if self.list_signals {
			return print_kill_signals(&context, operands);
		}
		if operands.is_empty() {
			writeln!(context.stderr(), "{}: invalid usage", context.command_name)?;
			return Ok(ExecutionExitCode::InvalidUsage.into());
		}

		// One process-table walk for the whole invocation, and only when a signal
		// will actually be delivered: `-l` and the signal-0 probe touch nothing.
		// Every guard below reads this same resolved chain.
		let host = signal.sends_signal().then(HostProcesses::resolve);
		let blocks = |target: i32| host.as_ref().is_some_and(|host| blocks_target(host, target));

		// `kill -0` asks only whether a target exists. Unix answers per target with
		// one syscall; elsewhere there is no such call, so the table is walked once
		// here and every target is answered from that snapshot rather than from a
		// fresh walk apiece.
		#[cfg(not(unix))]
		let running: Vec<i32> = if signal.sends_signal() {
			Vec::new()
		} else {
			ProcInfo::all()
				.into_iter()
				.filter(|process| process.status() == ProcessStatus::Running)
				.map(|process| process.pid())
				.collect()
		};
		#[cfg(unix)]
		let exists = |target: i32| {
			// SAFETY: signal 0 only checks target existence and permission.
			unsafe { libc::kill(target, 0) == 0 }
		};
		#[cfg(not(unix))]
		let exists = |target: i32| target > 0 && running.contains(&target);

		let mut had_failure = false;
		for operand in operands {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if operand.starts_with('%') {
				let Some(job) = context.shell.jobs_mut().resolve_job_spec(operand) else {
					writeln!(context.stderr(), "{}: {}: no such job", context.command_name, operand)?;
					had_failure = true;
					continue;
				};
				#[cfg(unix)]
				{
					let mut targets: Vec<i32> = job
						.process_ids()
						.filter_map(|pid| {
							// SAFETY: getpgid reads process-group metadata for a managed child.
							let pgid = unsafe { libc::getpgid(pid) };
							(pgid > 0).then_some(-pgid)
						})
						.collect();
					if targets.is_empty()
						&& let Some(pgid) = job.process_group_id()
					{
						targets.push(-pgid);
					}
					targets.sort_unstable();
					targets.dedup();
					if targets.iter().copied().any(&blocks) {
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					let succeeded = match signal {
						KillSignal::Probe => targets.iter().copied().any(&exists),
						KillSignal::Signal(signal) => {
							let mut succeeded = false;
							for target in targets {
								if sys::signal::kill_process(target, signal).is_ok() {
									succeeded = true;
								}
							}
							succeeded
						},
					};
					if !succeeded {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				}
				#[cfg(windows)]
				{
					let job_group = job.process_group_id();
					if signal.sends_signal()
						&& (job_group.is_some_and(&blocks) || job.process_ids().any(&blocks))
					{
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					let expected_handles = job.external_process_count();
					let handles = job.duplicate_kill_handles();
					let mut succeeded = expected_handles != 0 && handles.len() == expected_handles;
					for handle in &handles {
						let handled = match signal {
							KillSignal::Probe => brush_core::processes::process_handle_is_running(handle),
							KillSignal::Signal(_) => {
								brush_core::processes::terminate_process_handle(handle)
							},
						};
						if !handled {
							succeeded = false;
						}
					}
					if !succeeded {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				}
				#[cfg(all(not(unix), not(windows)))]
				{
					let job_group = job.process_group_id();
					let representative = job.representative_pid();
					if signal.sends_signal()
						&& (job_group.is_some_and(&blocks) || representative.is_some_and(&blocks))
					{
						writeln!(
							context.stderr(),
							"{}: {}: refusing to signal the shell process",
							context.command_name,
							operand
						)?;
						had_failure = true;
						continue;
					}
					match signal {
						KillSignal::Probe => {
							if !representative.is_some_and(&exists) {
								writeln!(
									context.stderr(),
									"{}: {}: failed to send signal",
									context.command_name,
									operand
								)?;
								had_failure = true;
							}
						},
						KillSignal::Signal(signal) => {
							if let Err(err) = job.kill(signal) {
								writeln!(
									context.stderr(),
									"{}: {}: {}",
									context.command_name,
									operand,
									err
								)?;
								had_failure = true;
							}
						},
					}
				}
				continue;
			}

			let pid = match brush_core::int_utils::parse(operand, 10) {
				Ok(pid) => pid,
				Err(err) => {
					writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
					had_failure = true;
					continue;
				},
			};
			if blocks(pid) {
				writeln!(
					context.stderr(),
					"{}: {}: refusing to signal the shell process",
					context.command_name,
					operand
				)?;
				had_failure = true;
				continue;
			}
			match signal {
				KillSignal::Probe => {
					if !exists(pid) {
						writeln!(
							context.stderr(),
							"{}: {}: failed to send signal",
							context.command_name,
							operand
						)?;
						had_failure = true;
					}
				},
				KillSignal::Signal(signal) => {
					if let Err(err) = sys::signal::kill_process(pid, signal) {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, err)?;
						had_failure = true;
					}
				},
			}
		}

		if had_failure {
			Ok(ExecutionResult::general_error())
		} else {
			Ok(ExecutionResult::success())
		}
	}
}

/// Splits attached short-option values before clap sees the argv: `-sKILL`
/// and `-s9` become `-s <spec>`, `-n9` becomes `-n 9`, and `-l9`/`-L137`
/// become `-l <spec>` (bash splits `-s<name>` the same way; the digit forms
/// are the /bin/kill spellings). A token whose whole body already names a
/// signal (`-sigkill`, `-SIGKILL`, `-9`) is left intact, matching BSD kill
/// and the manual sigspec pre-parse in `execute`. Rewriting stops at `--` or
/// the first operand, so negative-PID operands survive untouched.
fn rewrite_attached_short_options(args: impl IntoIterator<Item = String>) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut args = args.into_iter();
	// The first element is the command name itself.
	out.extend(args.next());
	let mut skip_value = false;
	for arg in &mut args {
		if skip_value {
			skip_value = false;
			out.push(arg);
			continue;
		}
		if arg == "--" {
			out.push(arg);
			break;
		}
		if arg == "-s" || arg == "-n" {
			skip_value = true;
			out.push(arg);
			continue;
		}
		if arg == "-l" || arg == "-L" {
			out.push(arg);
			continue;
		}
		if let Some((option, value)) = split_attached(&arg) {
			out.push(option);
			out.push(value);
			continue;
		}
		out.push(arg);
		break;
	}
	out.extend(args);
	out
}

/// Splits one attached-value option token, or `None` for anything that must
/// pass through untouched (whole sigspecs, operands, malformed tokens).
fn split_attached(arg: &str) -> Option<(String, String)> {
	let rest = arg.get(2..).filter(|rest| !rest.is_empty())?;
	let split = match arg.get(..2)? {
		"-l" | "-L" => true,
		"-s" => KillSignal::parse(&arg[1..]).is_err(),
		"-n" => rest.bytes().all(|byte| byte.is_ascii_digit()),
		_ => false,
	};
	split.then(|| (arg[..2].to_string(), rest.to_string()))
}

/// Whether signalling `target` would reach the shell or one of its ancestors.
///
/// `target` follows `kill(2)`: a positive value is a pid, `0` is the caller's own
/// process group, `-1` is every process the caller may signal, and any other
/// negative value is the process group `-target`. The caller's own group needs no
/// special case — it is in `host.pgids` by construction.
///
/// Takes the already-resolved chain rather than resolving one, so a loop over
/// operands walks the process table once, not once per operand.
fn blocks_target(host: &HostProcesses, target: i32) -> bool {
	if target == -1 || target == 0 {
		return true;
	}
	match target.checked_neg() {
		Some(pgid) if pgid > 0 => host.pgids.contains(&pgid),
		_ => host.pids.contains(&target),
	}
}

fn print_kill_signals<'a>(
	context: &ExecutionContext<'_, impl brush_core::ShellExtensions>,
	signals: impl IntoIterator<Item = &'a String>,
) -> std::result::Result<ExecutionResult, brush_core::Error> {
	let mut result = ExecutionResult::success();
	let mut signals = signals.into_iter().peekable();
	if signals.peek().is_none() {
		return brush_core::traps::format_signals(
			context.stdout(),
			TrapSignal::iterator().filter(|signal| !matches!(signal, TrapSignal::Exit)),
		)
		.map(|()| ExecutionResult::success());
	}
	for value in signals {
		match printed_signal(value) {
			Ok(PrintedSignal::Name(name)) => writeln!(context.stdout(), "{name}")?,
			Ok(PrintedSignal::Number(number)) => writeln!(context.stdout(), "{number}")?,
			Err(err) => {
				writeln!(context.stderr(), "{err}")?;
				result = ExecutionResult::general_error();
			},
		}
	}
	Ok(result)
}

/// How `kill -l <operand>` renders one operand: numbers become names and
/// names become numbers.
enum PrintedSignal {
	Name(&'static str),
	Number(i32),
}

fn printed_signal(value: &str) -> std::result::Result<PrintedSignal, brush_core::Error> {
	if let Ok(number) = value.parse::<i32>() {
		// bash also maps the exit status of a signal-killed process back to
		// its signal: `kill -l 137` prints `KILL` (137 = 128 + 9), while an
		// unmappable value like 128 or 265 keeps its own diagnostic.
		let signal = TrapSignal::try_from(number).or_else(|err| {
			if number > 128 {
				TrapSignal::try_from(number - 128).map_err(|_| err)
			} else {
				Err(err)
			}
		})?;
		Ok(PrintedSignal::Name(
			signal.as_str().strip_prefix("SIG").unwrap_or(signal.as_str()),
		))
	} else {
		let signal = TrapSignal::try_from(value)?;
		Ok(i32::try_from(signal).map_or(PrintedSignal::Name(signal.as_str()), PrintedSignal::Number))
	}
}

#[cfg(test)]
impl KillCommand {
	fn listed_signals(&self) -> impl Iterator<Item = &String> {
		let mut consumed_marker = false;
		self.args
			.iter()
			.filter(move |arg| {
				if !consumed_marker && *arg == "--" {
					consumed_marker = true;
					false
				} else {
					true
				}
			})
			.chain(&self.post_marker_args)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn listed(args: &[&str]) -> Vec<String> {
		let cmd = KillCommand::try_parse_from(args).unwrap();
		cmd.listed_signals().cloned().collect()
	}

	#[test]
	fn lists_post_marker_operands() {
		assert_eq!(listed(&["kill", "-l", "--", "9"]), ["9"]);
	}

	#[test]
	fn lists_pre_and_post_marker_operands() {
		assert_eq!(listed(&["kill", "-l", "TERM", "--", "9"]), ["TERM", "9"]);
	}

	#[test]
	fn lists_pre_marker_operands_without_marker() {
		assert_eq!(listed(&["kill", "-l", "TERM", "HUP"]), ["TERM", "HUP"]);
	}

	fn parsed(args: &[&str]) -> KillCommand {
		use brush_core::builtins::Command as _;
		KillCommand::new(args.iter().map(ToString::to_string)).unwrap()
	}

	/// `kill -s9`/`-sKILL` used to land in the positional args and die with
	/// "invalid signal name"; the attached value must reach `-s`.
	#[test]
	fn attached_signal_name_values_split() {
		let cmd = parsed(&["kill", "-s9", "123"]);
		assert_eq!(cmd.signal_name.as_deref(), Some("9"));
		assert_eq!(cmd.args, ["123"]);

		let cmd = parsed(&["kill", "-sKILL", "123"]);
		assert_eq!(cmd.signal_name.as_deref(), Some("KILL"));
		assert_eq!(cmd.args, ["123"]);
	}

	/// A whole-token signal spec such as `-sigkill` (BSD kill accepts it)
	/// must not be misread as `-s igkill`.
	#[test]
	fn sig_prefixed_spec_stays_whole() {
		let cmd = parsed(&["kill", "-sigkill", "123"]);
		assert_eq!(cmd.signal_name, None);
		assert_eq!(cmd.args, ["-sigkill", "123"]);
	}

	/// `kill -n9` used to fail to parse; the digits must reach `-n`.
	#[test]
	fn attached_signal_number_splits() {
		let cmd = parsed(&["kill", "-n9", "123"]);
		assert_eq!(cmd.signal_number, Some(9));
		assert_eq!(cmd.args, ["123"]);
	}

	/// `kill -l9` and `kill -L137` used to be clap parse errors; they must
	/// behave as `-l` with the value as its listing operand.
	#[test]
	fn attached_list_operand_splits() {
		let cmd = parsed(&["kill", "-l9"]);
		assert!(cmd.list_signals);
		assert_eq!(cmd.listed_signals().cloned().collect::<Vec<_>>(), ["9"]);

		let cmd = parsed(&["kill", "-L137"]);
		assert!(cmd.list_signals);
		assert_eq!(cmd.listed_signals().cloned().collect::<Vec<_>>(), ["137"]);
	}

	/// Rewriting must stop at `--` and at the first operand so option-like
	/// operands (and negative PIDs) are never split.
	#[test]
	fn rewrite_leaves_operand_region_alone() {
		let rewritten = rewrite_attached_short_options(
			["kill", "--", "-s9"].map(String::from),
		);
		assert_eq!(rewritten, ["kill", "--", "-s9"]);

		let rewritten = rewrite_attached_short_options(
			["kill", "-9", "-s9"].map(String::from),
		);
		assert_eq!(rewritten, ["kill", "-9", "-s9"]);

		let rewritten = rewrite_attached_short_options(
			["kill", "-s", "KILL", "-123"].map(String::from),
		);
		assert_eq!(rewritten, ["kill", "-s", "KILL", "-123"]);
	}

	/// bash maps exit statuses above 128 back to the terminating signal:
	/// `kill -l 137` prints `KILL`, while 128 and 265 stay invalid.
	#[test]
	fn list_maps_exit_statuses_above_128() {
		assert!(matches!(printed_signal("137"), Ok(PrintedSignal::Name("KILL"))));
		assert!(matches!(printed_signal("9"), Ok(PrintedSignal::Name("KILL"))));
		assert!(matches!(printed_signal("129"), Ok(PrintedSignal::Name("HUP"))));
		assert!(printed_signal("128").is_err());
		assert!(printed_signal("265").is_err());
	}
}

/// A `kill` signal argument: a real signal, or the "does this process
/// exist?" probe that signal 0 requests.
#[derive(Clone, Copy)]
enum KillSignal {
	Probe,
	Signal(TrapSignal),
}

impl KillSignal {
	fn parse(value: &str) -> std::result::Result<Self, brush_core::Error> {
		if let Ok(number) = value.parse::<i32>() {
			if number == 0 {
				Ok(Self::Probe)
			} else {
				TrapSignal::try_from(number).map(Self::Signal)
			}
		} else {
			TrapSignal::try_from(value).map(Self::Signal)
		}
	}

	const fn sends_signal(self) -> bool {
		matches!(self, Self::Signal(_))
	}
}


/// Resolves a signal name or number to its number.
///
/// Shared with `pkill`, which accepts the same `-SIGNAL` spellings.
#[allow(
	dead_code,
	reason = "shared with optional process-match builtins that may be feature-disabled"
)]
pub(crate) fn signal_number(value: &str) -> Option<i32> {
	let value = value
		.strip_prefix("SIG")
		.or_else(|| value.strip_prefix("sig"))
		.unwrap_or(value);
	if let Ok(number) = value.parse::<i32>() {
		#[cfg(target_os = "linux")]
		return (0..=libc::SIGRTMAX()).contains(&number).then_some(number);
		#[cfg(target_os = "macos")]
		return (0..=31).contains(&number).then_some(number);
		#[cfg(not(unix))]
		return (0..=64).contains(&number).then_some(number);
	}
	match KillSignal::parse(value).ok()? {
		KillSignal::Probe => Some(0),
		KillSignal::Signal(signal) => i32::try_from(signal).ok(),
	}
}
