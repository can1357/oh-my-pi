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
	fs,
	future::Future,
	io::{self, BufRead, Write},
	path::{Path, PathBuf},
	time::Duration,
};

use brush_core::{ExecutionContext, ExecutionExitCode, ExecutionResult};
#[cfg(unix)]
use brush_core::openfiles::OpenFiles;
use tokio_util::sync::CancellationToken;

use crate::{kill::signal_number, proc_snapshot};

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
/// invoked name still comes from the execution context, so diagnostics and help
/// name the command the user actually typed.
pub(crate) fn run<SE: brush_core::ShellExtensions>(
	mode: ProcMatchMode,
	argv: Vec<String>,
	context: ExecutionContext<'_, SE>,
) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
	{
		let command_name = context.command_name.clone();
		let cwd = context.shell.working_dir().to_path_buf();
		async move {
			#[cfg(unix)]
			let stdin_watcher = context.try_fd(OpenFiles::STDIN_FD).and_then(|stdin| {
				let fd = stdin.try_borrow_as_fd().ok()?.try_clone_to_owned().ok()?;
				tokio::io::unix::AsyncFd::new(fd).ok()
			});
			let mut stdin = io::BufReader::new(context.stdin());
			let mut options = match parse_proc_match_args(mode, &argv, &cwd, &mut stdin) {
				Ok(ParseProcResult::Options(options)) => *options,
				Ok(ParseProcResult::Help) => {
					write_proc_match_help(context.stdout(), &command_name, mode)?;
					return Ok(ExecutionResult::success());
				},
				Ok(ParseProcResult::Version) => {
					writeln!(context.stdout(), "{command_name} {}", env!("CARGO_PKG_VERSION"))?;
					return Ok(ExecutionResult::success());
				},
				Err((code, message)) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(ExecutionResult::new(code));
				},
			};

			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}

			let (processes, host) = match select_processes(&mut options) {
				Ok(selected) => selected,
				Err(message) => {
					writeln!(context.stderr(), "{command_name}: {message}")?;
					return Ok(ExecutionResult::new(2));
				},
			};
			if processes.is_empty() {
				if options.count && !options.quiet {
					writeln!(context.stdout(), "0")?;
				}
				return Ok(ExecutionResult::new(1));
			}

			match mode {
				ProcMatchMode::Grep => {
					if options.quiet {
						return Ok(ExecutionResult::success());
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
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						if options.interactive {
							{
								let mut stderr = context.stderr();
								write!(stderr, "kill process {}? ", process.pid())?;
								stderr.flush()?;
							}
							#[cfg(unix)]
							let response = read_proc_confirmation(
								&mut stdin,
								context.cancel_token(),
								stdin_watcher.as_ref(),
							)
							.await?;
							#[cfg(not(unix))]
							let response = read_proc_confirmation(&mut stdin, context.cancel_token()).await?;
							let Some(response) = response else {
								return Ok(ExecutionExitCode::Interrupted.into());
							};
							if !matches!(response.trim(), "y" | "Y" | "yes" | "YES") {
								continue;
							}
						}
						if context.is_cancelled() {
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						// Selection may legitimately include an ancestor — `pgrep`
						// should still list the terminal — but signalling one would
						// tear down the session this shell runs in. Refuse late, at
						// delivery, so only the destructive mode is affected.
						if host.pids.contains(&process.pid()) {
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
						return Ok(ExecutionResult::new(1));
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
					loop {
						if processes
							.iter()
							.all(|process| process.status() == proc_snapshot::ProcessStatus::Exited)
						{
							break;
						}
						if context.is_cancelled() {
							return Ok(ExecutionExitCode::Interrupted.into());
						}
						if let Some(cancel_token) = context.cancel_token() {
							tokio::select! {
								() = tokio::time::sleep(Duration::from_millis(50)) => {},
								() = cancel_token.cancelled() => {
									return Ok(ExecutionExitCode::Interrupted.into());
								},
							}
						} else {
							tokio::time::sleep(Duration::from_millis(50)).await;
						}
					}
				},
			}
			Ok(ExecutionResult::success())
		}
	}
}

