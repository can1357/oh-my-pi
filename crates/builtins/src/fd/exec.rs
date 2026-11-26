//! fd's `-x`/`--exec`, `-X`/`--exec-batch`, and `-l`/`--list-details`:
//! commands run for the matches through the invoking shell, so builtins and
//! `scheme://` paths work in them.
//!
//! Unlike fd, which runs `-x` commands on its worker threads, commands run
//! one at a time in path order: their output never interleaves and follows
//! the order matches print in.

use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	iter,
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command};

use super::{FdCli, Template, When};
use crate::host::{Host, ShellCommand};

/// fd's `-x` and `-X` as given, each occurrence's arguments kept apart.
///
/// Written out by hand: clap's derive groups values by occurrence
/// (`Vec<Vec<T>>`) only under its unstable-v5 feature.
#[derive(Debug, Default)]
pub(super) struct ExecArgs {
	/// `-x` commands.
	pub(super) each:  Vec<Vec<String>>,
	/// `-X` commands.
	pub(super) batch: Vec<Vec<String>>,
}

const EXEC_HELP: &str = "Execute a command for each search result.

Every argument after -x belongs to the command; end it with '\\;' to pass fd \
more arguments. Repeat -x to run several commands for each result, in order, \
stopping at the first that fails. Commands run one at a time, in the order \
results print.

Placeholders: '{}' path, '{/}' basename, '{//}' parent directory, '{.}' path \
without extension, '{/.}' basename without extension; '{{' and '}}' are literal \
braces. A command without placeholders gets '{}' appended.";

const EXEC_BATCH_HELP: &str = "Execute a command once with all search results as arguments.

Arguments and placeholders as for --exec, but only one argument may hold \
placeholders, and not the first. Repeat -X to run several commands, each with \
every result.";

impl clap::FromArgMatches for ExecArgs {
	fn from_arg_matches(matches: &ArgMatches) -> Result<Self, clap::Error> {
		let commands = |id: &str| {
			matches
				.get_occurrences::<String>(id)
				.map_or_default(|occurrences| occurrences.map(|args| args.cloned().collect()).collect())
		};
		Ok(Self { each: commands("exec"), batch: commands("exec_batch") })
	}

	fn update_from_arg_matches(&mut self, matches: &ArgMatches) -> Result<(), clap::Error> {
		*self = Self::from_arg_matches(matches)?;
		Ok(())
	}
}

impl clap::Args for ExecArgs {
	fn augment_args(cmd: Command) -> Command {
		let command_arg = |id: &'static str| {
			Arg::new(id)
				.value_name("cmd")
				.value_parser(clap::value_parser!(String))
				.num_args(1..)
				.allow_hyphen_values(true)
				.value_terminator(";")
				.action(ArgAction::Append)
		};
		cmd.arg(
			command_arg("exec")
				.short('x')
				.long("exec")
				.conflicts_with("list_details")
				.help("Execute a command for each search result")
				.long_help(EXEC_HELP),
		)
		.arg(
			command_arg("exec_batch")
				.short('X')
				.long("exec-batch")
				.conflicts_with_all(["exec", "list_details"])
				.help("Execute a command once with all search results as arguments")
				.long_help(EXEC_BATCH_HELP),
		)
	}

	fn augment_args_for_update(cmd: Command) -> Command {
		Self::augment_args(cmd)
	}
}

/// The commands fd runs for its matches instead of printing them.
pub(super) struct Exec {
	mode:      Mode,
	runner:    Runner,
	/// `--path-separator`.
	separator: String,
	/// `-0`: under `-x`, a NUL follows the output of each match's commands.
	print0:    bool,
	/// An `-X` command could not run, which ends the search.
	stopped:   bool,
}

enum Mode {
	/// `-x`: for each match, every command in turn until one fails.
	Each(Vec<Vec<Template>>),
	/// `-X`, and `-l` as `ls -l -h -d`: every command with the matches as
	/// arguments.
	Batch(Vec<Batch>),
}

