//! `timeout` builtin, moved from `pi-shell`.

use std::{collections::HashMap, io::Write, sync::Arc, time::Duration};

use brush_core::{
	ExecutionContext, ExecutionExitCode, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	SpawnObserver, builtins, commands::CommandTarget, traps::TrapSignal,
};
use clap::Parser;
use parking_lot::Mutex;
use tokio::time;
use tokio_util::sync::CancellationToken;

use crate::{
	PinnedProcess, SpawnLedger,
	host::{parse_duration, quote_arg},
};

/// GNU timeout's exit status for its own usage/internal errors.
const EXIT_TIMEOUT_FAILURE: u8 = 125;
/// GNU timeout's exit status when the time limit expired.
const EXIT_TIMED_OUT: u8 = 124;
/// 128 + SIGKILL(9): reported when the command died from SIGKILL.
const EXIT_KILLED: u8 = 137;

/// Run a command with a time limit.
#[derive(Parser)]
#[command(disable_help_flag = true)]
struct TimeoutArgs {
	/// Signal to send on expiry: a name with or without the `SIG` prefix, or
	/// a number. Defaults to TERM.
	#[arg(short = 's', long = "signal", value_name = "SIGNAL")]
	signal: Option<String>,
	/// Also send SIGKILL if the command is still running this long after the
	/// initial signal.
	#[arg(short = 'k', long = "kill-after", value_name = "DURATION")]
	kill_after: Option<String>,
	/// Exit with the command's own status even when the time limit expired.
	#[arg(long)]
	preserve_status: bool,
	/// GNU compatibility: don't put the command in a separate process group,
	/// and signal only the direct children rather than a whole group.
	#[arg(long)]
	foreground: bool,
	/// Diagnose each signal sent to the command on stderr.
	#[arg(short = 'v', long)]
	verbose: bool,
	// Hyphenated operands must reach `parse_duration` so `timeout -1 cmd`
	// reports an invalid time interval (exit 125) like GNU, instead of a
	// clap unknown-option error.
	#[arg(required = true, allow_hyphen_values = true)]
	duration: String,
	// The command's own options belong to the command: `timeout 5 grep -v x`.
	#[arg(required = true, num_args = 1.., trailing_var_arg = true, allow_hyphen_values = true)]
	command: Vec<String>,
}

/// Holds the raw argument vector so parse failures surface as GNU timeout's
/// exit status 125, not brush's generic usage-error status 2 (which the
/// default `builtins::Command::new` path would produce).
pub(crate) struct TimeoutCommand {
	argv: Vec<String>,
}

impl clap::FromArgMatches for TimeoutCommand {
	fn from_arg_matches(_matches: &clap::ArgMatches) -> Result<Self, clap::Error> {
		Ok(Self { argv: Vec::new() })
	}

	fn update_from_arg_matches(&mut self, _matches: &clap::ArgMatches) -> Result<(), clap::Error> {
		Ok(())
	}
}

impl clap::CommandFactory for TimeoutCommand {
	fn command() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command()
	}

	fn command_for_update() -> clap::Command {
		<TimeoutArgs as clap::CommandFactory>::command_for_update()
	}
}

impl clap::Parser for TimeoutCommand {}

/// Records the external children spawned while running the timed command.
///
/// brush's cancellation token sends TERM then KILL (see
/// `brush_core::processes::Process::wait`), so delivering the *configured*
/// signal requires knowing the children; the shell reports them through its
/// [`SpawnObserver`] hook, and each is pinned as it is reported, so the signal
/// reaches it, or the group it was spawned into, and never a process that took
/// its pid or group number after it exited.
///
/// Each spawn is also reported to the observer this command inherited: the
/// run's spawn registry, or an enclosing `timeout`. That observer signals
/// what it recorded when the whole run is cancelled or an outer limit
/// expires; replacing it would leave the operand's process group, which
/// direct-child cancellation does not reach, unknown to it.
struct SpawnRecorder {
	spawns: Mutex<SpawnLedger>,
	parent: Option<Arc<dyn SpawnObserver>>,
}

impl SpawnObserver for SpawnRecorder {
	fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
		// Forward first: the run's registry pins the child's identity at once.
		if let Some(parent) = &self.parent {
			parent.on_spawn(pid, pgid);
		}
		// Windows has no signals for `timeout` to deliver: it cancels the
		// operand instead, so there is nothing to record.
		if cfg!(windows) {
			return;
		}
		// brush has not reaped the child yet, so `pid` still names it.
		let process = PinnedProcess::from_pid(pid);
		self.spawns.lock().record(pgid, process);
	}
}

impl SpawnRecorder {
	/// Sends `signal` to every recorded child that is still there — when
	/// `group` is set, to the process group a child leads instead — and
	/// reports whether any delivery succeeded. A leader whose group cannot be
	/// signalled is signalled itself.
	fn signal(&self, signal: TrapSignal, group: bool) -> bool {
		let Ok(signal) = i32::try_from(signal) else {
			return false;
		};
		let entries = self.spawns.lock().entries().to_vec();
		let mut sent = false;
		for entry in &entries {
			let to_group = group && entry.leads_group && entry.process.signal_group(signal);
			sent |= to_group || entry.process.kill(signal);
		}
		sent
	}
}

/// Parses a `-s` operand: a signal name (with or without the `SIG` prefix,
/// any case) or a signal number.
fn parse_signal(spec: &str) -> Option<TrapSignal> {
	let parsed = if let Ok(number) = spec.trim().parse::<i32>() {
		TrapSignal::try_from(number).ok()?
	} else {
		TrapSignal::try_from(spec).ok()?
	};
	// Only real signals can be delivered; EXIT/DEBUG/ERR are shell traps.
	matches!(parsed, TrapSignal::Signal(_)).then_some(parsed)
}

/// Renders a signal the way GNU timeout's diagnostics do: `TERM`, not `SIGTERM`.
fn signal_display(signal: TrapSignal) -> &'static str {
	let name = signal.as_str();
	name.strip_prefix("SIG").unwrap_or(name)
}

/// What runs a `timeout` operand, found by following the shell's own
/// dispatch through the wrappers that hand their operand on as GNU would exec
/// it (`command`, `env`, `nohup` and `timeout`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Operand {
	/// The shell itself: a keyword, a function, or one of the shell's own
	/// builtins (`eval`, `source`, `read`). Its GNU analog is
	/// `timeout ARGS bash -c 'OPERAND'`, so the limit's signal acts on a shell.
	Shell,
	/// A builtin standing in for a utility (`cat`, `sleep`): the signal acts on
	/// it as on that utility's process.
	Utility,
	/// An external program: the signal is the program's to handle, and the
	/// status is its own, as under GNU.
	Program,
}

/// What the limit's signal does to what it acts on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SignalEffect {
	/// It ends.
	Ends,
	/// It goes on.
	RunsOn,
	/// It stops until it is continued.
	Stops,
}

/// The effect of `signal` on `operand`: a process's default disposition (CONT
/// also resumes a stopped one), except that a shell ignores QUIT.
fn signal_effect(signal: TrapSignal, operand: Operand) -> SignalEffect {
	let number = signal_number(signal);
	if dispositions::stops(number) {
		SignalEffect::Stops
	} else if dispositions::ignored(number)
		|| (operand == Operand::Shell && dispositions::quit(number))
	{
		SignalEffect::RunsOn
	} else {
		SignalEffect::Ends
	}
}

/// The number of `signal`, which [`parse_signal`] admits only when it is a
/// real signal.
fn signal_number(signal: TrapSignal) -> i32 {
	i32::try_from(signal).unwrap_or_default()
}

/// Default signal dispositions of the platform, by signal number.
#[cfg(unix)]
mod dispositions {
	/// Whether a process ignores the signal by default: CHLD, CONT, URG and
	/// WINCH everywhere, and INFO and IO where the BSDs and Apple's systems
	/// discard them (Linux ends a process on IO and has no INFO).
	pub(super) fn ignored(number: i32) -> bool {
		#[cfg(any(
			target_vendor = "apple",
			target_os = "freebsd",
			target_os = "dragonfly",
			target_os = "netbsd",
			target_os = "openbsd"
		))]
		if matches!(number, libc::SIGINFO | libc::SIGIO) {
			return true;
		}
		matches!(number, libc::SIGCHLD | libc::SIGCONT | libc::SIGURG | libc::SIGWINCH)
	}

	/// Whether the signal stops a process by default.
	pub(super) fn stops(number: i32) -> bool {
		matches!(number, libc::SIGSTOP | libc::SIGTSTP | libc::SIGTTIN | libc::SIGTTOU)
	}

	/// Whether the signal is QUIT, which a shell ignores.
	pub(super) fn quit(number: i32) -> bool {
		number == libc::SIGQUIT
	}

	/// Whether GNU's `timeout` catches the signal: ALRM, which it takes for
	/// its own limit, and INT, QUIT, HUP and TERM, which it passes on to its
	/// command.
	pub(super) fn caught_by_timeout(number: i32) -> bool {
		matches!(number, libc::SIGALRM | libc::SIGINT | libc::SIGQUIT | libc::SIGHUP | libc::SIGTERM)
	}

	/// Whether the signal is ALRM.
	pub(super) fn alarm(number: i32) -> bool {
		number == libc::SIGALRM
	}

	/// Whether GNU's `timeout` ignores the signal itself: TTIN and TTOU, so a
	/// command in the background cannot stop it through the terminal.
	pub(super) fn ignored_by_timeout(number: i32) -> bool {
		matches!(number, libc::SIGTTIN | libc::SIGTTOU)
	}
}

/// Elsewhere every signal the shell can name ends a process.
#[cfg(not(unix))]
mod dispositions {
	pub(super) fn ignored(_number: i32) -> bool {
		false
	}

	pub(super) fn stops(_number: i32) -> bool {
		false
	}

	pub(super) fn quit(_number: i32) -> bool {
		false
	}

