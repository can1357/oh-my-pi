//! `env` builtin: run a command in a modified environment, or print the
//! environment.
//!
//! Options stop at the first operand, `-S`
//! replaces its argument with the split string and parses the options again
//! (so the split may carry options, assignments, and the command), the only
//! expansion is `${VARNAME}`, `--env0-from` takes the place of uutils' `-f`,
//! and the environment prints shell-quoted. The command runs through the
//! shell's own dispatch ([`Host::run_command`]), so builtins run in-process;
//! its environment changes live only in the worker subshell that runs it.
//!
//! Signal options cannot change the host process's dispositions or mask,
//! which every other command shares. A command starts with an empty signal
//! mask and default handling, except for signals the host process ignores
//! (`SIGPIPE` excepted, which children get back at its default), so `env`
//! behaves as GNU `env` does when `sigaction`/`sigprocmask` fail for any
//! change that would need more: `--default-signal` and `--ignore-signal`
//! succeed where the command already gets that handling and otherwise fail
//! with "Operation not supported" (ignored for the all-signals forms, as GNU
//! ignores those failures); `--block-signal` of a blockable signal fails;
//! `--list-signal-handling` lists what the command inherits.

use std::{
	collections::HashMap,
	ffi::OsString,
	io::{self, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use uucore::{
	display::Quotable,
	i18n::UEncoding,
	quoting_style::{QuotingStyle, escape_name},
};

use crate::{
	host::{Host, ShellCommand, Utility, format_usage, os_bytes_lossy, strip_errno, util},
	locale,
	quoting_style::quoting_style_by_name,
};

/// `env` itself failed.
const EXIT_CANCELED: i32 = 125;
/// The command was found but could not be invoked.
const EXIT_CANNOT_INVOKE: i32 = 126;
/// The command was not found.
const EXIT_ENOENT: i32 = 127;
/// Status of a command interrupted by the shell.
const EXIT_INTERRUPTED: i32 = 130;

/// The C locale's `isspace` characters: separators in `-S` strings and, as
/// short options, the sign of a mis-written shebang line.
const C_ISSPACE_CHARS: &[u8] = b" \t\n\x0b\x0c\r";

/// The value a signal option written without `=SIG` holds: no command-line
/// argument can contain a NUL byte, so no `=SIG` can spell it.
const ALL_SIGNALS: &str = "\0";

mod options {
	pub const IGNORE_ENVIRONMENT: &str = "ignore-environment";
	pub const CHDIR: &str = "chdir";
	pub const NULL: &str = "null";
	pub const ENV0_FROM: &str = "env0-from";
	pub const UNSET: &str = "unset";
	pub const DEBUG: &str = "debug";
	pub const SPLIT_STRING: &str = "split-string";
	pub const ARGV0: &str = "argv0";
	pub const IGNORE_SIGNAL: &str = "ignore-signal";
	pub const DEFAULT_SIGNAL: &str = "default-signal";
	pub const BLOCK_SIGNAL: &str = "block-signal";
	pub const LIST_SIGNAL_HANDLING: &str = "list-signal-handling";
	pub const VARS: &str = "vars";
}

const AFTER_HELP: &str = "\
A mere - implies -i.  If no COMMAND, print the resulting environment.

SIG may be a signal name like 'PIPE', or a signal number like '13'.
Without SIG, all known signals are included.  Multiple signals can be
comma-separated.  An empty SIG argument is a no-op.

Exit status:
  125  if the env command itself fails
  126  if COMMAND is found but cannot be invoked
  127  if COMMAND cannot be found
  -    the exit status of COMMAND otherwise";

/// Parsed `env` invocation.
///
/// A command line using `-S` is kept raw: the split string expands
/// `${VARNAME}` from the shell's environment, which only [`Utility::run`]
/// sees, and the options are parsed once it has been replaced.
pub(crate) struct Env {
	parsed: Parsed,
}

enum Parsed {
	Matches(ArgMatches),
	SplitString(Vec<OsString>),
}

impl clap::FromArgMatches for Env {
	fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { parsed: Parsed::Matches(matches.clone()) })
	}

	fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
		self.parsed = Parsed::Matches(matches.clone());
		Ok(())
	}
}

impl clap::CommandFactory for Env {
	fn command() -> Command {
		app()
	}

	fn command_for_update() -> Command {
		app()
	}
}

impl clap::Parser for Env {
	fn try_parse_from<I, T>(itr: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = T>,
		T: Into<OsString> + Clone,
	{
		let argv: Vec<OsString> = itr.into_iter().map(Into::into).collect();
		if matches!(scan_options(&argv), Some(Found::SplitString(_))) {
			return Ok(Self { parsed: Parsed::SplitString(argv) });
		}
		app()
			.try_get_matches_from(argv)
			.map(|matches| Self { parsed: Parsed::Matches(matches) })
	}
}

impl Utility for Env {
	const NAME: &'static str = "env";
	const RUNS_COMMANDS: bool = true;
	const USAGE_ERROR: u8 = 125;

	/// Rejects a whitespace character used as a short option, the sign of a
	/// shebang line passing options without `-S` (`#!/usr/bin/env -i cmd`).
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		match scan_options(&argv) {
			Some(Found::Space(c)) => Err(shebang_error(c)),
			_ => Ok(argv),
		}
	}

	fn run(self, host: &mut Host) -> i32 {
		let utf8 = locale::ctype_is_utf8(host);
		let mut run = Run { host, utf8, debug: false };
		let matches = match self.parsed {
			Parsed::Matches(matches) => Ok(matches),
			Parsed::SplitString(argv) => run.expand_split_strings(argv),
		};
		match matches.and_then(|matches| run.main(&matches)) {
			Ok(code) | Err(code) => code,
		}
	}
}

/// The `env` argument model.
fn app() -> Command {
	let signal = |id: &'static str, help: &'static str| {
		Arg::new(id)
			.long(id)
			.value_name("SIG")
			.num_args(0..=1)
			.require_equals(true)
			.action(ArgAction::Append)
			.default_missing_value(ALL_SIGNALS)
			.value_parser(ValueParser::os_string())
			.help(help)
	};
	Command::new(Env::NAME)
		.version("0.8.0")
		.about("Set each NAME to VALUE in the environment and run COMMAND.")
		.override_usage(format_usage("env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]"))
		.after_help(AFTER_HELP)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::ARGV0)
				.short('a')
				.long(options::ARGV0)
				.value_name("ARG")
				.value_parser(ValueParser::os_string())
				.help("pass ARG as the zeroth argument of COMMAND"),
		)
		.arg(
			Arg::new(options::IGNORE_ENVIRONMENT)
				.short('i')
				.long(options::IGNORE_ENVIRONMENT)
				.action(ArgAction::SetTrue)
				.help("start with an empty environment"),
		)
		.arg(
			Arg::new(options::ENV0_FROM)
				.long(options::ENV0_FROM)
				.value_name("FILE")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::FilePath)
				.help("read NUL-delimited environment entries from FILE"),
		)
		.arg(
			Arg::new(options::NULL)
				.short('0')
				.long(options::NULL)
				.action(ArgAction::SetTrue)
				.help("end each output line with NUL, not newline"),
		)
		.arg(
			Arg::new(options::UNSET)
				.short('u')
				.long(options::UNSET)
				.value_name("NAME")
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.help("remove variable from the environment"),
		)
		.arg(
			Arg::new(options::CHDIR)
				.short('C')
				.long(options::CHDIR)
				.value_name("DIR")
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::DirPath)
				.help("change working directory to DIR"),
		)
		.arg(
			// Replaced before parsing (see `Run::expand_split_strings`); listed
			// for the help text.
			Arg::new(options::SPLIT_STRING)
				.short('S')
				.long(options::SPLIT_STRING)
				.value_name("S")
				.value_parser(ValueParser::os_string())
				.help(
					"process and split S into separate arguments; used to pass multiple arguments on \
					 shebang lines",
				),
		)
		.arg(signal(options::BLOCK_SIGNAL, "block delivery of SIG signal(s) to COMMAND"))
		.arg(signal(options::DEFAULT_SIGNAL, "reset handling of SIG signal(s) to the default"))
		.arg(signal(options::IGNORE_SIGNAL, "set handling of SIG signal(s) to do nothing"))
		.arg(
			Arg::new(options::LIST_SIGNAL_HANDLING)
				.long(options::LIST_SIGNAL_HANDLING)
				.action(ArgAction::SetTrue)
				.help("list non default signal handling to standard error"),
		)
		.arg(
			Arg::new(options::DEBUG)
				.short('v')
				.long(options::DEBUG)
				.action(ArgAction::Count)
				.help("print verbose information for each processing step"),
		)
		.arg(
			Arg::new(options::VARS)
				.value_name("NAME=VALUE")
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.num_args(1..)
				.trailing_var_arg(true),
		)
}

