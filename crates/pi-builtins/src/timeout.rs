//! `timeout` builtin, moved from `pi-shell`.

use std::{
	collections::HashMap,
	io::Write,
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

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

	fn before_reap(&self, pid: i32, unreaped: bool) {
		if let Some(parent) = &self.parent {
			parent.before_reap(pid, unreaped);
		}
		self.spawns.lock().before_reap(pid, unreaped);
	}
}

impl SpawnRecorder {
	/// Sends `signal` to every recorded child that is still there and, when
	/// `group` is set, to the group each recorded leader leads: listed while
	/// the shell has not reaped the leader, through the kernel's group signal
	/// (Linux 6.9 and later) after that. One wave delivers it (see
	/// [`crate::SignalWave`]), with the ledger locked, so the shell cannot
	/// reap a leader while the wave lists its group.
	fn signal(&self, signal: TrapSignal, group: bool) -> bool {
		let Ok(signal) = i32::try_from(signal) else {
			return false;
		};
		let mut spawns = self.spawns.lock();
		let wave = spawns.plan_wave(signal, group).deliver();
		spawns.record_reached(&wave);
		!wave.reached().is_empty() || !wave.members().is_empty() || !wave.kernel_leaders().is_empty()
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

/// An `--env0-from` file as the classifier found it.
#[cfg_attr(not(feature = "util.env"), allow(dead_code, reason = "only a nested `env` reads it"))]
enum Env0File {
	/// A regular file and its content.
	Data(Vec<u8>),
	/// `env` cannot read it, so it runs nothing.
	Unreadable,
	/// A pipe, terminal or descriptor path: reading it here would take the
	/// bytes `env` reads, so the environment past it stays unknown.
	Stream,
}

/// What the classifier carries while it follows wrapper commands: the
/// environment and directory the next `env` receives, the `--env0-from`
/// files read so far, and the inner `timeout`s passed on the way.
#[cfg_attr(
	not(feature = "util.env"),
	allow(dead_code, reason = "only a nested `env` reads the environment and its files")
)]
struct Follow<'a> {
	/// The known entries of the environment the next `env` receives (a
	/// lookup takes the first entry of a name, as `getenv` does).
	environment:  Vec<Vec<u8>>,
	/// Names known to be unset while `unknown_rest` holds.
	absent:       Vec<String>,
	/// Whether a variable neither in `environment` nor in `absent` is
	/// unknown: an `--env0-from` stream may have set it, which `env` reads
	/// only when it starts.
	unknown_rest: bool,
	/// The directory the next command runs in, which an `env -C` changes.
	directory:    PathBuf,
	/// `--env0-from` files by absolute path.
	files:        &'a HashMap<PathBuf, Env0File>,
	/// A file not yet in `files` that the classification needs.
	missing:      Option<PathBuf>,
	inner:        Vec<InnerTimeout>,
	/// Whether the arguments of the command the last `env` hands on hold
	/// values not known before it runs, so a wrapper among them cannot be
	/// followed.
	unknown_arguments: bool,
	/// When the limit fires: classification still under way then stops, as
	/// GNU `env` still splitting then dies of the signal.
	deadline:     Option<std::time::Instant>,
}

impl Follow<'_> {
	/// The value of `name` in the environment the next `env` receives:
	/// `None` when it is unset, [`crate::env::Unknown`] when a stream may
	/// have set it.
	#[cfg(feature = "util.env")]
	fn lookup(&self, name: &str) -> Result<Option<String>, crate::env::Unknown> {
		let known = self.environment.iter().find_map(|entry| {
			let value = entry.strip_prefix(name.as_bytes())?.strip_prefix(b"=")?;
			Some(String::from_utf8_lossy(value).into_owned())
		});
		match known {
			Some(value) => Ok(Some(value)),
			None if !self.unknown_rest || self.absent.iter().any(|absent| absent == name) => Ok(None),
			None => Err(crate::env::Unknown),
		}
	}

	/// Applies what an `env` does to the environment it passes on, as `env`
	/// itself builds it ([`crate::env::passed_environment`]), and to the
	/// directory its command runs in. `None` when `env` would refuse to run,
	/// or the classification needs a file not read yet.
	#[cfg(feature = "util.env")]
	fn apply(&mut self, command: &crate::env::CommandWords) -> Option<()> {
		// `env` reads its file in the directory it runs in, before it
		// changes directory for its command, and resolves the name as the
		// shell does.
		let env0 = match command.env0_from.as_deref() {
			None => Some(None),
			Some("-") => None,
			Some(file) => {
				let path = pi_vfs::absolute_path(&self.directory, Path::new(file));
				match self.files.get(&path) {
					Some(Env0File::Data(data)) => Some(Some(data.as_slice())),
					Some(Env0File::Unreadable) => return None,
					Some(Env0File::Stream) => None,
					None => {
						self.missing = Some(path);
						return None;
					},
				}
			},
		};
		match env0 {
			// A stream may set any variable, those known before too. `env`
			// then unsets and assigns as usual, and those names are known.
			None => {
				self.environment = crate::env::passed_environment(Vec::new(), command, Some(&[]))?;
				self.absent.clone_from(&command.unset);
				self.unknown_rest = true;
			},
			Some(env0) => {
				// The next `env` sees one value per name, the first that has
				// one: an entry without `=` holds no variable (`getenv` skips
				// it), so it hides no later assignment.
				let mut initial: Vec<Vec<u8>> = Vec::new();
				for entry in self.environment.drain(..) {
					let Some(equals) = entry.iter().position(|&byte| byte == b'=') else {
						continue;
					};
					if !initial.iter().any(|kept| kept.starts_with(&entry[..=equals])) {
						initial.push(entry);
					}
				}
				self.environment = crate::env::passed_environment(initial, command, env0)?;
				if command.clear_env {
					// `-i` drops what `env` received, so all is known again.
					self.absent.clear();
					self.unknown_rest = false;
				} else if self.unknown_rest {
					self.absent.extend(command.unset.iter().cloned());
				}
			},
		}
		// The shell checks the directory as spelled and keeps it normalized
		// lexically, without resolving symbolic links (a logical `cd`).
		if let Some(directory) = &command.chdir {
			self.directory = pi_vfs::normalize_lexically(&pi_vfs::absolute_path(&self.directory, Path::new(directory)));
		}
		Some(())
	}
}