	pub(super) fn caught_by_timeout(_number: i32) -> bool {
		true
	}

	pub(super) fn alarm(_number: i32) -> bool {
		false
	}

	pub(super) fn ignored_by_timeout(_number: i32) -> bool {
		false
	}
}

/// A `timeout` the operand runs through, with what decides how GNU's
/// program reacts to the outer limit's signal.
#[derive(Clone, Copy)]
struct InnerTimeout {
	signal:     TrapSignal,
	preserve:   bool,
	foreground: bool,
	kill_after: Option<Duration>,
}

/// What runs the operand, and the inner `timeout`s on the way to it,
/// outermost first.
struct Classified {
	operand: Operand,
	inner:   Vec<InnerTimeout>,
}

/// The exported environment a nested `env` receives while the classifier
/// follows wrapper commands. `--env0-from` cannot be known without reading a
/// file or standard input at execution time, so that form remains a utility.
#[derive(Clone)]
struct Environment {
	values: HashMap<String, String>,
}

impl Environment {
	fn apply(&mut self, command: &crate::env::CommandWords) {
		if command.clear_env {
			self.values.clear();
		}
		for name in &command.unset {
			self.values.remove(name);
		}
		self.values.extend(command.assignments.iter().cloned());
	}
}

/// What the limit's signal does once it has passed the inner `timeout`s.
enum Delivery {
	/// The command receives `signal`, from a sender that signals its process
	/// groups when `group`. `exit` is what an inner timeout reports instead of
	/// its command's status when the signal fired its own limit, and
	/// `kill_after` the `-k` of the first inner timeout that passed it on.
	Reaches {
		signal:     TrapSignal,
		group:      bool,
		exit:       Option<u8>,
		kill_after: Option<Duration>,
	},
	/// An inner timeout ignores it, and its command goes on untouched. A
	/// timeout that passed the signal on above it may still have armed `-k`.
	Absorbed {
		kill_after: Option<Duration>,
		kill_group: bool,
	},
	/// An inner timeout stops, and nothing continues it.
	Stops,
	/// An inner timeout dies of it before its command is reached.
	Ends(TrapSignal),
}

/// Delivers `signal` from a sender that signals process groups when `group`
/// through the inner timeouts `inner` to the command. GNU's `timeout`
/// passes on INT, QUIT, HUP, TERM and its own `-s` signal, turns ALRM into
/// its own expiry, ignores TTIN and TTOU, and is otherwise any process: a
/// signal it ignores by default leaves it and its command alone, a stop
/// signal stops it until a sender in group mode continues it, and any other
/// signal ends it, leaving its command running. An inner `--foreground`
/// timeout keeps its command in the sender's process group, which a sender
/// in group mode signals as well.
fn deliver(signal: TrapSignal, inner: &[InnerTimeout], group: bool) -> Delivery {
	let Some((first, rest)) = inner.split_first() else {
		return Delivery::Reaches { signal, group, exit: None, kill_after: None };
	};
	let number = signal_number(signal);
	let through_first = if dispositions::caught_by_timeout(number) || signal == first.signal {
		// ALRM is its own limit expiring, whatever its `-s` signal is.
		let (passed, expired) =
			if dispositions::alarm(number) { (first.signal, true) } else { (signal, false) };
		match deliver(passed, rest, !first.foreground) {
			Delivery::Reaches { signal, group, exit, kill_after } => Delivery::Reaches {
				signal,
				group,
				exit: if expired && !first.preserve { Some(EXIT_TIMED_OUT) } else { exit },
				// Each timeout that passed it on arms its own `-k`; the first to
				// fire kills what lies below it.
				kill_after: match (first.kill_after, kill_after) {
					(Some(own), Some(deeper)) => Some(own.min(deeper)),
					(own, deeper) => own.or(deeper),
				},
			},
			Delivery::Absorbed { kill_after, kill_group } => Delivery::Absorbed {
				kill_after: match (first.kill_after, kill_after) {
					(Some(own), Some(deeper)) => Some(own.min(deeper)),
					(own, deeper) => own.or(deeper),
				},
				kill_group: if first.kill_after.is_some() { !first.foreground } else { kill_group },
			},
			other => other,
		}
	} else if dispositions::ignored(number) || dispositions::ignored_by_timeout(number) {
		Delivery::Absorbed { kill_after: None, kill_group: false }
	} else if dispositions::stops(number) {
		if group { Delivery::Absorbed { kill_after: None, kill_group: false } } else { Delivery::Stops }
	} else {
		Delivery::Ends(signal)
	};
	if group && first.foreground && matches!(through_first, Delivery::Absorbed { .. }) {
		return deliver(signal, rest, group);
	}
	through_first
}

/// Classifies the operand `words`, which the shell runs as a command line.
fn classify_operand<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	words: &[String],
) -> Classified {
	let mut inner = Vec::new();
	let mut environment = Environment { values: crate::host::exported_env(shell) };
	let operand = classify_line(shell, words, &[], &mut environment, &mut inner);
	Classified { operand, inner }
}

/// The aliases whose text each word of a command line came from; an empty
/// slice when none did.
type Provenance = [Vec<String>];

/// Classifies a command line holding `words`, as the shell runs it: an
/// unquoted keyword, else the words with their aliases substituted, then
/// the simple command.
///
/// Bash's rule stops an alias from expanding inside its own text, but a
/// wrapper that re-reads its operand as a new command line (`nohup`,
/// `timeout`) starts afresh: a word that came from an alias's text and names
/// that alias again makes the shell recurse through it without end,
/// in-process.
fn classify_line<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	words: &[String],
	provenance: &Provenance,
	environment: &mut Environment,
	inner: &mut Vec<InnerTimeout>,
) -> Operand {
	let Some(name) = words.first() else {
		return Operand::Shell;
	};
	// The command line quotes each word that needs it, and a quoted word is
	// never a keyword.
	if shell.is_keyword(name) && quote_arg(name) == *name {
		return Operand::Shell;
	}
	match substitute_aliases(shell, words, provenance) {
		Substituted::Unchanged => classify_simple(shell, words, provenance, true, environment, inner),
		Substituted::Words(words, provenance) => {
			classify_simple(shell, &words, &provenance, true, environment, inner)
		},
		Substituted::Recurses => Operand::Shell,
	}
}

/// A command line's words once the shell has substituted its aliases.
enum Substituted {
	/// No alias applied.
	Unchanged,
	/// The words the shell runs, and where each came from.
	Words(Vec<String>, Vec<Vec<String>>),
	/// An alias came back through its own text.
	Recurses,
}

/// Substitutes aliases in `words` as the shell's dispatch does on the
/// re-read operand line. Every word after the command word is single-quoted
/// there ([`crate::host::operand_command_line`]), so only a word in command
/// position can name an alias. The shell looks that word up after expansion,
/// quoted or not. An alias that expands to nothing leaves the next word in
/// command position.
fn substitute_aliases<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	words: &[String],
	provenance: &Provenance,
) -> Substituted {
	let came_from = |index: usize| provenance.get(index).map_or(&[][..], Vec::as_slice);
	let mut substituted: Vec<String> = Vec::new();
	let mut sources: Vec<Vec<String>> = Vec::new();
	let mut index = 0;
	while let Some(word) = words.get(index) {
		let Some((replacement, _)) = shell.expand_command_alias(word, true) else {
			break;
		};
		if came_from(index).contains(word) {
			return Substituted::Recurses;
		}
		let mut source = came_from(index).to_vec();
		source.push(word.clone());
		sources.extend(std::iter::repeat_n(source, replacement.len()));
		let expanded_to_nothing = replacement.is_empty();
		substituted.extend(replacement);
		index += 1;
		if !expanded_to_nothing {
			break;
		}
	}
	if index == 0 {
		return Substituted::Unchanged;
	}
	substituted.extend(words[index..].iter().cloned());
	sources.extend((index..words.len()).map(|later| came_from(later).to_vec()));
	Substituted::Words(substituted, sources)
}

/// Classifies the simple command `words` once the shell has looked its name
/// up, in its order, so a function named `f/x` or `/bin/sleep` is a function;
/// `use_functions` is unset where the shell skips functions. A wrapper that
/// hands its operand on is classified by that operand.
fn classify_simple<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	words: &[String],
	provenance: &Provenance,
	use_functions: bool,
	environment: &mut Environment,
	inner: &mut Vec<InnerTimeout>,
) -> Operand {
	let Some(name) = words.first() else {
		return Operand::Shell;
	};
	let builtin = match shell.command_target(name, use_functions) {
		CommandTarget::External => return Operand::Program,
		CommandTarget::Function(_) => return Operand::Shell,
		CommandTarget::Builtin(builtin) => builtin,
	};
	let (operand, line) = match handoff(words, environment) {
		Some(Handoff::Line(operand)) => (operand, true),
		Some(Handoff::Timeout(operand, timeout)) => {
			inner.push(timeout);
			(operand, true)
		},
		Some(Handoff::Environment(command)) => {
			environment.apply(&command);
			(command.command, false)
		},
		Some(Handoff::Simple(operand)) => (operand, false),
		None if builtin.utility => return Operand::Utility,
		None => return Operand::Shell,
	};
	// The operand is the wrapper's trailing words, or, split from an `env -S`
	// string, comes from where the wrapper's own word did.
	let operand_provenance: Vec<Vec<String>> = if provenance.is_empty() {
		Vec::new()
	} else if words.ends_with(&operand) {
		provenance[words.len() - operand.len()..].to_vec()
	} else {
		vec![provenance[0].clone(); operand.len()]
	};
	if line {
		classify_line(shell, &operand, &operand_provenance, environment, inner)
	} else {
		classify_simple(shell, &operand, &operand_provenance, false, environment, inner)
	}
}