/// Creates the `env` builtin registration.
pub(crate) fn env_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Env, SE>()
}

/// The message for a whitespace character used as a short option.
fn shebang_error(c: u8) -> String {
	format!(
		"invalid option -- {}\n{}: use -[v]S to pass options in shebang lines\nTry '{} --help' for \
		 more information.",
		os_string(&[c]).quote(),
		Env::NAME,
		Env::NAME,
	)
}

/// What [`scan_options`] stopped at.
enum Found {
	SplitString(SplitString),
	/// A whitespace character used as a short option.
	Space(u8),
}

/// A `-S` among the options: words `index..index + words` of `argv` hold
/// it, `prefix` the options clustered before it (`-v` of `-vS…`), and `debug`
/// whether `--debug` came first.
struct SplitString {
	index:  usize,
	words:  usize,
	prefix: Option<OsString>,
	string: Vec<u8>,
	debug:  bool,
}

/// Long options and whether each takes a separate value word.
const LONG_OPTIONS: [(&str, bool); 14] = [
	(options::ARGV0, true),
	(options::IGNORE_ENVIRONMENT, false),
	(options::ENV0_FROM, true),
	(options::NULL, false),
	(options::UNSET, true),
	(options::CHDIR, true),
	(options::DEFAULT_SIGNAL, false),
	(options::IGNORE_SIGNAL, false),
	(options::BLOCK_SIGNAL, false),
	(options::LIST_SIGNAL_HANDLING, false),
	(options::DEBUG, false),
	(options::SPLIT_STRING, true),
	("help", false),
	("version", false),
];

/// The long option `name` spells, in full or as an unambiguous prefix.
fn long_option(name: &[u8]) -> Option<(&'static str, bool)> {
	if let Some(&option) = LONG_OPTIONS
		.iter()
		.find(|(long, _)| long.as_bytes() == name)
	{
		return Some(option);
	}
	let mut candidates = LONG_OPTIONS
		.iter()
		.filter(|(long, _)| long.as_bytes().starts_with(name));
	let first = *candidates.next()?;
	candidates.next().is_none().then_some(first)
}

/// Walks the options of `argv` (they end at the first operand) for the first
/// `-S` or whitespace short option.
fn scan_options(argv: &[OsString]) -> Option<Found> {
	let mut debug = false;
	let mut index = 1;
	while let Some(word) = argv.get(index) {
		let bytes = os_bytes_lossy(word);
		if bytes.as_ref() == b"--" || bytes.len() < 2 || bytes[0] != b'-' {
			return None;
		}
		let next = argv
			.get(index + 1)
			.map(|word| os_bytes_lossy(word).into_owned());
		if let Some(long) = bytes.strip_prefix(b"--") {
			let (name, value) = match memchr::memchr(b'=', long) {
				Some(eq) => (&long[..eq], Some(&long[eq + 1..])),
				None => (long, None),
			};
			match long_option(name) {
				Some((options::SPLIT_STRING, _)) => {
					let (string, words) = match value {
						Some(value) => (value.to_vec(), 1),
						None => (next?, 2),
					};
					let found = SplitString { index, words, prefix: None, string, debug };
					return Some(Found::SplitString(found));
				},
				Some((options::DEBUG, _)) => debug = true,
				Some((_, true)) if value.is_none() => index += 1,
				_ => {},
			}
			index += 1;
			continue;
		}
		for (at, &c) in bytes.iter().enumerate().skip(1) {
			let rest = &bytes[at + 1..];
			match c {
				b'S' => {
					let (string, words) = if rest.is_empty() {
						(next?, 2)
					} else {
						(rest.to_vec(), 1)
					};
					let prefix = (at > 1).then(|| os_string(&bytes[..at]));
					let found = SplitString { index, words, prefix, string, debug };
					return Some(Found::SplitString(found));
				},
				b'a' | b'C' | b'u' => {
					if rest.is_empty() {
						index += 1;
					}
					break;
				},
				b'v' => debug = true,
				c if C_ISSPACE_CHARS.contains(&c) => return Some(Found::Space(c)),
				_ => {},
			}
		}
		index += 1;
	}
	None
}

/// The exit status `env` stops with; the diagnostic is already written.
type Exit = i32;

/// One `env` invocation in progress.
struct Run<'h> {
	host:  &'h mut Host,
	/// Whether the shell's `LC_CTYPE` is UTF-8, which decides whether
	/// non-ASCII characters print as-is.
	utf8:  bool,
	debug: bool,
}

/// Signal option occurrences in command-line order.
#[derive(Clone, Copy)]
enum SignalOption {
	Default,
	Ignore,
	Block,
}

