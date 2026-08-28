//! The `ps` process-status builtin, moved from `pi-shell`.

#[cfg(unix)]
use std::collections::HashSet;
#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::path::{Path, PathBuf};
use std::{
	collections::HashMap,
	fmt::Write as _,
	io::{self, Write},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use brush_core::{ExecutionContext, ExecutionExitCode, ExecutionResult, builtins};
use clap::Parser;
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};

#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
/// Implements the `ps` process-status builtin.
pub(crate) struct PsCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

#[derive(Default)]
struct PsOptions {
	all:                 bool,
	other_users:         bool,
	include_no_terminal: bool,
	full_format:         bool,
	long_format:         bool,
	user_format:         bool,
	job_format:          bool,
	memory_format:       bool,
	bsd_syntax:          bool,
	command_only:        bool,
	running_only:        bool,
	no_headers:          bool,
	custom_format:       bool,
	pids:                Vec<i32>,
	parents:             Vec<i32>,
	groups:              Vec<i32>,
	sessions:            Vec<i32>,
	effective_users:     Vec<u32>,
	real_users:          Vec<u32>,
	real_groups:         Vec<u32>,
	terminals:           Vec<Option<u64>>,
	columns:             Vec<PsColumn>,
	sort:                Vec<PsSort>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PsField {
	User,
	Uid,
	Pid,
	Ppid,
	Pgid,
	Sid,
	Tty,
	State,
	Start,
	LongStart,
	Elapsed,
	ElapsedSeconds,
	CpuTime,
	CpuPercent,
	CpuInteger,
	MemPercent,
	VirtualSize,
	ResidentSize,
	Nice,
	Threads,
	Command,
	Args,
	Tpgid,
	StateChar,
	Priority,
	Flags,
	Ruser,
	Ruid,
	Rgroup,
	Rgid,
	Egroup,
	Egid,
	Wchan,
	MinorFaults,
	MajorFaults,
	CpuSeconds,
	Size,
}

impl PsField {
	const fn header(self) -> &'static str {
		match self {
			Self::User => "USER",
			Self::Uid => "UID",
			Self::Pid => "PID",
			Self::Ppid => "PPID",
			Self::Pgid => "PGID",
			Self::Sid => "SID",
			Self::Tty => "TTY",
			Self::State => "STAT",
			Self::Start => "START",
			Self::LongStart => "STARTED",
			Self::Elapsed => "ELAPSED",
			Self::ElapsedSeconds => "ELAPSED",
			Self::CpuTime => "TIME",
			Self::CpuPercent => "%CPU",
			Self::CpuInteger => "C",
			Self::MemPercent => "%MEM",
			Self::VirtualSize => "VSZ",
			Self::ResidentSize => "RSS",
			Self::Nice => "NI",
			Self::Threads => "NLWP",
			Self::Command => "COMMAND",
			Self::Args => "COMMAND",
			Self::Tpgid => "TPGID",
			Self::StateChar => "S",
			Self::Priority => "PRI",
			Self::Flags => "F",
			Self::Ruser => "RUSER",
			Self::Ruid => "RUID",
			Self::Rgroup => "RGROUP",
			Self::Rgid => "RGID",
			Self::Egroup => "GROUP",
			Self::Egid => "GID",
			Self::Wchan => "WCHAN",
			Self::MinorFaults => "MINFL",
			Self::MajorFaults => "MAJFL",
			Self::CpuSeconds => "TIME",
			Self::Size => "SZ",
		}
	}

	const fn right_aligned(self) -> bool {
		matches!(
			self,
			Self::Uid
				| Self::Pid
				| Self::Ppid
				| Self::Pgid
				| Self::Sid
				| Self::ElapsedSeconds
				| Self::CpuPercent
				| Self::CpuInteger
				| Self::MemPercent
				| Self::VirtualSize
				| Self::ResidentSize
				| Self::Nice
				| Self::Threads
				| Self::Tpgid
				| Self::Priority
				| Self::Flags
				| Self::Ruid
				| Self::Rgid
				| Self::Egid
				| Self::MinorFaults
				| Self::MajorFaults
				| Self::CpuSeconds
				| Self::Size
		)
	}
}

#[derive(Clone)]
struct PsColumn {
	field:     PsField,
	header:    String,
	min_width: usize,
}

impl PsColumn {
	fn new(field: PsField) -> Self {
		Self { field, header: field.header().to_string(), min_width: 0 }
	}

	fn with_header(field: PsField, header: &str) -> Self {
		Self { field, header: header.to_string(), min_width: 0 }
	}
}

#[derive(Clone, Copy)]
enum PsSortField {
	Pid,
	Ppid,
	Cpu,
	Mem,
	Time,
	Start,
	Command,
}

struct PsSort {
	field:      PsSortField,
	descending: bool,
}

enum ParsePsResult {
	Options(Box<PsOptions>),
	Help,
	Version,
}

