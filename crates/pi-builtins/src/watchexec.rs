//! `watchexec`: run a command when watched files change, with the options,
//! messages and event formats of watchexec 2.3.2.
//!
//! Changes come from the shared watcher ([`pi_watch`]): FSEvents on macOS,
//! inotify on Linux, `ReadDirectoryChangesW` on Windows, or a polling scan
//! with `--poll`. Each batch is filtered on the watcher's thread (`--fs-events`,
//! ignore files, `--ignore`, `--filter`, `--exts`), and what passes is gathered
//! for the debounce time, counted from the first event, before it is acted on.
//! On Linux, directories the ignores cover entirely get no watch at all.
//!
//! The command runs through the host, in the invoking shell's own engine: by
//! default as a command line of that shell, with `--shell=PROGRAM` as
//! `PROGRAM -c LINE`, with `--shell=none` as an argv. Signals (`--signal`,
//! `--stop-signal`, the forced stop after `--stop-timeout`) go to the
//! command's whole tree, as to a process group.

mod events;
mod filter;
#[cfg(test)]
mod tests;

use std::{
	ffi::OsString,
	fmt,
	io::{self, Seek as _, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use clap::{Parser, ValueEnum};
use futures::future::BoxFuture;
use pi_watch::{Backend, Config, Root, Watcher};

use self::{
	events::{Change, FsEvent},
	filter::{Discovery, Filterer, Homes, Settings},
};
use crate::{
	extras::Fd,
	host::{AsyncUtility, CommandStatus, Host, ShellCommand, strip_errno},
};

/// The release whose behavior this follows.
const VERSION: &str = "2.3.2";

/// The manual page `--manual` prints, as watchexec 2.3.2 ships it
/// (Apache-2.0).
const MANUAL: &str = include_str!("watchexec-manual.txt");

const AFTER_HELP: &str = "Want more detail? Try the long '--help' flag!";

const AFTER_LONG_HELP: &str = "\
Use @argfile as first argument to load arguments from the file 'argfile' (one argument per line)
which will be inserted in place of the @argfile (further arguments on the CLI will override or add
onto those in the file).

Didn't expect this much output? Use the short '-h' flag to get short help.";

const UNITLESS_WARNING: &str = "Warning: unitless non-zero time span values are deprecated and will \
                                be removed in an upcoming version";

/// Signal names and their numbers on this platform; where the system has no
/// signals, the numbers the shell uses.
#[cfg(unix)]
const SIGNALS: [(&str, i32); 29] = [
	("HUP", libc::SIGHUP),
	("INT", libc::SIGINT),
	("QUIT", libc::SIGQUIT),
	("ILL", libc::SIGILL),
	("TRAP", libc::SIGTRAP),
	("ABRT", libc::SIGABRT),
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
];

#[cfg(not(unix))]
const SIGNALS: [(&str, i32); 29] = [
	("HUP", 1),
	("INT", 2),
	("QUIT", 3),
	("ILL", 4),
	("TRAP", 5),
	("ABRT", 6),
	("BUS", 7),
	("FPE", 8),
	("KILL", 9),
	("USR1", 10),
	("SEGV", 11),
	("USR2", 12),
	("PIPE", 13),
	("ALRM", 14),
	("TERM", 15),
	("CHLD", 17),
	("CONT", 18),
	("STOP", 19),
	("TSTP", 20),
	("TTIN", 21),
	("TTOU", 22),
	("URG", 23),
	("XCPU", 24),
	("XFSZ", 25),
	("VTALRM", 26),
	("PROF", 27),
	("WINCH", 28),
	("IO", 29),
	("SYS", 31),
];

/// The number of the signal `name` (`TERM`, `KILL`, …).
fn signal_number(name: &str) -> i32 {
	SIGNALS
		.iter()
		.find(|(known, _)| *known == name)
		.map_or(0, |&(_, number)| number)
}

/// A signal as a full name (`SIGTERM`), a short one (`term`) or a number.
fn parse_signal(text: &str) -> Result<i32, String> {
	let upper = text.trim().to_ascii_uppercase();
	if let Ok(number) = upper.parse::<i32>()
		&& (1..=64).contains(&number)
	{
		return Ok(number);
	}
	let name = upper.strip_prefix("SIG").unwrap_or(&upper);
	SIGNALS
		.iter()
		.find(|(known, _)| *known == name)
		.map(|&(_, number)| number)
		.ok_or_else(|| format!("invalid signal `{text}`: unknown control name"))
}

/// How watchexec names the signal that killed a command.
struct KilledBy(i32);

impl fmt::Display for KilledBy {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let name = SIGNALS
			.iter()
			.find(|&&(_, number)| number == self.0)
			.map(|&(name, _)| name);
		match name {
			Some("HUP") => f.write_str("Hangup"),
			Some("INT") => f.write_str("Interrupt"),
			Some("QUIT") => f.write_str("Quit"),
			Some("KILL") => f.write_str("ForceStop"),
			Some("TERM") => f.write_str("Terminate"),
			_ => write!(f, "Custom({})", self.0),
		}
	}
}

/// A time span option, and whether it was given without a unit.
#[derive(Clone, Copy, Debug, PartialEq)]
struct TimeSpan {
	span:     Duration,
	unitless: bool,
}

/// Parses `5`, `0.5`, `300ms` or `2min 5s`; a bare number counts `unit`s.
fn parse_span(text: &str, unit: Duration) -> Result<TimeSpan, String> {
	let text = text.trim();
	if text.is_empty() {
		return Err("value was empty".into());
	}
	if let Ok(number) = text.parse::<f64>()
		&& number.is_finite()
		&& number >= 0.0
	{
		let span = Duration::try_from_secs_f64(unit.as_secs_f64() * number)
			.map_err(|_| "number is too large".to_owned())?;
		return Ok(TimeSpan { span, unitless: number != 0.0 });
	}
	let mut span = Duration::ZERO;
	let mut rest = text;
	loop {
		rest = rest.trim_start();
		if rest.is_empty() {
			return Ok(TimeSpan { span, unitless: false });
		}
		let at = text.len() - rest.len();
		let digits = rest
			.find(|c: char| !c.is_ascii_digit() && c != '.')
			.unwrap_or(rest.len());
		if digits == 0 {
			return Err(format!("expected number at {at}"));
		}
		let number: f64 = rest[..digits]
			.parse()
			.map_err(|_| format!("invalid character at {at}"))?;
		rest = rest[digits..].trim_start();
		let letters = rest
			.find(|c: char| !c.is_ascii_alphabetic())
			.unwrap_or(rest.len());
		let seconds = match &rest[..letters] {
			"nanos" | "nsec" | "ns" => 1e-9,
			"micros" | "usec" | "us" => 1e-6,
			"millis" | "msec" | "ms" => 1e-3,
			"seconds" | "second" | "secs" | "sec" | "s" => 1.0,
			"minutes" | "minute" | "mins" | "min" | "m" => 60.0,
			"hours" | "hour" | "hrs" | "hr" | "h" => 3600.0,
			"days" | "day" | "d" => 86_400.0,
			"weeks" | "week" | "wks" | "wk" | "w" => 604_800.0,
			"months" | "month" | "M" => 2_630_016.0,
			"years" | "year" | "yrs" | "yr" | "y" => 31_557_600.0,
			"" => return Err("time unit needed, for example 5sec or 5ms".into()),
			unknown => {
				return Err(format!(
					"unknown time unit {unknown:?}, supported units: ns, us, ms, sec, min, hours, days, \
					 weeks, months, years (and few variations)"
				));
			},
		};
		span += Duration::try_from_secs_f64(number * seconds)
			.map_err(|_| "number is too large".to_owned())?;
		rest = &rest[letters..];
	}
}

fn span_seconds(text: &str) -> Result<TimeSpan, String> {
	parse_span(text, Duration::from_secs(1))
}

fn span_millis(text: &str) -> Result<TimeSpan, String> {
	parse_span(text, Duration::from_millis(1))
}

/// A time span as watchexec prints it: `10s`, `1m 30s`, `500ms`.
struct Spelled(Duration);

impl fmt::Display for Spelled {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let seconds = self.0.as_secs();
		let parts = [
			(seconds / 86_400, "d"),
			(seconds / 3600 % 24, "h"),
			(seconds / 60 % 60, "m"),
			(seconds % 60, "s"),
			(u64::from(self.0.subsec_millis()), "ms"),
		];
		let mut first = true;
		for (count, unit) in parts {
			if count == 0 {
				continue;
			}
			if !first {
				f.write_str(" ")?;
			}
			write!(f, "{count}{unit}")?;
			first = false;
		}
		if first { f.write_str("0s") } else { Ok(()) }
	}
}