impl Run<'_> {
	fn main(&mut self, matches: &ArgMatches) -> Result<Exit, Exit> {
		self.debug |= matches.get_count(options::DEBUG) > 0;
		let bytes = |id: &str| {
			matches
				.get_one::<OsString>(id)
				.map(|value| os_bytes_lossy(value).into_owned())
		};
		let mut ignore_environment = matches.get_flag(options::IGNORE_ENVIRONMENT);
		let null = matches.get_flag(options::NULL);
		let newdir = bytes(options::CHDIR);
		let env0_from = bytes(options::ENV0_FROM);
		let argv0 = bytes(options::ARGV0);
		let unset: Vec<Vec<u8>> = matches
			.get_many::<OsString>(options::UNSET)
			.into_iter()
			.flatten()
			.map(|name| os_bytes_lossy(name).into_owned())
			.collect();
		let signals = self.parse_signal_options(matches)?;

		let argv: Vec<Vec<u8>> = matches
			.get_many::<OsString>(options::VARS)
			.into_iter()
			.flatten()
			.map(|arg| os_bytes_lossy(arg).into_owned())
			.collect();
		let mut optind = 0;
		if argv.first().is_some_and(|arg| arg == b"-") {
			ignore_environment = true;
			optind += 1;
		}

		let style = if null {
			QuotingStyle::Literal { show_control: true }
		} else {
			self.output_style()
		};

		let initial = self.initial_environment();
		let mut env: Vec<Vec<u8>> = Vec::new();
		if ignore_environment {
			self.vmsg("clearing environment\n");
			if let Some(file) = &env0_from {
				env = self.read_env_file(file)?;
			}
		} else {
			env = initial
				.iter()
				.map(|(name, value)| entry(name, value))
				.collect();
			if let Some(file) = &env0_from {
				self.merge_env_file(&mut env, file)?;
			}
		}
		if !ignore_environment || env0_from.is_some() {
			for name in &unset {
				self.debug_quoted("unsetting: ", name);
				if name.is_empty() || name.contains(&b'=') {
					let message = format!("cannot unset {}: Invalid argument", quote(name));
					return Err(self.die(&message));
				}
				env.retain(|entry| entry_name(entry) != Some(name.as_slice()));
			}
		}
		while let Some(assignment) = argv.get(optind).filter(|arg| arg.contains(&b'=')) {
			self.debug_quoted("setting:   ", assignment);
			set_entry(&mut env, assignment.clone());
			optind += 1;
		}

		let program_specified = optind < argv.len();
		if null && program_specified {
			return Err(self.usage("cannot specify --null (-0) with command"));
		}
		if newdir.is_some() && !program_specified {
			return Err(self.usage("must specify command with --chdir (-C)"));
		}
		if argv0.is_some() && !program_specified {
			return Err(self.usage("must specify command with --argv0 (-a)"));
		}
		if !program_specified {
			return self.print_environment(&env, style, if null { b'\0' } else { b'\n' });
		}

		let mut signals = signals;
		self.reset_signal_handlers(&mut signals)?;
		if signals.mask_changed {
			self.set_signal_mask(&signals)?;
		}
		if matches.get_flag(options::LIST_SIGNAL_HANDLING) {
			self.list_signal_handling(&signals);
		}

		let mut command_args = argv[optind..].to_vec();
		let program = command_args[0].clone();
		let mut command = ShellCommand::new(command_args.iter().map(|arg| os_string(arg)).collect());
		if let Some(dir) = &newdir {
			self.debug_quoted("change dir: ", dir);
			let resolved = self.change_dir(dir)?;
			command = command.current_dir(resolved);
		}
		if let Some(argv0) = &argv0 {
			self.debug_quoted("argv0:     ", argv0);
			command = command.argv0(os_string(argv0));
			command_args[0].clone_from(argv0);
		}
		if self.debug {
			self.debug_quoted("executing: ", &program);
			for (index, arg) in command_args.iter().enumerate() {
				self.vmsg(&format!("   arg[{index}]= {}\n", quote(arg)));
			}
		}

		command = environment_changes(command, &initial, &env, ignore_environment);
		if newdir.is_some() {
			// `chdir` leaves the environment alone, but the worker's change of
			// directory updates these.
			command = keep_directory_variables(command, &env);
		}
		if let Ok(stdin) = self.host.stdin.file().try_clone() {
			command = command.stdin(stdin);
		}
		match self.host.run_command(command) {
			Ok(status) => Ok(status.code()),
			Err(error) => {
				let (code, text) = match error.kind() {
					io::ErrorKind::Interrupted => return Err(EXIT_INTERRUPTED),
					io::ErrorKind::NotFound => (EXIT_ENOENT, "No such file or directory".to_owned()),
					io::ErrorKind::PermissionDenied => {
						(EXIT_CANNOT_INVOKE, "Permission denied".to_owned())
					},
					_ => (EXIT_CANNOT_INVOKE, strip_errno(&error)),
				};
				self.error(&format!("{}: {text}", quote(&program)));
				if code == EXIT_ENOENT && program.iter().any(|byte| C_ISSPACE_CHARS.contains(byte)) {
					self.error("use -[v]S to pass options in shebang lines");
				}
				Err(code)
			},
		}
	}

	/// Replaces every `-S` among the options with its split, as GNU's
	/// `getopt` rescan does, then parses the result.
	fn expand_split_strings(&mut self, mut argv: Vec<OsString>) -> Result<ArgMatches, Exit> {
		loop {
			if self.host.is_cancelled() {
				return Err(EXIT_INTERRUPTED);
			}
			let split = match scan_options(&argv) {
				None => break,
				Some(Found::Space(c)) => {
					self.error(&shebang_error(c));
					return Err(EXIT_CANCELED);
				},
				Some(Found::SplitString(split)) => split,
			};
			self.debug = split.debug;
			let words = self.build_argv(&split.string)?;
			if self.debug && !words.is_empty() {
				self.debug_quoted("split -S:  ", &split.string);
				self.debug_quoted(" into:     ", &words[0]);
				for word in &words[1..] {
					self.debug_quoted("     &     ", word);
				}
			}
			let rest = argv.split_off(split.index + split.words);
			argv.truncate(split.index);
			argv.extend(split.prefix);
			argv.extend(words.iter().map(|word| os_string(word)));
			argv.extend(rest);
		}
		app().try_get_matches_from(argv).map_err(|error| {
			// As the shared adapter renders parse results.
			let rendered = error.to_string();
			if error.use_stderr() {
				let _ = self.host.stderr.write_all(rendered.as_bytes());
				EXIT_CANCELED
			} else {
				let _ = self.host.stdout.write_all(rendered.as_bytes());
				0
			}
		})
	}

	/// The exported environment `env` starts from, in name order: the shell
	/// keeps no `environ` order to preserve.
	fn initial_environment(&self) -> Vec<(String, String)> {
		let mut initial: Vec<(String, String)> = self
			.host
			.env()
			.map(|(name, value)| (name.to_owned(), value.to_owned()))
			.collect();
		initial.sort_unstable();
		initial
	}

	/// The quoting style for printed entries: `QUOTING_STYLE`, else
	/// shell-escape.
	fn output_style(&mut self) -> QuotingStyle {
		let default = QuotingStyle::SHELL_ESCAPE.show_control(true);
		let Some(value) = self.host.var("QUOTING_STYLE").map(str::to_owned) else {
			return default;
		};
		if let Some(style) = quoting_style_by_name(&value) {
			return style;
		}
		self.error(&format!(
			"ignoring invalid value of environment variable QUOTING_STYLE: {}",
			value.quote()
		));
		default
	}

	/// Writes `env` as `env` with no command does.
	fn print_environment(
		&mut self,
		env: &[Vec<u8>],
		style: QuotingStyle,
		terminator: u8,
	) -> Result<Exit, Exit> {
		let encoding = if self.utf8 {
			UEncoding::Utf8
		} else {
			UEncoding::Ascii
		};
		let escape =
			|text: &[u8]| os_bytes_lossy(&escape_name(&os_string(text), style, encoding)).into_owned();
		let mut out = self.host.stdout_writer();
		let mut written = Ok(());
		for entry in env {
			let mut line = Vec::with_capacity(entry.len() + 3);
			if matches!(style, QuotingStyle::Literal { .. }) {
				line.extend(entry);
			} else {
				let (name, value) = match memchr::memchr(b'=', entry) {
					Some(eq) => (&entry[..eq], Some(&entry[eq + 1..])),
					None => (entry.as_slice(), None),
				};
				line.extend(escape(name));
				if let Some(value) = value {
					line.push(b'=');
					// "VAR=" rather than "VAR=''".
					if !value.is_empty() {
						line.extend(escape(value));
					}
				}
			}
			line.push(terminator);
			written = out.write_all(&line);
			if written.is_err() || self.host.is_cancelled() {
				break;
			}
		}
		if let Err(error) = written.and_then(|()| out.flush()) {
			return Err(self.die(&format!("write error: {}", strip_errno(&error))));
		}
		Ok(0)
	}

	/// Splits a `-S` string into arguments: quotes, backslash escapes, `#`
	/// comments, and `${VARNAME}` from the environment `env` started with.
	///
	/// uutils' splitter also expands `$VAR` and `${VAR:-default}` and reports
	/// positions; GNU accepts neither form, so this follows GNU.
	fn build_argv(&mut self, string: &[u8]) -> Result<Vec<Vec<u8>>, Exit> {
		fn start_arg(args: &mut Vec<Vec<u8>>, sep: &mut bool) {
			if *sep {
				args.push(Vec::new());
				*sep = false;
			}
		}

		let mut args: Vec<Vec<u8>> = Vec::new();
		let (mut dq, mut sq, mut sep) = (false, false, true);
		let mut i = 0;
		while i < string.len() {
			let mut newc = string[i];
			match newc {
				b'\'' if !dq => {
					sq = !sq;
					start_arg(&mut args, &mut sep);
					i += 1;
					continue;
				},
				b'"' if !sq => {
					dq = !dq;
					start_arg(&mut args, &mut sep);
					i += 1;
					continue;
				},
				c if C_ISSPACE_CHARS.contains(&c) && !(sq || dq) => {
					sep = true;
					while string.get(i).is_some_and(|c| C_ISSPACE_CHARS.contains(c)) {
						i += 1;
					}
					continue;
				},
				// '#' starting an argument comments out the rest.
				b'#' if sep => return Ok(args),
				b'\\' if !(sq && !matches!(string.get(i + 1), Some(b'\\' | b'\''))) => {
					i += 1;
					let Some(&escaped) = string.get(i) else {
						return Err(self.die("invalid backslash at end of string in -S"));
					};
					newc = match escaped {
						b'"' | b'#' | b'$' | b'\'' | b'\\' => escaped,
						b'_' if !dq => {
							i += 1;
							sep = true;
							continue;
						},
						b'_' => b' ',
						b'c' if dq => {
							return Err(self.die("'\\c' must not appear in double-quoted -S string"));
						},
						b'c' => return Ok(args),
						b'f' => b'\x0c',
						b'n' => b'\n',
						b'r' => b'\r',
						b't' => b'\t',
						b'v' => b'\x0b',
						other => {
							let message =
								format!("invalid sequence '\\{}' in -S", String::from_utf8_lossy(&[other]));
							return Err(self.die(&message));
						},
					};
				},
				b'$' if !sq => {
					let Some(name) = scan_varname(&string[i..]) else {
						let message = format!(
							"only ${{VARNAME}} expansion is supported, error at: {}",
							String::from_utf8_lossy(&string[i..])
						);
						return Err(self.die(&message));
					};
					let name = String::from_utf8_lossy(name).into_owned();
					match self.host.var(&name).map(str::to_owned) {
						Some(value) => {
							start_arg(&mut args, &mut sep);
							self.vmsg(&format!("expanding ${{{name}}} into {}\n", value.quote()));
							args.last_mut().expect("started").extend(value.as_bytes());
						},
						None => self.vmsg(&format!("replacing ${{{name}}} with empty string\n")),
					}
					// Past "${", the name, and "}".
					i += name.len() + 3;
					continue;
				},
				_ => {},
			}
			start_arg(&mut args, &mut sep);
			args.last_mut().expect("started").push(newc);
			i += 1;
		}
		if dq || sq {
			return Err(self.die("no terminating quote in -S string"));
		}
		Ok(args)
	}

	/// Reads `--env0-from` entries: NUL-terminated, from a file or `-`
	/// (standard input).
	fn read_env_file(&mut self, file: &[u8]) -> Result<Vec<Vec<u8>>, Exit> {
		let read = if file == b"-" {
			let mut data = Vec::new();
			self.host.stdin.read_to_end(&mut data).map(|_| data)
		} else {
			let path = self.host.resolve(os_string(file));
			self.host.fs().read(path)
		};
		let data = match read {
			Ok(data) => data,
			Err(error) => {
				let message = format!("cannot read {}: {}", quote(file), strip_errno(&error));
				return Err(self.die(&message));
			},
		};
		match data.split_last() {
			None => Ok(Vec::new()),
			Some((&0, entries)) => Ok(entries
				.split(|&byte| byte == 0)
				.map(<[u8]>::to_vec)
				.collect()),
			Some(_) => {
				let message =
					format!("{}: file must end with a NUL byte", os_string(file).maybe_quote());
				Err(self.die(&message))
			},
		}
	}

	/// Merges `--env0-from` entries into `env`: an assignment replaces the
	/// first entry of its name, anything else is appended.
	fn merge_env_file(&mut self, env: &mut Vec<Vec<u8>>, file: &[u8]) -> Result<(), Exit> {
		for entry in self.read_env_file(file)? {
			if entry.contains(&b'=') {
				self.debug_quoted("setting:   ", &entry);
				set_entry(env, entry);
			} else {
				self.debug_quoted("adding:    ", &entry);
				env.push(entry);
			}
		}
		Ok(())
	}

	/// Checks `-C DIR` as `chdir` would and returns it resolved against the
	/// shell's working directory.
	fn change_dir(&mut self, dir: &[u8]) -> Result<std::path::PathBuf, Exit> {
		let resolved = self.host.resolve(os_string(dir));
		let checked = self.host.fs().metadata(&resolved).and_then(|metadata| {
			if !metadata.is_dir() {
				return Err(io::Error::from(io::ErrorKind::NotADirectory));
			}
			#[cfg(unix)]
			self.host.fs().access(&resolved, false, false, true)?;
			Ok(())
		});
		match checked {
			Ok(()) => Ok(resolved),
			Err(error) => {
				let text = match error.kind() {
					io::ErrorKind::NotADirectory => "Not a directory".to_owned(),
					_ => strip_errno(&error),
				};
				let message = format!("cannot change directory to {}: {text}", quote(dir));
				Err(self.die(&message))
			},
		}
	}

	// Signals.

	/// Applies the signal options in command-line order: a later option
	/// overrides an earlier one for the same signal.
	fn parse_signal_options(&mut self, matches: &ArgMatches) -> Result<Signals, Exit> {
		let mut occurrences: Vec<(usize, SignalOption, Option<Vec<u8>>)> = Vec::new();
		for (id, option) in [
			(options::DEFAULT_SIGNAL, SignalOption::Default),
			(options::IGNORE_SIGNAL, SignalOption::Ignore),
			(options::BLOCK_SIGNAL, SignalOption::Block),
		] {
			let (Some(indices), Some(values)) =
				(matches.indices_of(id), matches.get_many::<OsString>(id))
			else {
				continue;
			};
			for (index, value) in indices.zip(values) {
				let value = (value != ALL_SIGNALS).then(|| os_bytes_lossy(value).into_owned());
				occurrences.push((index, option, value));
			}
		}
		occurrences.sort_by_key(|&(index, ..)| index);

		let mut signals = Signals::new();
		for (_, option, value) in occurrences {
			let value = value.as_deref();
			match option {
				SignalOption::Default => {
					self.parse_signal_action(&mut signals, value, true)?;
					self.parse_block_signal(&mut signals, value, false)?;
				},
				SignalOption::Ignore => self.parse_signal_action(&mut signals, value, false)?,
				SignalOption::Block => self.parse_block_signal(&mut signals, value, true)?,
			}
		}
		Ok(signals)
	}

	fn parse_signal_action(
		&mut self,
		signals: &mut Signals,
		arg: Option<&[u8]>,
		set_default: bool,
	) -> Result<(), Exit> {
		let Some(arg) = arg else {
			// Some signals cannot be changed; failures for "all" are ignored.
			let mode = if set_default {
				Mode::DefaultNoErr
			} else {
				Mode::IgnoreNoErr
			};
			signals.modes[1..].fill(mode);
			return Ok(());
		};
		for operand in arg
			.split(|&byte| byte == b',')
			.filter(|operand| !operand.is_empty())
		{
			let signum = self.operand2sig(operand)?;
			signals.modes[signum] = if set_default {
				Mode::Default
			} else {
				Mode::Ignore
			};
		}
		Ok(())
	}

	fn parse_block_signal(
		&mut self,
		signals: &mut Signals,
		arg: Option<&[u8]>,
		block: bool,
	) -> Result<(), Exit> {
		match arg {
			None => {
				let (filled, emptied) = if block {
					(&mut signals.block, &mut signals.unblock)
				} else {
					(&mut signals.unblock, &mut signals.block)
				};
				for (signum, member) in filled.iter_mut().enumerate() {
					*member = signum != 0 && !sig::is_internal(signum);
				}
				emptied.fill(false);
			},
			Some(_) if !signals.mask_changed => {
				signals.block.fill(false);
				signals.unblock.fill(false);
			},
			Some(_) => {},
		}
		signals.mask_changed = true;
		let Some(arg) = arg else {
			return Ok(());
		};
		for operand in arg
			.split(|&byte| byte == b',')
			.filter(|operand| !operand.is_empty())
		{
			let signum = self.operand2sig(operand)?;
			if sig::is_internal(signum) {
				// `sigaddset` refuses the C library's own signals.
				if block {
					return Err(self.die(&format!("failed to block signal {signum}: Invalid argument")));
				}
				continue;
			}
			let (added, removed) = if block {
				(&mut signals.block, &mut signals.unblock)
			} else {
				(&mut signals.unblock, &mut signals.block)
			};
			added[signum] = true;
			removed[signum] = false;
		}
		Ok(())
	}

	/// Parses a signal operand, rejecting signal 0 as GNU `env` does.
	fn operand2sig(&mut self, operand: &[u8]) -> Result<usize, Exit> {
		match sig::operand2sig(operand) {
			Some(signum) if signum != 0 => Ok(signum),
			_ => Err(self.usage(&format!("{}: invalid signal", quote(operand)))),
		}
	}

	/// Applies `--default-signal`/`--ignore-signal` to what the command will
	/// inherit; see the module documentation.
	fn reset_signal_handlers(&mut self, signals: &mut Signals) -> Result<(), Exit> {
		for signum in 1..signals.modes.len() {
			let mode = signals.modes[signum];
			if mode == Mode::Unchanged {
				continue;
			}
			let ignore_errors = matches!(mode, Mode::DefaultNoErr | Mode::IgnoreNoErr);
			let to_default = matches!(mode, Mode::Default | Mode::DefaultNoErr);
			let failure = match sig::inherited_ignore(signum) {
				Err(error) => Some(("get", strip_errno(&error))),
				Ok(ignored) => match sig::change_error(signum, ignored, !to_default) {
					Some(error) => Some(("set", error)),
					None => {
						signals.ignored[signum] = Some(!to_default);
						None
					},
				},
			};
			if let Some((step, error)) = &failure
				&& !ignore_errors
			{
				let message = format!("failed to {step} signal action for signal {signum}: {error}");
				return Err(self.die(&message));
			}
			if self.debug {
				let message = format!(
					"Reset signal {} ({signum}) to {}{}\n",
					sig::name(signum),
					if to_default { "DEFAULT" } else { "IGNORE" },
					if failure.is_some() {
						" (failure ignored)"
					} else {
						""
					},
				);
				self.vmsg(&message);
			}
		}
		Ok(())
	}

	/// Applies `--block-signal`/`--default-signal` to the command's signal
	/// mask, which starts empty and cannot gain a blockable signal.
	fn set_signal_mask(&mut self, signals: &Signals) -> Result<(), Exit> {
		let mut blocks = false;
		for signum in 1..signals.block.len() {
			let action = if signals.block[signum] {
				blocks |= !sig::is_unblockable(signum);
				"BLOCK"
			} else if signals.unblock[signum] {
				"UNBLOCK"
			} else {
				continue;
			};
			if self.debug {
				let message = format!("signal {} ({signum}) mask set to {action}\n", sig::name(signum));
				self.vmsg(&message);
			}
		}
		if blocks {
			return Err(self.die("failed to set signal process mask: Operation not supported"));
		}
		Ok(())
	}

	/// Lists, on stderr, the signals the command will have ignored (it has
	/// none blocked).
	fn list_signal_handling(&mut self, signals: &Signals) {
		for signum in 1..signals.ignored.len() {
			let Ok(inherited) = sig::inherited_ignore(signum) else {
				continue;
			};
			if signals.ignored[signum].unwrap_or(inherited) {
				let line = format!("{:<10} ({signum:>2}): IGNORE\n", sig::name(signum));
				let _ = self.host.stderr.write_all(line.as_bytes());
			}
		}
	}

	// Diagnostics.

	/// Writes a `--debug` message.
	fn vmsg(&mut self, message: &str) {
		if self.debug {
			let _ = self.host.stderr.write_all(message.as_bytes());
		}
	}

	/// Writes a `--debug` message `prefix` + quoted `arg`.
	fn debug_quoted(&mut self, prefix: &str, arg: &[u8]) {
		if self.debug {
			self.vmsg(&format!("{prefix}{}\n", quote(arg)));
		}
	}

	/// Writes `env: <message>`.
	fn error(&mut self, message: &str) {
		let line = format!("{}: {message}\n", self.host.name());
		let _ = self.host.stderr.write_all(line.as_bytes());
	}

	/// Writes `env: <message>` and gives the status `env` fails with.
	fn die(&mut self, message: &str) -> Exit {
		self.error(message);
		EXIT_CANCELED
	}

	/// Writes `env: <message>` and a pointer to `--help`.
	fn usage(&mut self, message: &str) -> Exit {
		self.host.usage_error(message, EXIT_CANCELED)
	}
}