struct PsProcessRow {
	pid:           i32,
	ppid:          Option<i32>,
	pgid:          Option<i32>,
	sid:           Option<i32>,
	tpgid:         Option<i32>,
	user:          Option<u32>,
	ruid:          Option<u32>,
	rgid:          Option<u32>,
	egid:          Option<u32>,
	terminal:      Option<u64>,
	state:         char,
	start_time:    u64,
	started_at:    Option<SystemTime>,
	age:           Option<Duration>,
	cpu_time:      Option<Duration>,
	virtual_size:  Option<u64>,
	resident_size: Option<u64>,
	threads:       Option<u32>,
	nice:          Option<i32>,
	priority:      Option<i32>,
	flags:         Option<u64>,
	minor_faults:  Option<u64>,
	major_faults:  Option<u64>,
	wchan:         Option<String>,
	command:       String,
	args:          String,
}

impl PsProcessRow {
	fn from_process(process: crate::proc_snapshot::ProcInfo, now: SystemTime, command_only: bool) -> Self {
		let command = crate::proc_snapshot::sanitize_process_command(process.command_name());
		let argv = process.args();
		let args = if command_only || argv.is_empty() {
			command.clone()
		} else {
			crate::proc_snapshot::sanitize_process_command(argv.join(" "))
		};
		let age = process.age();
		Self {
			pid: process.pid(),
			ppid: process.ppid(),
			pgid: process.group_id(),
			sid: process.session_id(),
			tpgid: process.terminal_group_id(),
			user: process
				.effective_user_id()
				.or_else(|| process.real_user_id()),
			ruid: process.real_user_id(),
			rgid: process.real_group_id(),
			egid: process.effective_group_id(),
			terminal: process.terminal_id(),
			state: process.state(),
			start_time: process.start_time(),
			started_at: age.and_then(|age| now.checked_sub(age)),
			age,
			cpu_time: process.cpu_time(),
			virtual_size: process.virtual_bytes(),
			resident_size: process.resident_bytes(),
			threads: process.thread_count(),
			nice: process.nice(),
			priority: process.priority(),
			flags: process.flags(),
			minor_faults: process.minor_faults(),
			major_faults: process.major_faults(),
			wchan: process.wchan(),
			command,
			args,
		}
	}

	fn cpu_percent(&self) -> Option<f64> {
		let age = self.age?.as_secs_f64();
		let cpu_time = self.cpu_time?.as_secs_f64();
		(age > 0.0).then_some(100.0 * cpu_time / age)
	}

	fn memory_percent(&self, total_memory: Option<u64>) -> Option<f64> {
		let total = total_memory.filter(|total| *total > 0)?;
		Some(100.0 * self.resident_size? as f64 / total as f64)
	}
}

impl builtins::Command for PsCommand {
	type Error = brush_core::Error;

	fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> impl Future<Output = std::result::Result<ExecutionResult, brush_core::Error>> + Send {
		let argv = self.argv.clone();
		async move {
			let options = match parse_ps_args(&argv) {
				Ok(ParsePsResult::Options(options)) => *options,
				Ok(ParsePsResult::Help) => {
					write_ps_help(context.stdout())?;
					return Ok(ExecutionResult::success());
				},
				Ok(ParsePsResult::Version) => {
					writeln!(context.stdout(), "ps {}", env!("CARGO_PKG_VERSION"))?;
					return Ok(ExecutionResult::success());
				},
				Err((code, message)) => {
					writeln!(context.stderr(), "ps: {message}")?;
					return Ok(ExecutionResult::new(code));
				},
			};
			if context.is_cancelled() {
				return Ok(ExecutionExitCode::Interrupted.into());
			}

			let mut processes = crate::proc_snapshot::ProcInfo::all();
			let current_pid = i32::try_from(std::process::id()).ok();
			let current =
				current_pid.and_then(|pid| processes.iter().find(|process| process.pid() == pid));
			let current_user = current.and_then(|process| {
				process
					.effective_user_id()
					.or_else(|| process.real_user_id())
			});
			let current_terminal = current.and_then(crate::proc_snapshot::ProcInfo::terminal_id);
			let current_session = current.and_then(crate::proc_snapshot::ProcInfo::session_id);
			processes.retain(|process| {
				ps_process_selected(
					process,
					&options,
					current_pid,
					current_user,
					current_terminal,
					current_session,
				)
			});

			let now = SystemTime::now();
			let mut rows: Vec<_> = processes
				.into_iter()
				.map(|process| PsProcessRow::from_process(process, now, options.command_only))
				.collect();
			sort_ps_rows(&mut rows, &options.sort);
			let columns = ps_columns(&options);
			let output = render_ps_table(&rows, &columns, options.no_headers);
			if let Err(err) = write!(context.stdout(), "{output}") {
				if err.kind() == io::ErrorKind::BrokenPipe {
					return Ok(ExecutionResult::success());
				}
				return Err(err.into());
			}
			Ok(if rows.is_empty() {
				ExecutionResult::new(1)
			} else {
				ExecutionResult::success()
			})
		}
	}
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

fn parse_ps_args(argv: &[String]) -> std::result::Result<ParsePsResult, (u8, String)> {
	let mut options = PsOptions::default();
	let mut index = 0;
	let mut options_done = false;
	while index < argv.len() {
		let arg = &argv[index];
		if !options_done && arg == "--" {
			options_done = true;
			index += 1;
			continue;
		}
		if options_done {
			parse_i32_list(arg, &mut options.pids)?;
			index += 1;
			continue;
		}
		match arg.as_str() {
			"--help" => return Ok(ParsePsResult::Help),
			"--version" => return Ok(ParsePsResult::Version),
			"--all" | "--everyone" => options.all = true,
			"--no-headers" => options.no_headers = true,
			"--headers" => options.no_headers = false,
			_ if arg == "--pid" || arg.starts_with("--pid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--pid="), "--pid")?;
				parse_i32_list(&value, &mut options.pids)?;
			},
			_ if arg == "--ppid" || arg.starts_with("--ppid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--ppid="), "--ppid")?;
				parse_i32_list(&value, &mut options.parents)?;
			},
			_ if arg == "--group" || arg.starts_with("--group=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--group="), "--group")?;
				parse_i32_list(&value, &mut options.groups)?;
			},
			_ if arg == "--sid" || arg.starts_with("--sid=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--sid="), "--sid")?;
				parse_i32_list(&value, &mut options.sessions)?;
			},
			_ if arg == "--user" || arg.starts_with("--user=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--user="), "--user")?;
				parse_user_list(&value, &mut options.effective_users)?;
			},
			_ if arg == "--User" || arg.starts_with("--User=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--User="), "--User")?;
				parse_user_list(&value, &mut options.real_users)?;
			},
			_ if arg == "--tty" || arg.starts_with("--tty=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--tty="), "--tty")?;
				parse_terminal_list(&value, &mut options.terminals)?;
			},
			_ if arg == "--format" || arg.starts_with("--format=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--format="), "--format")?;
				parse_ps_format(&value, &mut options.columns)?;
				options.custom_format = true;
			},
			_ if arg == "--sort" || arg.starts_with("--sort=") => {
				let value = take_ps_value(argv, &mut index, arg.strip_prefix("--sort="), "--sort")?;
				parse_ps_sort(&value, &mut options.sort)?;
			},
			_ if let Some(group) = arg.strip_prefix('-') => {
				if group.is_empty() {
					return Err((1, "invalid option '-'".to_string()));
				}
				let bsd = group.contains('x');
				parse_ps_flag_group(group, bsd, argv, &mut index, &mut options)?;
			},
			_ if arg
				.chars()
				.all(|character| character.is_ascii_digit() || character == ',') =>
			{
				parse_i32_list(arg, &mut options.pids)?;
			},
			_ if arg.chars().all(|character| character.is_ascii_alphabetic()) => {
				parse_ps_flag_group(arg, true, argv, &mut index, &mut options)?;
			},
			_ => return Err((1, format!("unsupported operand '{arg}'"))),
		}
		index += 1;
	}
	Ok(ParsePsResult::Options(Box::new(options)))
}