/// How a wrapper builtin hands its operand on.
enum Handoff {
	/// As a command line, which the shell parses and dispatches in full
	/// (`nohup`).
	Line(Vec<String>),
	/// As a command line under an inner limit (`timeout`).
	Timeout(Vec<String>, InnerTimeout),
	/// As a simple command with an environment it applies (`env`).
	Environment(crate::env::CommandWords),
	/// As a simple command, whose lookup skips functions (`command`).
	Simple(Vec<String>),
}

/// The operand the builtin `words` names hands on, found by that builtin's
/// own argument parsing: `None` for a builtin that hands nothing on as GNU
/// would exec it, or that runs nothing this time (a `command -v` query,
/// `--help`, a usage error).
///
/// `command` is the shell's builtin; Bash execs the program it names, so
/// the operand ends with that program's status (`builtin command` and
/// `command eval` stay the shell's). `env`, `nohup` and `timeout` are
/// utilities GNU runs as programs that exec their operand. The other
/// utilities that run commands, `xargs`, `find -exec` and `ifne`, wait for
/// them instead, and die of the signal themselves.
fn handoff(words: &[String], environment: &Environment) -> Option<Handoff> {
	match words[0].as_str() {
		#[cfg(feature = "builtin.command")]
		"command" => {
			let command =
				<crate::command::CommandCommand as builtins::Command>::new(words.iter().cloned()).ok()?;
			(!command.print_description
				&& !command.print_verbose_description
				&& !command.command_and_args.is_empty())
			.then_some(Handoff::Simple(command.command_and_args))
		},
		#[cfg(feature = "util.env")]
		"env" => crate::env::command_words(words, |name| environment.values.get(name).cloned())
			.map(Handoff::Environment),
		#[cfg(feature = "util.nohup")]
		"nohup" => <crate::nohup::NohupCommand as builtins::Command>::new(words.iter().cloned())
			.ok()?
			.operand()
			.map(|operand| Handoff::Line(operand.to_vec())),
		"timeout" => {
			let args = TimeoutArgs::try_parse_from(words).ok()?;
			parse_duration(&args.duration)?;
			let kill_after = match &args.kill_after {
				Some(spec) => Some(parse_duration(spec)?),
				None => None,
			};
			let signal = match &args.signal {
				Some(spec) => parse_signal(spec)?,
				None => TrapSignal::try_from("TERM").ok()?,
			};
			let timeout =
				InnerTimeout { signal, preserve: args.preserve_status, foreground: args.foreground, kill_after };
			Some(Handoff::Timeout(args.command, timeout))
		},
		_ => None,
	}
}