fn key_value(text: &str) -> Result<(String, String), String> {
	text
		.split_once('=')
		.map(|(key, value)| (key.to_owned(), value.to_owned()))
		.ok_or_else(|| "missing = separator".to_owned())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Completions {
	Bash,
	Elvish,
	Fish,
	Nu,
	Powershell,
	Zsh,
}

impl Completions {
	/// The script watchexec 2.3.2 generates for the shell (Apache-2.0).
	const fn script(self) -> &'static str {
		match self {
			Self::Bash => include_str!("watchexec-completions-bash.txt"),
			Self::Elvish => include_str!("watchexec-completions-elvish.txt"),
			Self::Fish => include_str!("watchexec-completions-fish.txt"),
			Self::Nu => include_str!("watchexec-completions-nu.txt"),
			Self::Powershell => include_str!("watchexec-completions-powershell.txt"),
			Self::Zsh => include_str!("watchexec-completions-zsh.txt"),
		}
	}
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum OnBusy {
	Queue,
	DoNothing,
	Restart,
	Signal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Emit {
	Environment,
	Stdio,
	File,
	JsonStdio,
	JsonFile,
	None,
}

/// How the command is wrapped. The shell runs every command as a tree it
/// signals as one, whichever is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Wrap {
	Group,
	Session,
	None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Clear {
	Clear,
	Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
enum Color {
	Auto,
	Always,
	Never,
}

const COMMAND: &str = "Command";
const EVENTS: &str = "Events";
const FILTERING: &str = "Filtering";
const DEBUGGING: &str = "Debugging";
const OUTPUT: &str = "Output";

/// Execute commands when watched files change
#[derive(Parser, Debug)]
#[command(
	name = "watchexec",
	version = VERSION,
	about = "Execute commands when watched files change",
	after_help = AFTER_HELP,
	after_long_help = AFTER_LONG_HELP
)]
pub(crate) struct Watchexec {
	/// Command (program and arguments) to run on changes
	#[arg(
		trailing_var_arg = true,
		num_args = 0..,
		value_name = "COMMAND",
		required_unless_present_any = ["completions", "manual", "only_emit_events"]
	)]
	command: Vec<OsString>,

	/// Generate a shell completions script
	#[arg(long, value_name = "SHELL", conflicts_with_all = ["command", "manual"])]
	completions: Option<Completions>,

	/// Show the manual page
	#[arg(long, conflicts_with_all = ["command", "completions"])]
	manual: bool,

	/// Only emit events to stdout, run no commands
	#[arg(long, conflicts_with_all = ["command", "completions", "manual"])]
	only_emit_events: bool,

	/// Exit after the first run, with the command's status
	#[arg(short = '1', hide = true)]
	once: bool,

	/// Sleep before running the command
	#[arg(long, value_name = "DURATION", value_parser = span_seconds, help_heading = COMMAND)]
	delay_run: Option<TimeSpan>,

	/// Add env vars to the command
	#[arg(short = 'E', long, value_name = "KEY=VALUE", value_parser = key_value, help_heading = COMMAND)]
	env: Vec<(String, String)>,

	/// Shorthand for '--shell=none'
	#[arg(short = 'n', help_heading = COMMAND)]
	no_shell: bool,

	/// Don't use a shell
	#[arg(long = "no-shell", hide = true)]
	no_shell_long: bool,

	/// Don't set event environment variables
	#[arg(long, hide = true)]
	no_environment: bool,

	/// Don't use a process group
	#[arg(long, help_heading = COMMAND)]
	no_process_group: bool,

	/// Use a different shell
	#[arg(long, value_name = "SHELL", help_heading = COMMAND)]
	shell: Option<String>,

	/// Signal to send to stop the command
	#[arg(long, value_name = "SIGNAL", value_parser = parse_signal, help_heading = COMMAND)]
	stop_signal: Option<i32>,

	/// Time to wait for the command to exit gracefully
	#[arg(
		long,
		value_name = "TIMEOUT",
		value_parser = span_seconds,
		default_value = "10s",
		hide_default_value = true,
		help_heading = COMMAND
	)]
	stop_timeout: TimeSpan,

	/// Set the working directory
	#[arg(long, value_name = "DIRECTORY", help_heading = COMMAND)]
	workdir: Option<PathBuf>,

	/// Configure how the process is wrapped
	#[arg(
		long,
		value_name = "MODE",
		default_value = if cfg!(target_os = "macos") { "session" } else { "group" },
		help_heading = COMMAND
	)]
	wrap_process: Wrap,

	/// Time to wait for new events before taking action
	#[arg(
		short = 'd',
		long,
		value_name = "TIMEOUT",
		value_parser = span_millis,
		default_value = "50ms",
		hide_default_value = true,
		help_heading = EVENTS
	)]
	debounce: TimeSpan,

	/// Configure event emission
	#[arg(long, value_name = "MODE", help_heading = EVENTS)]
	emit_events_to: Option<Emit>,

	/// What to do when receiving events while the command is running
	#[arg(short = 'o', long, value_name = "MODE", help_heading = EVENTS)]
	on_busy_update: Option<OnBusy>,

	/// Poll for filesystem changes
	#[arg(
		long,
		alias = "force-poll",
		value_name = "INTERVAL",
		value_parser = span_millis,
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "30s",
		help_heading = EVENTS
	)]
	poll: Option<TimeSpan>,

	/// Wait until first change before running command
	#[arg(short = 'p', long, help_heading = EVENTS)]
	postpone: bool,

	/// Restart the process if it's still running
	#[arg(short = 'r', long, conflicts_with = "on_busy_update", help_heading = EVENTS)]
	restart: bool,

	/// Send a signal to the process when it's still running
	#[arg(
		short = 's',
		long,
		value_name = "SIGNAL",
		value_parser = parse_signal,
		conflicts_with = "restart",
		help_heading = EVENTS
	)]
	signal: Option<i32>,

	/// Exit when stdin closes
	#[arg(long, help_heading = EVENTS)]
	stdin_quit: bool,

	/// Filename extensions to filter to
	#[arg(short = 'e', long, value_name = "EXTENSIONS", value_delimiter = ',', help_heading = FILTERING)]
	exts: Vec<String>,

	/// Filename patterns to filter to
	#[arg(short = 'f', long, value_name = "PATTERN", help_heading = FILTERING)]
	filter: Vec<String>,

	/// Files to load filters from
	#[arg(long, value_name = "PATH", help_heading = FILTERING)]
	filter_file: Vec<PathBuf>,

	/// Filter programs
	#[arg(short = 'j', long, value_name = "EXPRESSION", help_heading = FILTERING)]
	filter_prog: Vec<String>,

	/// Filesystem events to filter to
	#[arg(
		long,
		value_name = "EVENTS",
		value_delimiter = ',',
		conflicts_with = "no_meta",
		help_heading = FILTERING
	)]
	fs_events: Vec<FsEvent>,

	/// Filename patterns to filter out
	#[arg(short = 'i', long, value_name = "PATTERN", help_heading = FILTERING)]
	ignore: Vec<String>,

	/// Files to load ignores from
	#[arg(long, value_name = "PATH", help_heading = FILTERING)]
	ignore_file: Vec<PathBuf>,

	/// Don't ignore anything at all
	#[arg(long, help_heading = FILTERING)]
	ignore_nothing: bool,

	/// Don't use internal default ignores
	#[arg(long, help_heading = FILTERING)]
	no_default_ignore: bool,

	/// Don't discover ignore files at all
	#[arg(long, help_heading = FILTERING)]
	no_discover_ignore: bool,

	/// Don't load global ignores
	#[arg(long, help_heading = FILTERING)]
	no_global_ignore: bool,

	/// Don't emit fs events for metadata changes
	#[arg(long, help_heading = FILTERING)]
	no_meta: bool,

	/// Don't load project-local ignores
	#[arg(long, help_heading = FILTERING)]
	no_project_ignore: bool,

	/// Don't load gitignores
	#[arg(long, alias = "no-ignore", help_heading = FILTERING)]
	no_vcs_ignore: bool,

	/// Set the project origin
	#[arg(long, value_name = "DIRECTORY", help_heading = FILTERING)]
	project_origin: Option<PathBuf>,

	/// Watch a specific file or directory
	#[arg(short = 'w', long, value_name = "PATH", help_heading = FILTERING)]
	watch: Vec<PathBuf>,

	/// Watch a specific directory, non-recursively
	#[arg(short = 'W', long, value_name = "PATH", help_heading = FILTERING)]
	watch_non_recursive: Vec<PathBuf>,

	/// Watch files and directories from a file
	#[arg(short = 'F', long, value_name = "PATH", help_heading = FILTERING)]
	watch_file: Option<PathBuf>,

	/// Write diagnostic logs to a file
	#[arg(
		long,
		value_name = "PATH",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "",
		help_heading = DEBUGGING
	)]
	log_file: Option<PathBuf>,

	/// Print events that trigger actions
	#[arg(long, help_heading = DEBUGGING)]
	print_events: bool,

	/// Set diagnostic log level
	#[arg(short = 'v', long, action = clap::ArgAction::Count, help_heading = DEBUGGING)]
	verbose: u8,

	/// Ring the terminal bell on command completion
	#[arg(long, help_heading = OUTPUT)]
	bell: bool,

	/// Clear screen before running command
	#[arg(
		short = 'c',
		long,
		value_name = "MODE",
		num_args = 0..=1,
		require_equals = true,
		default_missing_value = "clear",
		help_heading = OUTPUT
	)]
	clear: Option<Clear>,

	/// When to use terminal colours
	#[arg(long, value_name = "MODE", default_value = "auto", help_heading = OUTPUT)]
	color: Color,

	/// Alert when commands start and end
	#[arg(short = 'N', long, help_heading = OUTPUT)]
	notify: bool,

	/// Don't print starting and stopping messages
	#[arg(short = 'q', long, help_heading = OUTPUT)]
	quiet: bool,

	/// Print how long the command took to run
	#[arg(long, help_heading = OUTPUT)]
	timings: bool,
}

