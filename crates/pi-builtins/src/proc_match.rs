//! Shared process-matching engine behind `pgrep`, `pkill`, and `pidwait`.
//!
//! The three commands differ only in what they do with the processes they
//! select — print them, signal them, or wait for them — so selection, argument
//! parsing, and help rendering all live here, and each command is a thin front
//! end over [`run`].
//!
//! Ported from `pi-shell`, which previously defined all three inline.

// The three front ends are each feature-gated, so a build with only some of
// them enabled legitimately uses only part of this module.
#![allow(dead_code, reason = "consumed by the feature-gated pgrep/pkill/pidwait front ends")]

use std::{
	collections::{HashMap, HashSet},
	future::Future,
	io::{self, Write},
	time::Duration,
};

use crate::{
	host::{INTERRUPTED_EXIT_CODE, ProcContext, ShellPaths},
	proc_select::{parse_group_list, parse_i32_list, parse_terminal_list, parse_user_list},
	proc_snapshot,
	stdio::Source,
};

/// What a process-matching command does with the processes it selects.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcMatchMode {
	Grep,
	Kill,
	Wait,
}

#[derive(Default)]
struct ProcMatchOptions {
	patterns:          Vec<String>,
	full:              bool,
	exact:             bool,
	ignore_case:       bool,
	invert:            bool,
	newest:            bool,
	oldest:            bool,
	parents:           Vec<i32>,
	groups:            Vec<i32>,
	sessions:          Vec<i32>,
	effective_users:   Vec<u32>,
	real_users:        Vec<u32>,
	real_groups:       Vec<u32>,
	terminals:         Vec<Option<u64>>,
	pids:              Vec<i32>,
	pid_files:         Vec<String>,
	explicit_pid:      bool,
	require_lock:      bool,
	older:             Option<Duration>,
	states:            HashSet<char>,
	ignore_ancestors:  bool,
	include_ancestors: bool,
	count:             bool,
	list_name:         bool,
	list_full:         bool,
	quiet:             bool,
	delimiter:         String,
	signal:            i32,
	queue:             Option<i32>,
	echo:              bool,
	echo_command:      bool,
	interactive:       bool,
}