fn take_ps_value(
	argv: &[String],
	index: &mut usize,
	inline: Option<&str>,
	option: &str,
) -> std::result::Result<String, (u8, String)> {
	if let Some(value) = inline {
		if value.is_empty() {
			return Err((1, format!("option '{option}' requires an argument")));
		}
		return Ok(value.to_string());
	}
	*index += 1;
	argv
		.get(*index)
		.filter(|value| !value.is_empty())
		.cloned()
		.ok_or_else(|| (1, format!("option '{option}' requires an argument")))
}

fn parse_ps_flag_group(
	group: &str,
	bsd: bool,
	argv: &[String],
	index: &mut usize,
	options: &mut PsOptions,
) -> std::result::Result<(), (u8, String)> {
	if bsd {
		options.bsd_syntax = true;
	}
	let mut offset = 0;
	while offset < group.len() {
		let option = group.as_bytes()[offset] as char;
		offset += 1;
		let remainder = &group[offset..];
		match option {
			'A' => options.all = true,
			'e' if !bsd => options.all = true,
			'e' => {},
			'a' => options.other_users = true,
			'x' => {
				options.include_no_terminal = true;
				options.bsd_syntax = true;
			},
			'f' => options.full_format = true,
			'l' => options.long_format = true,
			'j' => options.job_format = true,
			'v' => options.memory_format = true,
			'u' if bsd => options.user_format = true,
			'w' => {},
			'c' => options.command_only = true,
			'r' => options.running_only = true,
			'h' => options.no_headers = true,
			'o' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-o")?;
				parse_ps_format(&value, &mut options.columns)?;
				options.custom_format = true;
				return Ok(());
			},
			'p' | 'q' => {
				let value = take_ps_value(
					argv,
					index,
					(!remainder.is_empty()).then_some(remainder),
					if option == 'p' { "-p" } else { "-q" },
				)?;
				parse_i32_list(&value, &mut options.pids)?;
				return Ok(());
			},
			'P' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-P")?;
				parse_i32_list(&value, &mut options.parents)?;
				return Ok(());
			},
			'g' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-g")?;
				parse_i32_list(&value, &mut options.groups)?;
				return Ok(());
			},
			's' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-s")?;
				parse_i32_list(&value, &mut options.sessions)?;
				return Ok(());
			},
			't' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-t")?;
				parse_terminal_list(&value, &mut options.terminals)?;
				return Ok(());
			},
			'u' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-u")?;
				parse_user_list(&value, &mut options.effective_users)?;
				return Ok(());
			},
			'U' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-U")?;
				parse_user_list(&value, &mut options.real_users)?;
				return Ok(());
			},
			'G' => {
				let value =
					take_ps_value(argv, index, (!remainder.is_empty()).then_some(remainder), "-G")?;
				parse_group_list(&value, &mut options.real_groups)?;
				return Ok(());
			},
			_ => return Err((1, format!("unsupported option '-{option}'"))),
		}
	}
	Ok(())
}