/// Long options that take the next argument as their value.
const LONG_VALUES: [&str; 24] = [
	"--completions",
	"--delay-run",
	"--env",
	"--shell",
	"--stop-signal",
	"--stop-timeout",
	"--workdir",
	"--wrap-process",
	"--debounce",
	"--emit-events-to",
	"--on-busy-update",
	"--signal",
	"--exts",
	"--filter",
	"--filter-file",
	"--filter-prog",
	"--fs-events",
	"--ignore",
	"--ignore-file",
	"--project-origin",
	"--watch",
	"--watch-non-recursive",
	"--watch-file",
	"--color",
];

/// Short options that take a value.
const SHORT_VALUES: &str = "EdosefjiwWF";

/// Gives `--clear`, `--poll` and `--log-file` their optional values in the
/// `--option=value` form, the one spelling that never mistakes the command's
/// first word for a value: `-c make test` clears and runs `make test`,
/// `-c reset make` resets, `--poll 5s` polls every five seconds.
fn attach_optional_values(argv: Vec<OsString>) -> Vec<OsString> {
	let is_mode = |next: &OsString| matches!(next.to_str(), Some("clear" | "reset"));
	let mut out = Vec::with_capacity(argv.len());
	let mut args = argv.into_iter();
	out.extend(args.next());
	let mut args = args.peekable();
	while let Some(arg) = args.next() {
		let text = match arg.to_str() {
			Some(text) if text != "--" && text != "-" && text.starts_with('-') => text,
			// The command starts here.
			_ => {
				out.push(arg);
				break;
			},
		};
		if text.starts_with("--") {
			match text {
				"--clear" => {
					let mode = args.next_if(is_mode);
					let mode = mode.as_ref().and_then(|mode| mode.to_str()).unwrap_or("clear");
					out.push(format!("--clear={mode}").into());
				},
				"--poll" | "--force-poll" => {
					let interval = args.next_if(|next| next.to_str().is_some_and(|next| span_millis(next).is_ok()));
					let interval = interval.as_ref().and_then(|next| next.to_str()).unwrap_or("30s");
					out.push(format!("--poll={interval}").into());
				},
				"--log-file" => {
					let mut option = OsString::from("--log-file=");
					if let Some(path) = args.next_if(|next| !next.as_encoded_bytes().starts_with(b"-")) {
						option.push(path);
					}
					out.push(option);
				},
				_ => {
					let takes_value = LONG_VALUES.contains(&text);
					out.push(arg);
					if takes_value {
						out.extend(args.next());
					}
				},
			}
			continue;
		}
		let cluster = &text[1..];
		if let Some(at) = cluster.find(|flag| SHORT_VALUES.contains(flag)) {
			// The rest of the cluster, or the next argument, is its value.
			let value_follows = at + 1 == cluster.len();
			out.push(arg);
			if value_follows {
				out.extend(args.next());
			}
			continue;
		}
		if let Some(before) = cluster.strip_suffix('c') {
			let mode = args.next_if(is_mode);
			let mode = mode.as_ref().and_then(|mode| mode.to_str()).unwrap_or("clear");
			if !before.is_empty() {
				out.push(format!("-{before}").into());
			}
			out.push(format!("--clear={mode}").into());
			continue;
		}
		out.push(arg);
	}
	out.extend(args);
	out
}