/// Runs the process-matching body for `mode`.
///
/// `pgrep`, `pkill`, and `pidwait` each call this with their own mode; the
/// invoked name still comes from the context, so diagnostics and help name the
/// command the user actually typed. The context must carry its paths
/// ([`crate::host::Process::USES_PATHS`]).
pub(crate) fn run<'a>(
	mode: ProcMatchMode,
	argv: &[String],
	context: &'a ProcContext,
) -> impl Future<Output = io::Result<i32>> + Send + 'a {
	{
		let command_name = context.command_name.clone();
		let argv = argv.to_vec();
		async move {
			let mut stdin = ProcStdin::default();
			let parsed = parse_proc_match(mode, &argv, context, &mut stdin).await;
			let mut options = match parsed {
				Ok(ParseProcResult::Options(options)) => *options,
				Ok(ParseProcResult::Help) => {
					write_proc_match_help(context.stdout(), &command_name, mode)?;
					return Ok(0);
				},
				Ok(ParseProcResult::Version) => {
					writeln!(context.stdout(), "{command_name} {}", env!("CARGO_PKG_VERSION"))?;
					return Ok(0);
				},
				Ok(ParseProcResult::Cancelled) => return Ok(INTERRUPTED_EXIT_CODE),
				Err((code, message)) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(code.into());
				},
			};

			if context.is_cancelled() {
				return Ok(INTERRUPTED_EXIT_CODE);
			}

			let (processes, host) = match select_processes(&mut options) {
				Ok(selected) => selected,
				Err(message) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(2);
				},
			};
			if processes.is_empty() {
				if options.count && !options.quiet {
					writeln!(context.stdout(), "0")?;
				}
				return Ok(1);
			}

			match mode {
				ProcMatchMode::Grep => {
					if options.quiet {
						return Ok(0);
					}
					if options.count {
						writeln!(context.stdout(), "{}", processes.len())?;
					} else {
						let mut output = Vec::with_capacity(processes.len());
						for process in &processes {
							let line = if options.list_full
								|| (cfg!(target_os = "macos") && options.list_name && options.full)
							{
								format!("{} {}", process.pid(), process.args().join(" "))
							} else if options.list_name {
								format!("{} {}", process.pid(), process.command_name())
							} else {
								process.pid().to_string()
							};
							output.push(line);
						}
						writeln!(context.stdout(), "{}", output.join(&options.delimiter))?;
					}
				},
				ProcMatchMode::Kill => {
					if options.count && !options.quiet {
						writeln!(context.stdout(), "{}", processes.len())?;
					}
					let mut succeeded = false;
					for process in &processes {
						if context.is_cancelled() {
							return Ok(INTERRUPTED_EXIT_CODE);
						}
						if options.interactive {
							{
								let mut stderr = context.stderr();
								write!(stderr, "kill process {}? ", process.pid())?;
								stderr.flush()?;
							}
							context.flush_output().await?;
							let response = stdin.read_confirmation(context).await?;
							let Some(response) = response else {
								return Ok(INTERRUPTED_EXIT_CODE);
							};
							if !matches!(response.trim(), "y" | "Y" | "yes" | "YES") {
								continue;
							}
						}
						if context.is_cancelled() {
							return Ok(INTERRUPTED_EXIT_CODE);
						}
						// Selection may legitimately include an ancestor — `pgrep`
						// should still list the terminal — but signalling one would
						// tear down the session this shell runs in. Refuse late, at
						// delivery, so only the destructive mode is affected.
						if host.blocks(process.pid()) {
							if !options.quiet {
								writeln!(
									context.stderr(),
									"{command_name}: refusing to signal pid {} (this shell or one of its \
									 ancestors)",
									process.pid()
								)?;
							}
							continue;
						}
						if !process.signal(options.signal, options.queue) {
							if !options.quiet {
								writeln!(
									context.stderr(),
									"{command_name}: signalling pid {} failed",
									process.pid()
								)?;
							}
							continue;
						}
						succeeded = true;
						if options.echo_command && !options.quiet {
							writeln!(context.stdout(), "kill -{} {}", options.signal, process.pid())?;
						} else if options.echo && !options.quiet {
							writeln!(
								context.stdout(),
								"{} killed (pid {})",
								process.command_name(),
								process.pid()
							)?;
						}
					}
					if !succeeded {
						return Ok(1);
					}
				},
				ProcMatchMode::Wait => {
					if options.count && !options.quiet {
						writeln!(context.stdout(), "{}", processes.len())?;
					}
					if options.echo && !options.quiet {
						for process in &processes {
							writeln!(
								context.stdout(),
								"waiting for {} (pid {})",
								process.command_name(),
								process.pid()
							)?;
						}
					}
					context.flush_output().await?;
					// `biased` keeps the old precedence: processes that are already gone
					// report success even if cancellation is also pending.
					if let Some(cancel_token) = context.cancel_token() {
						tokio::select! {
							biased;
							() = wait_for_exits(&processes) => {},
							() = cancel_token.cancelled() => {
								return Ok(INTERRUPTED_EXIT_CODE);
							},
						}
					} else {
						wait_for_exits(&processes).await;
					}
				},
			}
			Ok(0)
		}
	}
}

/// The signal a `pkill` operand names: a number (`9`; `0` probes for
/// existence), or a name in any case with or without `SIG` (`TERM`, `sigterm`).
pub(crate) fn signal_number(operand: &str) -> Option<i32> {
	let upper = operand.to_ascii_uppercase();
	let name = upper.strip_prefix("SIG").unwrap_or(&upper);
	if !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()) {
		let number: i32 = name.parse().ok()?;
		let known = number == 0 || SIGNALS.iter().any(|&(_, signal)| signal == number);
		return (known || is_realtime(number)).then_some(number);
	}
	if name == "EXIT" {
		return Some(0);
	}
	SIGNALS.iter().find(|&&(known, _)| known == name).map(|&(_, number)| number)
}