#[cfg(unix)]
async fn read_proc_confirmation<R: io::Read>(
	stdin: &mut io::BufReader<R>,
	cancel_token: Option<CancellationToken>,
	watcher: Option<&tokio::io::unix::AsyncFd<std::os::fd::OwnedFd>>,
) -> io::Result<Option<String>> {
	if cancel_token
		.as_ref()
		.is_some_and(CancellationToken::is_cancelled)
	{
		return Ok(None);
	}
	if let Some(watcher) = watcher {
		if let Some(cancel_token) = cancel_token {
			let ready = tokio::select! {
				ready = watcher.readable() => ready,
				() = cancel_token.cancelled() => return Ok(None),
			};
			drop(ready?);
		} else {
			drop(watcher.readable().await?);
		}
	}
	let mut response = String::new();
	stdin.read_line(&mut response)?;
	Ok(Some(response))
}

#[cfg(not(unix))]
async fn read_proc_confirmation<R: io::Read>(
	stdin: &mut io::BufReader<R>,
	cancel_token: Option<CancellationToken>,
) -> io::Result<Option<String>> {
	if cancel_token
		.as_ref()
		.is_some_and(CancellationToken::is_cancelled)
	{
		return Ok(None);
	}
	let mut response = String::new();
	stdin.read_line(&mut response)?;
	Ok(Some(response))
}

enum ParseProcResult {
	Options(Box<ProcMatchOptions>),
	Help,
	Version,
}

fn parse_proc_match_args(
	mode: ProcMatchMode,
	argv: &[String],
	cwd: &Path,
	stdin: &mut impl BufRead,
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
				"--terminal" => parse_terminal_list(value.unwrap_or_default(), &mut options.terminals)?,
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
					't' => parse_terminal_list(value, &mut options.terminals)?,
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
	for file in &options.pid_files {
		let contents = if file == "-" {
			if options.require_lock {
				return Err((2, "-L cannot be used with '-F -'".to_string()));
			}
			let mut contents = String::new();
			stdin
				.read_to_string(&mut contents)
				.map_err(|err| (3, format!("cannot read pidfile from standard input: {err}")))?;
			contents
		} else {
			let path = resolve_shell_path(cwd, file);
			let mut pidfile = fs::File::open(&path)
				.map_err(|err| (3, format!("cannot read pidfile '{}': {err}", path.display())))?;
			if options.require_lock
				&& !pidfile_is_locked(&pidfile)
					.map_err(|err| (3, format!("cannot inspect pidfile '{}': {err}", path.display())))?
			{
				return Err((3, format!("pidfile '{}' is not locked", path.display())));
			}
			let mut contents = String::new();
			io::Read::read_to_string(&mut pidfile, &mut contents)
				.map_err(|err| (3, format!("cannot read pidfile '{}': {err}", path.display())))?;
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
	if !cfg!(target_os = "macos") && options.patterns.len() > 1 {
		return Err((2, "only one pattern can be provided".to_string()));
	}
	if options.patterns.is_empty() && !has_proc_selectors(&options) {
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
	Ok(ParseProcResult::Options(Box::new(options)))
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

fn parse_i32_list(value: &str, target: &mut Vec<i32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		let parsed = item
			.parse::<i32>()
			.map_err(|_| (2, format!("invalid numeric selector '{item}'")))?;
		target.push(parsed);
	}
	Ok(())
}

fn parse_user_list(value: &str, target: &mut Vec<u32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		target.push(resolve_user(item).ok_or_else(|| (2, format!("unknown user '{item}'")))?);
	}
	Ok(())
}

fn parse_group_list(value: &str, target: &mut Vec<u32>) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		target.push(resolve_group(item).ok_or_else(|| (2, format!("unknown group '{item}'")))?);
	}
	Ok(())
}