/// What the command is, as the host runs it.
enum Program {
	/// A command line of the invoking shell.
	Line(String),
	/// A program and its arguments.
	Argv(Vec<OsString>),
}

/// Splits a command given as one word for `--shell=none`: on blanks, with
/// quotes and backslashes keeping them.
fn split_words(line: &str) -> Vec<OsString> {
	let mut words = Vec::new();
	let mut word = String::new();
	let mut started = false;
	let mut quote = None;
	let mut chars = line.chars();
	while let Some(c) = chars.next() {
		match (quote, c) {
			(Some(open), c) if c == open => quote = None,
			(None, '\'' | '"') => {
				quote = Some(c);
				started = true;
			},
			(None | Some('"'), '\\') => {
				word.extend(chars.next());
				started = true;
			},
			(None, c) if c.is_whitespace() => {
				if started {
					words.push(OsString::from(std::mem::take(&mut word)));
					started = false;
				}
			},
			(_, c) => {
				word.push(c);
				started = true;
			},
		}
	}
	if started {
		words.push(OsString::from(word));
	}
	words
}

/// `word` quoted for the shell.
fn quoted(word: &str) -> String {
	let mut out = String::with_capacity(word.len() + 2);
	out.push('\'');
	for c in word.chars() {
		if c == '\'' {
			out.push_str("'\\''");
		} else {
			out.push(c);
		}
	}
	out.push('\'');
	out
}

/// Diagnostic logging (`-v`, `--log-file`): lines go to the main loop, which
/// prints them, or to the thread writing the log file.
#[derive(Clone)]
struct Log {
	/// 0 logs nothing; 1 `INFO`, 2 `DEBUG`, 3 and up `TRACE`.
	level: u8,
	json:  bool,
	lines: flume::Sender<String>,
}

impl Log {
	const INFO: u8 = 1;
	const DEBUG: u8 = 2;
	const TRACE: u8 = 3;

	fn enabled(&self, level: u8) -> bool {
		self.level >= level
	}

	fn write(&self, level: u8, message: fmt::Arguments<'_>) {
		if !self.enabled(level) {
			return;
		}
		let name = match level {
			Self::INFO => "INFO",
			Self::DEBUG => "DEBUG",
			_ => "TRACE",
		};
		let time = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ");
		let line = if self.json {
			format!(
				"{{\"timestamp\":\"{time}\",\"level\":\"{name}\",\"fields\":{{\"message\":{}}},\"target\":\"\
				 watchexec\"}}\n",
				serde_json::Value::String(message.to_string())
			)
		} else {
			format!("{time} {name:>5} watchexec: {message}\n")
		};
		let _ = self.lines.send(line);
	}
}

/// What the watcher's thread sends the main loop.
enum Message {
	/// Events that passed the filters, in the order they happened.
	Changes(Vec<Change>),
	/// The watch ended on its own.
	Failed(io::Error),
}

/// The command, running.
struct Job {
	/// Resolves once the command ended.
	ended:   BoxFuture<'static, io::Result<CommandStatus>>,
	signals: flume::Sender<i32>,
	started: Instant,
	/// The events file of `--emit-events-to=file`, removed with the job.
	_events: Option<tempfile::NamedTempFile>,
}

/// Everything decided before the first run.
struct Plan {
	/// `None` with `--only-emit-events`.
	program:      Option<Program>,
	/// The command as `[Running: …]` shows it.
	display:      String,
	workdir:      Option<PathBuf>,
	env:          Vec<(String, String)>,
	emit:         Emit,
	on_busy:      OnBusy,
	/// What `--on-busy-update=signal` sends.
	signal:       i32,
	stop_signal:  i32,
	stop_timeout: Duration,
	/// How long events are gathered, from the first, before they are acted on.
	debounce:     Duration,
	delay_run:    Duration,
	filter_progs: Vec<String>,
	postpone:     bool,
	once:         bool,
	quiet:        bool,
	timings:      bool,
	bell:         bool,
	notify:       bool,
	clear:        Option<Clear>,
	color:        bool,
	print_events: bool,
	stdin_quit:   bool,
	verbose:      bool,
}

/// A failure that ends watchexec before or while it watches.
struct Fatal(String);

impl From<io::Error> for Fatal {
	fn from(error: io::Error) -> Self {
		Self(error.to_string())
	}
}

impl AsyncUtility for Watchexec {
	const NAME: &'static str = "watchexec";
	const RUNS_COMMANDS: bool = true;
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(attach_optional_values(argv))
	}

	async fn run(self, host: &mut Host) -> i32 {
		let this = match self.with_argfile(host).await {
			Ok(this) => this,
			Err(code) => return code,
		};
		if let Some(shell) = this.completions {
			let _ = host.stdout_writer().write_all(shell.script().as_bytes());
			return 0;
		}
		if this.manual {
			let _ = host.stdout_writer().write_all(MANUAL.as_bytes());
			return 0;
		}
		match this.watch(host).await {
			Ok(code) => code,
			Err(Fatal(message)) => {
				let _ = writeln!(host.stderr, "Error:   \u{d7} {message}\n");
				1
			},
		}
	}
}

impl Watchexec {
	/// Replaces a leading `@argfile` with the arguments in that file, one
	/// per line.
	async fn with_argfile(self, host: &mut Host) -> Result<Self, i32> {
		let Some(file) = self
			.command
			.first()
			.and_then(|first| first.to_str())
			.and_then(|first| first.strip_prefix('@'))
		else {
			return Ok(self);
		};
		let text = match host.vfs().read_to_string(host.resolve(file)).await {
			Ok(text) => text,
			Err(error) => {
				let _ = writeln!(host.stderr, "watchexec: {file}: {}", strip_errno(&error));
				return Err(2);
			},
		};
		let argv = std::iter::once(OsString::from(Self::NAME))
			.chain(text.lines().map(OsString::from))
			.chain(self.command[1..].iter().cloned())
			.collect();
		match Self::try_parse_from(attach_optional_values(argv)) {
			Ok(parsed) => Ok(parsed),
			Err(error) if error.use_stderr() => {
				let _ = write!(host.stderr, "{error}");
				Err(2)
			},
			Err(error) => {
				let _ = write!(host.stdout_writer(), "{error}");
				Err(0)
			},
		}
	}