/// Signal names (without `SIG`) and numbers on this platform.
#[cfg(unix)]
const SIGNALS: &[(&str, i32)] = &[
	("HUP", libc::SIGHUP),
	("INT", libc::SIGINT),
	("QUIT", libc::SIGQUIT),
	("ILL", libc::SIGILL),
	("TRAP", libc::SIGTRAP),
	("ABRT", libc::SIGABRT),
	("IOT", libc::SIGABRT),
	("BUS", libc::SIGBUS),
	("FPE", libc::SIGFPE),
	("KILL", libc::SIGKILL),
	("USR1", libc::SIGUSR1),
	("SEGV", libc::SIGSEGV),
	("USR2", libc::SIGUSR2),
	("PIPE", libc::SIGPIPE),
	("ALRM", libc::SIGALRM),
	("TERM", libc::SIGTERM),
	("CHLD", libc::SIGCHLD),
	("CONT", libc::SIGCONT),
	("STOP", libc::SIGSTOP),
	("TSTP", libc::SIGTSTP),
	("TTIN", libc::SIGTTIN),
	("TTOU", libc::SIGTTOU),
	("URG", libc::SIGURG),
	("XCPU", libc::SIGXCPU),
	("XFSZ", libc::SIGXFSZ),
	("VTALRM", libc::SIGVTALRM),
	("PROF", libc::SIGPROF),
	("WINCH", libc::SIGWINCH),
	("IO", libc::SIGIO),
	("SYS", libc::SIGSYS),
	#[cfg(any(target_os = "linux", target_os = "android"))]
	("STKFLT", libc::SIGSTKFLT),
	#[cfg(any(target_os = "linux", target_os = "android"))]
	("PWR", libc::SIGPWR),
	#[cfg(any(target_os = "linux", target_os = "android"))]
	("POLL", libc::SIGPOLL),
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	("EMT", libc::SIGEMT),
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "openbsd",
		target_os = "netbsd",
		target_os = "dragonfly"
	))]
	("INFO", libc::SIGINFO),
];

/// The signals every POSIX platform numbers alike, which Windows scripts can
/// still name.
#[cfg(not(unix))]
const SIGNALS: &[(&str, i32)] = &[
	("HUP", 1),
	("INT", 2),
	("QUIT", 3),
	("ILL", 4),
	("TRAP", 5),
	("ABRT", 6),
	("FPE", 8),
	("KILL", 9),
	("SEGV", 11),
	("PIPE", 13),
	("ALRM", 14),
	("TERM", 15),
];

/// Whether `number` is a real-time signal (Linux), which has no name here.
#[cfg(target_os = "linux")]
fn is_realtime(number: i32) -> bool {
	(libc::SIGRTMIN()..=libc::SIGRTMAX()).contains(&number)
}

/// Whether `number` is a real-time signal; none are recognized here.
#[cfg(not(target_os = "linux"))]
const fn is_realtime(_number: i32) -> bool {
	false
}

/// Resolves once every process in `processes` has exited.
///
/// Processes are awaited on kernel exit notifications where the platform has
/// them (pidfds on Linux, process handles on Windows); only the ones that
/// cannot be watched that way fall back to a 50 ms status poll.
async fn wait_for_exits(processes: &[proc_snapshot::ProcInfo]) {
	let polled = wait_for_watchable_exits(processes).await;
	while polled
		.iter()
		.any(|process| process.status() != proc_snapshot::ProcessStatus::Exited)
	{
		tokio::time::sleep(Duration::from_millis(50)).await;
	}
}

/// Waits on a pidfd per process and returns the processes that need polling.
#[cfg(target_os = "linux")]
async fn wait_for_watchable_exits(
	processes: &[proc_snapshot::ProcInfo],
) -> Vec<&proc_snapshot::ProcInfo> {
	use tokio::io::{Interest, unix::AsyncFd};

	let mut polled = Vec::new();
	let mut watched = Vec::new();
	for process in processes {
		let Some(fd) = proc_snapshot::sys::open_pidfd(process.pid()) else {
			polled.push(process);
			continue;
		};
		// The pidfd names whoever owns the pid now. It is the selected process
		// only if that process (matched by start time) is still alive after the
		// open; otherwise it already exited and the pid may have been reused.
		if process.status() == proc_snapshot::ProcessStatus::Exited {
			continue;
		}
		match AsyncFd::with_interest(fd, Interest::READABLE) {
			Ok(fd) => watched.push((process, fd)),
			Err(_) => polled.push(process),
		}
	}
	// A pidfd turns readable once its process has exited; readiness is never
	// cleared, so awaiting them one after another is the same as awaiting all.
	for (process, fd) in &watched {
		if fd.readable().await.is_err() {
			polled.push(process);
		}
	}
	polled
}