/// The environment changes taking the shell's exported `initial` variables
/// to `env`. Entries without `=` cannot be variables and are dropped; of
/// several with one name the first counts, as `getenv` finds it.
fn environment_changes(
	mut command: ShellCommand,
	initial: &[(String, String)],
	env: &[Vec<u8>],
	cleared: bool,
) -> ShellCommand {
	let mut wanted: Vec<(String, String)> = Vec::with_capacity(env.len());
	for entry in env {
		let Some(eq) = memchr::memchr(b'=', entry) else {
			continue;
		};
		let name = String::from_utf8_lossy(&entry[..eq]).into_owned();
		if wanted.iter().all(|(seen, _)| *seen != name) {
			wanted.push((name, String::from_utf8_lossy(&entry[eq + 1..]).into_owned()));
		}
	}
	if cleared {
		command = command.env_clear();
		for (name, value) in wanted {
			command = command.env(name, value);
		}
		return command;
	}
	let wanted_values: HashMap<&str, &str> = wanted
		.iter()
		.map(|(name, value)| (name.as_str(), value.as_str()))
		.collect();
	for (name, _) in initial {
		if !wanted_values.contains_key(name.as_str()) {
			command = command.env_remove(name.as_str());
		}
	}
	let initial: HashMap<&str, &str> = initial
		.iter()
		.map(|(name, value)| (name.as_str(), value.as_str()))
		.collect();
	for (name, value) in &wanted {
		if initial.get(name.as_str()) != Some(&value.as_str()) {
			command = command.env(name.as_str(), value.as_str());
		}
	}
	command
}