	fn unitless(&self) -> bool {
		[Some(self.stop_timeout), Some(self.debounce), self.delay_run, self.poll]
			.into_iter()
			.flatten()
			.any(|span| span.unitless)
	}

	/// The command as the host runs it and as the messages show it.
	fn program(&self) -> (Option<Program>, String) {
		if self.only_emit_events {
			return (None, String::new());
		}
		let words: Vec<String> = self
			.command
			.iter()
			.map(|word| word.to_string_lossy().into_owned())
			.collect();
		let line = words.join(" ");
		let shell = self.shell.as_deref().map(str::trim);
		let program = if self.no_shell || self.no_shell_long || shell == Some("none") {
			Program::Argv(match self.command.as_slice() {
				[only] => split_words(&only.to_string_lossy()),
				command => command.to_vec(),
			})
		} else if let Some(shell) = shell.filter(|shell| !shell.is_empty()) {
			// `PROGRAM [OPTIONS] -c LINE`; the host runs a shell it knows in
			// its own engine.
			let mut argv = split_words(shell);
			let flag = if cfg!(windows) && shell.eq_ignore_ascii_case("cmd") { "/C" } else { "-c" };
			argv.extend([OsString::from(flag), OsString::from(&line)]);
			Program::Argv(argv)
		} else {
			Program::Line(line.clone())
		};
		(Some(program), line)
	}

	/// The watched paths, canonical: `(path, recursive)`. Empty when the
	/// only path is `/dev/null`.
	async fn roots(&self, host: &mut Host) -> Result<Vec<Root>, Fatal> {
		let mut named: Vec<(PathBuf, bool)> = self
			.watch
			.iter()
			.map(|path| (path.clone(), true))
			.chain(self.watch_non_recursive.iter().map(|path| (path.clone(), false)))
			.collect();
		if let Some(list) = &self.watch_file {
			let text = if list.as_os_str() == "-" {
				let mut bytes = Vec::new();
				host.read_stdin_to_end(&mut bytes, 16 << 20).await?;
				String::from_utf8_lossy(&bytes).into_owned()
			} else {
				host.vfs().read_to_string(host.resolve(list)).await?
			};
			named.extend(
				text
					.lines()
					.filter(|line| !line.is_empty())
					.map(|line| (PathBuf::from(line), true)),
			);
		}
		if let [(only, _)] = named.as_slice()
			&& only.as_os_str() == "/dev/null"
		{
			return Ok(Vec::new());
		}
		if named.is_empty() {
			named.push((PathBuf::from("."), true));
		}
		let fs = host.vfs();
		let mut roots = Vec::with_capacity(named.len());
		for (path, recursive) in named {
			let resolved = host.resolve(&path);
			if !host.fs().is_native_local(&resolved) {
				return Err(Fatal(format!("{}: not a path of the local file system", path.display())));
			}
			let path = fs.canonicalize(&resolved).await?;
			if !roots.iter().any(|root: &Root| root.path == path) {
				roots.push(Root { path, recursive });
			}
		}
		Ok(roots)
	}

	/// The lines of `--filter-file`s and `$WATCHEXEC_FILTER_FILES`, added to
	/// the `--filter` patterns.
	async fn filters(&self, host: &mut Host) -> Result<Vec<String>, Fatal> {
		let mut filters = self.filter.clone();
		let from_env = host
			.var("WATCHEXEC_FILTER_FILES")
			.map(|list| std::env::split_paths(list).collect::<Vec<_>>())
			.unwrap_or_default();
		for file in self.filter_file.iter().chain(&from_env) {
			let text = host.vfs().read_to_string(host.resolve(file)).await?;
			filters.extend(
				text
					.lines()
					.filter(|line| !line.is_empty() && !line.starts_with('#'))
					.map(str::to_owned),
			);
		}
		Ok(filters)
	}

	/// The `--filter-prog` programs, read from their files where given as
	/// `@file`.
	async fn filter_progs(&self, host: &mut Host) -> Result<Vec<String>, Fatal> {
		let mut progs = Vec::with_capacity(self.filter_prog.len());
		for prog in &self.filter_prog {
			progs.push(match prog.strip_prefix('@') {
				Some(file) => host.vfs().read_to_string(host.resolve(file)).await?,
				None => prog.clone(),
			});
		}
		Ok(progs)
	}