/// Waits on each process's snapshot handle and returns the processes whose
/// wait could not be registered, which need polling.
#[cfg(windows)]
async fn wait_for_watchable_exits(
	processes: &[proc_snapshot::ProcInfo],
) -> Vec<&proc_snapshot::ProcInfo> {
	let mut polled = Vec::new();
	// A process handle stays signalled once its process has exited, so
	// awaiting them one after another is the same as awaiting all.
	for process in processes {
		if process.exited().await.is_err() {
			polled.push(process);
		}
	}
	polled
}

/// No exit notification primitive is wired up here; every process is polled.
#[cfg(not(any(target_os = "linux", windows)))]
async fn wait_for_watchable_exits(
	processes: &[proc_snapshot::ProcInfo],
) -> Vec<&proc_snapshot::ProcInfo> {
	processes.iter().collect()
}

/// Standard input of one invocation, opened on first use and kept so bytes
/// read ahead of a line survive into the next confirmation.
#[derive(Default)]
struct ProcStdin {
	reader: Option<LineReader>,
}

struct LineReader {
	source:  Source,
	pending: Vec<u8>,
}

impl ProcStdin {
	fn reader(&mut self, context: &ProcContext) -> io::Result<&mut LineReader> {
		if self.reader.is_none() {
			self.reader = Some(LineReader { source: context.stdin_source()?, pending: Vec::new() });
		}
		Ok(self.reader.as_mut().expect("reader was just opened"))
	}

	/// Reads the rest of standard input as text.
	async fn read_all(&mut self, context: &ProcContext) -> io::Result<String> {
		let reader = self.reader(context)?;
		let mut bytes = std::mem::take(&mut reader.pending);
		reader.source.read_to_end(&mut bytes, usize::MAX).await?;
		utf8(bytes)
	}

	/// Reads one confirmation line; `None` when cancelled first.
	async fn read_confirmation(&mut self, context: &ProcContext) -> io::Result<Option<String>> {
		if context.is_cancelled() {
			return Ok(None);
		}
		let reader = self.reader(context)?;
		if let Some(cancel_token) = context.cancel_token() {
			tokio::select! {
				line = reader.read_line() => line.map(Some),
				() = cancel_token.cancelled() => Ok(None),
			}
		} else {
			reader.read_line().await.map(Some)
		}
	}
}

impl LineReader {
	/// Reads through the next newline, or to end of input.
	async fn read_line(&mut self) -> io::Result<String> {
		let mut searched = 0;
		loop {
			if let Some(offset) = self.pending[searched..].iter().position(|byte| *byte == b'\n') {
				let line: Vec<u8> = self.pending.drain(..=searched + offset).collect();
				return utf8(line);
			}
			searched = self.pending.len();
			let mut chunk = [0u8; 8192];
			let count = self.source.read(&mut chunk).await?;
			if count == 0 {
				return utf8(std::mem::take(&mut self.pending));
			}
			self.pending.extend_from_slice(&chunk[..count]);
		}
	}
}

fn utf8(bytes: Vec<u8>) -> io::Result<String> {
	String::from_utf8(bytes)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8"))
}

enum ParseProcResult {
	Options(Box<ProcMatchOptions>),
	Help,
	Version,
	Cancelled,
}

/// Parses `argv`, resolves `-F` pidfiles (reading standard input only for
/// `-F -`), and validates the result.
async fn parse_proc_match(
	mode: ProcMatchMode,
	argv: &[String],
	context: &ProcContext,
	stdin: &mut ProcStdin,
) -> std::result::Result<ParseProcResult, (u8, String)> {
	let mut options = match parse_proc_match_args(mode, argv, context.paths())? {
		ParseProcResult::Options(options) => *options,
		other => return Ok(other),
	};
	// Resolution is raced against cancellation; a cancelled one is not a diagnostic.
	if let Some(cancel_token) = context.cancel_token() {
		tokio::select! {
			biased;
			resolved = resolve_pid_files(&mut options, context, stdin) => resolved?,
			() = cancel_token.cancelled() => return Ok(ParseProcResult::Cancelled),
		}
	} else {
		resolve_pid_files(&mut options, context, stdin).await?;
	}
	validate_proc_match_options(mode, &options)?;
	Ok(ParseProcResult::Options(Box::new(options)))
}