/// An inner `timeout`'s `-k`: when it fires, which inner timeout armed it
/// (`depth`, 0 for the outermost), and whether that timeout signals its
/// process group (it is not `--foreground`).
#[derive(Clone, Copy)]
struct Kill {
	after: Duration,
	group: bool,
	depth: usize,
}

/// The `-k` of `a` or `b` that fires first.
fn earliest(a: Option<Kill>, b: Option<Kill>) -> Option<Kill> {
	match (a, b) {
		(Some(a), Some(b)) => Some(if b.after < a.after { b } else { a }),
		(a, b) => a.or(b),
	}
}

/// A signal that reaches the command, and whether its sender signals the
/// command's process group.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Sent {
	signal: TrapSignal,
	group:  bool,
}

/// What the limit's signal does once it has passed the inner `timeout`s.
/// `expired` names the inner timeouts (by depth) that took it for their own
/// limit: each reports 124 instead of its command's status unless it
/// preserves it. `kill` is the first `-k` that an inner timeout which passed
/// the signal on armed.
enum Delivery {
	/// The command receives each of `sent` (more than one when an inner
	/// `--foreground` timeout leaves it in an outer process group).
	Reaches {
		sent:    Vec<Sent>,
		expired: Vec<usize>,
		kill:    Option<Kill>,
	},
	/// An inner timeout ignores it, and its command goes on untouched.
	Absorbed { expired: Vec<usize>, kill: Option<Kill> },
	/// An inner timeout stops, and nothing continues it.
	Stops,
	/// The inner timeout at `depth` dies of `signal` before its command is
	/// reached.
	Ends {
		signal:  TrapSignal,
		depth:   usize,
		expired: Vec<usize>,
	},
}

impl Delivery {
	/// Adds what an inner timeout above this delivery did: a `-k` it armed,
	/// and whether it took the signal for its own limit.
	fn above(self, armed: Option<Kill>, expired_at: Option<usize>) -> Self {
		let add = |mut expired: Vec<usize>| {
			expired.extend(expired_at);
			expired
		};
		match self {
			Self::Reaches { sent, expired, kill } => {
				Self::Reaches { sent, expired: add(expired), kill: earliest(armed, kill) }
			},
			Self::Absorbed { expired, kill } => Self::Absorbed { expired: add(expired), kill: earliest(armed, kill) },
			Self::Ends { signal, depth, expired } => Self::Ends { signal, depth, expired: add(expired) },
			Self::Stops => Self::Stops,
		}
	}

	/// Joins what the command receives through an inner `--foreground`
	/// timeout (`self`) with what reaches it directly in the outer process
	/// group (`direct`). A death of a timeout on either path ends the
	/// operand; otherwise every signal arrives and the earliest `-k` fires.
	fn join(self, direct: Self) -> Self {
		let union = |mut a: Vec<usize>, b: Vec<usize>| {
			a.extend(b.into_iter().filter(|depth| !a.contains(depth)).collect::<Vec<_>>());
			a
		};
		match (self, direct) {
			(Self::Ends { signal, depth, expired }, other) | (other, Self::Ends { signal, depth, expired }) => {
				let more = match other {
					Self::Reaches { expired, .. } | Self::Absorbed { expired, .. } | Self::Ends { expired, .. } => expired,
					Self::Stops => Vec::new(),
				};
				Self::Ends { signal, depth, expired: union(expired, more) }
			},
			(Self::Stops, _) | (_, Self::Stops) => Self::Stops,
			(Self::Absorbed { expired: a, kill: ka }, Self::Absorbed { expired: b, kill: kb }) => {
				Self::Absorbed { expired: union(a, b), kill: earliest(ka, kb) }
			},
			(Self::Absorbed { expired: a, kill: ka }, Self::Reaches { sent, expired: b, kill: kb })
			| (Self::Reaches { sent, expired: b, kill: kb }, Self::Absorbed { expired: a, kill: ka }) => {
				Self::Reaches { sent, expired: union(a, b), kill: earliest(ka, kb) }
			},
			(
				Self::Reaches { sent: mut through, expired: a, kill: ka },
				Self::Reaches { sent, expired: b, kill: kb },
			) => {
				for one in sent {
					if !through.contains(&one) {
						through.push(one);
					}
				}
				Self::Reaches { sent: through, expired: union(a, b), kill: earliest(ka, kb) }
			},
		}
	}
}