#[cfg(unix)]
fn resolve_user(value: &str) -> Option<u32> {
	use std::ffi::CString;
	if let Ok(id) = value.parse() {
		return Some(id);
	}
	let name = CString::new(value).ok()?;
	let mut record = std::mem::MaybeUninit::<libc::passwd>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0u8; 16 * 1024];
	// SAFETY: all pointers refer to live, writable storage for this call.
	let status = unsafe {
		libc::getpwnam_r(
			name.as_ptr(),
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: a successful getpwnam_r call initialized `record`.
	Some(unsafe { record.assume_init() }.pw_uid)
}

#[cfg(not(unix))]
fn resolve_user(value: &str) -> Option<u32> {
	value.parse().ok()
}

#[cfg(unix)]
fn resolve_group(value: &str) -> Option<u32> {
	use std::ffi::CString;
	if let Ok(id) = value.parse() {
		return Some(id);
	}
	let name = CString::new(value).ok()?;
	let mut record = std::mem::MaybeUninit::<libc::group>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0u8; 16 * 1024];
	// SAFETY: all pointers refer to live, writable storage for this call.
	let status = unsafe {
		libc::getgrnam_r(
			name.as_ptr(),
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: a successful getgrnam_r call initialized `record`.
	Some(unsafe { record.assume_init() }.gr_gid)
}

#[cfg(not(unix))]
fn resolve_group(value: &str) -> Option<u32> {
	value.parse().ok()
}

fn parse_terminal_list(
	value: &str,
	target: &mut Vec<Option<u64>>,
) -> std::result::Result<(), (u8, String)> {
	for item in value.split(',') {
		if matches!(item, "?" | "-") {
			target.push(None);
		} else if let Some(id) = resolve_terminal(item) {
			target.push(Some(id));
		} else if let Ok(id) = item.parse() {
			target.push(Some(id));
		} else {
			return Err((2, format!("unknown terminal '{item}'")));
		}
	}
	Ok(())
}

#[cfg(unix)]
fn resolve_terminal(value: &str) -> Option<u64> {
	use std::os::unix::fs::MetadataExt;
	let primary = if value.starts_with('/') {
		PathBuf::from(value)
	} else {
		Path::new("/dev").join(value)
	};
	fs::metadata(&primary)
		.or_else(|_| fs::metadata(Path::new("/dev").join(format!("tty{value}"))))
		.ok()
		.map(|metadata| metadata.rdev())
}

#[cfg(not(unix))]
fn resolve_terminal(_value: &str) -> Option<u64> {
	None
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

fn resolve_shell_path(cwd: &Path, value: &str) -> PathBuf {
	let normalized = brush_core::sys::fs::normalize_shell_path(Path::new(value));
	if normalized.is_absolute() {
		normalized.into_owned()
	} else {
		cwd.join(normalized)
	}
}

#[cfg(unix)]
fn pidfile_is_locked(file: &fs::File) -> io::Result<bool> {
	use std::os::fd::AsRawFd;
	let mut lock = libc::flock {
		l_type:   libc::F_WRLCK as libc::c_short,
		l_whence: libc::SEEK_SET as libc::c_short,
		l_start:  0,
		l_len:    0,
		l_pid:    0,
	};
	// SAFETY: `file` owns a valid fd and `lock` is writable for F_GETLK.
	if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &raw mut lock) } == -1 {
		return Err(io::Error::last_os_error());
	}
	Ok(lock.l_type != libc::F_UNLCK as libc::c_short)
}

#[cfg(not(unix))]
fn pidfile_is_locked(_file: &fs::File) -> io::Result<bool> {
	Err(io::Error::new(
		io::ErrorKind::Unsupported,
		"pidfile lock validation is unavailable on this platform",
	))
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
	use super::*;

	#[test]
	fn resolves_msys_drive_alias_pidfiles() {
		assert_eq!(
			resolve_shell_path(Path::new(r"C:\workspace"), "/c/Users/Adam/app.pid"),
			PathBuf::from(r"C:\Users\Adam\app.pid"),
		);
	}
}