fn parse_proc_match_args(
	mode: ProcMatchMode,
	argv: &[String],
	paths: &ShellPaths,
) -> std::result::Result<ParseProcResult, (u8, String)> {
	let mut options =
		ProcMatchOptions { delimiter: "\n".to_string(), signal: 15, ..Default::default() };
	let mut index = 0;
	let mut options_done = false;
	while index < argv.len() {
		let arg = &argv[index];
		if !options_done && arg == "--" {
			options_done = true;
			index += 1;
			continue;
		}
		if !options_done && matches!(arg.as_str(), "--help" | "-h") {
			return Ok(ParseProcResult::Help);
		}
		if !options_done && arg == "--version" {
			return Ok(ParseProcResult::Version);
		}
		if mode == ProcMatchMode::Kill
			&& !options_done
			&& index == 0
			&& arg.starts_with('-')
			&& !arg.starts_with("--")
			&& signal_number(&arg[1..]).is_some()
		{
			options.signal = signal_number(&arg[1..]).unwrap_or(15);
			index += 1;
			continue;
		}
		if !options_done && arg.starts_with("--") {
			let (name, inline_value) = arg
				.split_once('=')
				.map_or((arg.as_str(), None), |(name, value)| (name, Some(value)));
			let takes_value =
				matches!(
					name,
					"--parent"
						| "--pgroup" | "--session"
						| "--euid" | "--uid"
						| "--group" | "--terminal"
						| "--pidfile"
						| "--pid" | "--older"
						| "--runstates"
						| "--delimiter"
						| "--signal" | "--queue"
				);
			let value = if takes_value {
				if let Some(value) = inline_value {
					Some(value)
				} else {
					index += 1;
					argv.get(index).map(String::as_str)
				}
			} else {
				None
			};
			if takes_value && value.is_none() {
				return Err((2, format!("option '{name}' requires an argument")));
			}
			match name {
				"--full" => options.full = true,
				"--exact" => options.exact = true,
				"--ignore-case" => options.ignore_case = true,
				"--inverse" => options.invert = true,
				"--newest" => options.newest = true,
				"--oldest" => options.oldest = true,
				"--parent" => parse_i32_list(value.unwrap_or_default(), &mut options.parents)?,
				"--pgroup" => parse_i32_list(value.unwrap_or_default(), &mut options.groups)?,
				"--session" => parse_i32_list(value.unwrap_or_default(), &mut options.sessions)?,
				"--euid" => parse_user_list(value.unwrap_or_default(), &mut options.effective_users)?,
				"--uid" => parse_user_list(value.unwrap_or_default(), &mut options.real_users)?,
				"--group" => parse_group_list(value.unwrap_or_default(), &mut options.real_groups)?,
				"--terminal" => parse_terminal_list(value.unwrap_or_default(), &mut options.terminals, paths)?,
				"--pidfile" => options
					.pid_files
					.push(value.unwrap_or_default().to_string()),
				"--pid" => {
					options.explicit_pid = true;
					parse_i32_list(value.unwrap_or_default(), &mut options.pids)?;
				},
				"--older" => {
					options.older = Some(Duration::from_secs(
						value
							.unwrap_or_default()
							.parse()
							.map_err(|_| (2, "invalid age".to_string()))?,
					));
				},
				"--runstates" => parse_states(value.unwrap_or_default(), &mut options.states)?,
				"--ignore-ancestors" => options.ignore_ancestors = true,
				"--count" => options.count = true,
				"--list-name" => options.list_name = true,
				"--list-full" => options.list_full = true,
				"--quiet" => options.quiet = true,
				"--delimiter" => options.delimiter = value.unwrap_or_default().to_string(),
				"--signal" if mode == ProcMatchMode::Kill => {
					options.signal = signal_number(value.unwrap_or_default())
						.ok_or_else(|| (2, "invalid signal".to_string()))?;
				},
				"--queue" if mode == ProcMatchMode::Kill && cfg!(target_os = "linux") => {
					options.queue = Some(
						value
							.unwrap_or_default()
							.parse()
							.map_err(|_| (2, "invalid queue value".to_string()))?,
					);
				},
				"--echo" if mode != ProcMatchMode::Grep => options.echo = true,
				"--logpidfile" => options.require_lock = true,
				"--lightweight" | "--ns" | "--nslist" | "--cgroup" | "--env" => {
					return Err((2, format!("unsupported option '{name}'")));
				},
				_ => return Err((2, format!("unrecognized option '{name}'"))),
			}
			index += 1;
			continue;
		}
		if !options_done && arg.starts_with('-') && arg != "-" {
			let chars: Vec<char> = arg[1..].chars().collect();
			let mut short_index = 0;
			while short_index < chars.len() {
				let option = chars[short_index];
				let takes_value =
					matches!(
						option,
						'P' | 'g' | 's' | 'u' | 'U' | 'G' | 't' | 'F' | 'p' | 'O' | 'r' | 'd'
					) || (option == 'q' && mode == ProcMatchMode::Kill && cfg!(target_os = "linux"));
				let owned_value;
				let value = if takes_value {
					if short_index + 1 < chars.len() {
						owned_value = chars[short_index + 1..].iter().collect::<String>();
						short_index = chars.len();
						owned_value.as_str()
					} else {
						index += 1;
						argv
							.get(index)
							.map(String::as_str)
							.ok_or_else(|| (2, format!("option '-{option}' requires an argument")))?
					}
				} else {
					""
				};
				match option {
					'f' => options.full = true,
					'x' => options.exact = true,
					'i' => options.ignore_case = true,
					'v' if mode == ProcMatchMode::Kill && !cfg!(target_os = "macos") => {
						return Err((2, "unrecognized option '-v'".to_string()));
					},
					'v' => options.invert = true,
					'n' => options.newest = true,
					'o' => options.oldest = true,
					'P' => parse_i32_list(value, &mut options.parents)?,
					'g' => parse_i32_list(value, &mut options.groups)?,
					's' => parse_i32_list(value, &mut options.sessions)?,
					'u' => parse_user_list(value, &mut options.effective_users)?,
					'U' => parse_user_list(value, &mut options.real_users)?,
					'G' => parse_group_list(value, &mut options.real_groups)?,
					't' => parse_terminal_list(value, &mut options.terminals, paths)?,
					'F' => options.pid_files.push(value.to_string()),
					'L' => options.require_lock = true,
					'p' => {
						options.explicit_pid = true;
						parse_i32_list(value, &mut options.pids)?;
					},
					'O' => {
						options.older = Some(Duration::from_secs(
							value.parse().map_err(|_| (2, "invalid age".to_string()))?,
						));
					},
					'r' => parse_states(value, &mut options.states)?,
					'a' => {
						if cfg!(target_os = "macos") {
							options.include_ancestors = true;
						} else {
							options.list_full = true;
						}
					},
					'A' => options.ignore_ancestors = true,
					'c' => options.count = true,
					'l' if mode == ProcMatchMode::Kill && cfg!(target_os = "macos") => {
						options.echo_command = true;
					},
					'l' => options.list_name = true,
					'q' if mode == ProcMatchMode::Kill && cfg!(target_os = "linux") => {
						options.queue = Some(
							value
								.parse()
								.map_err(|_| (2, "invalid queue value".to_string()))?,
						);
					},
					'q' if mode == ProcMatchMode::Grep => {
						options.quiet = true;
					},
					'q' => return Err((2, "unrecognized option '-q'".to_string())),
					'd' => options.delimiter = value.to_string(),
					'e' if mode != ProcMatchMode::Grep => options.echo = true,
					'I' if mode == ProcMatchMode::Kill && cfg!(target_os = "macos") => {
						options.interactive = true;
					},
					'I' if mode == ProcMatchMode::Kill => {
						return Err((2, "unrecognized option '-I'".to_string()));
					},
					'w' | 'H' => {
						return Err((2, format!("unsupported option '-{option}'")));
					},
					_ => return Err((2, format!("unrecognized option '-{option}'"))),
				}
				short_index += 1;
			}
			index += 1;
			continue;
		}
		options.patterns.push(arg.clone());
		index += 1;
	}

	#[cfg(target_os = "windows")]
	if !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty()
	{
		return Err((2, "selected process metadata is unavailable on Windows".to_string()));
	}

	if options.explicit_pid && !options.pid_files.is_empty() {
		return Err((2, "-F and -p cannot be combined".to_string()));
	}
	if options.require_lock && options.pid_files.is_empty() {
		return Err((2, "-L requires -F".to_string()));
	}
	Ok(ParseProcResult::Options(Box::new(options)))
}

