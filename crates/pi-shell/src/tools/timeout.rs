//! `timeout [-s SIG] [-k DUR] [--preserve-status] [--foreground] [-v]
//! DURATION COMMAND [ARG]...`, as GNU and pi's builtin run it.
//!
//! The command runs in a labeled subshell of the caller (functions and
//! builtins too, as pi's builtin re-entered the interpreter). At the
//! deadline the tree gets the signal as a process group would
//! ([`SigTarget::Label`]); `timeout` then waits for the tree and for the
//! externals it started (an external the tree abandoned, say a `sh` that
//! ignores `TERM`), sends `KILL` to both after `-k`, and gives up waiting
//! [`REAP_AFTER_KILL`] after that. Exit status: the command's when it
//! finishes in time; 124 after the deadline; 137 once `KILL` was sent;
//! the command's own under `--preserve-status`; 125 for timeout's own
//! errors (bad usage, interval or signal).

use std::time::Duration;

use bstr::{BString, ByteSlice};

use super::{Child, Out, Turn, nanos, signal_os};
use crate::bash::{CallOutcome, Platform, ShellApi, SigTarget, Signal, ToolCall};

/// GNU timeout's exit status for its own usage or internal errors.
const EXIT_FAILURE: i32 = 125;
/// GNU timeout's exit status when the time limit expired.
const EXIT_TIMED_OUT: i32 = 124;
/// 128 + `SIGKILL`.
const EXIT_KILLED: i32 = 137;

/// How long `timeout` still waits for the command after sending `KILL`
/// (a wedged tree must not hang it).
const REAP_AFTER_KILL: Duration = Duration::from_secs(2);

/// How often a timed-out command's externals are checked for their exit
/// (nothing wakes the driver when an abandoned external exits).
const RECHECK: Duration = Duration::from_millis(20);

const USAGE_HINT: &str = "Try 'timeout --help' for more information.\n";

const HELP: &str = "\
Usage: timeout [OPTION] DURATION COMMAND [ARG]...
  or:  timeout [OPTION]
Start COMMAND, and kill it if still running after DURATION.

  -s, --signal=SIGNAL      specify the signal to be sent on timeout;
                             SIGNAL may be a name like 'HUP' or a number
  -k, --kill-after=DURATION
                           also send a KILL signal if COMMAND is still running
                             this long after the initial signal was sent
      --preserve-status    exit with the same status as COMMAND, even when
                             the command times out
      --foreground         when the time limit expires, signal only COMMAND's
                             own processes, not the process groups they lead
  -v, --verbose            diagnose to stderr any signal sent upon timeout
      --help               display this help and exit
      --version            output version information and exit

DURATION is a floating point number with an optional suffix: 's' for seconds
(the default), 'm' for minutes, 'h' for hours or 'd' for days. A duration of
0 disables the associated timeout.

If the command times out, and --preserve-status is not set, then exit with
status 124. Otherwise, exit with the status of COMMAND. If no signal is
specified, send the TERM signal upon timeout. If the command is killed by
the KILL signal, the exit status is 137. Timeout's own failures exit 125.
";

/// Parsed options.
#[derive(Debug, PartialEq)]
struct Options {
	signal:     Signal,
	/// `None`: no time limit (`0`).
	limit:      Option<Duration>,
	kill_after: Option<Duration>,
	preserve:   bool,
	foreground: bool,
	verbose:    bool,
	command:    Vec<BString>,
}

/// What an invocation asks for.
#[derive(Debug, PartialEq)]
enum Parsed {
	Run(Options),
	/// Print this on stdout, exit 0.
	Print(String),
	/// Print this on stderr, exit 125.
	Fail(String),
}

/// Long options, for unique-abbreviation matching as getopt does; `true`
/// when the option takes a value.
const LONG: [(&str, bool); 7] = [
	("signal", true),
	("kill-after", true),
	("preserve-status", false),
	("foreground", false),
	("verbose", false),
	("help", false),
	("version", false),
];

fn long(spelled: &str) -> Result<(&'static str, bool), String> {
	if let Some(&(name, value)) = LONG.iter().find(|(name, _)| *name == spelled) {
		return Ok((name, value));
	}
	let mut found = LONG.iter().filter(|(name, _)| name.starts_with(spelled));
	match (found.next(), found.next()) {
		(Some(&(name, value)), None) => Ok((name, value)),
		(Some(_), Some(_)) => {
			Err(format!("timeout: option '--{spelled}' is ambiguous\n{USAGE_HINT}"))
		},
		_ => Err(format!("timeout: unrecognized option '--{spelled}'\n{USAGE_HINT}")),
	}
}