/// Pins `PWD` and `OLDPWD` to their values in `env` (or their absence).
fn keep_directory_variables(mut command: ShellCommand, env: &[Vec<u8>]) -> ShellCommand {
	for name in ["PWD", "OLDPWD"] {
		match env
			.iter()
			.find(|entry| entry_name(entry) == Some(name.as_bytes()))
		{
			Some(entry) => {
				let value = String::from_utf8_lossy(&entry[name.len() + 1..]).into_owned();
				command = command.env(name, value);
			},
			None => command = command.env_remove(name),
		}
	}
	command
}

/// `NAME=VALUE` as an environment entry.
fn entry(name: &str, value: &str) -> Vec<u8> {
	let mut entry = Vec::with_capacity(name.len() + value.len() + 1);
	entry.extend(name.as_bytes());
	entry.push(b'=');
	entry.extend(value.as_bytes());
	entry
}

/// The name of an assignment entry; `None` for an entry without `=`.
fn entry_name(entry: &[u8]) -> Option<&[u8]> {
	memchr::memchr(b'=', entry).map(|eq| &entry[..eq])
}

/// Sets `assignment` as `putenv` does: replacing the first entry of its
/// name, else appending.
fn set_entry(env: &mut Vec<Vec<u8>>, assignment: Vec<u8>) {
	let name = entry_name(&assignment).expect("assignments contain '='");
	match env.iter().position(|entry| entry_name(entry) == Some(name)) {
		Some(index) => env[index] = assignment,
		None => env.push(assignment),
	}
}

/// The `VARNAME` of a `${VARNAME}` at the start of `string` (which begins
/// with `$`): a letter or underscore, then letters, digits, underscores.
fn scan_varname(string: &[u8]) -> Option<&[u8]> {
	let rest = string.strip_prefix(b"${")?;
	if !rest
		.first()
		.is_some_and(|c| c.is_ascii_alphabetic() || *c == b'_')
	{
		return None;
	}
	let len = rest
		.iter()
		.position(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))?;
	(rest[len] == b'}').then_some(&rest[..len])
}