async fn resolve_pid_files(
	options: &mut ProcMatchOptions,
	context: &ProcContext,
	stdin: &mut ProcStdin,
) -> std::result::Result<(), (u8, String)> {
	let paths = context.paths();
	let fs = context.vfs();
	let files = std::mem::take(&mut options.pid_files);
	for file in &files {
		let contents = if file == "-" {
			if options.require_lock {
				return Err((2, "-L cannot be used with '-F -'".to_string()));
			}
			stdin
				.read_all(context)
				.await
				.map_err(|err| (3, format!("cannot read pidfile from standard input: {err}")))?
		} else {
			let pidfile = fs
				.open(paths.resolve(file))
				.await
				.map_err(|err| (3, format!("cannot read pidfile '{file}': {err}")))?;
			if options.require_lock
				&& !pidfile
					.is_locked_async()
					.await
					.map_err(|err| (3, format!("cannot inspect pidfile '{file}': {err}")))?
			{
				return Err((3, format!("pidfile '{file}' is not locked")));
			}
			let mut contents = String::new();
			pidfile
				.read_to_string_async(&mut contents)
				.await
				.map_err(|err| (3, format!("cannot read pidfile '{file}': {err}")))?;
			contents
		};
		let pid = contents
			.split_whitespace()
			.next()
			.and_then(|value| value.parse::<i32>().ok())
			.filter(|pid| *pid > 0)
			.ok_or_else(|| (3, format!("invalid pidfile '{file}'")))?;
		options.pids.push(pid);
	}
	Ok(())
}