/// A hyphenated operand that is a (negative) number: the duration, so
/// `timeout -1 cmd` reports an invalid interval, as pi's builtin did.
fn numeric(arg: &str) -> bool {
	arg.strip_prefix('-')
		.and_then(|rest| rest.chars().next())
		.is_some_and(|c| c.is_ascii_digit() || c == '.')
}

/// Parse `argv` (with `timeout` itself) the way GNU's `getopt_long` with a
/// leading `+` does: options end at the first operand.
fn parse(argv: &[BString]) -> Parsed {
	let mut signal = None;
	let mut kill_after = None;
	let (mut preserve, mut foreground, mut verbose) = (false, false, false);
	let mut i = 1;
	while let Some(arg) = argv.get(i) {
		let arg = arg.to_str_lossy();
		if arg == "--" {
			i += 1;
			break;
		}
		let value = |inline: Option<&str>, name: &str, i: &mut usize| {
			if let Some(v) = inline {
				Ok(v.to_owned())
			} else {
				*i += 1;
				argv
					.get(*i)
					.map(|v| v.to_str_lossy().into_owned())
					.ok_or_else(|| {
						format!("timeout: option requires an argument -- '{name}'\n{USAGE_HINT}")
					})
			}
		};
		if let Some(spelled) = arg.strip_prefix("--") {
			let (spelled, inline) = match spelled.split_once('=') {
				Some((name, v)) => (name, Some(v)),
				None => (spelled, None),
			};
			let (name, takes) = match long(spelled) {
				Ok(found) => found,
				Err(msg) => return Parsed::Fail(msg),
			};
			if !takes && inline.is_some() {
				return Parsed::Fail(format!(
					"timeout: option '--{name}' doesn't allow an argument\n{USAGE_HINT}"
				));
			}
			match name {
				"signal" => match value(inline, name, &mut i) {
					Ok(v) => signal = Some(v),
					Err(msg) => return Parsed::Fail(msg),
				},
				"kill-after" => match value(inline, name, &mut i) {
					Ok(v) => kill_after = Some(v),
					Err(msg) => return Parsed::Fail(msg),
				},
				"preserve-status" => preserve = true,
				"foreground" => foreground = true,
				"verbose" => verbose = true,
				"help" => return Parsed::Print(HELP.to_owned()),
				_ => {
					return Parsed::Print(format!("timeout (pi) {}\n", env!("CARGO_PKG_VERSION")));
				},
			}
		} else if arg.len() > 1 && arg.starts_with('-') && !numeric(&arg) {
			for (at, flag) in arg.char_indices().skip(1) {
				match flag {
					'v' => verbose = true,
					's' | 'k' => {
						let rest = &arg[at + 1..];
						let inline = (!rest.is_empty()).then_some(rest);
						let name = if flag == 's' { "s" } else { "k" };
						match value(inline, name, &mut i) {
							Ok(v) if flag == 's' => signal = Some(v),
							Ok(v) => kill_after = Some(v),
							Err(msg) => return Parsed::Fail(msg),
						}
						break;
					},
					other => {
						return Parsed::Fail(format!(
							"timeout: invalid option -- '{other}'\n{USAGE_HINT}"
						));
					},
				}
			}
		} else {
			break;
		}
		i += 1;
	}
	let [duration, command @ ..] = argv.get(i..).unwrap_or_default() else {
		return Parsed::Fail(format!("timeout: missing operand\n{USAGE_HINT}"));
	};
	if command.is_empty() {
		return Parsed::Fail(format!("timeout: missing operand\n{USAGE_HINT}"));
	}
	let duration = duration.to_str_lossy();
	let Some(limit) = pi_builtins::parse_duration(&duration) else {
		return Parsed::Fail(format!("timeout: invalid time interval '{duration}'\n"));
	};
	let kill_after = match kill_after {
		Some(spec) => match pi_builtins::parse_duration(&spec) {
			Some(d) => Some(d),
			None => return Parsed::Fail(format!("timeout: invalid time interval '{spec}'\n")),
		},
		None => None,
	};
	let signal = match signal {
		Some(spec) => match Signal::parse_spec(spec.trim().as_bytes(), Platform::current()) {
			Some(sig) => sig,
			None => return Parsed::Fail(format!("timeout: '{spec}': invalid signal\n")),
		},
		None => Signal::Term,
	};
	Parsed::Run(Options {
		signal,
		// GNU: a zero duration disables the limit (as does `-k 0`).
		limit: (!limit.is_zero()).then_some(limit),
		kill_after: kill_after.filter(|d| !d.is_zero()),
		preserve,
		foreground,
		verbose,
		command: command.to_vec(),
	})
}