/// `bytes` quoted for a diagnostic.
fn quote(bytes: &[u8]) -> String {
	os_string(bytes).quote().to_string()
}

/// `bytes` as an argument; lossy only where the platform's strings cannot
/// hold them (the bytes came from `os_bytes_lossy`, so never in practice).
fn os_string(bytes: &[u8]) -> OsString {
	uucore::os_string_from_vec(bytes.to_vec())
		.unwrap_or_else(|_| String::from_utf8_lossy(bytes).into_owned().into())
}

// Signal bookkeeping.

/// The requested handling for one signal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Unchanged,
	Default,
	/// From the all-signals form: failures are ignored.
	DefaultNoErr,
	Ignore,
	IgnoreNoErr,
}

/// Signal options, indexed by signal number up to [`sig::bound`].
struct Signals {
	modes:        Vec<Mode>,
	block:        Vec<bool>,
	unblock:      Vec<bool>,
	mask_changed: bool,
	/// Handling changed successfully: whether the command ignores it.
	ignored:      Vec<Option<bool>>,
}

impl Signals {
	fn new() -> Self {
		let len = sig::bound() + 1;
		Self {
			modes:        vec![Mode::Unchanged; len],
			block:        vec![false; len],
			unblock:      vec![false; len],
			mask_changed: false,
			ignored:      vec![None; len],
		}
	}
}

/// Signal names and numbers from `uucore::signals`, and what a command
/// started by the shell inherits.
#[cfg(unix)]
mod sig {
	use std::io;

	use uucore::signals::{
		signal_by_name_or_value, signal_list_name_by_value, signal_number_upper_bound,
	};

	/// `SIGNUM_BOUND`: the largest signal number.
	pub(super) fn bound() -> usize {
		signal_number_upper_bound()
	}

	/// Signals between the classic ones and `SIGRTMIN` that the C library
	/// keeps for itself (glibc's 32 and 33): `sigfillset` leaves them out
	/// and `sigaddset` refuses them.
	pub(super) fn is_internal(signum: usize) -> bool {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		{
			signum > 31 && signum < libc::SIGRTMIN() as usize
		}
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		{
			let _ = signum;
			false
		}
	}

	/// The signal's name, falling back to `SIG<n>` as `sig2str` callers do.
	pub(super) fn name(signum: usize) -> String {
		signal_list_name_by_value(signum).unwrap_or_else(|| format!("SIG{signum}"))
	}

	/// A signal name (any case, optional `SIG` prefix) or number; as GNU
	/// `operand2sig` reads `$?`, a status above 128 names its signal. `None`
	/// when invalid; may return 0, which callers reject.
	pub(super) fn operand2sig(operand: &[u8]) -> Option<usize> {
		let operand = std::str::from_utf8(operand).ok()?;
		if operand.starts_with(|c: char| c.is_ascii_digit()) {
			let number: u32 = operand.parse().ok()?;
			let signum = number & if number >= 0xff { 0xff } else { 0x7f };
			let signum = usize::try_from(signum).ok()?;
			return (signum <= bound()).then_some(signum);
		}
		signal_by_name_or_value(operand)
	}

	/// Whether the kernel refuses to change the handling of `signum`.
	pub(super) fn is_unblockable(signum: usize) -> bool {
		signum == libc::SIGKILL as usize || signum == libc::SIGSTOP as usize
	}

	/// Whether a command the shell starts ignores `signum`: an external
	/// program inherits the host process's ignored signals, except `SIGPIPE`,
	/// which the process launcher resets to its default. The query fails as
	/// `sigaction` fails for a signal the system will not report.
	pub(super) fn inherited_ignore(signum: usize) -> io::Result<bool> {
		let signal =
			libc::c_int::try_from(signum).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
		// SAFETY: a query: no new action is installed, and `old` is a valid,
		// writable `sigaction` for the call.
		let ignored = unsafe {
			let mut old: libc::sigaction = std::mem::zeroed();
			if libc::sigaction(signal, std::ptr::null(), &raw mut old) != 0 {
				return Err(io::Error::last_os_error());
			}
			old.sa_sigaction == libc::SIG_IGN
		};
		Ok(ignored && signal != libc::SIGPIPE)
	}

	/// Why the command's handling of `signum` cannot change from ignored
	/// (`ignored`) to `ignore`; `None` when it already is that.
	pub(super) fn change_error(signum: usize, ignored: bool, ignore: bool) -> Option<String> {
		if is_unblockable(signum) {
			return Some("Invalid argument".to_owned());
		}
		(ignored != ignore).then(|| "Operation not supported".to_owned())
	}
}

/// Without POSIX signals no `SIG` names a signal: every signal operand is
/// invalid, and the all-signals forms change nothing.
#[cfg(not(unix))]
mod sig {
	use std::io;

	pub(super) const fn bound() -> usize {
		0
	}

	pub(super) const fn is_internal(_: usize) -> bool {
		false
	}

	pub(super) fn name(signum: usize) -> String {
		format!("SIG{signum}")
	}

	pub(super) const fn operand2sig(_: &[u8]) -> Option<usize> {
		None
	}

	pub(super) const fn is_unblockable(_: usize) -> bool {
		false
	}

	pub(super) const fn inherited_ignore(_: usize) -> io::Result<bool> {
		Ok(false)
	}

	pub(super) const fn change_error(_: usize, _: bool, _: bool) -> Option<String> {
		None
	}
}

#[cfg(test)]
mod tests {
	use std::{ffi::OsString, io::Write, path::Path};

	use crate::host::{Host, ShellCommand, Utility, run_script};

	/// Runs `script` in a real shell from `cwd`, in the C locale unless the
	/// script sets its own.
	async fn sh(script: &str) -> (i32, String, String) {
		sh_in(script, &std::env::temp_dir()).await
	}

	async fn sh_in(script: &str, cwd: &Path) -> (i32, String, String) {
		run_script(&format!("export LC_ALL=C\n{script}"), "", cwd).await
	}