impl Exec {
	/// The commands `cli` asks for, run in `base_dir` under `-C`; `None`
	/// when matches print instead.
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for an `-X` command with more than
	/// one argument holding placeholders, or whose first argument holds one.
	pub(super) fn new(cli: &FdCli, base_dir: &Path) -> io::Result<Option<Self>> {
		let mode = if !cli.exec.each.is_empty() {
			Mode::Each(cli.exec.each.iter().map(|args| each_template(args)).collect())
		} else if !cli.exec.batch.is_empty() {
			Mode::Batch(
				cli.exec
					.batch
					.iter()
					.map(|args| Batch::new(args, cli.batch_size))
					.collect::<io::Result<_>>()?,
			)
		} else if cli.list_details {
			let color = match cli.color {
				When::Auto => "--color=auto",
				When::Always => "--color=always",
				When::Never => "--color=never",
			};
			Mode::Batch(vec![Batch::new(&["ls", "-l", "-h", "-d", color], 0)?])
		} else {
			return Ok(None);
		};
		Ok(Some(Self {
			mode,
			runner: Runner {
				cwd:    cli.base_directory.is_some().then(|| base_dir.to_path_buf()),
				failed: false,
			},
			separator: cli.path_separator.clone().unwrap_or_else(|| "/".to_owned()),
			print0: cli.print0,
			stopped: false,
		}))
	}

	/// Runs the `-x` commands for the match shown as `path`, or adds it to
	/// the `-X` batches, running those that are full.
	///
	/// # Errors
	///
	/// Writing `-0`'s NUL to `out` fails, or the shell cancels fd
	/// ([`io::ErrorKind::Interrupted`]).
	pub(super) async fn push(&mut self, path: &Path, host: &mut Host, out: &mut impl Write) -> io::Result<()> {
		match &mut self.mode {
			Mode::Each(commands) => {
				for command in commands.iter() {
					let argv = command.iter().map(|arg| arg.render(path, &self.separator)).collect();
					if self.runner.run(argv, host).await? != Ran::Ok {
						break;
					}
				}
				if self.print0 {
					out.write_all(b"\0")?;
				}
			},
			Mode::Batch(batches) => {
				for batch in batches.iter_mut() {
					let arg = batch.arg.render(path, &self.separator);
					if batch.is_full(&arg) && !self.runner.run_batch(batch, host).await? {
						self.stopped = true;
						return Ok(());
					}
					if let Err(err) = batch.add(&arg) {
						self.runner.problem(&err, host);
						self.stopped = true;
						return Ok(());
					}
				}
			},
		}
		Ok(())
	}

	/// Runs what the `-X` batches still hold, in command order.
	///
	/// # Errors
	///
	/// The shell cancels fd ([`io::ErrorKind::Interrupted`]).
	pub(super) async fn finish(&mut self, host: &mut Host) -> io::Result<()> {
		if self.stopped {
			return Ok(());
		}
		if let Mode::Batch(batches) = &mut self.mode {
			for batch in batches.iter_mut() {
				if !self.runner.run_batch(batch, host).await? {
					break;
				}
			}
		}
		Ok(())
	}

	/// Whether an `-X` command could not run: the search ends.
	pub(super) const fn stopped(&self) -> bool {
		self.stopped
	}

	/// Whether a command failed or could not run (fd's status 1).
	pub(super) const fn failed(&self) -> bool {
		self.runner.failed
	}
}

/// An `-x` command: `{}` is appended when no argument holds a placeholder.
fn each_template(args: &[String]) -> Vec<Template> {
	let mut template: Vec<Template> = args.iter().map(|arg| Template::parse(arg)).collect();
	if !template.iter().any(Template::has_placeholder) {
		template.push(Template::path());
	}
	template
}

/// One `-X` command, filled with matches up to `--batch-size` and the
/// system's argument-length limit, then run.
struct Batch {
	/// The fixed arguments before the one holding placeholders.
	head:    Vec<OsString>,
	/// The argument holding placeholders, rendered once per match.
	arg:     Template,
	/// The fixed arguments after it.
	tail:    Vec<OsString>,
	/// The command being filled; `argmax` only sizes it, the shell runs it.
	command: argmax::Command,
	count:   usize,
	/// `--batch-size`; 0 is no limit.
	limit:   usize,
}