/// Where a `timeout` call is.
enum Phase {
	/// Parsed; the command starts at the next advance.
	Start(Options),
	/// The command runs; the limit expires at `deadline`.
	Running { opts: Options, deadline: Option<u64> },
	/// The signal was sent; waiting for the tree, `KILL` at `kill_at`.
	Signalled { opts: Options, kill_at: Option<u64>, give_up: Option<u64>, recheck: u64 },
	/// The answer, once the output is written.
	Exit(i32),
}

/// A `timeout` call.
pub(super) struct Timeout {
	pub(super) child: Child,
	call:             ToolCall,
	out:              Out,
	phase:            Phase,
}

impl Timeout {
	pub(super) fn new(call: ToolCall) -> Self {
		let mut out = Out::default();
		let phase = match parse(&call.argv) {
			Parsed::Run(opts) => Phase::Start(opts),
			Parsed::Print(text) => {
				out.push(1, text);
				Phase::Exit(0)
			},
			Parsed::Fail(text) => {
				out.push(2, text);
				Phase::Exit(EXIT_FAILURE)
			},
		};
		Self { child: Child::default(), call, out, phase }
	}

	pub(super) fn deadline(&self) -> Option<u64> {
		match &self.phase {
			Phase::Running { deadline, .. } => *deadline,
			Phase::Signalled { kill_at, give_up, recheck, .. } => [*kill_at, *give_up, Some(*recheck)]
				.into_iter()
				.flatten()
				.min(),
			Phase::Start(_) | Phase::Exit(_) => None,
		}
	}