	#[tokio::test]
	async fn ignore_environment_runs_command_with_only_assignments() {
		let (code, out, err) = sh("env -i FOO=1 env").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "FOO=1\n", ""));
		// Printed in environment order: assignments append.
		let (code, out, _) = sh("env - FOO=1 BAR='x y'").await;
		assert_eq!((code, out.as_str()), (0, "FOO=1\nBAR='x y'\n"));
		let (code, out, _) = sh("env -i -i A=1").await;
		assert_eq!((code, out.as_str()), (0, "A=1\n"));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn external_command_sees_only_the_changed_environment() {
		let (code, out, err) =
			sh("export HOME=/h; env -i FOO=1 /bin/sh -c 'echo $FOO ${HOME-unset}'").await;
		assert_eq!((code, out.as_str(), err.as_str()), (0, "1 unset\n", ""));
		let (code, out, _) = sh("export HOME=/h; env -u HOME /bin/sh -c 'echo ${HOME-unset}'").await;
		assert_eq!((code, out.as_str()), (0, "unset\n"));
	}

	#[tokio::test]
	async fn assignments_reach_builtin_commands() {
		let (code, out, _) = sh("env FOO=bar env | grep '^FOO='").await;
		assert_eq!((code, out.as_str()), (0, "FOO=bar\n"));
		let (code, out, _) = sh("export X=1; env -u X env | grep -c '^X=' ; true").await;
		assert_eq!((code, out.as_str()), (0, "0\n"));
	}

	/// Options end at the first operand: the rest belongs to the command.
	#[tokio::test]
	async fn options_stop_at_the_first_operand() {
		let (code, _, err) = sh("env -i A=1 env -i B=2 -u A env").await;
		assert_eq!((code, err.as_str()), (127, "env: '-u': No such file or directory\n"));
		let (code, out, _) = sh("env -i A=1 printf '%s,' -i -u; echo").await;
		assert_eq!((code, out.as_str()), (0, "-i,-u,\n"));
	}

	/// Runs `env` four times through [`Host::run_command`], alternating
	/// commands with and without environment changes; sequential commands
	/// share one reused worker subshell.
	#[derive(clap::Parser)]
	struct FourRuns {}

	impl Utility for FourRuns {
		const NAME: &'static str = "four-runs";
		const RUNS_COMMANDS: bool = true;

		fn run(self, host: &mut Host) -> i32 {
			let env = || ShellCommand::new(vec![OsString::from("env")]);
			let runs = [
				env()
					.env_remove("DROP")
					.env("KEEP", "changed")
					.env("NEW", "n"),
				env(),
				env().env_clear().env("ONLY", "1"),
				env(),
			];
			for command in runs {
				let _ = writeln!(host.stdout, "--");
				if !host
					.run_command(command)
					.is_ok_and(|status| status.success())
				{
					return 1;
				}
			}
			0
		}
	}

	/// Contract: changes apply to that one command only; the next command
	/// run by the same reused worker, and the invoking shell, see the
	/// original environment.
	#[tokio::test]
	async fn changes_do_not_leak_into_later_commands() {
		use std::io::{Read, Seek};

		use brush_core::{
			ProfileLoadBehavior, RcLoadBehavior, Shell, SourceInfo,
			openfiles::{OpenFile, OpenFiles},
		};

		use crate::{
			factory::{BuiltinSet, default_builtins, utility_builtins},
			host::util,
		};

		let mut shell = Shell::builder()
			.profile(ProfileLoadBehavior::Skip)
			.rc(RcLoadBehavior::Skip)
			.builtins(default_builtins(BuiltinSet::BashMode))
			.build()
			.await
			.unwrap();
		for (name, builtin) in utility_builtins() {
			shell.register_builtin(name, builtin);
		}
		shell.register_builtin("four-runs", util::<FourRuns, _>());
		let mut output = tempfile::tempfile().unwrap();
		let mut params = shell.default_exec_params();
		params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().unwrap()));
		let script = "export KEEP=k DROP=d; four-runs; env -u KEEP true; env";
		let result = shell
			.run_string(script, &SourceInfo::from("test"), &params)
			.await
			.unwrap();
		assert_eq!(u8::from(result.exit_code), 0);

		let mut text = String::new();
		output.rewind().unwrap();
		output.read_to_string(&mut text).unwrap();
		let relevant: Vec<&str> = text
			.lines()
			.filter(|line| {
				*line == "--"
					|| ["KEEP=", "DROP=", "NEW=", "ONLY="]
						.iter()
						.any(|p| line.starts_with(p))
			})
			.collect();
		assert_eq!(relevant, [
			"--",
			"KEEP=changed",
			"NEW=n",
			"--",
			"DROP=d",
			"KEEP=k",
			"--",
			"ONLY=1",
			"--",
			"DROP=d",
			"KEEP=k",
			"DROP=d",
			"KEEP=k",
		]);
	}

	#[tokio::test]
	async fn env_running_env_twice_sees_each_layer() {
		let (code, out, _) = sh("env -i A=1 env B=2 env").await;
		assert_eq!((code, out.as_str()), (0, "A=1\nB=2\n"));
		let (code, out, _) = sh("env -i A=1 env -u A B=2 env").await;
		assert_eq!((code, out.as_str()), (0, "B=2\n"));
	}

	#[tokio::test]
	async fn chdir_runs_command_in_directory() {
		let dir = tempfile::tempdir().unwrap();
		let target = dir.path().join("sub");
		std::fs::create_dir(&target).unwrap();
		let (code, out, err) = sh_in("env -C sub pwd; pwd", dir.path()).await;
		assert_eq!(err, "");
		assert_eq!(code, 0);
		assert_eq!(out, format!("{}\n{}\n", target.display(), dir.path().display()));
		// As `chdir` does, -C leaves PWD as it was. Literal style: a Windows
		// path's backslashes would otherwise print shell-quoted.
		let script = "export QUOTING_STYLE=literal; env -C sub env | grep '^PWD='";
		let (code, out, _) = sh_in(script, dir.path()).await;
		assert_eq!((code, out), (0, format!("PWD={}\n", dir.path().display())));
	}

	#[tokio::test]
	async fn chdir_failures_exit_125() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("file"), "").unwrap();
		let (code, _, err) = sh_in("env -C nonexist true", dir.path()).await;
		assert_eq!(code, 125);
		assert_eq!(err, "env: cannot change directory to 'nonexist': No such file or directory\n");
		let (code, _, err) = sh_in("env -C file true", dir.path()).await;
		assert_eq!(code, 125);
		assert_eq!(err, "env: cannot change directory to 'file': Not a directory\n");
		let (code, _, err) = sh_in("env -C sub", dir.path()).await;
		assert_eq!(code, 125);
		assert_eq!(
			err,
			"env: must specify command with --chdir (-C)\nTry 'env --help' for more information.\n"
		);
	}

	#[tokio::test]
	async fn split_string_splits_quotes_and_expands() {
		let (code, out, _) = sh("env -S 'echo a  b'").await;
		assert_eq!((code, out.as_str()), (0, "a b\n"));
		let (code, out, _) =
			sh(r#"export V='v w'; env -S "printf %s| 'x y' \"\${V}\"\_z\tq #c" ; echo"#).await;
		assert_eq!((code, out.as_str()), (0, "x y|v w|z\tq|\n"));
		let (code, out, _) = sh(r#"env -S"-i A=1 env" ; env -S 'printf [%s] a\cb' ; echo"#).await;
		assert_eq!((code, out.as_str()), (0, "A=1\n[a]\n"));
		// The split replaces only the -S argument; later operands follow.
		let (code, out, _) = sh("env -S'printf %s,' a b; echo").await;
		assert_eq!((code, out.as_str()), (0, "a,b,\n"));
		// Options the split carries are parsed; an assignment ends them.
		let (code, out, _) = sh("env -i --split-string='A=1 printf %s,' -i; echo").await;
		assert_eq!((code, out.as_str()), (0, "-i,\n"));
		let (code, out, _) = sh("env -iS'B=2 -u' A=1; env -i -vS 'C=3' 2>/dev/null").await;
		assert_eq!((code, out.as_str()), (0, "C=3\n"));
	}

	#[tokio::test]
	async fn split_string_errors_exit_125() {
		let cases = [
			(r"env -S 'echo a\q'", "env: invalid sequence '\\q' in -S\n"),
			(r#"env -S 'echo "a\c"'"#, "env: '\\c' must not appear in double-quoted -S string\n"),
			(r"env -S 'echo a\'", "env: invalid backslash at end of string in -S\n"),
			(r#"env -S 'echo "a'"#, "env: no terminating quote in -S string\n"),
			(r"env -S 'echo $HOME'", "env: only ${VARNAME} expansion is supported, error at: $HOME\n"),
		];
		for (script, want) in cases {
			let (code, out, err) = sh(script).await;
			assert_eq!((code, out.as_str(), err.as_str()), (125, "", want), "{script}");
		}
	}

	#[tokio::test]
	async fn missing_and_unrunnable_commands() {
		let (code, _, err) = sh("env nonexistent-command-xyz").await;
		assert_eq!(code, 127);
		assert_eq!(err, "env: 'nonexistent-command-xyz': No such file or directory\n");
		let (code, _, err) = sh("env 'a b'").await;
		assert_eq!(code, 127);
		assert_eq!(
			err,
			"env: 'a b': No such file or directory\nenv: use -[v]S to pass options in shebang lines\n"
		);
		#[cfg(unix)]
		{
			let (code, _, err) = sh("env /").await;
			assert_eq!((code, err.as_str()), (126, "env: '/': Permission denied\n"));
		}
	}

	#[tokio::test]
	async fn command_status_and_stdin_pass_through() {
		let (code, ..) = sh("env sh -c 'exit 3'").await;
		assert_eq!(code, 3);
		let (code, out, _) = sh("echo piped | env cat").await;
		assert_eq!((code, out.as_str()), (0, "piped\n"));
	}

	#[tokio::test]
	async fn null_output_and_its_conflict_with_a_command() {
		let (code, out, _) = sh("env -0 -i A='x y' B=").await;
		assert_eq!((code, out.as_str()), (0, "A=x y\0B=\0"));
		let (code, _, err) = sh("env -0 true").await;
		assert_eq!(code, 125);
		assert_eq!(
			err,
			"env: cannot specify --null (-0) with command\nTry 'env --help' for more information.\n"
		);
	}

	#[tokio::test]
	async fn printed_values_are_shell_quoted_per_quoting_style() {
		let (code, out, _) = sh("env -i 'A=b c' X= 'S=a#' 'D=$x'").await;
		assert_eq!((code, out.as_str()), (0, "A='b c'\nX=\nS=a#\nD='$x'\n"));
		let (_, out, _) = sh("QUOTING_STYLE=literal env -i 'A=b c'").await;
		assert_eq!(out, "A=b c\n");
		let (_, out, _) = sh("QUOTING_STYLE=c env -i 'A=b c'").await;
		assert_eq!(out, "\"A\"=\"b c\"\n");
		let (_, out, err) = sh("QUOTING_STYLE=sh env -i 'A=b c'").await;
		assert_eq!(out, "A='b c'\n");
		assert_eq!(err, "env: ignoring invalid value of environment variable QUOTING_STYLE: 'sh'\n");
	}

	/// Contract: usage errors exit 125 with nothing on stdout; a whitespace
	/// short option (a shebang line without -S) also suggests -S.
	#[tokio::test]
	async fn usage_errors_exit_125() {
		for script in ["env -x", "env --foo=bar", "env -u", "env --unset", "env --null=x", "env --de"]
		{
			let (code, out, err) = sh(script).await;
			assert_eq!((code, out.as_str()), (125, ""), "{script}");
			assert!(err.starts_with("error: "), "{script}: {err}");
		}
		let (code, _, err) = sh("env '-i true'").await;
		assert_eq!(code, 125);
		assert_eq!(
			err,
			"env: invalid option -- ' '\nenv: use -[v]S to pass options in shebang lines\nTry 'env \
			 --help' for more information.\n"
		);
		for (script, want) in [
			("env --ignore-signal=FOO true", "env: 'FOO': invalid signal\n"),
			("env --block-signal=0 true", "env: '0': invalid signal\n"),
		] {
			let (code, _, err) = sh(script).await;
			assert_eq!(code, 125, "{script}");
			assert_eq!(err, format!("{want}Try 'env --help' for more information.\n"), "{script}");
		}
	}

	#[tokio::test]
	async fn unset_rejects_invalid_names() {
		let (code, _, err) = sh("env -u A=B true").await;
		assert_eq!((code, err.as_str()), (125, "env: cannot unset 'A=B': Invalid argument\n"));
		let (code, _, err) = sh("env -u '' true").await;
		assert_eq!((code, err.as_str()), (125, "env: cannot unset '': Invalid argument\n"));
	}

	#[tokio::test]
	async fn double_dash_and_abbreviations() {
		let (code, out, _) = sh("env --ignore-e -- A=1").await;
		assert_eq!((code, out.as_str()), (0, "A=1\n"));
		let (code, out, _) = sh("env -i -- -i 2>&1; echo $?").await;
		assert_eq!((code, out.as_str()), (0, "env: '-i': No such file or directory\n127\n"));
	}

	#[tokio::test]
	async fn debug_traces_each_step() {
		let (code, _, err) = sh("export V=x; env -v -i -a zz -S 'A=1 true ${V} ${NOPE}' y").await;
		assert_eq!(code, 0);
		assert_eq!(
			err,
			"expanding ${V} into 'x'\nreplacing ${NOPE} with empty string\nsplit -S:  'A=1 true ${V} \
			 ${NOPE}'\n into:     'A=1'\n     &     'true'\n     &     'x'\nclearing \
			 environment\nsetting:   'A=1'\nargv0:     'zz'\nexecuting: 'true'\n   arg[0]= 'zz'\n   \
			 arg[1]= 'x'\n   arg[2]= 'y'\n"
		);
	}

	#[tokio::test]
	async fn env0_from_file_merges_entries() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("vars"), b"A=1\0B=x y\0A=2\0").unwrap();
		let (code, out, _) = sh_in("env -i --env0-from=vars", dir.path()).await;
		assert_eq!((code, out.as_str()), (0, "A=1\nB='x y'\nA=2\n"));
		let (code, out, _) = sh_in("env -i --env0-from=vars -u A C=3 env", dir.path()).await;
		assert_eq!((code, out.as_str()), (0, "B='x y'\nC=3\n"));
		std::fs::write(dir.path().join("bad"), b"A=1").unwrap();
		let (code, _, err) = sh_in("env --env0-from=bad", dir.path()).await;
		assert_eq!((code, err.as_str()), (125, "env: bad: file must end with a NUL byte\n"));
		let (code, _, err) = sh_in("env --env0-from=missing", dir.path()).await;
		assert_eq!(
			(code, err.as_str()),
			(125, "env: cannot read 'missing': No such file or directory\n")
		);
	}

	/// Contract: signal handling a command cannot get in-process fails like a
	/// failed `sigaction`, while handling it already has succeeds.
	#[cfg(unix)]
	#[tokio::test]
	async fn signal_options() {
		// Only signals the test process itself ignores may be listed.
		let (code, _, err) = sh("env --default-signal=INT,PIPE --list-signal-handling true").await;
		assert_eq!(code, 0);
		assert!(err.lines().all(|line| line.ends_with("): IGNORE")), "{err}");
		assert!(!err.contains("INT ") && !err.contains("PIPE "), "{err}");
		let (code, _, err) = sh("env --ignore-signal=, --default-signal= true").await;
		assert_eq!((code, err.as_str()), (0, ""));
		let (code, _, err) = sh("env --ignore-signal=USR1 true").await;
		assert_eq!(code, 125);
		assert_eq!(
			err,
			format!(
				"env: failed to set signal action for signal {}: Operation not supported\n",
				libc::SIGUSR1
			)
		);
		let (code, _, err) = sh("env --block-signal=HUP true").await;
		assert_eq!(code, 125);
		assert_eq!(err, "env: failed to set signal process mask: Operation not supported\n");
		// Later options win, in command-line order; 143 names TERM as `$?` does.
		let (code, _, err) = sh("env -v --block-signal=KILL --default-signal=143 true").await;
		assert_eq!(code, 0);
		assert_eq!(
			err,
			format!(
				"Reset signal TERM ({term}) to DEFAULT\nsignal KILL (9) mask set to BLOCK\nsignal \
				 TERM ({term}) mask set to UNBLOCK\nexecuting: 'true'\n   arg[0]= 'true'\n",
				term = libc::SIGTERM
			)
		);
		let (code, _, err) = sh("env -v --default-signal=HUP --block-signal true").await;
		assert_eq!(code, 125);
		assert!(err.contains("signal HUP (1) mask set to BLOCK\n"), "{err}");
		let (code, _, err) = sh("env -v --block-signal --default-signal=HUP true").await;
		assert_eq!(code, 125);
		assert!(err.contains("signal HUP (1) mask set to UNBLOCK\n"), "{err}");
	}

	#[tokio::test]
	async fn help_and_version() {
		let (code, out, err) = sh("env --help").await;
		assert_eq!((code, err.as_str()), (0, ""));
		assert!(out.contains("Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]\n"));
		assert!(out.contains("--split-string"), "{out}");
		assert!(
			out.trim_end()
				.ends_with("-    the exit status of COMMAND otherwise"),
			"{out}"
		);
		let (code, out, _) = sh("env -i --version").await;
		assert_eq!(code, 0);
		assert!(out.starts_with("env "), "{out}");
		// Through -S as well.
		let (code, out, _) = sh("env -S--version").await;
		assert_eq!(code, 0);
		assert!(out.starts_with("env "), "{out}");
	}
}