impl Batch {
	/// The batch command for `args`, split around its one argument with
	/// placeholders (an implicit trailing `{}` when there is none).
	///
	/// # Errors
	///
	/// [`io::ErrorKind::InvalidInput`] for a second argument with
	/// placeholders, or a first one; the fixed arguments overflow the
	/// system's argument-length limit.
	fn new(args: &[impl AsRef<str>], limit: usize) -> io::Result<Self> {
		let mut head = Vec::new();
		let mut arg = None;
		let mut tail = Vec::new();
		for template in args.iter().map(|arg| Template::parse(arg.as_ref())) {
			if template.has_placeholder() {
				if arg.replace(template).is_some() {
					return Err(invalid("Only one placeholder allowed for batch commands"));
				}
			} else {
				// No placeholder: the path is never consulted.
				let text = template.render(Path::new(""), "/");
				if arg.is_none() {
					head.push(text);
				} else {
					tail.push(text);
				}
			}
		}
		if head.is_empty() {
			return Err(invalid("First argument of --exec-batch must be a fixed executable, not a placeholder"));
		}
		let command = start_command(&head)?;
		Ok(Self { head, arg: arg.unwrap_or_else(Template::path), tail, command, count: 0, limit })
	}

	/// Whether the batch must run before it can take `arg`.
	fn is_full(&self, arg: &OsStr) -> bool {
		(self.limit > 0 && self.count >= self.limit)
			|| !self.command.args_would_fit(iter::once(arg).chain(self.tail.iter().map(OsString::as_os_str)))
	}

	/// Adds `arg`.
	///
	/// # Errors
	///
	/// `arg` alone overflows the system's argument-length limit.
	fn add(&mut self, arg: &OsStr) -> io::Result<()> {
		self.command.try_arg(arg)?;
		self.count += 1;
		Ok(())
	}

	/// The argv of the filled command, leaving an empty one in its place;
	/// `None` when it holds no match.
	///
	/// # Errors
	///
	/// The trailing fixed arguments overflow the system's argument-length
	/// limit.
	fn take(&mut self) -> io::Result<Option<Vec<OsString>>> {
		if self.count == 0 {
			return Ok(None);
		}
		let mut command = std::mem::replace(&mut self.command, start_command(&self.head)?);
		self.count = 0;
		command.try_args(&self.tail)?;
		Ok(Some(
			iter::once(command.get_program())
				.chain(command.get_args())
				.map(OsStr::to_os_string)
				.collect(),
		))
	}
}

/// A batch command holding the fixed arguments `head`, program first.
fn start_command(head: &[OsString]) -> io::Result<argmax::Command> {
	let mut command = argmax::Command::new(&head[0]);
	command.try_args(&head[1..])?;
	Ok(command)
}

fn invalid(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// How a command run for the matches ended.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ran {
	/// It exited 0.
	Ok,
	/// It exited non-zero or was killed.
	Failed,
	/// It could not start; already reported.
	Unrunnable,
}

/// Runs commands through the shell and keeps fd's status.
struct Runner {
	/// `-C`'s directory, where the shown paths start; `None` runs commands in
	/// the shell's working directory.
	cwd:    Option<PathBuf>,
	failed: bool,
}

impl Runner {
	/// Runs `argv`, reporting a command that cannot start as fd does.
	///
	/// # Errors
	///
	/// The shell cancels fd ([`io::ErrorKind::Interrupted`]).
	async fn run(&mut self, argv: Vec<OsString>, host: &mut Host) -> io::Result<Ran> {
		let program = argv[0].clone();
		let mut command = ShellCommand::new(argv);
		if let Some(dir) = &self.cwd {
			command = command.current_dir(dir.as_path());
		}
		match host.run_command_async(command).await {
			Ok(status) if status.success() => Ok(Ran::Ok),
			Ok(_) => {
				self.failed = true;
				Ok(Ran::Failed)
			},
			Err(err) if err.kind() == io::ErrorKind::Interrupted => Err(err),
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				self.failed = true;
				let _ = writeln!(host.stderr, "fd: Command not found: {program:?}");
				Ok(Ran::Unrunnable)
			},
			Err(err) => {
				self.problem(&err, host);
				Ok(Ran::Unrunnable)
			},
		}
	}

	/// Runs what `batch` holds: `false` when it could not run.
	///
	/// # Errors
	///
	/// The shell cancels fd ([`io::ErrorKind::Interrupted`]).
	async fn run_batch(&mut self, batch: &mut Batch, host: &mut Host) -> io::Result<bool> {
		match batch.take() {
			Ok(Some(argv)) => Ok(self.run(argv, host).await? != Ran::Unrunnable),
			Ok(None) => Ok(true),
			Err(err) => {
				self.problem(&err, host);
				Ok(false)
			},
		}
	}

	/// Reports a command fd could not build or start.
	fn problem(&mut self, err: &io::Error, host: &mut Host) {
		self.failed = true;
		let _ = writeln!(host.stderr, "fd: Problem while executing command: {err}");
	}
}