	/// Send `signal` to the command's tree and, for `KILL`, to the
	/// externals it started.
	fn send(&mut self, turn: &Turn<'_>, opts: &Options, signal: Signal) {
		if opts.verbose {
			let name: &'static str = signal.into();
			let command = opts.command[0].to_str_lossy();
			self
				.out
				.push(2, format!("timeout: sending signal {name} to command '{command}'\n"));
		}
		for &label in turn.group {
			turn.ctl.signal(SigTarget::Label(label), signal);
		}
		// The tree's live externals get the signal from the engine; those it
		// already abandoned are reached here, but only by the uncatchable
		// `KILL` (a trapped signal must not run its handler twice).
		if signal == Signal::Kill {
			for pid in turn.log.live(turn.group) {
				signal_os(pid, signal, !opts.foreground);
			}
		}
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		let now = turn.now;
		self.phase = match std::mem::replace(&mut self.phase, Phase::Exit(0)) {
			Phase::Start(opts) => {
				self
					.child
					.start(api, turn, &self.call, opts.command.clone(), false, "");
				let deadline = opts.limit.map(|d| now.saturating_add(nanos(d)));
				Phase::Running { opts, deadline }
			},
			Phase::Running { opts, deadline } => match self.child.status {
				Some(status) => Phase::Exit(status),
				None if deadline.is_some_and(|at| now >= at) => {
					self.send(turn, &opts, opts.signal);
					let killed = opts.signal == Signal::Kill;
					Phase::Signalled {
						kill_at: (!killed)
							.then(|| opts.kill_after.map(|d| now.saturating_add(nanos(d))))
							.flatten(),
						give_up: killed.then(|| now.saturating_add(nanos(REAP_AFTER_KILL))),
						recheck: now.saturating_add(nanos(RECHECK)),
						opts,
					}
				},
				None => Phase::Running { opts, deadline },
			},
			Phase::Signalled { opts, mut kill_at, mut give_up, .. } => {
				if kill_at.is_some_and(|at| now >= at) {
					self.send(turn, &opts, Signal::Kill);
					kill_at = None;
					give_up = Some(now.saturating_add(nanos(REAP_AFTER_KILL)));
				}
				let killed = opts.signal == Signal::Kill || give_up.is_some();
				let ended =
					self.child.status.is_some() && !turn.live && turn.log.live(turn.group).is_empty();
				if ended || give_up.is_some_and(|at| now >= at) {
					let platform = Platform::current();
					Phase::Exit(if opts.preserve {
						self.child.status.unwrap_or_else(|| {
							if killed {
								EXIT_KILLED
							} else {
								opts.signal.exit_status(platform)
							}
						})
					} else if killed {
						EXIT_KILLED
					} else {
						EXIT_TIMED_OUT
					})
				} else {
					Phase::Signalled {
						opts,
						kill_at,
						give_up,
						recheck: now.saturating_add(nanos(RECHECK)),
					}
				}
			},
			Phase::Exit(code) => Phase::Exit(code),
		};
		match self.phase {
			Phase::Exit(code) if self.out.flush(api) => Some(CallOutcome::Exit(code)),
			_ => {
				// Verbose lines go out as they come.
				self.out.flush(api);
				None
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parsed(line: &str) -> Parsed {
		let argv: Vec<BString> = line.split(' ').map(BString::from).collect();
		parse(&argv)
	}

	fn options(line: &str) -> Options {
		match parsed(line) {
			Parsed::Run(opts) => opts,
			other => panic!("{line}: {other:?}"),
		}
	}

	fn failure(line: &str) -> String {
		match parsed(line) {
			Parsed::Fail(msg) => msg,
			other => panic!("{line}: {other:?}"),
		}
	}

	#[test]
	fn gnu_spellings_parse() {
		let opts = options("timeout -s INT -k 2s 10s cmd arg");
		assert_eq!(opts.signal, Signal::Int);
		assert_eq!(opts.kill_after, Some(Duration::from_secs(2)));
		assert_eq!(opts.limit, Some(Duration::from_secs(10)));
		assert_eq!(opts.command, ["cmd", "arg"]);

		let opts =
			options("timeout --signal=KILL --kill-after=1 --preserve-status --foreground -v 5 cmd");
		assert_eq!(opts.signal, Signal::Kill);
		assert!(opts.preserve && opts.foreground && opts.verbose);

		let opts = options("timeout -vsHUP --kill 3 0.5 cmd");
		assert_eq!((opts.signal, opts.kill_after), (Signal::Hup, Some(Duration::from_secs(3))));
		assert_eq!(opts.limit, Some(Duration::from_millis(500)));

		// `--` before the duration ends the options.
		assert_eq!(options("timeout -- 5 cmd").limit, Some(Duration::from_secs(5)));
		// The command's own options belong to the command.
		assert_eq!(options("timeout 5 grep -v -e x").command, ["grep", "-v", "-e", "x"]);
		// Zero disables the limit.
		assert_eq!(options("timeout 0 cmd").limit, None);
		assert_eq!(options("timeout 1m cmd").limit, Some(Duration::from_secs(60)));
	}

	#[test]
	fn signal_spellings_follow_kill() {
		for spec in ["TERM", "term", "SIGTERM", "sigterm", "15"] {
			assert_eq!(options(&format!("timeout -s {spec} 1 cmd")).signal, Signal::Term, "{spec}");
		}
		for spec in ["NOSUCH", "EXIT", "0"] {
			assert_eq!(
				failure(&format!("timeout -s {spec} 1 cmd")),
				format!("timeout: '{spec}': invalid signal\n")
			);
		}
	}

	/// Usage errors exit 125 with GNU's messages, `--help` prints on stdout.
	#[test]
	fn usage_errors_are_timeouts_own() {
		assert_eq!(failure("timeout invalid cmd"), "timeout: invalid time interval 'invalid'\n");
		assert_eq!(failure("timeout -1 cmd"), "timeout: invalid time interval '-1'\n");
		assert_eq!(failure("timeout -k bogus 1 cmd"), "timeout: invalid time interval 'bogus'\n");
		assert!(failure("timeout").starts_with("timeout: missing operand\n"));
		assert!(failure("timeout 5").starts_with("timeout: missing operand\n"));
		assert!(failure("timeout -x 5 cmd").starts_with("timeout: invalid option -- 'x'\n"));
		assert!(
			failure("timeout --nope 5 cmd").starts_with("timeout: unrecognized option '--nope'\n")
		);
		assert!(failure("timeout -s").starts_with("timeout: option requires an argument -- 's'\n"));
		assert!(
			matches!(parsed("timeout --help"), Parsed::Print(text) if text.starts_with("Usage: timeout"))
		);
	}
}