	async fn watch(self, host: &mut Host) -> Result<i32, Fatal> {
		if self.unitless() {
			let _ = writeln!(host.stderr, "{UNITLESS_WARNING}");
		}
		let (log_lines, logged) = flume::unbounded();
		let log = self.log(host, log_lines);
		let (program, display) = self.program();
		let workdir = self.workdir.as_ref().map(|dir| host.resolve(dir));
		let cwd = host.vfs().canonicalize(host.cwd()).await.unwrap_or_else(|_| host.cwd().to_path_buf());
		log.write(
			Log::INFO,
			format_args!("effective working directory path={:?}", workdir.as_deref().unwrap_or(&cwd)),
		);
		let roots = self.roots(host).await?;
		let filters = self.filters(host).await?;
		let filter_progs = self.filter_progs(host).await?;
		let project_origin = match &self.project_origin {
			Some(origin) => Some(host.vfs().canonicalize(host.resolve(origin)).await?),
			None => None,
		};

		let on_busy = if self.restart {
			OnBusy::Restart
		} else if let Some(mode) = self.on_busy_update {
			mode
		} else if self.signal.is_some() {
			OnBusy::Signal
		} else {
			OnBusy::DoNothing
		};
		let stop_signal = self.stop_signal.unwrap_or_else(|| signal_number("TERM"));
		let emit = match self.emit_events_to {
			Some(emit) => emit,
			None if self.only_emit_events => Emit::JsonStdio,
			None => Emit::None,
		};
		let color = match self.color {
			Color::Always => true,
			Color::Never => false,
			Color::Auto => host.var("NO_COLOR").is_none() && host.stderr.is_terminal(),
		};
		let plan = Plan {
			program,
			display,
			workdir,
			env: self.env.clone(),
			emit: if self.no_environment && emit == Emit::Environment { Emit::None } else { emit },
			on_busy,
			signal: self.signal.unwrap_or(stop_signal),
			stop_signal,
			stop_timeout: self.stop_timeout.span,
			debounce: self.debounce.span,
			delay_run: self.delay_run.map_or(Duration::ZERO, |delay| delay.span),
			filter_progs,
			postpone: self.postpone,
			once: self.once,
			quiet: self.quiet,
			timings: self.timings,
			bell: self.bell,
			notify: self.notify,
			clear: self.clear,
			color,
			print_events: self.print_events,
			stdin_quit: self.stdin_quit,
			verbose: self.verbose > 0,
		};

		let fs_events = if self.no_meta {
			vec![FsEvent::Create, FsEvent::Remove, FsEvent::Rename, FsEvent::Modify]
		} else if self.fs_events.is_empty() {
			vec![FsEvent::Create, FsEvent::Remove, FsEvent::Rename, FsEvent::Modify, FsEvent::Metadata]
		} else {
			self.fs_events.clone()
		};
		let discover = !(self.no_discover_ignore || self.ignore_nothing);
		let ignore_files = self
			.ignore_file
			.iter()
			.map(|file| host.resolve(file))
			.chain(
				host
					.var("WATCHEXEC_IGNORE_FILES")
					.into_iter()
					.flat_map(std::env::split_paths)
					.map(|file| host.resolve(file)),
			)
			.collect();
		let homes = {
			let var = |name: &str| host.var(name).map(str::to_owned);
			Homes {
				home:       var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }),
				xdg_config: var("XDG_CONFIG_HOME"),
				appdata:    var("APPDATA"),
			}
		};
		let extensions = self
			.exts
			.iter()
			.filter(|extension| !extension.is_empty())
			.map(|extension| OsString::from(extension.strip_prefix('.').unwrap_or(extension)))
			.collect();
		let default_ignore = !(self.no_default_ignore || self.ignore_nothing);
		let discovery = discover.then_some(Discovery {
			vcs:     !self.no_vcs_ignore,
			project: !self.no_project_ignore,
			global:  !self.no_global_ignore,
		});
		let ignores = self.ignore.clone();
		let blocking_fs = host.fs().clone();
		let watched: Vec<PathBuf> = roots.iter().map(|root| root.path.clone()).collect();
		// Reads ignore files and looks for project markers: blocking work.
		let filterer = tokio::task::spawn_blocking(move || {
			let fs = &blocking_fs;
			let origin = project_origin.unwrap_or_else(|| {
				let home = homes.home.as_deref().map(Path::new);
				let home = home.and_then(|home| fs.canonicalize(home).ok());
				let paths = if watched.is_empty() { std::slice::from_ref(&cwd) } else { watched.as_slice() };
				filter::project_origin(fs, paths, home.as_deref(), &cwd)
			});
			let watched_files = watched
				.iter()
				.filter(|path| fs.metadata(path).is_ok_and(|metadata| metadata.is_file()))
				.cloned()
				.collect();
			Filterer::new(fs, Settings {
				origin,
				fs_events,
				filters,
				ignores,
				extensions,
				default_ignore,
				discovery,
				ignore_files,
				watched_files,
				homes,
			})
		})
		.await
		.map_err(|error| Fatal(error.to_string()))?;
		let filterer = Arc::new(filterer);
		log.write(Log::INFO, format_args!("effective project origin path={:?}", filterer.origin()));
		log.write(Log::INFO, format_args!("effective watched paths paths={roots:?}"));

		for prog in &plan.filter_progs {
			check_filter_prog(host, prog).await?;
		}

		let (messages, received) = flume::unbounded();
		let watcher = if roots.is_empty() {
			None
		} else {
			let mut config = Config::new(roots);
			// The debounce itself is the main loop's: the system delivers a
			// large burst in pieces however long it is asked to gather.
			config.latency = self.debounce.span.min(Duration::from_millis(20));
			if let Some(interval) = self.poll {
				config.backend = Backend::Poll;
				config.poll_interval = interval.span.max(Duration::from_millis(1));
			}
			let prune = Arc::clone(&filterer);
			config.descend = Some(Box::new(move |dir| prune.watches(dir)));
			let trace = log.clone();
			let messages = messages.clone();
			let mut changes = Vec::new();
			let mut expanded = Vec::new();
			let sink = move |batch: io::Result<&pi_watch::Batch>| {
				let batch = match batch {
					Ok(batch) => batch,
					Err(error) => {
						let _ = messages.send(Message::Failed(error));
						return;
					},
				};
				for event in batch.iter() {
					Change::expand(event.path, event.flags, &mut expanded);
					for change in expanded.drain(..) {
						let passes = filterer.passes(&change);
						if trace.enabled(Log::TRACE) {
							let verdict = if passes { "pass" } else { "filtered out" };
							trace.write(Log::TRACE, format_args!("{verdict}: {change:?}"));
						}
						if passes {
							changes.push(change);
						}
					}
				}
				if !changes.is_empty() {
					let _ = messages.send(Message::Changes(std::mem::take(&mut changes)));
				}
			};
			// Starting may walk the watched trees: blocking work.
			let watcher = tokio::task::spawn_blocking(move || Watcher::start(config, sink))
				.await
				.map_err(|error| Fatal(error.to_string()))??;
			log.write(Log::INFO, format_args!("watching with {}", watcher.backend().monitor_name()));
			Some(watcher)
		};

		let code = Session {
			plan,
			log,
			logged: (!self.log_to_file()).then_some(logged),
			received,
			gathered: Vec::new(),
			pending: Vec::new(),
			job: None,
			restarting: false,
			queued: false,
			kill_at: None,
		}
		.run(host)
		.await;
		drop((watcher, messages));
		Ok(code)
	}

	fn log_to_file(&self) -> bool {
		self.log_file.is_some()
	}

	/// The logger of `-v` and `--log-file`. A log file is written by a
	/// thread of its own; without one, the main loop prints the lines.
	fn log(&self, host: &Host, lines: flume::Sender<String>) -> Log {
		let Some(path) = &self.log_file else {
			return Log { level: self.verbose, json: false, lines };
		};
		let level = if self.verbose == 0 { Log::TRACE } else { self.verbose };
		let mut path = if path.as_os_str().is_empty() { host.cwd().to_path_buf() } else { host.resolve(path) };
		let fs = host.fs().clone();
		let (lines, written) = flume::unbounded::<String>();
		std::thread::spawn(move || {
			if fs.metadata(&path).is_ok_and(|metadata| metadata.is_dir()) {
				let name = chrono::Utc::now().format("watchexec.%Y-%m-%dT%H-%M-%SZ.log");
				path.push(name.to_string());
			}
			let Ok(mut file) = fs.create(&path) else {
				return;
			};
			for line in written {
				let _ = file.write_all(line.as_bytes());
			}
		});
		Log { level, json: true, lines }
	}
}

/// Fails for a `--filter-prog` that does not compile.
async fn check_filter_prog(host: &mut Host, prog: &str) -> Result<(), Fatal> {
	let line = format!("jq -n {} >/dev/null 2>&1", quoted(&format!("({prog}) as $pass | empty")));
	match host.run_command_async(ShellCommand::line(line)).await? {
		CommandStatus::Exited(3) => Err(Fatal(format!("invalid filter program: {prog}"))),
		_ => Ok(()),
	}
}