/// Delivers `signal` from a sender that signals process groups when `group`
/// through the inner timeouts `inner[depth..]` to the command. GNU's
/// `timeout` passes on INT, QUIT, HUP, TERM and its own `-s` signal, turns
/// ALRM into its own expiry, ignores TTIN and TTOU, and is otherwise any
/// process: a signal it ignores by default leaves it and its command alone,
/// a stop signal stops it until a sender in group mode continues it, and any
/// other signal ends it, leaving its command running. An inner
/// `--foreground` timeout keeps its child in the sender's process group,
/// which a sender in group mode signals as well, whatever that timeout does
/// with it; a child that is itself a timeout without `--foreground` has its
/// own group, which the signal does not reach.
fn deliver(signal: TrapSignal, inner: &[InnerTimeout], depth: usize, group: bool) -> Delivery {
	let Some(first) = inner.get(depth) else {
		return Delivery::Reaches { sent: vec![Sent { signal, group }], expired: Vec::new(), kill: None };
	};
	let number = signal_number(signal);
	let through_first = if dispositions::caught_by_timeout(number) || signal == first.signal {
		// ALRM is its own limit expiring, whatever its `-s` signal is.
		let alarm = dispositions::alarm(number);
		let passed = if alarm { first.signal } else { signal };
		if passed.as_str() == "SIGKILL" && !first.foreground {
			// It sends KILL to its own process group, which it is in: it dies
			// with its command.
			Delivery::Ends {
				signal:  passed,
				depth,
				expired: alarm.then_some(depth).into_iter().collect(),
			}
		} else {
			let own = first.kill_after.map(|after| Kill { after, group: !first.foreground, depth });
			deliver(passed, inner, depth + 1, !first.foreground).above(own, alarm.then_some(depth))
		}
	} else if dispositions::ignored(number) || dispositions::ignored_by_timeout(number) {
		Delivery::Absorbed { expired: Vec::new(), kill: None }
	} else if dispositions::stops(number) {
		if group { Delivery::Absorbed { expired: Vec::new(), kill: None } } else { Delivery::Stops }
	} else {
		Delivery::Ends { signal, depth, expired: Vec::new() }
	};
	if !(group && first.foreground) {
		return through_first;
	}
	let direct = match inner.get(depth + 1) {
		Some(next) if !next.foreground => Delivery::Absorbed { expired: Vec::new(), kill: None },
		_ => deliver(signal, inner, depth + 1, group),
	};
	through_first.join(direct)
}

/// How the process below an inner timeout ended, as that timeout sees it.
#[derive(Clone, Copy)]
enum Outcome {
	/// It died of a signal.
	Died(TrapSignal),
	/// It exited with a status.
	Exited(u8),
}

/// The status this `timeout` reports for `seen`, the outcome below the
/// inner timeout at depth `from`, once each inner timeout above it has
/// reported it the way GNU's does. A timeout whose limit fired (`expired`)
/// reports 137 for a child that died of KILL (GNU forces that), else 124
/// unless it preserves the status (128 + the signal for a death). One whose
/// limit did not fire dies of the signal its child died of, or exits with
/// its child's status. This `timeout`'s own limit fired.
fn report(
	inner: &[InnerTimeout],
	expired: &[usize],
	from: usize,
	mut seen: Outcome,
	preserve: bool,
) -> u8 {
	let reported = |seen: Outcome, timed_out: bool, preserve: bool| match seen {
		Outcome::Died(signal) if !timed_out => Outcome::Died(signal),
		Outcome::Died(signal) if signal.as_str() == "SIGKILL" => Outcome::Exited(EXIT_KILLED),
		Outcome::Died(signal) => Outcome::Exited(if preserve { death_status(signal) } else { EXIT_TIMED_OUT }),
		Outcome::Exited(status) => Outcome::Exited(if timed_out && !preserve { EXIT_TIMED_OUT } else { status }),
	};
	for depth in (0..from).rev() {
		seen = reported(seen, expired.contains(&depth), inner[depth].preserve);
	}
	match reported(seen, true, preserve) {
		Outcome::Exited(status) => status,
		Outcome::Died(signal) => death_status(signal),
	}
}

/// Classifies the operand `words`, which the shell runs as a command line.
/// An `--env0-from` file on the way is read the way `env` reads it, through
/// the shell's filesystem.
async fn classify_operand<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	words: &[String],
	deadline: Option<std::time::Instant>,
) -> Classified {
	let mut files = HashMap::new();
	loop {
		let mut follow = Follow {
			environment:  crate::host::exported_env(shell)
				.into_iter()
				.map(|(name, value)| format!("{name}={value}").into_bytes())
				.collect(),
			absent:       Vec::new(),
			unknown_rest: false,
			directory:    shell.working_dir().to_path_buf(),
			files:        &files,
			missing:      None,
			inner:        Vec::new(),
			unknown_arguments: false,
			deadline,
		};
		let operand = classify_line(shell, words, &[], &mut follow);
		let Follow { missing, inner, .. } = follow;
		let Some(path) = missing else {
			return Classified { operand, inner };
		};
		let file = read_env0_file(shell, &path).await;
		files.insert(path, file);
	}
}