fn parse_ps_format(
	value: &str,
	columns: &mut Vec<PsColumn>,
) -> std::result::Result<(), (u8, String)> {
	let start_len = columns.len();
	for spec in value.split(',').flat_map(str::split_ascii_whitespace) {
		let (field_spec, header) = spec
			.split_once('=')
			.map_or((spec, None), |(field, header)| (field, Some(header)));
		let (name, min_width) = field_spec
			.rsplit_once(':')
			.and_then(|(name, width)| width.parse::<usize>().ok().map(|width| (name, width)))
			.unwrap_or((field_spec, 0));
		let field = match name.to_ascii_lowercase().as_str() {
			"user" | "uname" | "euser" => PsField::User,
			"uid" | "euid" => PsField::Uid,
			"pid" | "lwp" | "tid" | "spid" | "tgid" => PsField::Pid,
			"ppid" => PsField::Ppid,
			"pgid" | "pgrp" => PsField::Pgid,
			"sid" | "sess" => PsField::Sid,
			"tpgid" => PsField::Tpgid,
			"tty" | "tt" | "tname" => PsField::Tty,
			"stat" | "state" => PsField::State,
			"s" => PsField::StateChar,
			"start" | "stime" | "bsdstart" => PsField::Start,
			"lstart" | "start_time" => PsField::LongStart,
			"etime" | "elapsed" => PsField::Elapsed,
			"etimes" => PsField::ElapsedSeconds,
			"time" | "cputime" | "bsdtime" => PsField::CpuTime,
			"times" | "cputimes" => PsField::CpuSeconds,
			"pcpu" | "%cpu" => PsField::CpuPercent,
			"c" => PsField::CpuInteger,
			"pmem" | "%mem" => PsField::MemPercent,
			"vsz" | "vsize" => PsField::VirtualSize,
			"rss" | "rssize" | "rsz" => PsField::ResidentSize,
			"sz" => PsField::Size,
			"ni" | "nice" => PsField::Nice,
			"pri" | "opri" | "priority" => PsField::Priority,
			"f" | "flag" | "flags" => PsField::Flags,
			"ruser" | "logname" => PsField::Ruser,
			"ruid" => PsField::Ruid,
			"rgroup" => PsField::Rgroup,
			"rgid" => PsField::Rgid,
			"group" | "egroup" => PsField::Egroup,
			"gid" | "egid" => PsField::Egid,
			"wchan" | "mwchan" => PsField::Wchan,
			"min_flt" | "minflt" => PsField::MinorFaults,
			"maj_flt" | "majflt" => PsField::MajorFaults,
			"nlwp" | "thcount" => PsField::Threads,
			"comm" | "ucomm" | "fname" => PsField::Command,
			"args" | "command" | "cmd" => PsField::Args,
			_ => return Err((1, format!("unknown output format specifier '{name}'"))),
		};
		let mut column = PsColumn::new(field);
		if let Some(header) = header {
			column.header = header.to_string();
		}
		column.min_width = min_width;
		columns.push(column);
	}
	if columns.len() == start_len {
		return Err((1, "output format must name at least one column".to_string()));
	}
	Ok(())
}

fn parse_ps_sort(value: &str, sort: &mut Vec<PsSort>) -> std::result::Result<(), (u8, String)> {
	for spec in value.split(',').flat_map(str::split_ascii_whitespace) {
		let (descending, name) = if let Some(name) = spec.strip_prefix('-') {
			(true, name)
		} else {
			(false, spec.strip_prefix('+').unwrap_or(spec))
		};
		let field = match name.to_ascii_lowercase().as_str() {
			"pid" => PsSortField::Pid,
			"ppid" => PsSortField::Ppid,
			"pcpu" | "%cpu" | "cpu" => PsSortField::Cpu,
			"pmem" | "%mem" | "mem" | "rss" => PsSortField::Mem,
			"time" | "cputime" => PsSortField::Time,
			"start" | "lstart" => PsSortField::Start,
			"comm" | "command" | "cmd" => PsSortField::Command,
			_ => return Err((1, format!("unknown sort specifier '{name}'"))),
		};
		sort.push(PsSort { field, descending });
	}
	if sort.is_empty() {
		return Err((1, "sort must name at least one column".to_string()));
	}
	Ok(())
}