/// What ended a wait of the main loop.
enum Wake {
	Ended(io::Result<CommandStatus>),
	Message(Message),
	/// The debounce period is over.
	Act,
	Log(String),
	Start,
	Kill,
	StdinClosed,
	/// Stdin gave data, or the watcher is gone: nothing to do.
	Idle,
}

/// Resolves at `deadline`; never without one.
async fn at(deadline: Option<Instant>) {
	match deadline {
		Some(deadline) => tokio::time::sleep_until(deadline.into()).await,
		None => std::future::pending().await,
	}
}

/// The main loop's state.
struct Session {
	plan:       Plan,
	log:        Log,
	/// Log lines to print; `None` when a file takes them.
	logged:     Option<flume::Receiver<String>>,
	received:   flume::Receiver<Message>,
	/// The events of the debounce period under way.
	gathered:   Vec<Change>,
	/// The events the next run answers.
	pending:    Vec<Change>,
	job:        Option<Job>,
	/// The command was told to stop so that it starts again.
	restarting: bool,
	/// The command runs again once it ends (`--on-busy-update=queue`).
	queued:     bool,
	/// When a command told to stop is stopped by force.
	kill_at:    Option<Instant>,
}

impl Session {
	async fn run(mut self, host: &mut Host) -> i32 {
		let mut start_at = (!self.plan.postpone && self.plan.program.is_some())
			.then(|| Instant::now() + self.plan.delay_run);
		let mut act_at = None;
		let stdin_open = self.plan.stdin_quit;
		let mut probe = [0u8; 4096];
		loop {
			let _ = host.sync_output().await;
			let wake = {
				let starting = self.job.is_none();
				let ended = async {
					match &mut self.job {
						Some(job) => (&mut job.ended).await,
						None => std::future::pending().await,
					}
				};
				let logged = async {
					match &self.logged {
						Some(logged) => logged.recv_async().await.ok(),
						None => std::future::pending().await,
					}
				};
				tokio::select! {
					biased;
					Some(line) = logged => Wake::Log(line),
					status = ended => Wake::Ended(status),
					() = at(self.kill_at) => Wake::Kill,
					() = at(act_at) => Wake::Act,
					message = self.received.recv_async() => message.map_or(Wake::Idle, Wake::Message),
					() = at(start_at), if starting => Wake::Start,
					read = host.read_stdin(&mut probe), if stdin_open => match read {
						Ok(read) if read > 0 => Wake::Idle,
						_ => Wake::StdinClosed,
					},
				}
			};
			match wake {
				Wake::Log(line) => {
					let _ = host.stderr.write_all(line.as_bytes());
				},
				Wake::Idle => {},
				Wake::Kill => {
					self.kill_at = None;
					self.signal(signal_number("KILL"));
				},
				Wake::Start => {
					start_at = None;
					if let Err(code) = self.start(host).await {
						return code;
					}
				},
				Wake::Ended(status) => {
					let Some(job) = self.job.take() else {
						continue;
					};
					self.kill_at = None;
					if std::mem::take(&mut self.restarting) {
						start_at = Some(Instant::now() + self.plan.delay_run);
						continue;
					}
					let code = self.report(host, job.started, status);
					if self.plan.once {
						return code;
					}
					if std::mem::take(&mut self.queued) {
						start_at = Some(Instant::now() + self.plan.delay_run);
					}
				},
				Wake::Message(Message::Failed(error)) => {
					let _ = writeln!(host.stderr, "Error:   \u{d7} {error}\n");
					self.stop_for_exit(host).await;
					return 1;
				},
				Wake::Message(Message::Changes(changes)) => {
					self.gathered.extend(changes);
					act_at.get_or_insert_with(|| Instant::now() + self.plan.debounce);
				},
				Wake::Act => {
					act_at = None;
					let changes = std::mem::take(&mut self.gathered);
					let changes = Self::programs_pass(&self.plan, host, changes).await;
					if changes.is_empty() {
						continue;
					}
					if self.plan.print_events {
						for (index, change) in changes.iter().enumerate() {
							let _ = writeln!(host.stderr, "{}", change.describe(index));
						}
					}
					if self.plan.program.is_none() {
						let mut text = String::new();
						write_events(self.plan.emit, &changes, &mut text);
						let _ = host.stdout_writer().write_all(text.as_bytes());
						continue;
					}
					if self.job.is_none() {
						self.pending.extend(changes);
						start_at.get_or_insert_with(|| Instant::now() + self.plan.delay_run);
						continue;
					}
					match self.plan.on_busy {
						OnBusy::DoNothing => {
							self.log.write(Log::DEBUG, format_args!("command is running, ignoring events"));
						},
						OnBusy::Queue => {
							self.pending.extend(changes);
							self.queued = true;
						},
						OnBusy::Signal => self.signal(self.plan.signal),
						OnBusy::Restart => {
							self.pending.extend(changes);
							if !std::mem::replace(&mut self.restarting, true) {
								self.stop();
							}
						},
					}
				},
				Wake::StdinClosed => {
					self.stop_for_exit(host).await;
					return 0;
				},
			}
		}
	}

	/// Sends the running command's tree a signal.
	fn signal(&self, signal: i32) {
		if let Some(job) = &self.job {
			self.log.write(Log::INFO, format_args!("sending signal {signal} to the command"));
			let _ = job.signals.send(signal);
		}
	}

	/// Asks the running command to stop, and stops it by force once the stop
	/// timeout passed; at once when that is zero.
	fn stop(&mut self) {
		if self.plan.stop_timeout.is_zero() {
			self.signal(signal_number("KILL"));
		} else {
			self.signal(self.plan.stop_signal);
			self.kill_at = Some(Instant::now() + self.plan.stop_timeout);
		}
	}

	/// Stops the running command before watchexec exits and waits for it.
	async fn stop_for_exit(&mut self, host: &mut Host) {
		let _ = writeln!(
			host.stderr,
			"[Waiting {} for processes to exit before stopping...]",
			Spelled(self.plan.stop_timeout)
		);
		let _ = host.sync_output().await;
		let Some(mut job) = self.job.take() else {
			return;
		};
		let _ = job.signals.send(if self.plan.stop_timeout.is_zero() {
			signal_number("KILL")
		} else {
			self.plan.stop_signal
		});
		if tokio::time::timeout(self.plan.stop_timeout, &mut job.ended)
			.await
			.is_err()
		{
			let _ = job.signals.send(signal_number("KILL"));
			let _ = job.ended.await;
		}
	}

	/// Runs the `--filter-prog` programs over the events: each is `jq` on the
	/// event's JSON, and an event passes when every program's first output is
	/// true.
	async fn programs_pass(plan: &Plan, host: &mut Host, mut changes: Vec<Change>) -> Vec<Change> {
		for prog in &plan.filter_progs {
			let quiet = if plan.verbose { "" } else { " 2>&1" };
			let line = format!("jq -e {} >/dev/null{quiet}", quoted(&format!("first({prog})")));
			let mut kept = Vec::with_capacity(changes.len());
			for change in changes {
				let mut json = String::new();
				change.write_json(&mut json);
				let Ok(input) = stdin_file(json).await else {
					continue;
				};
				let command = ShellCommand::line(line.clone()).stdin(input);
				if matches!(host.run_command_async(command).await, Ok(status) if status.success()) {
					kept.push(change);
				}
			}
			changes = kept;
		}
		changes
	}

