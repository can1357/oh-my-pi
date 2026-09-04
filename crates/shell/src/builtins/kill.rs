//! The `kill` builtin.

use std::{io::Write, result};

use clap::Parser;
use smallvec::SmallVec;

#[cfg(windows)]
use crate::processes::{process_handle_is_running, terminate_process_handle};
use crate::{
	Error, ExecutionContext, ExecutionExitCode, ExecutionResult, ShellExtensions, builtins,
	int_utils::parse,
	sys,
	traps::{TrapSignal, format_signals},
};

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
	type Error = Error;

	fn new<I>(args: I) -> result::Result<Self, clap::Error>
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
	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> result::Result<ExecutionResult, Self::Error> {
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

		let protected = (context.params.process_scope().is_none()
			&& matches!(signal, KillSignal::Signal(_)))
		.then(ProtectedProcesses::resolve);
		let blocks = |target| {
			protected
				.as_ref()
				.is_some_and(|protected| protected.blocks_target(target))
				|| context
					.params
					.process_scope()
					.is_some_and(|scope| !scope.may_signal(target))
		};

		#[cfg(unix)]
		let exists = |target: i32| {
			// SAFETY: signal 0 only checks target existence and permission.
			unsafe { libc::kill(target, 0) == 0 }
		};
		#[cfg(windows)]
		let exists = |target: i32| process_exists(target);

		let mut had_failure = false;
		for operand in operands {
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}
			if operand.starts_with('%') {
				let job = match context.shell.jobs_mut().resolve_job_spec(operand) {
					Ok(job) => job,
					Err(error) => {
						writeln!(context.stderr(), "{}: {}: {}", context.command_name, operand, error)?;
						had_failure = true;
						continue;
					},
				};
				if context
					.params
					.process_scope()
					.is_some_and(|scope| job.process_ids().any(|pid| !scope.may_signal(pid)))
				{
					writeln!(
						context.stderr(),
						"{}: {}: signalling is outside this shell's process scope",
						context.command_name,
						operand
					)?;
					had_failure = true;
					continue;
				}
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
					let expected_handles = job.external_process_count();
					let handles = job.duplicate_kill_handles();
					let mut succeeded = expected_handles != 0 && handles.len() == expected_handles;
					for handle in &handles {
						let handled = match signal {
							KillSignal::Probe => process_handle_is_running(handle),
							KillSignal::Signal(_) => terminate_process_handle(handle),
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
				continue;
			}

			let pid = match parse(operand, 10) {
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

/// Splits attached short-option values before clap sees argv while leaving
/// whole signal specs and negative-PID operands intact.
fn rewrite_attached_short_options(args: impl IntoIterator<Item = String>) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	let mut args = args.into_iter();
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
struct ProtectedProcesses {
	pids:  SmallVec<i32, 16>,
	pgids: SmallVec<i32, 16>,
}

impl ProtectedProcesses {
	fn blocks_target(&self, target: i32) -> bool {
		if target == 0 || target == -1 {
			return true;
		}
		match target.checked_neg() {
			Some(pgid) if pgid > 0 => self.pgids.contains(&pgid),
			_ => self.pids.contains(&target),
		}
	}

	#[cfg(unix)]
	fn resolve() -> Self {
		let self_pid = unsafe { libc::getpid() };
		let mut protected = Self { pids: SmallVec::new(), pgids: SmallVec::new() };
		let mut pid = self_pid;
		while pid > 0 && !protected.pids.contains(&pid) {
			protected.pids.push(pid);
			let Some((parent, pgid)) = process_parent_and_group(pid) else {
				if pid == self_pid {
					let pgid = unsafe { libc::getpgid(pid) };
					if pgid > 0 && !protected.pgids.contains(&pgid) {
						protected.pgids.push(pgid);
					}
				}
				break;
			};
			if pgid > 0 && !protected.pgids.contains(&pgid) {
				protected.pgids.push(pgid);
			}
			pid = parent;
		}
		protected
	}

	#[cfg(windows)]
	fn resolve() -> Self {
		let pid = i32::try_from(std::process::id()).ok();
		Self { pids: pid.into_iter().collect(), pgids: SmallVec::new() }
	}
}

#[cfg(target_os = "linux")]
fn process_parent_and_group(pid: i32) -> Option<(i32, i32)> {
	let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
	let fields = stat.get(stat.rfind(')')? + 1..)?.split_whitespace();
	let mut fields = fields.skip(1);
	let parent = fields.next()?.parse().ok()?;
	let group = fields.next()?.parse().ok()?;
	Some((parent, group))
}

#[cfg(target_os = "macos")]
fn process_parent_and_group(pid: i32) -> Option<(i32, i32)> {
	let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
	let size = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>()).ok()?;
	let read =
		unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), size) };
	if read != size {
		return None;
	}
	let info = unsafe { info.assume_init() };
	Some((i32::try_from(info.pbi_ppid).ok()?, i32::try_from(info.pbi_pgid).ok()?))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn process_parent_and_group(pid: i32) -> Option<(i32, i32)> {
	if pid != unsafe { libc::getpid() } {
		return None;
	}
	let parent = unsafe { libc::getppid() };
	let group = unsafe { libc::getpgid(pid) };
	Some((parent, group))
}

#[cfg(windows)]
fn process_exists(pid: i32) -> bool {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	};

	let Ok(pid) = u32::try_from(pid) else {
		return false;
	};
	// SAFETY: the numeric process id is supplied by the user and the returned
	// handle is checked before use.
	let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if handle.is_null() {
		return false;
	}
	// SAFETY: `handle` was returned by `OpenProcess` and is closed exactly once.
	let _ = unsafe { CloseHandle(handle) };
	true
}