fn validate_proc_match_options(
	mode: ProcMatchMode,
	options: &ProcMatchOptions,
) -> std::result::Result<(), (u8, String)> {
	if !cfg!(target_os = "macos") && options.patterns.len() > 1 {
		return Err((2, "only one pattern can be provided".to_string()));
	}
	if options.patterns.is_empty() && !has_proc_selectors(options) {
		return Err((2, "no matching criteria specified".to_string()));
	}
	if options.invert && (options.newest || options.oldest) {
		return Err((2, "-v cannot be combined with -n or -o".to_string()));
	}
	if options.newest && options.oldest {
		return Err((2, "-n and -o are mutually exclusive".to_string()));
	}
	if mode != ProcMatchMode::Grep
		&& (options.list_name || options.list_full || options.delimiter != "\n")
	{
		return Err((2, "unsupported output-format option for this command".to_string()));
	}
	Ok(())
}

fn has_proc_selectors(options: &ProcMatchOptions) -> bool {
	!options.parents.is_empty()
		|| !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty()
		|| !options.pids.is_empty()
		|| options.older.is_some()
		|| !options.states.is_empty()
}

/// Selects the processes matching `options`, and resolves the host chain from the
/// same process-table snapshot.
///
/// Both come from one `ProcInfo::all()`: `pkill` needs the chain to decide what it
/// may signal, and taking a second snapshot for it would walk the whole table
/// again.
fn select_processes(
	options: &mut ProcMatchOptions,
) -> std::result::Result<(Vec<proc_snapshot::ProcInfo>, proc_snapshot::HostProcesses), String> {
	let all = proc_snapshot::ProcInfo::all();
	let host = proc_snapshot::HostProcesses::resolve_in(&all);
	let host_pid = std::process::id() as i32;
	let host_group = all
		.iter()
		.find(|process| process.pid() == host_pid)
		.and_then(proc_snapshot::ProcInfo::group_id);
	let host_session = all
		.iter()
		.find(|process| process.pid() == host_pid)
		.and_then(proc_snapshot::ProcInfo::session_id);
	if let Some(host_group) = host_group {
		for group in &mut options.groups {
			if *group == 0 {
				*group = host_group;
			}
		}
	}
	if let Some(host_session) = host_session {
		for session in &mut options.sessions {
			if *session == 0 {
				*session = host_session;
			}
		}
	}
	let by_pid: HashMap<i32, Option<i32>> = all
		.iter()
		.map(|process| (process.pid(), process.ppid()))
		.collect();
	let exclude_ancestors = options.ignore_ancestors
		|| (cfg!(target_os = "macos") && !options.include_ancestors && !options.invert);
	let mut forbidden = HashSet::from([host_pid]);
	if exclude_ancestors {
		let mut current = by_pid.get(&host_pid).copied().flatten();
		while let Some(pid) = current {
			if !forbidden.insert(pid) {
				break;
			}
			current = by_pid.get(&pid).copied().flatten();
		}
	}
	let regex = if options.patterns.is_empty() {
		None
	} else {
		let source = options
			.patterns
			.iter()
			.map(|pattern| {
				if options.exact {
					format!("^(?:{pattern})$")
				} else {
					format!("(?:{pattern})")
				}
			})
			.collect::<Vec<_>>()
			.join("|");
		Some(
			regex::RegexBuilder::new(&source)
				.case_insensitive(options.ignore_case)
				.build()
				.map_err(|err| format!("invalid regular expression: {err}"))?,
		)
	};
	let mut selected = Vec::new();
	for process in all {
		if forbidden.contains(&process.pid()) {
			continue;
		}
		let pattern_matches = regex.as_ref().is_none_or(|regex| {
			let subject = if options.full {
				process.args().join(" ")
			} else {
				process.match_name()
			};
			regex.is_match(&subject)
		});
		let selectors_match = (options.parents.is_empty()
			|| process
				.ppid()
				.is_some_and(|value| options.parents.contains(&value)))
			&& (options.groups.is_empty()
				|| process
					.group_id()
					.is_some_and(|value| options.groups.contains(&value)))
			&& (options.sessions.is_empty()
				|| process
					.session_id()
					.is_some_and(|value| options.sessions.contains(&value)))
			&& (options.effective_users.is_empty()
				|| process
					.effective_user_id()
					.is_some_and(|value| options.effective_users.contains(&value)))
			&& (options.real_users.is_empty()
				|| process
					.real_user_id()
					.is_some_and(|value| options.real_users.contains(&value)))
			&& (options.real_groups.is_empty()
				|| process
					.real_group_id()
					.is_some_and(|value| options.real_groups.contains(&value)))
			&& (options.terminals.is_empty() || options.terminals.contains(&process.terminal_id()))
			&& (options.pids.is_empty() || options.pids.contains(&process.pid()))
			&& options
				.older
				.is_none_or(|age| process.age().is_some_and(|process_age| process_age >= age))
			&& (options.states.is_empty() || options.states.contains(&process.state()));
		let matches = pattern_matches && selectors_match;
		if matches != options.invert {
			selected.push(process);
		}
	}
	selected.sort_by_key(|process| (process.start_time(), process.pid()));
	if options.newest {
		selected = selected.into_iter().next_back().into_iter().collect();
	} else if options.oldest {
		selected.truncate(1);
	}
	Ok((selected, host))
}