	/// Starts the command for the pending events. `Err` is watchexec's exit
	/// status when it cannot go on.
	async fn start(&mut self, host: &mut Host) -> Result<(), i32> {
		let changes = std::mem::take(&mut self.pending);
		let plan = &self.plan;
		let Some(program) = &plan.program else {
			return Ok(());
		};
		if host.stdout.is_terminal() {
			let _ = host.stdout_writer().write_all(match plan.clear {
				Some(Clear::Clear) => b"\x1b[2J\x1b[3J\x1b[H".as_slice(),
				Some(Clear::Reset) => b"\x1bc",
				None => b"",
			});
		}
		if !plan.quiet {
			announce(host, plan.color, GREEN, format_args!("Running: {}", plan.display));
		}
		if plan.notify {
			notify(host, "Watchexec: change detected", format!("Running {}", plan.display));
		}
		let mut command = match program {
			Program::Line(line) => ShellCommand::line(line),
			Program::Argv(argv) => ShellCommand::new(argv.clone()),
		};
		if let Some(dir) = &plan.workdir {
			command = command.current_dir(dir);
		}
		for (name, value) in &plan.env {
			command = command.env(name, value);
		}
		let mut events_file = None;
		let mut stdin = None;
		match plan.emit {
			Emit::None => {},
			Emit::Environment => {
				for (name, value) in events::environment(&changes) {
					command = command.env(name, value);
				}
			},
			Emit::Stdio | Emit::JsonStdio => {
				let mut text = String::new();
				write_events(plan.emit, &changes, &mut text);
				stdin = stdin_file(text).await.ok();
			},
			Emit::File | Emit::JsonFile => {
				let mut text = String::new();
				write_events(plan.emit, &changes, &mut text);
				let written = tokio::task::spawn_blocking(move || {
					let mut file = tempfile::NamedTempFile::new()?;
					file.write_all(text.as_bytes())?;
					file.flush()?;
					Ok::<_, io::Error>(file)
				})
				.await;
				if let Ok(Ok(file)) = written {
					command = command.env("WATCHEXEC_EVENTS_FILE", file.path().to_string_lossy());
					events_file = Some(file);
				}
			},
		}
		// The command reads what watchexec's own input offers, unless
		// watchexec reads it itself.
		if stdin.is_none() && !plan.stdin_quit && !matches!(plan.emit, Emit::Stdio | Emit::JsonStdio) {
			stdin = host.stdin.file().to_fd().ok();
		}
		if let Some(stdin) = stdin {
			command = command.stdin(stdin);
		}
		let (signals, receiver) = flume::unbounded();
		let started = Instant::now();
		match host.spawn_command_async(command.signals(receiver)).await {
			Ok(running) => {
				self.job = Some(Job { ended: Box::pin(running.wait()), signals, started, _events: events_file });
				Ok(())
			},
			// The shell cancelled watchexec.
			Err(error) if error.kind() == io::ErrorKind::Interrupted => Err(130),
			Err(error) => {
				let _ = writeln!(host.stderr, "watchexec: {}", strip_errno(&error));
				Err(1)
			},
		}
	}

	/// Prints how the command ended; returns the status a shell would report.
	fn report(&self, host: &mut Host, started: Instant, status: io::Result<CommandStatus>) -> i32 {
		let plan = &self.plan;
		let (message, color, code) = match status {
			Ok(CommandStatus::Exited(0)) => ("Command was successful".to_owned(), GREEN, 0),
			Ok(CommandStatus::Exited(code)) => {
				(format!("Command exited with {code}"), RED, i32::from(code))
			},
			Ok(status @ CommandStatus::Signaled(signal)) => {
				(format!("Command killed by {}", KilledBy(signal)), MAGENTA, status.code())
			},
			Err(error) => {
				// The program could not be run at all.
				let (code, name) = match error.kind() {
					io::ErrorKind::NotFound => (127, "command not found"),
					io::ErrorKind::PermissionDenied => (126, "permission denied"),
					_ => (1, ""),
				};
				let program = plan.display.split(' ').next().unwrap_or_default();
				let reason = if name.is_empty() { strip_errno(&error) } else { name.to_owned() };
				let _ = writeln!(host.stderr, "watchexec: {program}: {reason}");
				(format!("Command exited with {code}"), RED, code)
			},
		};
		if !plan.quiet {
			if plan.timings {
				announce(host, plan.color, color, format_args!("{message}, lasted {:?}", started.elapsed()));
			} else {
				announce(host, plan.color, color, format_args!("{message}"));
			}
		}
		if plan.bell {
			let _ = host.stdout_writer().write_all(b"\x07");
		}
		if plan.notify {
			notify(host, "Watchexec: command ended", message);
		}
		code
	}
}

const RED: u8 = 31;
const GREEN: u8 = 32;
const MAGENTA: u8 = 35;

/// Prints one of watchexec's bracketed messages to stderr.
fn announce(host: &mut Host, colored: bool, color: u8, message: fmt::Arguments<'_>) {
	let _ = if colored {
		write!(host.stderr, "\x1b[0m\x1b[0m\x1b[{color}m[{message}]\n\x1b[0m")
	} else {
		writeln!(host.stderr, "[{message}]")
	};
}

/// The events in the form `emit` hands them to a command.
fn write_events(emit: Emit, changes: &[Change], out: &mut String) {
	for change in changes {
		match emit {
			Emit::Stdio | Emit::File => change.write_text(out),
			_ => change.write_json(out),
		}
	}
}

/// A file holding `text`, positioned at its start, for a command's stdin.
async fn stdin_file(text: String) -> io::Result<Fd> {
	tokio::task::spawn_blocking(move || {
		let mut file = tempfile::tempfile()?;
		file.write_all(text.as_bytes())?;
		file.rewind()?;
		Ok(Fd::File(file))
	})
	.await
	.map_err(io::Error::other)?
}

/// Shows a desktop notification where the system has a program for it.
fn notify(host: &Host, title: &'static str, body: String) {
	let (program, arguments): (&str, Vec<String>) = if cfg!(target_os = "macos") {
		let script = format!(
			"display notification {} with title {}",
			serde_json::Value::String(body),
			serde_json::Value::String(title.to_owned())
		);
		("/usr/bin/osascript", vec!["-e".to_owned(), script])
	} else if cfg!(unix) {
		("notify-send", vec![title.to_owned(), body])
	} else {
		return;
	};
	let Ok(mut command) = host.child_env().command(program) else {
		return;
	};
	command
		.args(arguments)
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null());
	// Spawned and reaped off the runtime; a missing notifier is not an error.
	std::thread::spawn(move || {
		if let Ok(mut child) = command.spawn() {
			let _ = child.wait();
		}
	});
}