impl builtins::Command for TimeoutCommand {
	type Error = brush_core::Error;

	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		Ok(Self { argv: args.into_iter().collect() })
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> std::result::Result<ExecutionResult, brush_core::Error> {
		if context.is_cancelled() {
			return Ok(ExecutionExitCode::Interrupted.into());
		}
		let args = match TimeoutArgs::try_parse_from(&self.argv) {
			Ok(args) => args,
			Err(err) => {
				// clap reports `--help` as an error; that belongs on stdout
				// with a success status, real usage errors exit 125.
				let rendered = err.to_string();
				if err.use_stderr() {
					let _ = write!(context.stderr(), "{rendered}");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				}
				let _ = write!(context.stdout(), "{rendered}");
				return Ok(ExecutionResult::success());
			},
		};
		let Some(limit) = parse_duration(&args.duration) else {
			let _ = writeln!(
				context.stderr(),
				"timeout: invalid time interval '{}'",
				args.duration
			);
			return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
		};
		let kill_after = match &args.kill_after {
			Some(spec) => match parse_duration(spec) {
				Some(duration) => Some(duration),
				None => {
					let _ =
						writeln!(context.stderr(), "timeout: invalid time interval '{spec}'");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => None,
		};
		let signal = match &args.signal {
			Some(spec) => match parse_signal(spec) {
				Some(signal) => signal,
				None => {
					let _ = writeln!(context.stderr(), "timeout: '{spec}': invalid signal");
					return Ok(ExecutionResult::new(EXIT_TIMEOUT_FAILURE));
				},
			},
			None => TrapSignal::try_from("TERM").expect("SIGTERM must be a known signal"),
		};

		let child_cancel = CancellationToken::new();
		let spawns = Arc::new(SpawnRecorder {
			spawns: Mutex::default(),
			parent: context.params.spawn_observer().cloned(),
		});
		let mut params = context.params.clone();
		// GNU runs the command in its own process group and signals the whole
		// group; `--foreground` keeps it in the invoking group and signals
		// only the direct children.
		params.process_group_policy = if args.foreground {
			ProcessGroupPolicy::SameProcessGroup
		} else {
			ProcessGroupPolicy::NewProcessGroup
		};
		params.set_cancel_token(child_cancel.clone());
		// GNU's killed command says nothing; neither does the shell that ran an
		// in-process operand once the limit cancels it.
		params.set_quiet_cancellation(true);
		params.set_spawn_observer(Arc::clone(&spawns) as Arc<dyn SpawnObserver>);

		let command_line = crate::host::operand_command_line(&args.command);
		// GNU runs a program, which the limit's signal acts on. When the shell
		// runs the operand itself, or a utility in-process, no signal reaches
		// them: when the signal would end them the limit has to cancel the
		// operand, or `eval 'sleep 5; next'` runs `next` once the signal has
		// ended `sleep`.
		let Classified { operand, inner } = classify_operand(context.shell, &args.command);

		// Grab an owned stderr handle up front: `run_future` below holds the
		// shell mutably, so `context.stderr()` is unavailable once it exists.
		let mut stderr = context.stderr();
		let outer_cancel = context.cancel_token();
		let source_info = SourceInfo::from("pi-natives:timeout");
		let run_future = context.shell.run_string(command_line, &source_info, &params);
		tokio::pin!(run_future);

		let outer_cancelled = async {
			match &outer_cancel {
				Some(token) => token.cancelled().await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(outer_cancelled);

		// GNU: a duration of zero disables the timeout entirely.
		let deadline = async {
			if limit.is_zero() {
				std::future::pending::<()>().await;
			} else {
				time::sleep(limit).await;
			}
		};
		tokio::pin!(deadline);

		tokio::select! {
			result = &mut run_future => return result,
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			() = &mut deadline => {},
		}

		// The limit expired: deliver the configured signal like GNU timeout.
		if args.verbose {
			let _ = writeln!(
				stderr,
				"timeout: sending signal {} to command '{}'",
				signal_display(signal),
				args.command[0]
			);
		}
		// The signal reaches the command unless inner `timeout`s stand in the
		// way, each reacting as GNU's program does.
		let (delivered, group, mut inner_exit, inner_kill_after, inner_kill_group, held) =
			match deliver(signal, &inner, !args.foreground) {
				Delivery::Reaches { signal, group, exit, kill_after } => {
					(Some(signal), group, exit, kill_after, group, false)
				},
				Delivery::Absorbed { kill_after, kill_group } => {
					(None, false, None, kill_after, kill_group, false)
				},
				Delivery::Stops => (None, false, None, None, false, true),
				Delivery::Ends(died_of) => {
					// An inner timeout died of it: GNU reports that death at once
					// and leaves the inner command running. An in-process inner
					// timeout cannot outlive its operand, so the command ends
					// with it.
					child_cancel.cancel();
					return Ok(ExecutionResult::new(if died_of.as_str() == "SIGKILL" {
						EXIT_KILLED
					} else if args.preserve_status {
						death_status(died_of)
					} else {
						EXIT_TIMED_OUT
					}));
				},
			};
		// An inner `--foreground` timeout keeps its command in the outer
		// process group. That command receives the outer signal directly,
		// even when the inner timeout transforms or absorbs it.
		let direct_foreground_signal = !args.foreground
			&& inner.first().is_some_and(|timeout| timeout.foreground)
			&& delivered != Some(signal);
		// Both deliveries happen: `||` would skip the direct one whenever the
		// signal the inner timeout passes on reached a process.
		let passed_on = delivered.is_some_and(|delivered| spawns.signal(delivered, group));
		let direct = direct_foreground_signal && spawns.signal(signal, true);
		let signalled = passed_on || direct;
		// GNU follows any other signal with CONT in group mode, so a stopped
		// child receives it and a stop signal leaves nothing stopped.
		if group
			&& let Some(delivered) = delivered
			&& !matches!(delivered.as_str(), "SIGKILL" | "SIGCONT")
			&& let Ok(cont) = TrapSignal::try_from("CONT")
		{
			spawns.signal(cont, true);
		}
		// A program that received the signal is left to it, as under GNU.
		// Otherwise the signal acts on the shell or the utility running the
		// operand, or, with no child left to receive it, on the program's
		// place. When it would end them, cancellation retires the operand: it
		// gives a child the operand waits for a moment to die of the signal
		// and then kills it (see `Process::wait`). A stop signal that no CONT
		// follows leaves the operand stopped, or an inner timeout, and GNU
		// waits for it until `-k`; the shell would report a stopped program
		// and go on to its next command, so the operand is not polled again
		// until it is killed. An inner timeout that ignores the signal leaves
		// its command alone.
		let (cancelled, stopped) = match delivered {
			None => (false, held),
			Some(delivered) => {
				let effect = signal_effect(delivered, operand);
				let stops = !group && effect == SignalEffect::Stops;
				match operand {
					Operand::Program if signalled => (false, stops),
					Operand::Program => (effect == SignalEffect::Ends, false),
					Operand::Shell | Operand::Utility => (effect == SignalEffect::Ends, stops),
				}
			},
		};
		if cancelled {
			child_cancel.cancel();
		}
		let mut killed = signal.as_str() == "SIGKILL";

		// Wait for the command to finish, escalating to SIGKILL after
		// `--kill-after`. Without `-k`, GNU waits indefinitely — a command
		// that catches the signal, or that it stopped, keeps the wait going
		// (the caller can still cancel). The shell that runs a cancelled
		// operand may surface its cancellation as an Interrupted error instead
		// of the operand's result; that is expected retirement, not a fault.
		let reap = |result: Result<ExecutionResult, brush_core::Error>| match result {
			Ok(result) => Ok(Some(result)),
			Err(err) if cancelled && matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
				Ok(None)
			},
			Err(err) => Err(err),
		};
		let kill_deadline = async {
			match kill_after {
				Some(duration) => time::sleep(duration).await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(kill_deadline);
		// An inner timeout that passed the signal on arms its own `-k`.
		let inner_kill_deadline = async {
			match inner_kill_after {
				Some(duration) => time::sleep(duration).await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(inner_kill_deadline);
		let inner_kill_pending = inner_kill_after.is_some();

		let child_result = loop {
			tokio::select! {
				result = &mut run_future, if !stopped => break reap(result)?,
				() = &mut outer_cancelled => {
					child_cancel.cancel();
					return Ok(ExecutionExitCode::Interrupted.into());
				},
				() = &mut inner_kill_deadline, if inner_kill_pending => {
					spawns.signal(kill_signal(), inner_kill_group);
					child_cancel.cancel();
					// A command its own limit killed leaves GNU's inner timeout
					// exiting 137; one it passed a signal to, dying of the
					// KILL itself, which the outer reports as 137 too. Stop the
					// in-process operand as well: otherwise `eval 'sleep; late'`
					// reports 137 but still executes `late`.
					match &mut inner_exit {
						Some(exit) => *exit = EXIT_KILLED,
						None => killed = true,
					}
					match time::timeout(Duration::from_secs(2), &mut run_future).await {
						Ok(Err(err)) if !matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
							return Err(err);
						},
						_ => break None,
					}
				},
				() = &mut kill_deadline => {
					if args.verbose {
						let _ = writeln!(
							stderr,
							"timeout: sending signal KILL to command '{}'",
							args.command[0]
						);
					}
					killed = true;
					spawns.signal(kill_signal(), !args.foreground);
					child_cancel.cancel();
					// SIGKILL can't be resisted; bound the reaping wait anyway so
					// a wedged in-process operand can't hang the builtin forever.
					// The operand's own result is moot once it was sent SIGKILL,
					// and the cancellation just above can surface as Interrupted.
					match time::timeout(Duration::from_secs(2), &mut run_future).await {
						Ok(Err(err)) if !matches!(err.kind(), brush_core::ErrorKind::Interrupted) => {
							return Err(err);
						},
						_ => break None,
					}
				},
			}
		};

		// Exit status per GNU: 137 once the command was sent SIGKILL, by `-s`
		// or by `-k`, with or without `--preserve-status`: the operand's result
		// after `-k` races the cancellation that follows the kill and can read
		// 130. An inner timeout whose own limit the signal fired reports that
		// instead of its command's status. Otherwise the command's own status
		// under `--preserve-status`, else 124.
		if killed {
			return Ok(ExecutionResult::new(EXIT_KILLED));
		}
		if args.preserve_status {
			if let Some(exit) = inner_exit {
				return Ok(ExecutionResult::new(exit));
			}
			if let Some(result) = child_result.filter(|_| !cancelled) {
				return Ok(result);
			}
			// A cancelled operand's own status races the shell's cancellation,
			// so it is unreliable. Report death by the delivered signal (128+N)
			// deterministically, as Bash does for a shell operand the signal
			// ended (`timeout --preserve-status .2 bash -c 'sleep 5; next'`
			// exits 143).
			return Ok(ExecutionResult::new(death_status(delivered.unwrap_or(signal))));
		}
		Ok(ExecutionResult::new(EXIT_TIMED_OUT))
	}
}

/// The status of a command a signal ended: 128 plus its number.
fn death_status(signal: TrapSignal) -> u8 {
	128_u8.wrapping_add(signal_number(signal) as u8)
}

/// SIGKILL, which every platform the shell runs on can name.
fn kill_signal() -> TrapSignal {
	TrapSignal::try_from("KILL").expect("SIGKILL must be a known signal")
}

#[cfg(test)]
mod tests {
	use std::{
		io::{Read, Seek, SeekFrom},
		time::Duration,
	};

	use brush_core::{
		ExecutionContext, ExecutionResult, Shell, SourceInfo, builtins,
		extensions::DefaultShellExtensions,
		openfiles::OpenFiles,
	};
	use clap::Parser;

	use super::{Operand, TimeoutArgs, TimeoutCommand, classify_operand, parse_signal, signal_display};

	#[derive(Parser)]
	struct StatusCommand;

	impl builtins::Command for StatusCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			_context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			Ok(ExecutionResult::new(7))
		}
	}

	#[derive(Parser)]
	struct SlowCommand;

	impl builtins::Command for SlowCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			let cancel_token = context
				.cancel_token()
				.expect("timeout must provide its operand a cancellation token");
			tokio::select! {
				() = cancel_token.cancelled() => Ok(ExecutionResult::success()),
				() = tokio::time::sleep(Duration::from_millis(500)) => {
					Ok(ExecutionResult::new(99))
				},
			}
		}
	}

	/// An operand that ignores cancellation, so only SIGKILL escalation (the
	/// cancel-token fallback plus the bounded reap) can retire it early.
	#[derive(Parser)]
	struct StubbornCommand;

	impl builtins::Command for StubbornCommand {
		type Error = brush_core::Error;

		async fn execute<SE: brush_core::ShellExtensions>(
			&self,
			_context: ExecutionContext<'_, SE>,
		) -> Result<ExecutionResult, Self::Error> {
			tokio::time::sleep(Duration::from_millis(300)).await;
			Ok(ExecutionResult::new(99))
		}
	}

	async fn test_shell() -> Shell<DefaultShellExtensions> {
		Shell::builder()
			.builtin(
				"timeout",
				builtins::builtin::<TimeoutCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"status-test",
				builtins::builtin::<StatusCommand, DefaultShellExtensions>(),
			)
			.builtin(
				"slow-test",
				builtins::builtin::<SlowCommand, DefaultShellExtensions>(),
			)
			.build()
			.await
			.expect("build test shell")
	}

	async fn run_with_deadline(command: &str) -> ExecutionResult {
		let mut shell = test_shell().await;
		let mut params = shell.default_exec_params();
		// Cancelling the operand makes the shell report an interrupted command;
		// without this the diagnostic lands on the test runner's terminal.
		for fd in [OpenFiles::STDIN_FD, OpenFiles::STDOUT_FD, OpenFiles::STDERR_FD] {
			params.set_fd(fd, brush_core::openfiles::null().expect("null device"));
		}
		tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(command, &SourceInfo::default(), &params),
		)
		.await
		.expect("timeout builtin test exceeded its safety deadline")
		.expect("execute test command")
	}

	#[tokio::test]
	async fn command_finishing_inside_limit_returns_its_status() {
		let result = run_with_deadline("timeout 0.250 status-test").await;

		assert_eq!(u8::from(result.exit_code), 7);
	}

	#[tokio::test]
	async fn command_exceeding_limit_is_cancelled_with_timeout_status() {
		let result = run_with_deadline("timeout 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 124);
	}

	/// A shell with every builtin and in-process utility, as the bash tool's
	/// shell has, working in `dir`.
	#[cfg(unix)]
	async fn full_shell(dir: &std::path::Path) -> Shell<DefaultShellExtensions> {
		let mut shell = Shell::builder()
			.builtins(crate::default_builtins(crate::BuiltinSet::BashMode))
			.working_dir(dir.to_path_buf())
			.build()
			.await
			.expect("build test shell");
		for (name, registration) in crate::utility_builtins().into_iter().chain(crate::process_builtins()) {
			shell.register_builtin(name, registration);
		}
		shell
	}

	/// What [`run_with_params`] saw.
	#[cfg(unix)]
	struct Ran {
		status: u8,
		stdout: String,
		stderr: String,
	}

	/// Runs `command` (stdin closed, output captured) under `cancel`, if
	/// given. The 1 s deadline is the contract: a command that ignores
	/// cancellation never returns.
	#[cfg(unix)]
	async fn run_in_process(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		cancel: Option<tokio_util::sync::CancellationToken>,
	) -> Ran {
		let mut params = shell.default_exec_params();
		if let Some(token) = cancel {
			params.set_cancel_token(token);
		}
		run_with_params(shell, command, params).await
	}

	/// [`run_in_process`] with `params` in place of the shell's defaults.
	#[cfg(unix)]
	async fn run_with_params(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		mut params: brush_core::ExecutionParameters,
	) -> Ran {
		let mut stdout = tempfile::tempfile().expect("create stdout capture");
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		params.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().expect("null device"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout.try_clone().expect("clone stdout capture").into());
		params.set_fd(OpenFiles::STDERR_FD, stderr.try_clone().expect("clone stderr capture").into());
		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(command, &SourceInfo::default(), &params),
		)
		.await
		.unwrap_or_else(|_| panic!("`{command}` ignored cancellation"))
		.expect("execute test command");
		let read_back = |file: &mut std::fs::File| {
			file.seek(SeekFrom::Start(0)).expect("rewind capture");
			let mut text = String::new();
			file.read_to_string(&mut text).expect("read capture");
			text
		};
		Ran { status: u8::from(result.exit_code), stdout: read_back(&mut stdout), stderr: read_back(&mut stderr) }
	}

	/// A scratch directory holding `sparse` and `sparse2`: 4 GiB files of NUL
	/// bytes with no line breaks that take no disk space, too long to read
	/// inside a short limit.
	#[cfg(unix)]
	fn sparse_dir() -> tempfile::TempDir {
		let dir = tempfile::tempdir().expect("create scratch dir");
		for name in ["sparse", "sparse2"] {
			std::fs::File::create(dir.path().join(name))
				.and_then(|file| file.set_len(4 << 30))
				.expect("create sparse file");
		}
		dir
	}

	/// A utility reading a host file that never ends kept reading after the
	/// limit: the builtin waits for its operand, so `timeout` never returned.
	/// Once cancelled it says nothing about the cancelled read either
	/// (`cat: /dev/zero: Operation canceled`); the shell's own
	/// `error: interrupted` for the retired operand is not the utility's.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn in_process_reader_of_an_endless_file_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 cat /dev/zero", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("cat:"), "{}", ran.stderr);
	}