fn print_kill_signals<'a>(
	context: &ExecutionContext<'_, impl ShellExtensions>,
	signals: impl IntoIterator<Item = &'a String>,
) -> result::Result<ExecutionResult, Error> {
	let mut result = ExecutionResult::success();
	let mut signals = signals.into_iter().peekable();
	if signals.peek().is_none() {
		return format_signals(
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

/// How `kill -l <operand>` renders one operand.
enum PrintedSignal {
	Name(&'static str),
	Number(i32),
}

fn printed_signal(value: &str) -> result::Result<PrintedSignal, Error> {
	if let Ok(number) = value.parse::<i32>() {
		let signal = TrapSignal::try_from(number).or_else(|err| {
			if number > 128 {
				TrapSignal::try_from(number - 128).map_err(|_| err)
			} else {
				Err(err)
			}
		})?;
		Ok(PrintedSignal::Name(
			signal
				.as_str()
				.strip_prefix("SIG")
				.unwrap_or(signal.as_str()),
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
		self
			.args
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
		use crate::builtins::Command as _;
		let cmd = KillCommand::new(args.iter().map(ToString::to_string)).unwrap();
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
		use crate::builtins::Command as _;
		KillCommand::new(args.iter().map(ToString::to_string)).unwrap()
	}

	#[test]
	fn attached_signal_name_values_split() {
		let cmd = parsed(&["kill", "-s9", "123"]);
		assert_eq!(cmd.signal_name.as_deref(), Some("9"));
		assert_eq!(cmd.args, ["123"]);

		let cmd = parsed(&["kill", "-sKILL", "123"]);
		assert_eq!(cmd.signal_name.as_deref(), Some("KILL"));
		assert_eq!(cmd.args, ["123"]);
	}

	#[test]
	fn sig_prefixed_spec_stays_whole() {
		let cmd = parsed(&["kill", "-sigkill", "123"]);
		assert_eq!(cmd.signal_name, None);
		assert_eq!(cmd.args, ["-sigkill", "123"]);
	}

	#[test]
	fn attached_signal_number_splits() {
		let cmd = parsed(&["kill", "-n9", "123"]);
		assert_eq!(cmd.signal_number, Some(9));
		assert_eq!(cmd.args, ["123"]);
	}

	#[test]
	fn attached_list_operand_splits() {
		let cmd = parsed(&["kill", "-l9"]);
		assert!(cmd.list_signals);
		assert_eq!(cmd.listed_signals().cloned().collect::<Vec<_>>(), ["9"]);

		let cmd = parsed(&["kill", "-L137"]);
		assert!(cmd.list_signals);
		assert_eq!(cmd.listed_signals().cloned().collect::<Vec<_>>(), ["137"]);
	}

	#[test]
	fn rewrite_leaves_operand_region_alone() {
		let rewritten = rewrite_attached_short_options(["kill", "--", "-s9"].map(String::from));
		assert_eq!(rewritten, ["kill", "--", "-s9"]);

		let rewritten = rewrite_attached_short_options(["kill", "-9", "-s9"].map(String::from));
		assert_eq!(rewritten, ["kill", "-9", "-s9"]);

		let rewritten =
			rewrite_attached_short_options(["kill", "-s", "KILL", "-123"].map(String::from));
		assert_eq!(rewritten, ["kill", "-s", "KILL", "-123"]);
	}

	#[test]
	fn list_maps_exit_statuses_above_128() {
		assert!(matches!(printed_signal("137"), Ok(PrintedSignal::Name("KILL"))));
		assert!(matches!(printed_signal("9"), Ok(PrintedSignal::Name("KILL"))));
		assert!(matches!(printed_signal("129"), Ok(PrintedSignal::Name("HUP"))));
		assert!(printed_signal("128").is_err());
		assert!(printed_signal("265").is_err());
	}
	#[test]
	fn protected_processes_cover_special_pid_ancestor_and_group_targets() {
		let protected = ProtectedProcesses {
			pids:  SmallVec::from_slice_copy(&[100, 50, 1]),
			pgids: SmallVec::from_slice_copy(&[100, 40]),
		};
		assert!(protected.blocks_target(0));
		assert!(protected.blocks_target(-1));
		assert!(protected.blocks_target(50));
		assert!(protected.blocks_target(-40));
		assert!(!protected.blocks_target(200));
		assert!(!protected.blocks_target(-200));
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
	fn parse(value: &str) -> result::Result<Self, Error> {
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
}

/// Resolves a signal name or number to its number.
///
/// Shared with `pkill`, which accepts the same `-SIGNAL` spellings.
#[allow(
	dead_code,
	reason = "shared with optional process-match builtins that may be feature-disabled"
)]
pub fn signal_number(value: &str) -> Option<i32> {
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