fn parse_states(value: &str, target: &mut HashSet<char>) -> std::result::Result<(), (u8, String)> {
	for state in value.split(',').flat_map(str::chars) {
		if !state.is_ascii_alphabetic() {
			return Err((2, format!("invalid process state '{state}'")));
		}
		target.insert(state.to_ascii_uppercase());
	}
	Ok(())
}

fn write_proc_match_help(
	mut output: impl Write,
	name: &str,
	mode: ProcMatchMode,
) -> io::Result<()> {
	let action = match mode {
		ProcMatchMode::Grep => "print matching process IDs",
		ProcMatchMode::Kill => "signal matching processes",
		ProcMatchMode::Wait => "wait for matching processes",
	};
	writeln!(output, "Usage: {name} [options] [pattern ...]")?;
	writeln!(output, "{action}")?;
	writeln!(
		output,
		"  -f full command  -x exact  -i ignore case  -v invert  -n newest  -o oldest"
	)?;
	#[cfg(not(target_os = "windows"))]
	writeln!(
		output,
		"  -P ppid  -g pgrp  -s sid  -u euid  -U uid  -G gid  -t tty  -p pid  -F pidfile"
	)?;
	#[cfg(target_os = "windows")]
	writeln!(output, "  -P ppid  -p pid  -F pidfile  -O seconds  -r states")?;
	if mode == ProcMatchMode::Kill {
		writeln!(output, "  -SIGNAL, --signal SIGNAL  choose signal (default TERM)")?;
	}
	#[cfg(target_os = "linux")]
	if mode == ProcMatchMode::Kill {
		writeln!(output, "  -q value, --queue value  send an integer with sigqueue")?;
	}
	if mode == ProcMatchMode::Grep {
		writeln!(output, "  -q  suppress output")?;
	}
	Ok(())
}

#[cfg(all(test, windows))]
mod tests {
	use std::path::PathBuf;

	use super::*;

	#[test]
	fn resolves_msys_drive_alias_pidfiles() {
		assert_eq!(
			ShellPaths::with_cwd(r"C:\workspace").resolve("/c/Users/Adam/app.pid"),
			PathBuf::from(r"C:\Users\Adam\app.pid"),
		);
	}
}