fn ps_process_selected(
	process: &crate::proc_snapshot::ProcInfo,
	options: &PsOptions,
	current_pid: Option<i32>,
	current_user: Option<u32>,
	current_terminal: Option<u64>,
	current_session: Option<i32>,
) -> bool {
	if options.running_only && process.state() != 'R' {
		return false;
	}
	let has_selectors = !options.pids.is_empty()
		|| !options.parents.is_empty()
		|| !options.groups.is_empty()
		|| !options.sessions.is_empty()
		|| !options.effective_users.is_empty()
		|| !options.real_users.is_empty()
		|| !options.real_groups.is_empty()
		|| !options.terminals.is_empty();
	if options.all {
		return true;
	}
	if has_selectors {
		return options.pids.contains(&process.pid())
			|| process
				.ppid()
				.is_some_and(|value| options.parents.contains(&value))
			|| process
				.group_id()
				.is_some_and(|value| options.groups.contains(&value))
			|| process
				.session_id()
				.is_some_and(|value| options.sessions.contains(&value))
			|| process
				.effective_user_id()
				.is_some_and(|value| options.effective_users.contains(&value))
			|| process
				.real_user_id()
				.is_some_and(|value| options.real_users.contains(&value))
			|| process
				.real_group_id()
				.is_some_and(|value| options.real_groups.contains(&value))
			|| options.terminals.contains(&process.terminal_id());
	}
	if options.other_users {
		return options.include_no_terminal || process.terminal_id().is_some();
	}
	if current_user.is_some_and(|user| {
		process.effective_user_id() != Some(user) && process.real_user_id() != Some(user)
	}) {
		return false;
	}
	if options.include_no_terminal {
		return true;
	}
	if cfg!(target_os = "macos") {
		return process.terminal_id().is_some();
	}
	if let Some(terminal) = current_terminal {
		return process.terminal_id() == Some(terminal);
	}
	if let Some(session) = current_session {
		return process.session_id() == Some(session);
	}
	current_pid.is_none_or(|pid| process.pid() == pid)
}