	/// `grep -z` over a large sparse file reads its NUL bytes as empty records,
	/// so memory stays flat but the search runs for minutes.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_grep_stops_without_a_diagnostic() {
		let dir = sparse_dir();
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 grep -z x sparse", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("grep:"), "{}", ran.stderr);
	}

	/// `diff` reads each file whole (`Fs::read`), which took no notice of the
	/// token, so `timeout 150 diff -r` over a tree holding a huge sparse file
	/// ran to the end of it.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn whole_file_read_of_a_sparse_file_stops_at_the_limit() {
		let dir = sparse_dir();
		let ran = run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 diff sparse sparse2", None).await;

		assert_eq!(ran.status, 124);
		assert!(!ran.stderr.contains("diff:"), "{}", ran.stderr);
	}

	/// `tail` panicked on the cancelled read (`tail: internal error`); what a
	/// cancelled utility prints is dropped in one place for every utility.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_utilities_print_nothing_about_it() {
		let dir = sparse_dir();
		let mut shell = full_shell(dir.path()).await;
		for command in ["timeout 0.2 tail -n 1 sparse", "timeout 0.2 sha256sum /dev/zero"] {
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!(ran.status, 124, "{command}");
			assert!(!ran.stderr.contains("tail") && !ran.stderr.contains("sha256sum"), "{command}: {}", ran.stderr);
		}
	}

	/// When the limit cancels an in-process operand, the shell that ran it
	/// printed `error: interrupted` (and a builtin's own `mapfile:
	/// interrupted`). GNU `timeout` kills its command, which says nothing; the
	/// status alone reports the timeout.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn timeout_prints_nothing_of_its_own_when_the_limit_fires() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		for command in [
			"timeout 0.2 cat /dev/zero",
			"timeout 0.2 mapfile -t a < /dev/zero",
			"timeout 0.2 eval 'cat /dev/zero'",
		] {
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!((ran.status, ran.stderr.as_str()), (124, ""), "{command}");
		}
		let ran = run_in_process(&mut shell, "timeout 0.5 cat nosuch; echo st=$?", None).await;
		assert!(ran.stderr.contains("nosuch"), "an error before the limit is still printed: {}", ran.stderr);
	}

	/// A cancelled read of standard input looked like EOF, so `md5sum` printed
	/// the checksum of whatever prefix it had read, as if it were the input's.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelled_stdin_read_reports_no_result_for_partial_input() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 md5sum - < /dev/zero", None).await;

		assert_eq!(ran.status, 124);
		assert_eq!(ran.stdout, "");
	}

	/// `wc -c` counts a pipe with `splice`, which bypasses the cancellable
	/// reads: behind a writer that never stops, `timeout` never returned.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn byte_count_of_an_endless_pipe_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "cat /dev/zero | timeout 0.2 wc -c", None).await;

		assert_eq!(ran.status, 124);
		assert_eq!(ran.stdout, "");
	}

	/// `mapfile` reading a line that never ends did not check cancellation.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn mapfile_of_endless_input_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 mapfile -t a < /dev/zero", None).await;

		assert_eq!(ran.status, 124);
	}

	/// `mapfile` read its input without waiting for it first, so input that
	/// paused before a delimiter or EOF (`{ printf x; sleep 60; } | timeout 1
	/// mapfile a`) held the task that runs `timeout` in a blocking read, and
	/// the limit never fired. Read a block at a time and, with `-n`, a byte at
	/// a time.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn mapfile_of_paused_input_stops_at_the_limit() {
		use std::io::Write as _;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let fifo = dir.path().join("fifo");
		pi_vfs::BlockingFs::native()
			.make_node(&fifo, pi_vfs::NodeKind::Fifo, 0o600)
			.expect("create FIFO");
		let mut shell = full_shell(dir.path()).await;
		for command in ["timeout 0.2 mapfile a < fifo", "timeout 0.2 mapfile -n 2 a < fifo"] {
			let path = fifo.clone();
			let writer = std::thread::spawn(move || {
				let mut file = std::fs::OpenOptions::new()
					.write(true)
					.open(path)
					.expect("open FIFO for writing");
				file.write_all(b"x").expect("write to FIFO");
				// Pauses past the test's deadline, then ends the input.
				std::thread::sleep(Duration::from_secs(2));
			});
			let ran = run_in_process(&mut shell, command, None).await;
			assert_eq!((ran.status, ran.stderr.as_str()), (124, ""), "{command}");
			writer.join().expect("FIFO writer");
		}
	}

	/// `ls -R` walked the whole tree before it looked at cancellation.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn recursive_listing_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let ran =
			run_in_process(&mut full_shell(dir.path()).await, "timeout 0.2 ls -R / > /dev/null", None).await;

		assert_eq!(ran.status, 124);
	}

	/// Opening a FIFO with no writer blocked in `open` until one came, past
	/// the limit; now the open stops at the limit, and a writer that does come
	/// is still read.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn reader_of_a_fifo_without_a_writer_stops_at_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		pi_vfs::BlockingFs::native()
			.make_node(dir.path().join("fifo"), pi_vfs::NodeKind::Fifo, 0o600)
			.expect("create FIFO");
		let mut shell = full_shell(dir.path()).await;

		let ran = run_in_process(&mut shell, "timeout 0.2 cat fifo", None).await;
		assert_eq!(ran.status, 124);

		let ran = run_in_process(&mut shell, "(sleep 0.1; echo hi > fifo) & timeout 0.8 cat fifo; wait", None).await;
		assert_eq!((ran.status, ran.stdout.as_str()), (0, "hi\n"), "{}", ran.stderr);
	}

	/// A background in-process reader must stop when the run that started it
	/// is cancelled (a tool abort); otherwise it keeps a core busy after the
	/// session is gone.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn background_reader_stops_when_its_run_is_cancelled() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let run_token = tokio_util::sync::CancellationToken::new();
		run_in_process(&mut shell, "cat /dev/zero > /dev/null &", Some(run_token.clone())).await;
		run_token.cancel();

		// `wait` returns once the job has ended; the deadline catches a job that
		// keeps reading.
		run_in_process(&mut shell, "wait", None).await;
	}

	#[tokio::test]
	async fn invalid_duration_preserves_diagnostic() {
		let mut shell = test_shell().await;
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		let mut params = shell.default_exec_params();
		params.set_fd(
			OpenFiles::STDERR_FD,
			stderr.try_clone().expect("clone stderr capture").into(),
		);

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(
				"timeout invalid status-test",
				&SourceInfo::default(),
				&params,
			),
		)
		.await
		.expect("invalid-duration test exceeded its safety deadline")
		.expect("execute invalid-duration command");
		stderr.seek(SeekFrom::Start(0)).expect("rewind stderr capture");
		let mut diagnostic = String::new();
		stderr.read_to_string(&mut diagnostic).expect("read stderr capture");

		assert_eq!(u8::from(result.exit_code), 125);
		assert_eq!(diagnostic, "timeout: invalid time interval 'invalid'\n");
	}

	#[tokio::test]
	async fn gnu_flag_spellings_parse() {
		// Failure mode: a real-world GNU invocation dying in clap.
		let args = TimeoutArgs::try_parse_from([
			"timeout", "-s", "INT", "-k", "2s", "10s", "cmd", "arg",
		])
		.expect("-s/-k spellings must parse");
		assert_eq!(args.signal.as_deref(), Some("INT"));
		assert_eq!(args.kill_after.as_deref(), Some("2s"));
		assert_eq!(args.duration, "10s");
		assert_eq!(args.command, ["cmd", "arg"]);

		let args = TimeoutArgs::try_parse_from([
			"timeout",
			"--signal=KILL",
			"--kill-after=1",
			"--preserve-status",
			"--foreground",
			"-v",
			"5",
			"cmd",
		])
		.expect("long spellings must parse");
		assert!(args.preserve_status && args.foreground && args.verbose);

		// `--` before the duration ends option parsing, GNU-style.
		let args = TimeoutArgs::try_parse_from(["timeout", "--", "5", "cmd"])
			.expect("-- before the duration must parse");
		assert_eq!(args.duration, "5");

		// The command's own options must pass through untouched.
		let args = TimeoutArgs::try_parse_from(["timeout", "5", "grep", "-v", "-e", "x"])
			.expect("command options must not be parsed by timeout");
		assert_eq!(args.command, ["grep", "-v", "-e", "x"]);

		// A hyphenated duration reaches parse_duration (exit 125 later),
		// instead of failing as an unknown clap option.
		let args = TimeoutArgs::try_parse_from(["timeout", "-1", "cmd"])
			.expect("hyphenated duration must reach the interval check");
		assert_eq!(args.duration, "-1");
	}

	#[test]
	fn signal_spellings_parse_and_display_without_prefix() {
		// Failure mode: rejecting a signal spelling GNU accepts.
		for spec in ["TERM", "term", "SIGTERM", "sigterm", "15", "KILL", "9", "INT", "2"] {
			assert!(parse_signal(spec).is_some(), "spec {spec:?} must parse");
		}
		// Shell-trap pseudo-signals and unknown names are invalid for kill(2).
		for spec in ["NOSUCH", "EXIT", "DEBUG", "ERR", "64", "-5"] {
			assert!(parse_signal(spec).is_none(), "spec {spec:?} must be rejected");
		}
		let term = parse_signal("SIGTERM").expect("SIGTERM parses");
		assert_eq!(signal_display(term), "TERM");
	}

	#[tokio::test]
	async fn zero_duration_disables_the_timeout() {
		// Failure mode: `timeout 0 cmd` firing instantly instead of never.
		let result = run_with_deadline("timeout 0 slow-test").await;
		assert_eq!(u8::from(result.exit_code), 99);

		let result = run_with_deadline("timeout 0s status-test").await;
		assert_eq!(u8::from(result.exit_code), 7);
	}

	#[tokio::test]
	async fn preserve_status_reports_death_by_the_timeout_signal() {
		// In-process operands retire via the cancel fallback, where the inner
		// shell's result is racy; --preserve-status must deterministically
		// report death by the configured signal (TERM -> 143), like GNU does
		// for a command killed by the timeout signal.
		let result = run_with_deadline("timeout --preserve-status 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 143);
	}

	#[tokio::test]
	async fn kill_signal_reports_137() {
		// GNU exits 128+9 when the command is taken down with SIGKILL.
		let result = run_with_deadline("timeout -s KILL 0.010 slow-test").await;

		assert_eq!(u8::from(result.exit_code), 137);
	}

	#[tokio::test]
	async fn kill_after_escalates_and_reports_137() {
		// stubborn-test ignores the initial (cancellation-based) signal; the
		// -k deadline must escalate and report the SIGKILL status.
		let mut shell = test_shell().await;
		shell
			.register_builtin(
				"stubborn-test",
				builtins::builtin::<StubbornCommand, DefaultShellExtensions>(),
			);
		let mut params = shell.default_exec_params();
		// Keep the inner shell's interrupted notice off the test runner's
		// terminal, like run_with_deadline does.
		for fd in [OpenFiles::STDIN_FD, OpenFiles::STDOUT_FD, OpenFiles::STDERR_FD] {
			params.set_fd(fd, brush_core::openfiles::null().expect("null device"));
		}
		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string(
				"timeout -k 0.075 0.010 stubborn-test",
				&SourceInfo::default(),
				&params,
			),
		)
		.await
		.expect("escalation test exceeded its safety deadline")
		.expect("execute escalation command");

		assert_eq!(u8::from(result.exit_code), 137);
	}

	#[tokio::test]
	async fn clap_parse_failure_exits_125_not_2() {
		// GNU usage errors exit 125; brush's generic clap path would exit 2.
		let result = run_with_deadline("timeout").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn invalid_kill_after_interval_exits_125() {
		let result = run_with_deadline("timeout -k bogus 1 status-test").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn invalid_signal_exits_125() {
		let result = run_with_deadline("timeout -s NOSUCH 1 status-test").await;

		assert_eq!(u8::from(result.exit_code), 125);
	}

	#[tokio::test]
	async fn verbose_reports_the_signal_sent() {
		let mut shell = test_shell().await;
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		let mut params = shell.default_exec_params();
		params.set_fd(
			OpenFiles::STDERR_FD,
			stderr.try_clone().expect("clone stderr capture").into(),
		);

		let result = tokio::time::timeout(
			Duration::from_secs(1),
			shell.run_string("timeout -v 0.010 slow-test", &SourceInfo::default(), &params),
		)
		.await
		.expect("verbose test exceeded its safety deadline")
		.expect("execute verbose command");
		stderr.seek(SeekFrom::Start(0)).expect("rewind stderr capture");
		let mut diagnostic = String::new();
		stderr.read_to_string(&mut diagnostic).expect("read stderr capture");

		assert_eq!(u8::from(result.exit_code), 124);
		// The cancel-fallback may race the inner shell's own cancellation
		// check, which can append its interrupted notice after our line.
		assert!(
			diagnostic.starts_with("timeout: sending signal TERM to command 'slow-test'\n"),
			"diagnostic must lead with the GNU-style signal line: {diagnostic:?}"
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn external_child_receives_the_configured_signal() {
		// Failure mode: the timed-out external child only ever seeing SIGKILL
		// (the cancel-token path) instead of the configured signal.
		let result = run_with_deadline("timeout -s TERM 0.050 sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 124);

		let result =
			run_with_deadline("timeout --preserve-status 0.050 sleep 5").await;
		assert_eq!(u8::from(result.exit_code), 143, "SIGTERM death is 128+15");
	}

	/// `-k` escalation under `--preserve-status` reports the command's death
	/// by SIGKILL, 137, as GNU `timeout` does. The operand token cancelled
	/// after the kill could win over the real exit status, and 130 came out.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn preserve_status_after_kill_escalation_reports_137() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		for attempt in 0..5 {
			let ran = run_in_process(
				&mut shell,
				"timeout --preserve-status -k 0.1 0.1 /bin/sh -c 'trap \"\" TERM; /bin/sleep 30 & wait'",
				None,
			)
			.await;
			assert_eq!(ran.status, 137, "attempt {attempt}: {}", ran.stderr);
		}
	}

	/// Records what the shell reports for each external child it spawns.
	#[cfg(target_os = "linux")]
	#[derive(Default)]
	struct SpawnLog(std::sync::Mutex<Vec<(i32, Option<i32>)>>);

	#[cfg(target_os = "linux")]
	impl brush_core::SpawnObserver for SpawnLog {
		fn on_spawn(&self, pid: i32, pgid: Option<i32>) {
			self.0.lock().expect("spawn log lock").push((pid, pgid));
		}
	}

	/// The run's spawn registry, and an outer `timeout`, signal the process
	/// group a child is reported in. Each child here prints the group `/proc`
	/// shows it in, and the report must name that group, or none when it is
	/// the shell's own (the host's), which no teardown may signal. A child
	/// detached into its own session under `SameProcessGroup` (the default
	/// policy, `--foreground`, later pipeline stages) was reported in no group
	/// or in the pipeline leader's, so its background children were lost once
	/// it died.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn spawned_children_report_the_process_group_they_are_in() {
		use std::{collections::HashMap, sync::Arc};

		let pty = nix::pty::openpty(None, None).expect("open a pseudo-terminal");
		let tty = nix::unistd::ttyname(&pty.slave).expect("name the pseudo-terminal");
		let tty = tty.display();
		let shell_group = nix::unistd::getpgrp().as_raw();
		// `r` prints the pid and process group of the `sh` that runs it.
		let setup = r#"r='read -r p c s pp g x < /proc/$$/stat; echo "$p $g"'
f() { /bin/sh -c "$r" | /bin/sh -c "$r; cat"; }
"#;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut wrong = Vec::new();
		for (case, command) in [
			("a child", r#"/bin/sh -c "$r""#.to_owned()),
			("pipeline stages", "f".to_owned()),
			("a timeout operand", r#"timeout 5 /bin/sh -c "$r""#.to_owned()),
			("pipeline stages under timeout", "timeout 5 f".to_owned()),
			("a --foreground operand", r#"timeout --foreground 5 /bin/sh -c "$r""#.to_owned()),
			("pipeline stages under --foreground", "timeout --foreground 5 f".to_owned()),
			("a child reading a terminal", format!(r#"/bin/sh -c "$r" < {tty}"#)),
			(
				"a --foreground operand reading a terminal",
				format!(r#"timeout --foreground 5 /bin/sh -c "$r" < {tty}"#),
			),
		] {
			let log = Arc::new(SpawnLog::default());
			let mut params = shell.default_exec_params();
			params.set_spawn_observer(Arc::clone(&log) as Arc<dyn brush_core::SpawnObserver>);
			let ran = run_with_params(&mut shell, &format!("{setup}{command}"), params).await;
			assert_eq!(ran.status, 0, "{case}: {}", ran.stderr);
			let groups: HashMap<i32, i32> = ran
				.stdout
				.lines()
				.map(|line| {
					let (pid, group) = line.split_once(' ').expect("`pid group` line");
					(pid.parse().expect("pid"), group.parse().expect("group"))
				})
				.collect();
			assert!(!groups.is_empty(), "{case}: no child reported its group");
			let reported = log.0.lock().expect("spawn log lock").clone();
			for (pid, group) in groups {
				let reported_group = reported
					.iter()
					.find_map(|&(spawned, group)| (spawned == pid).then_some(group))
					.unwrap_or_else(|| panic!("{case}: child {pid} was not reported: {reported:?}"));
				let expected = (group != shell_group).then_some(group);
				if reported_group != expected {
					wrong.push(format!(
						"{case}: child {pid} is in group {group} (the shell's is {shell_group}), \
						 reported in {reported_group:?}"
					));
				}
			}
		}
		assert!(wrong.is_empty(), "children reported in the wrong group: {wrong:#?}");
	}

	/// The limit ends an in-process operand, as it ends the program GNU
	/// `timeout` runs: under Bash 5.2.21, `timeout 0.2 bash -c '/bin/sleep 5;
	/// echo next'` prints nothing and exits 124 (143 with `--preserve-status`,
	/// still 124 with `-k`). An `eval` or function operand went on to its
	/// next command, a new process included, once the limit had killed
	/// `sleep`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_in_process_operand_starts_nothing_after_the_limit() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut wrong = Vec::new();
		for (command, status) in [
			("timeout 0.2 eval '/bin/sleep 5; echo next'", 124),
			(r#"timeout 0.2 eval '/bin/sleep 5; /bin/sh -c "echo launched"'"#, 124),
			("f() { /bin/sleep 5; echo next; }; timeout 0.2 f", 124),
			("timeout --foreground 0.2 eval '/bin/sleep 5; echo next'", 124),
			("timeout --preserve-status 0.2 eval '/bin/sleep 5; echo next'", 143),
			(r#"timeout -k 0.4 0.2 eval '/bin/sleep 5; /bin/sh -c "echo launched"'"#, 124),
		] {
			let ran = run_in_process(&mut shell, command, None).await;
			if (ran.status, ran.stdout.as_str()) != (status, "") {
				wrong.push(format!("{command}: status {} and output {:?}, want {status} and none", ran.status, ran.stdout));
			}
		}
		assert!(wrong.is_empty(), "the limit did not stop the operand: {wrong:#?}");
	}

	/// Runs `command` in a fresh shell with every builtin, standard input
	/// closed and standard error dropped, and returns its status and output.
	/// Each row gets its own shell, so a row's functions and aliases cannot
	/// reach the next. The deadline is past every row's `-k`, so a row the
	/// limit cannot end fails instead of hanging.
	#[cfg(unix)]
	async fn run_row(command: &str) -> (u8, String) {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut stdout = tempfile::tempfile().expect("create stdout capture");
		let mut params = shell.default_exec_params();
		params.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().expect("null device"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout.try_clone().expect("clone stdout capture").into());
		params.set_fd(OpenFiles::STDERR_FD, brush_core::openfiles::null().expect("null device"));
		let result = tokio::time::timeout(
			Duration::from_secs(5),
			shell.run_string(command, &SourceInfo::default(), &params),
		)
		.await
		.unwrap_or_else(|_| panic!("`{command}` outlived its limit"))
		.expect("execute test command");
		stdout.seek(SeekFrom::Start(0)).expect("rewind stdout capture");
		let mut text = String::new();
		stdout.read_to_string(&mut text).expect("read stdout capture");
		(u8::from(result.exit_code), text)
	}

	/// Runs each `(row, command, status, output)` and lists every row whose
	/// status or standard output differs from what GNU `timeout` 9.4 gives,
	/// with Bash 5.2.21 running an in-process operand as `bash -c 'OPERAND'`.
	/// The row names the line of the oracle script that measured it. A row
	/// whose status comes from a handler the operand's program installs gives
	/// it a 1 s limit: under heavy load `/bin/sh` took longer than 0.2 s to
	/// install its `trap`, and the signal then ended it (143).
	#[cfg(unix)]
	async fn rows_unlike_gnu(rows: &[(&str, &str, u8, &str)]) -> Vec<String> {
		let mut wrong = Vec::new();
		for &(row, command, status, stdout) in rows {
			let (got_status, got_stdout) = run_row(command).await;
			if (got_status, got_stdout.as_str()) != (status, stdout) {
				wrong.push(format!(
					"{row} `{command}`: status {got_status} and output {got_stdout:?}, GNU gives \
					 {status} and {stdout:?}"
				));
			}
		}
		wrong
	}

	/// The shell looks a function up before it treats a name holding a slash
	/// as a path, so functions named `f/x` and `/bin/sleep` run in-process.
	/// `timeout` took them for programs and left the shell running them, so
	/// their next command ran once the limit had killed `sleep`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_function_named_like_a_path_stops_at_the_limit() {
		let wrong = rows_unlike_gnu(&[
			("A1", "f/x() { /bin/sleep 5; echo next; }; timeout 0.2 f/x", 124, ""),
			(
				"A2",
				r#"/bin/sleep() { command /bin/sleep "$@"; echo next; }; timeout 0.2 /bin/sleep 5"#,
				124,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// With `--preserve-status` the operand reports what Bash reports for it.
	/// Bash execs a program that `command` (at any depth, with `-p` or `--`)
	/// or an alias leaves as the whole command, so it ends with the program's
	/// status, 3 from its TERM handler, also when the handler finishes before
	/// `-k`. `command eval`, `builtin command`, an alias for `eval` and a
	/// function (one named `command` too) leave the shell running, and the
	/// signal ends the shell: 143. `timeout` reported 143 for all of them.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn preserve_status_reports_what_bash_reports_for_each_shell_wrapper() {
		let wrong = rows_unlike_gnu(&[
			(
				"B1",
				r#"timeout --preserve-status 1 command /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B2",
				r#"timeout --preserve-status 1 command -p /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B3",
				r#"timeout --preserve-status 1 command -- /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B4",
				r#"timeout --preserve-status 1 command command /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B8",
				r#"timeout --preserve-status -k 3 1 command /bin/sh -c 'trap "/bin/sleep .3; exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B9",
				r#"alias a=/bin/sh; timeout --preserve-status 1 a -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"B5",
				r#"timeout --preserve-status 0.2 command eval '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				143,
				"",
			),
			(
				"B7",
				r#"timeout --preserve-status 0.2 builtin command /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				143,
				"",
			),
			(
				"B11",
				r#"alias e=eval; timeout --preserve-status 0.2 e '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				143,
				"",
			),
			(
				"B6",
				r#"command() { /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'; }; timeout --preserve-status 0.2 command x"#,
				143,
				"",
			),
			(
				"B10",
				r#"f() { /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'; }; timeout --preserve-status 0.2 f"#,
				143,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// The shell expands aliases as Bash does. An alias does not expand
	/// inside its own text, and the replacement's first word expands in turn.
	/// A value ending in a blank makes the next word eligible, but only when
	/// that word is an unquoted literal: `'w'`, `"w"`, `\w` and `$v` stay as
	/// they are. The alias whose text ends last decides eligibility, and an
	/// alias expands again once its text has ended. Each row defines its
	/// aliases on the line before it uses them, as Bash requires. Brush
	/// substituted one alias for the command word only.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn aliases_expand_as_bash_expands_them() {
		let wrong = rows_unlike_gnu(&[
			("T4", "shopt -s expand_aliases; alias c='command ' p=/bin/sh\nc p -c 'exit 3'", 3, ""),
			("T5", "shopt -s expand_aliases; alias e='echo ' w=word\ne w", 0, "word\n"),
			("T6", "shopt -s expand_aliases; alias a=b b='echo ' w=word\na w", 0, "w\n"),
			("T7", "shopt -s expand_aliases; alias a='b ' b=echo w=word\na w", 0, "word\n"),
			("T8", "shopt -s expand_aliases; alias e='echo ' w='word ' x=X\ne w x x", 0, "word X x\n"),
			("T9", "shopt -s expand_aliases; alias e='echo ' w=word\ne e w", 0, "echo word\n"),
			("T10", "shopt -s expand_aliases; alias e='echo ' w=word\ne 'w'", 0, "w\n"),
			("T11", "shopt -s expand_aliases; alias e='echo ' w=word\ne \"w\"", 0, "w\n"),
			("T12", "shopt -s expand_aliases; alias e='echo ' w=word\ne \\w", 0, "w\n"),
			("T13", "shopt -s expand_aliases; alias e='echo ' w=word\nv=w; e $v", 0, "w\n"),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// A `timeout` operand's command word is looked up as the shell looks
	/// up a command word, aliases included: an alias does not expand inside
	/// its own text (`a=a`, `a=b b=a`: the function `a` runs), and the
	/// replacement's first word expands in turn (`a=b b=/bin/sh`: 3). The
	/// operand's later words are data: `timeout` re-reads them quoted, so no
	/// alias whose value ends in a blank can take them (`c='command '
	/// p=/bin/sh`: `command` runs the program `p`, 127, as GNU `timeout` gives
	/// for the program `c`).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_timeout_operand_s_command_word_is_the_only_alias_it_expands() {
		let wrong = rows_unlike_gnu(&[
			("L1", "a() { echo A; }; alias a=a; timeout 5 a", 0, "A\n"),
			("L2", "a() { echo A; }; b() { echo B; }; alias a=b b=a; timeout 5 a", 0, "A\n"),
			(
				"L3",
				r#"alias a=b b=/bin/sh; timeout --preserve-status 1 a -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"L4",
				r#"alias c='command ' p=/bin/sh; timeout --preserve-status 1 c p -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				127,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// An alias whose replacement ends in a blank makes the next *unquoted
	/// literal* word eligible for alias expansion. It must not make a quoted
	/// filename name an alias, and a `timeout` operand's data word is never
	/// an alias. This uses real files: with `rr='rm '` and `w=CHANGED`,
	/// `rr 'w'` removes `w`, and neither `rr 'w'` nor `timeout 5 rr w` removes
	/// `CHANGED`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_trailing_blank_alias_does_not_expand_a_quoted_filename() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let ran = run_in_process(
			&mut shell,
			"alias rr='rm ' w=CHANGED; printf one >w; printf two >CHANGED; rr 'w'; \
			 if test -e w; then printf w-remains; fi; \
			 if test -e CHANGED; then printf changed-remains; fi",
			None,
		)
		.await;
		assert_eq!(ran.status, 0, "{}", ran.stderr);
		assert_eq!(ran.stdout, "changed-remains");
		let ran = run_in_process(
			&mut shell,
			"printf one >w; timeout 5 rr w; if test -e CHANGED; then printf changed-remains; fi",
			None,
		)
		.await;
		assert_eq!(ran.stdout, "changed-remains", "{}", ran.stderr);
	}

	/// An alias whose text leads back to it through a wrapper that re-reads
	/// its operand as a new command line (`alias t='timeout 5 t'`, or through
	/// `u='nohup v' v='timeout 5 u'`) makes the shell recurse through it
	/// without end, since Bash's rule starts afresh at each re-read. Running
	/// such an operand overflows the stack, as Bash 5.2.21 does for its own
	/// re-reading analog `alias t='eval t'` (it dies of SIGSEGV, 139), so it
	/// is not run here. Classifying it must still end, and find the shell.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_alias_re_entering_through_its_wrapper_classifies_as_the_shell() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let ran = run_in_process(&mut shell, "alias t='timeout 5 t' u='nohup v' v='timeout 5 u'", None).await;
		assert_eq!(ran.status, 0, "{}", ran.stderr);
		for name in ["t", "u"] {
			assert!(
				classify_operand(&shell, &[name.to_owned()]).operand == Operand::Shell,
				"alias {name} must classify as the shell"
			);
		}
	}

	/// `env` (past its options and assignments, and with a `-S` string split
	/// as it splits it, `${VARNAME}` from the exported variables), `nohup`
	/// and a nested `timeout` are programs under GNU that exec their operand,
	/// so the limit's signal reaches the program they run, and
	/// `--preserve-status` reports its status: 3 from its TERM handler.
	/// `timeout` cancelled these builtins as if the shell ran them and
	/// reported 143. An `env -S` whose split expands to another `-S` of the
	/// same variable never stops splitting, under GNU too, so it runs nothing
	/// before the limit (124).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn preserve_status_reports_the_program_a_utility_wrapper_runs() {
		let wrong = rows_unlike_gnu(&[
			(
				"U1",
				r#"timeout --preserve-status 1 env /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"U6",
				r#"timeout --preserve-status 1 env -u HOME X=1 /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"S1",
				r#"timeout --preserve-status 1 env -S '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"S2",
				r#"export P=/bin/sh; timeout --preserve-status 1 env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"S3",
				r#"timeout --preserve-status 1 env -iS '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"U2",
				r#"timeout --preserve-status 1 nohup /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			(
				"U4",
				r#"timeout --preserve-status 1 timeout 5 /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				3,
				"",
			),
			("S4", r#"export V='-S ${V}'; timeout 0.2 env -S '${V}'"#, 124, ""),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}


	/// An `env` wrapper changes the environment its nested `env` receives.
	/// The classifier must use that changed environment for `${VARNAME}` in
	/// the nested `-S` string. Otherwise it takes the program path when
	/// brush runs `eval`, and `eval` starts `late` after the limit.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn nested_env_changes_the_environment_of_a_nested_split_string() {
		let wrong = rows_unlike_gnu(&[
			(
				"E1",
				r#"unset P; timeout --preserve-status -k 2 1 env P=/bin/sh env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"E2",
				r#"export P=/bin/sh; timeout --preserve-status -k 2 .3 env P=eval env -S '${P} "/bin/sleep 5; echo late"'"#,
				143,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}
	/// The limit's signal ends an in-process operand only when it would end
	/// what GNU runs. A shell (the operand `eval '/bin/sleep .5; echo next'`)
	/// goes on after CONT, WINCH and QUIT, which Bash ignores, and after a
	/// stop signal, which group mode follows with CONT: `next` prints, and the
	/// status is 124 or, with `--preserve-status`, the operand's own 0. HUP
	/// ends it (128+1), and the outer shell ignoring TERM changes nothing. A
	/// utility (`cat`, `sleep`) is its program: QUIT ends it (128+3), and
	/// CONT leaves it reading until `-k`. IO, which the BSDs and Apple's
	/// systems discard, ends a process on Linux (128+29). `timeout` cancelled
	/// the shell on every signal, and would have left a utility running on
	/// QUIT.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn the_limit_ends_an_in_process_operand_only_with_a_signal_that_ends_it() {
		let wrong = rows_unlike_gnu(&[
			("C1", "timeout -s CONT 0.2 eval '/bin/sleep .5; echo next'", 124, "next\n"),
			("C2", "timeout --preserve-status -s CONT 0.2 eval '/bin/sleep .5; echo next'", 0, "next\n"),
			("C3", "timeout --preserve-status -s WINCH 0.2 eval '/bin/sleep .5; echo next'", 0, "next\n"),
			("C4", "timeout --preserve-status -s QUIT 0.2 eval '/bin/sleep .5; echo next'", 0, "next\n"),
			("C5", "timeout --preserve-status -s TSTP 0.2 eval '/bin/sleep .5; echo next'", 0, "next\n"),
			("C8", "timeout --preserve-status -s HUP 0.2 eval '/bin/sleep .5; echo next'", 129, ""),
			(
				"C9",
				"trap '' TERM; timeout --preserve-status 0.2 eval '/bin/sleep .5; echo next'",
				143,
				"",
			),
			("U3", "timeout --preserve-status -s QUIT 0.2 cat /dev/zero > /dev/null", 131, ""),
			("U7", "timeout --preserve-status -s QUIT 0.2 sleep 5", 131, ""),
			("U5", "timeout --preserve-status -s CONT -k 1 0.2 cat /dev/zero > /dev/null", 137, ""),
			#[cfg(target_os = "linux")]
			("U8", "timeout --preserve-status -s IO 0.2 cat /dev/zero > /dev/null", 157, ""),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// Under `--foreground` a stop signal leaves the command stopped until
	/// `-k` kills it, so GNU exits 137 with no output, for an in-process
	/// operand and a program alike. The shell went on to `echo next` once the
	/// cancellation had killed `sleep` (147), or reported the stopped program
	/// and returned at once (148), leaving it stopped.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_stop_signal_under_foreground_holds_the_operand_until_the_kill() {
		let wrong = rows_unlike_gnu(&[
			(
				"C7s",
				"timeout --preserve-status --foreground -k 1.5 -s STOP 0.2 eval '/bin/sleep .5; echo next'",
				137,
				"",
			),
			(
				"D2s",
				"timeout --preserve-status --foreground -k 1.5 -s STOP 0.2 /bin/sh -c '/bin/sleep .5; echo \
				 next'",
				137,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// In group mode GNU follows the limit's signal with CONT, so STOP leaves
	/// nothing stopped: the operand goes on to print `next`. Measured, GNU
	/// hangs on these rows only because it signals its own group and stops
	/// itself before it sends the CONT; this builtin is not in the operand's
	/// group, so the rows follow GNU's code. Without the CONT, the shell
	/// reported the stopped program and returned at once (148), leaving it
	/// stopped.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn group_mode_follows_a_stop_signal_with_cont() {
		let wrong = rows_unlike_gnu(&[
			("C6", "timeout -s STOP 0.2 eval '/bin/sleep .5; echo next'", 124, "next\n"),
			(
				"C6s",
				"timeout --preserve-status -s STOP 0.2 /bin/sh -c '/bin/sleep .5; echo next'",
				0,
				"next\n",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// The outer limit's signal reaches the command of an inner `timeout` as
	/// GNU's inner program passes it on. That program passes on INT, QUIT,
	/// HUP, TERM and its own `-s` signal (USR1 under `-s USR1`: 3 from the
	/// command's handler), arming its own `-k` (137 once that kills a command
	/// that ignores TERM), and takes ALRM for its own expiry (124). It
	/// ignores CONT and WINCH, so a command that traps them goes on (0, and
	/// `next`), unless `--foreground` leaves the command in the outer group
	/// (5). STOP stops the inner program: group mode continues it, so the
	/// command goes on (this row follows GNU's code: measured, GNU stops its
	/// own group and hangs); under `--foreground` it holds until `-k` while
	/// the command finishes (137, and `next`). USR1 and KILL end the inner
	/// program at once (128+10, 137), leaving its command running under GNU
	/// and ending it here. `timeout` signalled the inner command directly.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inner_timeout_passes_on_what_gnu_s_timeout_passes_on() {
		let wrong = rows_unlike_gnu(&[
			(
				"N1",
				r#"timeout --preserve-status -s USR1 0.2 timeout 5 /bin/sh -c 'exec >/dev/null; trap "exit 3" USR1; /bin/sleep 3'"#,
				138,
				"",
			),
			(
				"N2",
				"timeout --preserve-status -s KILL 0.2 timeout 5 /bin/sh -c 'exec >/dev/null; /bin/sleep 3'",
				137,
				"",
			),
			(
				"N3",
				r#"timeout --preserve-status -s CONT 0.2 timeout 5 /bin/sh -c 'trap "exit 5" CONT; /bin/sleep .5; echo next'"#,
				0,
				"next\n",
			),
			(
				"N4",
				r#"timeout --preserve-status -s WINCH 0.2 timeout 5 /bin/sh -c 'trap "exit 5" WINCH; /bin/sleep .5; echo next'"#,
				0,
				"next\n",
			),
			(
				"N5",
				r#"timeout --preserve-status -s ALRM 0.2 timeout 5 /bin/sh -c 'trap "exit 3" TERM; /bin/sleep 5'"#,
				124,
				"",
			),
			(
				"N6",
				r#"timeout --preserve-status -s WINCH 1 timeout --foreground 5 /bin/sh -c 'trap "exit 5" WINCH; /bin/sleep 2; echo next'"#,
				5,
				"",
			),
			(
				"N7",
				r#"timeout --preserve-status 1 timeout -k 0.3 5 /bin/sh -c 'trap "" TERM; /bin/sleep 3'"#,
				137,
				"",
			),
			(
				"N8",
				r#"timeout --preserve-status -s USR1 1 timeout -s USR1 5 /bin/sh -c 'trap "exit 3" USR1; /bin/sleep 2'"#,
				3,
				"",
			),
			(
				"N9",
				"timeout --preserve-status --foreground -k 1.5 -s STOP 0.2 timeout 5 /bin/sh -c '/bin/sleep .5; echo \
				 next'",
				137,
				"next\n",
			),
			(
				"N10",
				r#"timeout --preserve-status -s STOP 0.2 timeout 5 /bin/sh -c 'trap "exit 5" CONT; /bin/sleep .5; echo next'"#,
				0,
				"next\n",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// An inner timeout's `-k` kills both the spawned process and an
	/// in-process operand. A deeper timeout that ignores the signal cannot
	/// discard a timer an outer inner timeout already armed. An inner
	/// `--foreground` timeout leaves its command in the outer group, which
	/// receives the original ALRM even when that inner timeout turns ALRM
	/// into its configured CONT.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_inner_kill_after_survives_absorption_and_stops_the_operand() {
		let wrong = rows_unlike_gnu(&[
			(
				"K1",
				r#"timeout --preserve-status -s CONT .3 timeout -s CONT -k .4 20 eval 'sleep 2; echo late > marker'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:137\n",
			),
			(
				"K2",
				"timeout --preserve-status -s CONT .3 timeout -s CONT -k .4 5 timeout 5 /bin/sleep 2",
				137,
				"",
			),
			(
				"K3",
				"timeout --preserve-status -s ALRM -k 2 .3 timeout --foreground -s CONT -k .4 5 /bin/sleep 2",
				124,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}
}