/// Reads an `--env0-from` file for the classifier, only when it is a
/// regular file: a descriptor path, pipe or terminal would lose to the
/// classifier the bytes `env` reads from it.
async fn read_env0_file<SE: brush_core::ShellExtensions>(
	shell: &brush_core::Shell<SE>,
	path: &Path,
) -> Env0File {
	let descriptor = ["/dev/fd/", "/dev/std", "/proc/self/fd/"]
		.iter()
		.any(|prefix| path.to_string_lossy().starts_with(prefix));
	if descriptor {
		return Env0File::Stream;
	}
	match shell.filesystem().metadata(path).await {
		Ok(metadata) if metadata.is_file() => match shell.filesystem().read(path).await {
			Ok(data) => Env0File::Data(data),
			Err(_) => Env0File::Unreadable,
		},
		Ok(_) => Env0File::Stream,
		Err(_) => Env0File::Unreadable,
	}
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
	follow: &mut Follow<'_>,
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
		Substituted::Unchanged => classify_simple(shell, words, provenance, true, follow),
		Substituted::Words(words, provenance) => {
			classify_simple(shell, &words, &provenance, true, follow)
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
/// re-read operand line. Every word after the command word that names an
/// alias is single-quoted there ([`crate::host::operand_command_line`]), so
/// only a word in command position can name an alias. The shell looks that
/// word up after expansion, quoted or not. An alias that expands to nothing
/// leaves the next word in command position.
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
	follow: &mut Follow<'_>,
) -> Operand {
	let Some(name) = words.first() else {
		return Operand::Shell;
	};
	let builtin = match shell.command_target(name, use_functions) {
		CommandTarget::External => return Operand::Program,
		CommandTarget::Function(_) => return Operand::Shell,
		CommandTarget::Builtin(builtin) => builtin,
	};
	let handed = handoff(words, follow);
	let (operand, line) = match handed {
		#[cfg(feature = "util.nohup")]
		Some(Handoff::Line(operand)) => (operand, true),
		Some(Handoff::Timeout(operand, timeout)) => {
			follow.inner.push(timeout);
			(operand, true)
		},
		#[cfg(feature = "util.env")]
		Some(Handoff::Environment(command)) => match follow.apply(&command) {
			Some(()) => {
				follow.unknown_arguments = command.unknown_arguments;
				(command.command, false)
			},
			// `env` refuses to run, or a file is still to be read.
			None => return Operand::Utility,
		},
		// What the wrapper runs shows only when it runs. The limit's signal
		// goes to the processes the operand started, as to a program, and
		// with none to receive it the operand is cancelled.
		Some(Handoff::Unknown) => return Operand::Program,
		#[cfg(feature = "builtin.command")]
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
		classify_line(shell, &operand, &operand_provenance, follow)
	} else {
		classify_simple(shell, &operand, &operand_provenance, false, follow)
	}
}

/// How a wrapper builtin hands its operand on.
enum Handoff {
	/// As a command line, which the shell parses and dispatches in full
	/// (`nohup`).
	#[cfg(feature = "util.nohup")]
	Line(Vec<String>),
	/// As a command line under an inner limit (`timeout`).
	Timeout(Vec<String>, InnerTimeout),
	/// As a simple command with an environment it applies (`env`).
	#[cfg(feature = "util.env")]
	Environment(crate::env::CommandWords),
	/// As a simple command, whose lookup skips functions (`command`).
	#[cfg(feature = "builtin.command")]
	Simple(Vec<String>),
	/// Not known before the wrapper runs: values only it reads (an
	/// `--env0-from` stream) decide it, or its `env -S` split grows past
	/// what the classifier follows.
	Unknown,
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
fn handoff(words: &[String], follow: &Follow<'_>) -> Option<Handoff> {
	match words[0].as_str() {
		// A wrapper's arguments decide what it runs.
		"command" | "env" | "nohup" | "timeout" if follow.unknown_arguments => Some(Handoff::Unknown),
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
		"env" => match crate::env::command_words(words, follow.deadline, |name| follow.lookup(name)) {
			Ok(command) => command.map(Handoff::Environment),
			Err(crate::env::Unknown) => Some(Handoff::Unknown),
		},
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

		// A child of the caller's token: when an outer `timeout` cancels its
		// operand, this operand stops in the same step, before the signal the
		// outer sends next can let it go on to its next command.
		let child_cancel = context
			.cancel_token()
			.map_or_else(CancellationToken::new, |token| token.child_token());
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

		// The limit runs from here, before the classification below, so a
		// slow classification never delays it. GNU: a duration of zero
		// disables the timeout entirely.
		let deadline_at = (!limit.is_zero()).then(|| time::Instant::now() + limit);
		let command_line = crate::host::operand_command_line(&args.command, |word, command_position| {
			context.shell.expand_command_alias(word, command_position).map(|(words, next)| (words.len(), next))
		});
		// GNU runs a program, which the limit's signal acts on. When the shell
		// runs the operand itself, or a utility in-process, no signal reaches
		// them: when the signal would end them the limit has to cancel the
		// operand, or `eval 'sleep 5; next'` runs `next` once the signal has
		// ended `sleep`. Without a limit nothing reads the classification.
		let Classified { operand, inner } = match deadline_at {
			Some(at) => classify_operand(context.shell, &args.command, Some(at.into_std())).await,
			None => Classified { operand: Operand::Program, inner: Vec::new() },
		};

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

		let deadline = async {
			match deadline_at {
				Some(at) => time::sleep_until(at).await,
				None => std::future::pending::<()>().await,
			}
		};
		tokio::pin!(deadline);

		tokio::select! {
			biased;
			() = &mut outer_cancelled => {
				child_cancel.cancel();
				return Ok(ExecutionExitCode::Interrupted.into());
			},
			result = &mut run_future => return result,
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
		let (sent, expired, inner_kill, held) = match deliver(signal, &inner, 0, !args.foreground) {
			Delivery::Reaches { sent, expired, kill } => (sent, expired, kill, false),
			Delivery::Absorbed { expired, kill } => (Vec::new(), expired, kill, false),
			Delivery::Stops => (Vec::new(), Vec::new(), None, true),
			Delivery::Ends { signal: died_of, depth, expired } => {
				// An inner timeout died of it: GNU reports that death at once
				// and leaves the inner command running. An in-process inner
				// timeout cannot outlive its operand, so the command ends
				// with it. One that sent KILL to its own group killed its
				// command too.
				child_cancel.cancel();
				if died_of.as_str() == "SIGKILL" {
					spawns.signal(died_of, true);
				}
				return Ok(ExecutionResult::new(report(
					&inner,
					&expired,
					depth,
					Outcome::Died(died_of),
					args.preserve_status,
				)));
			},
		};
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
		let ending = sent
			.iter()
			.find(|one| signal_effect(one.signal, operand) == SignalEffect::Ends)
			.map(|one| one.signal);
		let stops = sent
			.iter()
			.any(|one| !one.group && signal_effect(one.signal, operand) == SignalEffect::Stops);
		// An in-process operand the signal ends is cancelled before the signal
		// goes out: a child it waits for could die of the signal first, and
		// the shell would start its next command.
		let ends_in_process = ending.is_some() && matches!(operand, Operand::Shell | Operand::Utility);
		if ends_in_process {
			child_cancel.cancel();
		}
		// Every signal is sent: one that reached a process must not skip the
		// next.
		let mut signalled = false;
		for one in &sent {
			signalled |= spawns.signal(one.signal, one.group);
		}
		// GNU follows any other signal with CONT in group mode, so a stopped
		// child receives it and a stop signal leaves nothing stopped.
		if sent
			.iter()
			.any(|one| one.group && !matches!(one.signal.as_str(), "SIGKILL" | "SIGCONT"))
			&& let Ok(cont) = TrapSignal::try_from("CONT")
		{
			spawns.signal(cont, true);
		}
		let (cancelled, stopped) = match operand {
			_ if sent.is_empty() => (false, held),
			Operand::Program if signalled => (false, stops),
			Operand::Program => (ending.is_some(), false),
			Operand::Shell | Operand::Utility => (ending.is_some(), stops),
		};
		if cancelled && !ends_in_process {
			child_cancel.cancel();
		}
		let mut killed = signal.as_str() == "SIGKILL";
		// What the inner timeout whose `-k` fired leaves its parent: a
		// `--foreground` one sends KILL to its child only and exits 137, any
		// other kills its whole group, itself included.
		let mut inner_killed: Option<(usize, Outcome)> = None;

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
			match inner_kill {
				Some(kill) => time::sleep(kill.after).await,
				None => std::future::pending().await,
			}
		};
		tokio::pin!(inner_kill_deadline);
		let inner_kill_pending = inner_kill.is_some();

		let child_result = loop {
			tokio::select! {
				biased;
				() = &mut outer_cancelled => {
					child_cancel.cancel();
					return Ok(ExecutionExitCode::Interrupted.into());
				},
				result = &mut run_future, if !stopped => break reap(result)?,
				() = &mut inner_kill_deadline, if inner_kill_pending => {
					if let Some(kill) = inner_kill {
						spawns.signal(kill_signal(), kill.group);
						let left = if kill.group { Outcome::Died(kill_signal()) } else { Outcome::Exited(EXIT_KILLED) };
						inner_killed = Some((kill.depth, left));
					}
					// Stop the in-process operand as well: otherwise
					// `eval 'sleep; late'` is reported killed but still executes
					// `late`.
					child_cancel.cancel();
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

		// Exit status per GNU: 137 once this `timeout` sent SIGKILL, by `-s`
		// or by `-k`, with or without `--preserve-status`: the operand's result
		// after `-k` races the cancellation that follows the kill and can read
		// 130. Otherwise what the inner timeouts report for the inner `-k`, or
		// for the command, which died of the signal that cancelled it or
		// exited with its own status. A cancelled operand's own status races
		// the shell's cancellation, so the delivered signal (128 + N) stands
		// for it, as Bash reports for a shell operand the signal ended
		// (`timeout --preserve-status .2 bash -c 'sleep 5; next'` exits 143).
		if killed {
			return Ok(ExecutionResult::new(EXIT_KILLED));
		}
		let (from, seen) = match (inner_killed, child_result) {
			(Some(killed_at), _) => killed_at,
			(None, Some(result)) if !cancelled => (inner.len(), Outcome::Exited(u8::from(result.exit_code))),
			(None, _) => (inner.len(), Outcome::Died(ending.unwrap_or(signal))),
		};
		Ok(ExecutionResult::new(report(&inner, &expired, from, seen, args.preserve_status)))
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
		params: brush_core::ExecutionParameters,
	) -> Ran {
		run_with_params_within(shell, command, params, Duration::from_secs(1)).await
	}

	/// [`run_with_params`] for a command that runs longer than one second:
	/// it fails only when the command has not returned by `deadline`.
	#[cfg(unix)]
	async fn run_with_params_within(
		shell: &mut Shell<DefaultShellExtensions>,
		command: &str,
		mut params: brush_core::ExecutionParameters,
		deadline: Duration,
	) -> Ran {
		let mut stdout = tempfile::tempfile().expect("create stdout capture");
		let mut stderr = tempfile::tempfile().expect("create stderr capture");
		params.set_fd(OpenFiles::STDIN_FD, brush_core::openfiles::null().expect("null device"));
		params.set_fd(OpenFiles::STDOUT_FD, stdout.try_clone().expect("clone stdout capture").into());
		params.set_fd(OpenFiles::STDERR_FD, stderr.try_clone().expect("clone stderr capture").into());
		let result = tokio::time::timeout(deadline, shell.run_string(command, &SourceInfo::default(), &params))
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

	/// A timeout's group-mode wave reaches a joined pipeline stage through its
	/// leader's group. The recorder must not then deliver the same signal to
	/// that stage directly: shells run one TERM trap for each TERM they take.
	#[cfg(unix)]
	#[test]
	fn recorder_signals_a_group_member_once_per_wave() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
			thread,
			time::Instant,
		};

		use brush_core::traps::TrapSignal;
		use parking_lot::Mutex;

		use super::SpawnRecorder;
		use crate::{PinnedProcess, ProcessStatus, SpawnLedger, pinned_process::tests::ProcessGuard};

		// Two TERMs sent back to back merge while both are pending, so a
		// single attempt can pass with the defect; one in several does not.
		for attempt in 0..40 {
			let dir = tempfile::tempdir().expect("trap directory");
			// The leader starts a member of its own group (a joined pipeline
			// stage) whose TERM trap appends one `x` per TERM it takes.
			let script = r#"sh -c 'trap "printf x >> runs; sleep 0.3; exit 0" TERM
: > ready
while :; do :; done' &
echo "$!"
while :; do :; done"#;
			let mut leader = Command::new("sh")
				.args(["-c", script])
				.current_dir(dir.path())
				.process_group(0)
				.stdout(Stdio::piped())
				.spawn()
				.expect("start group leader");
			let mut output = BufReader::new(leader.stdout.take().expect("leader stdout"));
			let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
			let mut guard = ProcessGuard::new(leader);
			let mut line = String::new();
			output.read_line(&mut line).expect("read joined member pid");
			let member_pid = line.trim().parse::<i32>().expect("member pid");
			let leader_pin = PinnedProcess::from_pid(leader_pid).expect("pin group leader");
			let member_pin = PinnedProcess::from_pid(member_pid).expect("pin joined member");
			guard.pin(&member_pin);
			let deadline = Instant::now() + Duration::from_secs(5);
			while !dir.path().join("ready").exists() {
				assert!(Instant::now() < deadline, "attempt {attempt}: the member never set its trap");
				thread::sleep(Duration::from_millis(10));
			}
			assert_eq!(member_pin.group_id(), Some(leader_pid), "the member joined the leader's group");

			let recorder = SpawnRecorder { spawns: Mutex::new(SpawnLedger::default()), parent: None };
			{
				let mut spawns = recorder.spawns.lock();
				spawns.record(Some(leader_pid), Some(leader_pin));
				spawns.record(Some(leader_pid), Some(member_pin.clone()));
			}
			let term = TrapSignal::try_from("TERM").expect("TERM is a signal");
			assert!(recorder.signal(term, true), "attempt {attempt}: the wave must reach the group");

			let deadline = Instant::now() + Duration::from_secs(5);
			while member_pin.status() == ProcessStatus::Running && Instant::now() < deadline {
				thread::sleep(Duration::from_millis(10));
			}
			assert!(
				member_pin.status() != ProcessStatus::Running,
				"attempt {attempt}: the member must end after its TERM trap"
			);
			let runs = std::fs::read_to_string(dir.path().join("runs")).expect("TERM trap ran");
			assert_eq!(runs, "x", "attempt {attempt}: the member must take TERM once");
		}
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
	///
	/// The operand writes its pid to `ready` once its `trap "" TERM` is in
	/// place. An attempt without `ready` took TERM before the trap (a machine
	/// so loaded that `sh` needed more than the 1 s limit to start), so it
	/// shows nothing about the status and is not counted.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn preserve_status_after_kill_escalation_reports_137() {
		/// Kills the operand and its `sleep` when an attempt ends, passed or
		/// failed, if `timeout`'s SIGKILL did not: both ignore TERM. Each pid
		/// is pinned and checked against what the test started before the kill.
		struct OperandGuard<'a>(&'a std::path::Path);

		impl Drop for OperandGuard<'_> {
			fn drop(&mut self) {
				for (file, word) in [("ready", "trap"), ("sleep_pid", "sleep")] {
					let Some(pid) = std::fs::read_to_string(self.0.join(file))
						.ok()
						.and_then(|text| text.trim().parse::<i32>().ok())
					else {
						continue;
					};
					if let Some(process) = crate::PinnedProcess::from_pid(pid)
						&& process.args().iter().any(|arg| arg.contains(word))
					{
						let _ = process.kill(libc::SIGKILL);
					}
				}
			}
		}

		const COUNTED: u32 = 5;
		const ATTEMPTS: u32 = 20;
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		let mut counted = 0;
		for attempt in 0..ATTEMPTS {
			for file in ["ready", "sleep_pid"] {
				let _ = std::fs::remove_file(dir.path().join(file));
			}
			let _guard = OperandGuard(dir.path());
			let params = shell.default_exec_params();
			let ran = run_with_params_within(
				&mut shell,
				"timeout --preserve-status -k 0.1 1 /bin/sh -c 'trap \"\" TERM; echo $$ > ready; /bin/sleep \
				 30 & echo $! > sleep_pid; wait'",
				params,
				Duration::from_secs(10),
			)
			.await;
			if !dir.path().join("ready").exists() {
				continue;
			}
			assert_eq!(ran.status, 137, "attempt {attempt}: {}", ran.stderr);
			counted += 1;
			if counted == COUNTED {
				return;
			}
		}
		panic!("only {counted} of {ATTEMPTS} operands set their TERM trap within the 1 s limit");
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
			("T14", "shopt -s expand_aliases; alias e='echo ' w=word\ne 2>/dev/null w", 0, "w\n"),
			("T15", "shopt -s expand_aliases; alias e='echo ' w=word\ne <(:) w | cut -d' ' -f2", 0, "w\n"),
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
	/// filename name an alias, nor a word that a redirection separates from
	/// the alias, and a `timeout` operand's data word is never an alias. This
	/// uses real files: with `rr='rm '` and `w=CHANGED`, `rr 'w'` and
	/// `rr >log w` remove `w`, and none of them nor `timeout 5 rr w` removes
	/// `CHANGED`.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_trailing_blank_alias_does_not_expand_a_quoted_filename() {
		let dir = tempfile::tempdir().expect("create scratch dir");
		let mut shell = full_shell(dir.path()).await;
		for removal in ["rr 'w'", "rr >log w", "timeout 5 rr w"] {
			let ran = run_in_process(
				&mut shell,
				&format!(
					"alias rr='rm ' w=CHANGED; printf one >w; printf two >CHANGED; {removal}; \
					 if test -e w; then printf w-remains; fi; \
					 if test -e CHANGED; then printf changed-remains; fi"
				),
				None,
			)
			.await;
			assert_eq!(ran.status, 0, "{removal}: {}", ran.stderr);
			assert_eq!(ran.stdout, "changed-remains", "{removal}: {}", ran.stderr);
		}
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
				classify_operand(&shell, &[name.to_owned()], None).await.operand == Operand::Shell,
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
			(
				"S5",
				r#"export V=HOME; timeout --preserve-status 1 env -S '-u ${V}' -S '-u ${V}' -S '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// `env` stops splitting only when its argument list stops changing,
	/// however many independent `-S` options it holds: 1,025 of them still
	/// leave GNU `env` its program, whose TERM handler exits 3.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn many_independent_split_strings_still_run_the_program() {
		let splits = " -S '-u ${V}'".repeat(1025);
		let command = format!(
			r#"export V=HOME; timeout --preserve-status 1 env{splits} -S '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#
		);
		let wrong = rows_unlike_gnu(&[("S6", command.as_str(), 3, "")]).await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// `env` splits a `-S` chain until it ends, however many rounds that
	/// takes without the argument list shrinking: a 200-link chain of
	/// variables (`V000='-S${V001}'` … `V200=/bin/sh`) still leaves GNU `env`
	/// its program, whose TERM handler exits 3. A chain that comes back to an
	/// earlier state never ends, under GNU too, so the limit fires on time
	/// and finds `env` still splitting (124), even when the cycle's rounds
	/// split strings of different lengths.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn env_split_chains_stop_exactly_when_gnu_env_stops() {
		let links = 200;
		let mut chain = String::new();
		for link in 0..links {
			chain.push_str(&format!("export V{link:03}='-S${{V{:03}}}'; ", link + 1));
		}
		let command = format!(
			r#"{chain}export V{links:03}=/bin/sh; timeout --preserve-status -k 3 1 env -S '${{V000}}' -c 'trap "exit 3" TERM; /bin/sleep 3'"#
		);
		let wrong = rows_unlike_gnu(&[
			("S7", command.as_str(), 3, ""),
			(
				"S8",
				"export A='-S${LONG}' LONG='-S${A}'; timeout -k 1 .2 env -S '${A}'; echo status:$?",
				0,
				"status:124\n",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// An `env` wrapper changes the environment its nested `env` receives.
	/// The classifier must use that changed environment for `${VARNAME}` in
	/// the nested `-S` string, also the entries an `--env0-from` file gives
	/// (GNU coreutils 9.4 has no `--env0-from`; its analog assigns them).
	/// Otherwise it takes the program path when brush runs `eval`, and
	/// `eval` starts `late` after the limit. An `env -i` after an
	/// `--env0-from` stream knows its environment again (E8), and a file
	/// entry without `=` holds no variable, so it hides no later one (E9).
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
			(
				"E3",
				r#"printf 'P=/bin/sh\0' >envfile; timeout --preserve-status 1 env --env0-from=envfile env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"E4",
				r#"mkdir sub; printf 'P=/bin/sh\0' >sub/envfile; timeout --preserve-status -k 4 1 env -C sub env --env0-from=envfile env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"E5",
				r#"mkdir sub; printf 'P=/bin/sh\0' >envfile; printf 'P=eval\0' >sub/envfile; timeout --preserve-status -k 4 .3 env -C sub env --env0-from=envfile env -S '${P} "/bin/sleep 2; echo late > marker"'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:143\n",
			),
			(
				"E6",
				r#"printf 'P=/bin/sh\0P=eval\0' >envfile; timeout --preserve-status -k 4 1 env -i --env0-from=envfile env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 5"'"#,
				3,
				"",
			),
			(
				"E7",
				r#"printf 'P=eval\0P=/bin/sh\0' >envfile; timeout --preserve-status -k 4 .3 env -i --env0-from=envfile env -S '${P} "/bin/sleep 2; echo late > marker"'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:143\n",
			),
			(
				"E8",
				r#"printf 'IGNORED=x\0' | timeout --preserve-status -k 3 1 env --env0-from=- env -i P=/bin/sh env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 3"'"#,
				3,
				"",
			),
			(
				"E9",
				r#"printf 'P\0P=/bin/sh\0' >envfile; timeout --preserve-status -k 3 1 env -i --env0-from=envfile env env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 3"'"#,
				3,
				"",
			),
			(
				"E10",
				r#"printf 'IGNORED=x\0' | timeout --preserve-status -k 3 1 env --env0-from=- env P=/bin/sh env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 3"'"#,
				3,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// What an `env` runs can depend on values only it reads, from an
	/// `--env0-from` stream (GNU coreutils 9.4 has no `--env0-from`; its
	/// analog assigns them). A streamed `P=/bin/sh` makes `env -S '${P}'` run
	/// the program, whose TERM handler exits 3, from standard input (F1) or
	/// a named pipe (F2). Such a value in an argument leaves the command word
	/// to decide: `eval` is the shell, which the signal ends before `late`
	/// (F3), while a wrapper's arguments decide what it runs, so `nohup` runs
	/// the program (F4). An unknown value can also decide the split's syntax:
	/// unset, `${U}` starts no argument, so the `#` after it comments out the
	/// rest, an unterminated quote included; set, the `#` is a literal and the
	/// quote makes `env` refuse. Here `U` is unset, so `env` runs the program
	/// (F6). `timeout` took an unknown value for an `env` that runs nothing
	/// and cancelled the program (143) in F1, F2, F4 and F6.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_command_only_a_streamed_environment_names_keeps_its_signal() {
		let wrong = rows_unlike_gnu(&[
			(
				"F1",
				r#"printf 'P=/bin/sh\0' | timeout --preserve-status -k 2 1 env --env0-from=- env -S '${P}' -c 'trap "exit 3" TERM; /bin/sleep 3'"#,
				3,
				"",
			),
			(
				"F2",
				r#"mkfifo f; printf 'P=/bin/sh\0' >f & timeout --preserve-status -k 2 1 env --env0-from=f env -S '${P}' -c 'trap "exit 3" TERM; /bin/sleep 3'"#,
				3,
				"",
			),
			(
				"F3",
				r#"printf 'X=1\0' | timeout --preserve-status -k 2 .3 env --env0-from=- env -S 'eval "/bin/sleep 2; echo late > marker; : ${X}"'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:143\n",
			),
			(
				"F4",
				r#"printf 'P=/bin/sh\0' | timeout --preserve-status -k 2 1 env --env0-from=- env -S 'nohup ${P} -c "trap \"exit 3\" TERM; /bin/sleep 3"'"#,
				3,
				"",
			),
			(
				"F6",
				r#"printf 'X=1\0' | timeout --preserve-status -k 2 1 env -i --env0-from=- env -S '/bin/sh -c "trap \"exit 3\" TERM; /bin/sleep 3" ${U}# "'"#,
				3,
				"",
			),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// The classifier follows `env -S` splits only while the argument list
	/// stays under its bound; `env` itself splits without one. Twenty-one
	/// splits of `-u` and a 100,000-byte name pass that bound on the way to
	/// `/bin/sh`, which GNU `env` still runs, and whose TERM handler exits 3.
	/// `timeout` took the bound for an `env` that runs nothing and cancelled
	/// the program (143).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn an_env_split_past_the_classifier_bound_keeps_its_signal() {
		let unset = format!("-u {}", "x".repeat(100_000));
		let splits = vec!["-S${S}"; 21].join(" ");
		let command = format!(
			r#"export S='{unset}' W='{splits} /bin/sh'; timeout --preserve-status -k 2 2 env -S '${{W}}' -c 'trap "exit 3" TERM; /bin/sleep 4'"#
		);
		let (status, stdout) = run_row(&command).await;
		assert_eq!(
			(status, stdout.as_str()),
			(3, ""),
			"F5: GNU `env` runs `/bin/sh`, whose TERM handler exits 3"
		);
	}

	/// An `env -C` directory is the one the shell then runs in: checked as
	/// spelled and kept normalized lexically, without resolving symbolic links
	/// (a logical `cd`). So after `env -C a/link env -C ..`, where `a/link`
	/// points to `../b/c`, the next `env --env0-from=f` reads `a/f`, and the
	/// classifier must read that file too. Here `a/f` names the program, whose
	/// TERM handler exits 3; `b/f`, which a physical `..` reaches, names
	/// `eval`. GNU `env` resolves `..` physically, so it has no matching row:
	/// this asserts that the classification agrees with what the operand runs.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn env_minus_c_resolves_the_directory_as_the_shell_does() {
		let (status, stdout) = run_row(
			r#"mkdir -p a b/c; ln -s ../b/c a/link; printf 'P=/bin/sh\0' >a/f; printf 'P=eval\0' >b/f; timeout --preserve-status -k 3 1 env -C a/link env -C .. env --env0-from=f env -S '${P} -c "trap \"exit 3\" TERM; /bin/sleep 3"'"#,
		)
		.await;
		assert_eq!((status, stdout.as_str()), (3, ""), "the classifier read a different file than the operand");
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
	/// in-process operand. A `--foreground` inner timeout kills its child and
	/// exits 137, which the outer reports only under `--preserve-status`
	/// (else 124, as its own limit fired). Any other inner timeout kills its
	/// whole process group, itself included, and the outer reports that death
	/// by KILL as 137 either way. A deeper timeout that ignores the signal
	/// cannot discard a timer an outer inner timeout already armed, also when
	/// an inner `--foreground` timeout lets the signal past; a deeper timeout
	/// without `--foreground` has its own process group, which the outer's
	/// signal does not reach. A `--foreground` timeout leaves its command in
	/// the outer group, which receives the original signal too: ALRM ends an
	/// `eval` there, whatever the inner timeout turns ALRM into. Each `eval`
	/// row checks `marker` as soon as `timeout` returns: GNU's analog leaves a
	/// deeper process running, which writes it later.
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
			(
				"K4",
				r#"timeout --preserve-status -s CONT .3 timeout --foreground -s CONT -k .4 20 timeout 20 eval '/bin/sleep 3; echo late > marker'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:137\n",
			),
			(
				"K5",
				r#"timeout --preserve-status -s ALRM .3 timeout --foreground -s CONT 20 eval '/bin/sleep 2; echo late > marker'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:124\n",
			),
			("K6", "timeout -s CONT .3 timeout --foreground -s CONT -k .4 5 /bin/sleep 2", 124, ""),
			(
				"K7",
				"timeout --preserve-status -s CONT .3 timeout --foreground -s CONT -k .4 5 /bin/sleep 2",
				137,
				"",
			),
			(
				"K8",
				r#"timeout -s CONT -k 2 .3 timeout -s CONT -k .4 5 eval 'sleep 1.5; echo late > marker'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:137\n",
			),
			("K9", "timeout -s CONT .1 timeout -s CONT -k .3 5 eval 'sleep .5; echo completed'", 137, ""),
			(
				"K10",
				r#"timeout --preserve-status -s ALRM -k 2 .3 timeout --foreground -s CONT -k .4 5 timeout 5 eval 'sleep 1.5; echo late > marker'; s=$?; if test -e marker; then printf marker-created\\n; fi; printf status:$s\\n"#,
				0,
				"status:137\n",
			),
			(
				"K11",
				"timeout --preserve-status -s ALRM -k 3 1 timeout -s KILL 10 /bin/sleep 5",
				137,
				"",
			),
			("K12", "timeout -s ALRM -k 3 1 timeout -s KILL 10 /bin/sleep 5", 137, ""),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}

	/// `timeout` and `nohup` re-read their operand as a command line, and the
	/// re-read keeps the operand's own words: a keyword pipeline such as
	/// `time -p` still takes `-p` as its option (status 0, as Bash's keyword
	/// gives), where quoting every later word made `-p` a command (127).
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_re_read_operand_keeps_its_keyword_options() {
		let wrong = rows_unlike_gnu(&[
			("O1", "timeout 5 time -p /bin/true", 0, ""),
			("O2", "nohup time -p /bin/true", 0, ""),
			("O3", "alias -- -p=BOGUS; timeout 5 time -p /bin/true", 0, ""),
			("O4", "alias -- -p=BOGUS; nohup time -p /bin/true", 0, ""),
		])
		.await;
		assert!(wrong.is_empty(), "{wrong:#?}");
	}
}