fn ps_columns(options: &PsOptions) -> Vec<PsColumn> {
	if options.custom_format {
		return options.columns.clone();
	}
	let columns = if options.user_format {
		vec![
			(PsField::User, "USER"),
			(PsField::Pid, "PID"),
			(PsField::CpuPercent, "%CPU"),
			(PsField::MemPercent, "%MEM"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::Start, "START"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.long_format {
		vec![
			(PsField::StateChar, "S"),
			(PsField::Uid, "UID"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::Pgid, "PGID"),
			(PsField::Sid, "SID"),
			(PsField::Nice, "NI"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	} else if options.job_format {
		vec![
			(PsField::User, "USER"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::Pgid, "PGID"),
			(PsField::Sid, "SID"),
			(PsField::Tpgid, "TPGID"),
			(PsField::State, "STAT"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.memory_format {
		vec![
			(PsField::Pid, "PID"),
			(PsField::MemPercent, "%MEM"),
			(PsField::VirtualSize, "VSZ"),
			(PsField::ResidentSize, "RSS"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::Start, "START"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else if options.full_format {
		vec![
			(PsField::Uid, "UID"),
			(PsField::Pid, "PID"),
			(PsField::Ppid, "PPID"),
			(PsField::CpuInteger, "C"),
			(PsField::Start, "STIME"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	} else if options.bsd_syntax {
		vec![
			(PsField::Pid, "PID"),
			(PsField::Tty, "TTY"),
			(PsField::State, "STAT"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "COMMAND"),
		]
	} else {
		vec![
			(PsField::Pid, "PID"),
			(PsField::Tty, "TTY"),
			(PsField::CpuTime, "TIME"),
			(PsField::Args, "CMD"),
		]
	};
	columns
		.into_iter()
		.map(|(field, header)| PsColumn::with_header(field, header))
		.collect()
}

fn sort_ps_rows(rows: &mut [PsProcessRow], sort: &[PsSort]) {
	rows.sort_by(|left, right| {
		for key in sort {
			let ordering = match key.field {
				PsSortField::Pid => left.pid.cmp(&right.pid),
				PsSortField::Ppid => left.ppid.cmp(&right.ppid),
				PsSortField::Cpu => match (left.cpu_percent(), right.cpu_percent()) {
					(Some(left), Some(right)) => left.total_cmp(&right),
					(left, right) => left.is_some().cmp(&right.is_some()),
				},
				PsSortField::Mem => left.resident_size.cmp(&right.resident_size),
				PsSortField::Time => left.cpu_time.cmp(&right.cpu_time),
				PsSortField::Start => left.start_time.cmp(&right.start_time),
				PsSortField::Command => left.command.cmp(&right.command),
			};
			let ordering = if key.descending {
				ordering.reverse()
			} else {
				ordering
			};
			if ordering != std::cmp::Ordering::Equal {
				return ordering;
			}
		}
		left.pid.cmp(&right.pid)
	});
}

fn render_ps_table(rows: &[PsProcessRow], columns: &[PsColumn], no_headers: bool) -> String {
	let has_field = |wanted| columns.iter().any(|column| column.field == wanted);
	let total_memory = has_field(PsField::MemPercent)
		.then(ps_total_memory_bytes)
		.flatten();
	let timezone = (has_field(PsField::Start) || has_field(PsField::LongStart))
		.then(|| TimeZone::try_system().unwrap_or(TimeZone::UTC));
	let terminal_names = if has_field(PsField::Tty) {
		ps_terminal_names(rows)
	} else {
		HashMap::new()
	};
	let mut user_names = HashMap::new();
	if has_field(PsField::User) || has_field(PsField::Ruser) {
		let uids = rows.iter().flat_map(|row| [row.user, row.ruid]).flatten();
		for uid in uids {
			user_names
				.entry(uid)
				.or_insert_with(|| ps_user_name(uid).unwrap_or_else(|| uid.to_string()));
		}
	}
	let mut group_names = HashMap::new();
	if has_field(PsField::Rgroup) || has_field(PsField::Egroup) {
		let gids = rows.iter().flat_map(|row| [row.rgid, row.egid]).flatten();
		for gid in gids {
			group_names
				.entry(gid)
				.or_insert_with(|| ps_group_name(gid).unwrap_or_else(|| gid.to_string()));
		}
	}
	let values: Vec<Vec<String>> = rows
		.iter()
		.map(|row| {
			columns
				.iter()
				.map(|column| {
					render_ps_value(
						row,
						column.field,
						total_memory,
						timezone.as_ref(),
						&terminal_names,
						&user_names,
						&group_names,
					)
				})
				.collect()
		})
		.collect();
	let widths: Vec<usize> = columns
		.iter()
		.enumerate()
		.map(|(index, column)| {
			values
				.iter()
				.map(|row| row[index].chars().count())
				.fold(column.header.chars().count().max(column.min_width), usize::max)
		})
		.collect();
	let mut output = String::new();
	if !no_headers && columns.iter().any(|column| !column.header.is_empty()) {
		write_ps_line(
			&mut output,
			columns.iter().map(|column| column.header.as_str()),
			columns,
			&widths,
		);
	}
	for row in &values {
		write_ps_line(&mut output, row.iter().map(String::as_str), columns, &widths);
	}
	output
}

fn write_ps_line<'a>(
	output: &mut String,
	values: impl Iterator<Item = &'a str>,
	columns: &[PsColumn],
	widths: &[usize],
) {
	for (index, value) in values.enumerate() {
		if index > 0 {
			output.push(' ');
		}
		let width = widths[index];
		if columns[index].field.right_aligned() {
			let _ = write!(output, "{value:>width$}");
		} else if index + 1 == columns.len() {
			output.push_str(value);
		} else {
			let _ = write!(output, "{value:<width$}");
		}
	}
	output.push('\n');
}

fn render_ps_value(
	row: &PsProcessRow,
	field: PsField,
	total_memory: Option<u64>,
	timezone: Option<&TimeZone>,
	terminal_names: &HashMap<u64, String>,
	user_names: &HashMap<u32, String>,
	group_names: &HashMap<u32, String>,
) -> String {
	match field {
		PsField::User => row
			.user
			.and_then(|uid| user_names.get(&uid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Uid => row
			.user
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Pid => row.pid.to_string(),
		PsField::Ppid => row
			.ppid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Pgid => row
			.pgid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Sid => row
			.sid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Tpgid => row
			.tpgid
			.map_or_else(|| "-1".to_string(), |value| value.to_string()),
		PsField::Tty => row
			.terminal
			.and_then(|terminal| terminal_names.get(&terminal).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::State => format_ps_state(row),
		PsField::StateChar => row.state.to_string(),
		PsField::Start => timezone.map_or_else(
			|| "?".to_string(),
			|timezone| format_ps_start(row.started_at, row.age, timezone, false),
		),
		PsField::LongStart => timezone.map_or_else(
			|| "?".to_string(),
			|timezone| format_ps_start(row.started_at, row.age, timezone, true),
		),
		PsField::Elapsed => row.age.map_or_else(|| "?".to_string(), format_ps_elapsed),
		PsField::ElapsedSeconds => row
			.age
			.map_or_else(|| "?".to_string(), |age| age.as_secs().to_string()),
		PsField::CpuTime => row
			.cpu_time
			.map_or_else(|| "?".to_string(), format_ps_elapsed),
		PsField::CpuPercent => row
			.cpu_percent()
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.1}")),
		PsField::CpuInteger => row
			.cpu_percent()
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.0}")),
		PsField::MemPercent => row
			.memory_percent(total_memory)
			.map_or_else(|| "?".to_string(), |percent| format!("{percent:.1}")),
		PsField::VirtualSize => row
			.virtual_size
			.map_or_else(|| "?".to_string(), |bytes| (bytes / 1024).to_string()),
		PsField::ResidentSize => row
			.resident_size
			.map_or_else(|| "?".to_string(), |bytes| (bytes / 1024).to_string()),
		PsField::Nice => row
			.nice
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Threads => row
			.threads
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Priority => row
			.priority
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Flags => row
			.flags
			.map_or_else(|| "?".to_string(), |value| format!("{value:x}")),
		PsField::Ruser => row
			.ruid
			.and_then(|uid| user_names.get(&uid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Ruid => row
			.ruid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Rgroup => row
			.rgid
			.and_then(|gid| group_names.get(&gid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Rgid => row
			.rgid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Egroup => row
			.egid
			.and_then(|gid| group_names.get(&gid).cloned())
			.unwrap_or_else(|| "?".to_string()),
		PsField::Egid => row
			.egid
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::Wchan => row.wchan.clone().unwrap_or_else(|| "-".to_string()),
		PsField::MinorFaults => row
			.minor_faults
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::MajorFaults => row
			.major_faults
			.map_or_else(|| "?".to_string(), |value| value.to_string()),
		PsField::CpuSeconds => row
			.cpu_time
			.map_or_else(|| "?".to_string(), |time| time.as_secs().to_string()),
		PsField::Size => row
			.virtual_size
			.zip(ps_page_size())
			.map_or_else(|| "?".to_string(), |(bytes, page)| bytes.div_ceil(page).to_string()),
		PsField::Command => row.command.clone(),
		PsField::Args => row.args.clone(),
	}
}

fn format_ps_state(row: &PsProcessRow) -> String {
	let mut state = row.state.to_string();
	match row.nice {
		Some(value) if value < 0 => state.push('<'),
		Some(value) if value > 0 => state.push('N'),
		_ => {},
	}
	if row.sid == Some(row.pid) {
		state.push('s');
	}
	if row.threads.is_some_and(|threads| threads > 1) {
		state.push('l');
	}
	if row.terminal.is_some() && row.tpgid.is_some() && row.tpgid == row.pgid {
		state.push('+');
	}
	state
}

fn format_ps_start(
	started_at: Option<SystemTime>,
	age: Option<Duration>,
	timezone: &TimeZone,
	long: bool,
) -> String {
	const DAY_SECONDS: u64 = 24 * 60 * 60;
	const SIX_MONTH_SECONDS: u64 = 180 * DAY_SECONDS;
	let Some(started_at) = started_at else {
		return "?".to_string();
	};
	let Ok(since_epoch) = started_at.duration_since(UNIX_EPOCH) else {
		return "?".to_string();
	};
	let Ok(nanoseconds) = i128::try_from(since_epoch.as_nanos()) else {
		return "?".to_string();
	};
	let Ok(timestamp) = Timestamp::from_nanosecond(nanoseconds) else {
		return "?".to_string();
	};
	let format = if long {
		"%a %b %e %H:%M:%S %Y"
	} else if age.is_some_and(|age| age.as_secs() < DAY_SECONDS) {
		"%H:%M"
	} else if age.is_some_and(|age| age.as_secs() < SIX_MONTH_SECONDS) {
		"%b%d"
	} else {
		"%Y"
	};
	strtime::format(format, &timestamp.to_zoned(timezone.clone()))
		.unwrap_or_else(|_| "?".to_string())
}

fn format_ps_elapsed(duration: Duration) -> String {
	let total_seconds = duration.as_secs();
	let days = total_seconds / 86_400;
	let hours = total_seconds % 86_400 / 3_600;
	let minutes = total_seconds % 3_600 / 60;
	let seconds = total_seconds % 60;
	if days > 0 {
		format!("{days}-{hours:02}:{minutes:02}:{seconds:02}")
	} else if hours > 0 {
		format!("{hours:02}:{minutes:02}:{seconds:02}")
	} else {
		format!("{minutes:02}:{seconds:02}")
	}
}

#[cfg(target_os = "linux")]
fn ps_total_memory_bytes() -> Option<u64> {
	let value = fs::read_to_string("/proc/meminfo")
		.ok()?
		.lines()
		.find_map(|line| line.strip_prefix("MemTotal:"))?
		.split_ascii_whitespace()
		.next()?
		.parse::<u64>()
		.ok()?;
	value.checked_mul(1024)
}

#[cfg(target_os = "macos")]
fn ps_total_memory_bytes() -> Option<u64> {
	let mut value = 0_u64;
	let mut size = std::mem::size_of::<u64>();
	// SAFETY: the output pointer names a writable u64 and `size` reports its
	// exact capacity; hw.memsize has no input buffer.
	let status = unsafe {
		libc::sysctlbyname(
			c"hw.memsize".as_ptr(),
			(&raw mut value).cast(),
			&raw mut size,
			std::ptr::null_mut(),
			0,
		)
	};
	(status == 0 && size == std::mem::size_of::<u64>()).then_some(value)
}

#[cfg(target_os = "windows")]
fn ps_total_memory_bytes() -> Option<u64> {
	None
}

#[cfg(unix)]
fn ps_user_name(uid: u32) -> Option<String> {
	use std::ffi::CStr;
	let mut record = std::mem::MaybeUninit::<libc::passwd>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0_u8; 16 * 1024];
	// SAFETY: all pointers refer to live storage for this call; a non-null
	// result guarantees `record` and its pw_name pointer were initialized.
	let status = unsafe {
		libc::getpwuid_r(
			uid,
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: getpwuid_r succeeded and the backing buffer remains alive.
	let name = unsafe { CStr::from_ptr(record.assume_init().pw_name) };
	Some(name.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn ps_user_name(_uid: u32) -> Option<String> {
	None
}

#[cfg(unix)]
fn ps_group_name(gid: u32) -> Option<String> {
	use std::ffi::CStr;
	let mut record = std::mem::MaybeUninit::<libc::group>::zeroed();
	let mut result = std::ptr::null_mut();
	let mut buffer = vec![0_u8; 16 * 1024];
	// SAFETY: all pointers refer to live storage for this call; a non-null
	// result guarantees `record` and its gr_name pointer were initialized.
	let status = unsafe {
		libc::getgrgid_r(
			gid,
			record.as_mut_ptr(),
			buffer.as_mut_ptr().cast(),
			buffer.len(),
			&raw mut result,
		)
	};
	if status != 0 || result.is_null() {
		return None;
	}
	// SAFETY: getgrgid_r succeeded and the backing buffer remains alive.
	let name = unsafe { CStr::from_ptr(record.assume_init().gr_name) };
	Some(name.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn ps_group_name(_gid: u32) -> Option<String> {
	None
}

/// System memory page size in bytes, used for the SZ (pages) column.
#[cfg(unix)]
fn ps_page_size() -> Option<u64> {
	// SAFETY: sysconf reads a process-global constant.
	u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) })
		.ok()
		.filter(|value| *value > 0)
}

#[cfg(not(unix))]
fn ps_page_size() -> Option<u64> {
	None
}

#[cfg(unix)]
fn ps_terminal_names(rows: &[PsProcessRow]) -> HashMap<u64, String> {
	use std::os::unix::fs::MetadataExt;
	let wanted: HashSet<u64> = rows.iter().filter_map(|row| row.terminal).collect();
	let mut names = HashMap::new();
	for directory in [Path::new("/dev"), Path::new("/dev/pts")] {
		let Ok(entries) = fs::read_dir(directory) else {
			continue;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			let Ok(metadata) = fs::metadata(&path) else {
				continue;
			};
			let id = metadata.rdev();
			if !wanted.contains(&id) || names.contains_key(&id) {
				continue;
			}
			let name = path
				.strip_prefix("/dev")
				.ok()
				.map(|path| path.to_string_lossy().trim_start_matches('/').to_string());
			if let Some(name) = name.filter(|name| !name.is_empty()) {
				names.insert(id, name);
			}
		}
	}
	names
}

#[cfg(not(unix))]
fn ps_terminal_names(_rows: &[PsProcessRow]) -> HashMap<u64, String> {
	HashMap::new()
}

fn write_ps_help(mut output: impl Write) -> io::Result<()> {
	writeln!(
		output,
		"Usage: ps [options]\n\nSelection:\n-A, -e, --all       select every process\n-p, --pid \
		 LIST      select process IDs\n-P, --ppid LIST     select parent process IDs\n-u, --user \
		 LIST     select effective users\n-U, --User LIST     select real users\n-t, --tty LIST      \
		 select terminals\n\nOutput:\n-f                  full format\n-l                  long \
		 format\n-o, --format LIST   custom columns\n--sort LIST     sort by columns; prefix \
		 descending keys with '-'\n--no-headers    omit column headings\n\nBSD forms such as 'ps \
		 ax', 'ps aux', and 'ps axo pid,command' are supported."
	)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_output_field_lists_and_overrides() {
		let argv = vec!["-o".to_string(), "pid:8=PROCESS,user,args=COMMAND".to_string()];
		let ParsePsResult::Options(options) = parse_ps_args(&argv).expect("valid output fields") else {
			panic!("expected parsed options");
		};

		assert!(options.custom_format);
		assert_eq!(options.columns.len(), 3);
		assert!(matches!(options.columns[0].field, PsField::Pid));
		assert_eq!(options.columns[0].header, "PROCESS");
		assert_eq!(options.columns[0].min_width, 8);
		assert!(matches!(options.columns[1].field, PsField::User));
		assert_eq!(options.columns[1].header, "USER");
		assert!(matches!(options.columns[2].field, PsField::Args));
		assert_eq!(options.columns[2].header, "COMMAND");
	}

	#[test]
	fn rejects_unknown_output_field() {
		let error = parse_ps_format("pid,definitely_not_a_field", &mut Vec::new())
			.expect_err("unknown fields must fail");
		assert_eq!(error, (1, "unknown output format specifier 'definitely_not_a_field'".to_string()));
	}

	#[test]
	fn parses_sort_keys_and_directions() {
		let mut sort = Vec::new();
		parse_ps_sort("-pcpu,+pid command", &mut sort).expect("valid sort keys");
		assert_eq!(sort.len(), 3);
		assert!(matches!(sort[0].field, PsSortField::Cpu));
		assert!(sort[0].descending);
		assert!(matches!(sort[1].field, PsSortField::Pid));
		assert!(!sort[1].descending);
		assert!(matches!(sort[2].field, PsSortField::Command));
		assert!(!sort[2].descending);

		let error = parse_ps_sort("bogus", &mut Vec::new()).expect_err("unknown keys must fail");
		assert_eq!(error, (1, "unknown sort specifier 'bogus'".to_string()));
	}

	#[test]
	fn formats_elapsed_time_boundaries() {
		assert_eq!(format_ps_elapsed(Duration::from_secs(0)), "00:00");
		assert_eq!(format_ps_elapsed(Duration::from_secs(65)), "01:05");
		assert_eq!(format_ps_elapsed(Duration::from_secs(3_661)), "01:01:01");
		assert_eq!(format_ps_elapsed(Duration::from_secs(90_061)), "1-01:01:01");
	}

	#[test]
	fn formats_start_time_by_age() {
		let started_at = UNIX_EPOCH.checked_add(Duration::from_secs(1_704_164_640)).unwrap();
		assert_eq!(
			format_ps_start(Some(started_at), Some(Duration::from_secs(60)), &TimeZone::UTC, false),
			"03:04"
		);
		assert_eq!(
			format_ps_start(
				Some(started_at),
				Some(Duration::from_secs(24 * 60 * 60)),
				&TimeZone::UTC,
				false,
			),
			"Jan02"
		);
		assert_eq!(
			format_ps_start(
				Some(started_at),
				Some(Duration::from_secs(180 * 24 * 60 * 60)),
				&TimeZone::UTC,
				false,
			),
			"2024"
		);
		assert_eq!(
			format_ps_start(Some(started_at), None, &TimeZone::UTC, true),
			"Tue Jan  2 03:04:00 2024"
		);
		assert_eq!(format_ps_start(None, None, &TimeZone::UTC, false), "?");
	}
}

