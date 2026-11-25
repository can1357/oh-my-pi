//! `time [-l | -v] [-p] COMMAND [ARG]...`: run a command, then report its
//! times and resource usage on stderr, as macOS `/usr/bin/time` (`-l`, `-p`)
//! and GNU time (`-v`) do.
//!
//! bash's `time` keyword reports a pipeline's real, user and system time on
//! the shell's stderr. This is the utility: the command runs in a subshell
//! of the caller (functions and builtins too) and the report goes to
//! `time`'s own stderr after it, so `time -l prog 2>&1 | grep resident`
//! reads it as it would `/usr/bin/time`'s. The lexer leaves `time` to this
//! tool when an option other than `-p` follows it, where bash's keyword
//! would only fail running a command named like the option; `command time`
//! and `env time` reach it too. An option it lacks (`-o`, `-f`) defers to
//! `PATH`'s `time` ([`lacks_option`]).
//!
//! The figures are those of the external processes the command waited for,
//! as `wait4` reports them ([`ProcUsage`]): in-process builtins and
//! functions count toward the real time only. The macOS-only `-l` lines
//! (instructions, cycles, peak footprint) print on macOS.
//!
//! Exit status: the command's; 1 for `time`'s own usage errors.

use std::fmt::Write as _;

use bstr::{BString, ByteSlice};

use super::{Child, Out, Turn};
use crate::bash::{CallOutcome, ProcUsage, RunId, ShellApi, ToolCall};

const USAGE: &str = "usage: time [-l | -v] [-p] utility [argument ...]\n";

/// The report's format.
#[derive(Debug, Default, PartialEq)]
struct Options {
	/// `-l`: BSD's `rusage` lines after the times.
	rusage:  bool,
	/// `-p`: the POSIX layout of the times.
	posix:   bool,
	/// `-v`: GNU's verbose report.
	verbose: bool,
	command: Vec<BString>,
}

/// What an invocation asks for.
#[derive(Debug, PartialEq)]
enum Parsed {
	Run(Options),
	/// Print this on stderr, exit 1.
	Fail(String),
}

/// The options before the command and its index in `argv`; `Err` names the
/// first option letter `time` lacks.
fn options(argv: &[BString]) -> Result<(Options, usize), u8> {
	let mut opts = Options::default();
	let mut i = 1;
	while let Some(arg) = argv.get(i) {
		if arg == "--" {
			i += 1;
			break;
		}
		let Some(letters) = arg.strip_prefix(b"-").filter(|letters| !letters.is_empty()) else {
			break;
		};
		for &letter in letters {
			match letter {
				b'l' => opts.rusage = true,
				b'p' => opts.posix = true,
				b'v' => opts.verbose = true,
				_ => return Err(letter),
			}
		}
		i += 1;
	}
	Ok((opts, i))
}

/// Whether `argv` (with `time` itself) has an option before the command
/// that `time` lacks: `PATH`'s `time` runs instead, when there is one.
pub(super) fn lacks_option(argv: &[BString]) -> bool {
	options(argv).is_err()
}

fn parse(argv: &[BString]) -> Parsed {
	let (mut opts, at) = match options(argv) {
		Ok(found) => found,
		Err(letter) => {
			return Parsed::Fail(format!("time: illegal option -- {}\n{USAGE}", char::from(letter)));
		},
	};
	if opts.verbose && (opts.rusage || opts.posix) {
		return Parsed::Fail(format!("time: -v cannot be combined with -l or -p\n{USAGE}"));
	}
	match argv.get(at..) {
		Some(command) if !command.is_empty() => {
			opts.command = command.to_vec();
			Parsed::Run(opts)
		},
		_ => Parsed::Fail(USAGE.to_owned()),
	}
}

/// How the command ended.
struct Ended {
	/// From the call to the command's end, in nanoseconds.
	real_ns: u64,
	usage:   ProcUsage,
	/// The status the shell reports in `$?`.
	status:  i32,
	/// The signal that killed the program the command ran as.
	signal:  Option<i32>,
}

/// Whole seconds and hundredths (truncated, as both `time`s print them).
const fn centis(ns: u64) -> (u64, u64) {
	(ns / 1_000_000_000, ns % 1_000_000_000 / 10_000_000)
}

/// The report for `ended`, in the format `opts` asks for; `page` is the
/// system's page size (GNU's last-but-one line).
fn report(opts: &Options, ended: &Ended, page: u64) -> String {
	let mut out = String::new();
	if opts.verbose {
		gnu_report(&mut out, &opts.command, ended, page);
	} else {
		bsd_report(&mut out, opts, ended);
	}
	out
}

/// macOS `time`'s report: the times, then with `-l` the `rusage` fields.
fn bsd_report(out: &mut String, opts: &Options, ended: &Ended) {
	if ended.signal.is_some() {
		out.push_str("time: command terminated abnormally\n");
	}
	let u = &ended.usage;
	let [(real, real_c), (user, user_c), (sys, sys_c)] =
		[ended.real_ns, u.user_ns, u.sys_ns].map(centis);
	if opts.posix {
		let _ =
			write!(out, "real {real}.{real_c:02}\nuser {user}.{user_c:02}\nsys {sys}.{sys_c:02}\n");
	} else {
		let _ = writeln!(
			out,
			"{real:9}.{real_c:02} real {user:9}.{user_c:02} user {sys:9}.{sys_c:02} sys"
		);
	}
	if !opts.rusage {
		return;
	}
	let mut rows = vec![
		(u.max_rss, "maximum resident set size"),
		(0, "average shared memory size"),
		(0, "average unshared data size"),
		(0, "average unshared stack size"),
		(u.minor_faults, "page reclaims"),
		(u.major_faults, "page faults"),
		(u.swaps, "swaps"),
		(u.block_in, "block input operations"),
		(u.block_out, "block output operations"),
		(u.msgs_sent, "messages sent"),
		(u.msgs_received, "messages received"),
		(u.signals, "signals received"),
		(u.voluntary_switches, "voluntary context switches"),
		(u.involuntary_switches, "involuntary context switches"),
	];
	if cfg!(target_os = "macos") {
		rows.extend([
			(u.instructions, "instructions retired"),
			(u.cycles, "cycles elapsed"),
			(u.peak_footprint, "peak memory footprint"),
		]);
	}
	for (n, what) in rows {
		let _ = writeln!(out, "{n:20}  {what}");
	}
}

/// GNU `time -v`'s report.
fn gnu_report(out: &mut String, command: &[BString], ended: &Ended, page: u64) {
	let u = &ended.usage;
	match ended.signal {
		Some(signal) => {
			let _ = writeln!(out, "Command terminated by signal {signal}");
		},
		None if ended.status != 0 => {
			let _ = writeln!(out, "Command exited with non-zero status {}", ended.status);
		},
		None => {},
	}
	let (user, user_c) = centis(u.user_ns);
	let (sys, sys_c) = centis(u.sys_ns);
	let cpu_ms = (u.user_ns + u.sys_ns) / 1_000_000;
	let real_ms = ended.real_ns / 1_000_000;
	let percent = (cpu_ms * 100)
		.checked_div(real_ms)
		.map_or_else(|| "?%".to_owned(), |p| format!("{p}%"));
	let (secs, secs_c) = centis(ended.real_ns);
	let elapsed = if secs >= 3600 {
		format!("{}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
	} else {
		format!("{}:{:02}.{secs_c:02}", secs / 60, secs % 60)
	};
	let line = command.join(&b' ').to_str_lossy().into_owned();
	let exit = if ended.signal.is_some() {
		0
	} else {
		ended.status
	};
	let _ = write!(
		out,
		"\tCommand being timed: \"{line}\"\n\tUser time (seconds): {user}.{user_c:02}\n\tSystem \
		 time (seconds): {sys}.{sys_c:02}\n\tPercent of CPU this job got: {percent}\n\tElapsed \
		 (wall clock) time (h:mm:ss or m:ss): {elapsed}\n\tAverage shared text size (kbytes): \
		 0\n\tAverage unshared data size (kbytes): 0\n\tAverage stack size (kbytes): 0\n\tAverage \
		 total size (kbytes): 0\n\tMaximum resident set size (kbytes): {}\n\tAverage resident set \
		 size (kbytes): 0\n\tMajor (requiring I/O) page faults: {}\n\tMinor (reclaiming a frame) \
		 page faults: {}\n\tVoluntary context switches: {}\n\tInvoluntary context switches: \
		 {}\n\tSwaps: {}\n\tFile system inputs: {}\n\tFile system outputs: {}\n\tSocket messages \
		 sent: {}\n\tSocket messages received: {}\n\tSignals delivered: {}\n\tPage size (bytes): \
		 {page}\n\tExit status: {exit}\n",
		u.max_rss / 1024,
		u.major_faults,
		u.minor_faults,
		u.voluntary_switches,
		u.involuntary_switches,
		u.swaps,
		u.block_in,
		u.block_out,
		u.msgs_sent,
		u.msgs_received,
		u.signals,
	);
}

#[cfg(unix)]
fn page_size() -> u64 {
	// SAFETY: sysconf has no preconditions.
	u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).unwrap_or(4096)
}

/// Every Windows architecture pi runs on pages by 4 KiB.
#[cfg(not(unix))]
const fn page_size() -> u64 {
	4096
}

/// Where a `time` call is.
enum Phase {
	/// Parsed; the command starts at the next advance.
	Start(Options),
	/// The command runs since `start` (ns).
	Running { opts: Options, start: u64 },
	/// The answer, once the output is written.
	Exit(i32),
}

/// A `time` call.
pub(super) struct Time {
	pub(super) child: Child,
	call:             ToolCall,
	out:              Out,
	phase:            Phase,
	/// The command's signal death and usage, from its `Done`.
	signal:           Option<i32>,
	usage:            ProcUsage,
}

impl Time {
	pub(super) fn new(call: ToolCall) -> Self {
		let mut out = Out::default();
		let phase = match parse(&call.argv) {
			Parsed::Run(opts) => Phase::Start(opts),
			Parsed::Fail(text) => {
				out.push(2, text);
				Phase::Exit(1)
			},
		};
		Self { child: Child::default(), call, out, phase, signal: None, usage: ProcUsage::default() }
	}

	/// `run` ended; `false` when it is not this call's command.
	pub(super) fn on_done(
		&mut self,
		run: RunId,
		status: i32,
		signal: Option<i32>,
		usage: Option<ProcUsage>,
	) -> bool {
		if !self.child.on_done(run, status) {
			return false;
		}
		self.signal = signal;
		self.usage = usage.unwrap_or_default();
		true
	}

	pub(super) fn advance(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
	) -> Option<CallOutcome> {
		self.phase = match std::mem::replace(&mut self.phase, Phase::Exit(0)) {
			Phase::Start(opts) => {
				self
					.child
					.start(api, turn, &self.call, opts.command.clone(), false, "");
				Phase::Running { opts, start: turn.now }
			},
			Phase::Running { opts, start } => match self.child.status {
				Some(status) => {
					let ended = Ended {
						real_ns: turn.now.saturating_sub(start),
						usage: self.usage,
						status,
						signal: self.signal,
					};
					self.out.push(2, report(&opts, &ended, page_size()));
					Phase::Exit(status)
				},
				None => Phase::Running { opts, start },
			},
			Phase::Exit(code) => Phase::Exit(code),
		};
		match self.phase {
			Phase::Exit(code) if self.out.flush(api) => Some(CallOutcome::Exit(code)),
			_ => None,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn argv(line: &str) -> Vec<BString> {
		line.split(' ').map(BString::from).collect()
	}

	fn options_of(line: &str) -> Options {
		match parse(&argv(line)) {
			Parsed::Run(opts) => opts,
			other => panic!("{line}: {other:?}"),
		}
	}

	fn failure(line: &str) -> String {
		match parse(&argv(line)) {
			Parsed::Fail(msg) => msg,
			other => panic!("{line}: {other:?}"),
		}
	}

	#[test]
	fn options_end_at_the_command() {
		let opts = options_of("time -lp cmd -v");
		assert!(opts.rusage && opts.posix && !opts.verbose);
		assert_eq!(opts.command, ["cmd", "-v"]);
		assert_eq!(options_of("time -v -- -cmd").command, ["-cmd"]);
		assert_eq!(options_of("time -l - x").command, ["-", "x"]);
	}

	/// An option `time` lacks defers to `PATH`'s `time`; with none there,
	/// `time` itself reports it, as it does its other usage errors.
	#[test]
	fn usage_errors() {
		assert!(lacks_option(&argv("time -f %M cmd")));
		assert!(lacks_option(&argv("time -lo out cmd")));
		assert!(!lacks_option(&argv("time -l cmd -f")));
		assert_eq!(failure("time -f %M cmd"), format!("time: illegal option -- f\n{USAGE}"));
		assert!(failure("time -lv cmd").starts_with("time: -v cannot be combined"));
		assert_eq!(failure("time -l"), USAGE);
		assert_eq!(failure("time -l --"), USAGE);
	}

	fn ended() -> Ended {
		Ended {
			real_ns: 3_723_456_789_000,
			usage:   ProcUsage {
				user_ns: 1_239_000_000,
				sys_ns: 50_000_000,
				max_rss: 981_614_592,
				minor_faults: 19_461,
				major_faults: 2,
				voluntary_switches: 7,
				involuntary_switches: 16,
				..ProcUsage::default()
			},
			status:  3,
			signal:  None,
		}
	}

	/// The layouts agents grep: macOS's (hundredths truncated) and its
	/// `rusage` rows.
	#[test]
	fn bsd_layouts() {
		let e = ended();
		let plain = Options::default();
		assert_eq!(
			report(&plain, &e, 4096),
			"     3723.45 real         1.23 user         0.05 sys\n"
		);
		let posix = Options { posix: true, ..Options::default() };
		assert_eq!(report(&posix, &e, 4096), "real 3723.45\nuser 1.23\nsys 0.05\n");
		let rusage = Options { rusage: true, ..Options::default() };
		let text = report(&rusage, &e, 4096);
		let rows: Vec<&str> = text.lines().collect();
		assert_eq!(rows[1], "           981614592  maximum resident set size");
		assert_eq!(rows[5], "               19461  page reclaims");
		assert_eq!(rows[14], "                  16  involuntary context switches");
		assert_eq!(rows.len(), if cfg!(target_os = "macos") { 18 } else { 15 });
		let killed = Ended { signal: Some(15), status: 143, ..ended() };
		assert!(report(&plain, &killed, 4096).starts_with("time: command terminated abnormally\n"));
	}

	#[test]
	fn gnu_verbose_layout() {
		let opts = Options { verbose: true, command: argv("prog -x"), ..Options::default() };
		let text = report(&opts, &ended(), 16384);
		assert_eq!(
			text,
			"Command exited with non-zero status 3\n\tCommand being timed: \"prog -x\"\n\tUser time \
			 (seconds): 1.23\n\tSystem time (seconds): 0.05\n\tPercent of CPU this job got: \
			 0%\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 1:02:03\n\tAverage shared text size \
			 (kbytes): 0\n\tAverage unshared data size (kbytes): 0\n\tAverage stack size (kbytes): \
			 0\n\tAverage total size (kbytes): 0\n\tMaximum resident set size (kbytes): \
			 958608\n\tAverage resident set size (kbytes): 0\n\tMajor (requiring I/O) page faults: \
			 2\n\tMinor (reclaiming a frame) page faults: 19461\n\tVoluntary context switches: \
			 7\n\tInvoluntary context switches: 16\n\tSwaps: 0\n\tFile system inputs: 0\n\tFile \
			 system outputs: 0\n\tSocket messages sent: 0\n\tSocket messages received: 0\n\tSignals \
			 delivered: 0\n\tPage size (bytes): 16384\n\tExit status: 3\n"
		);
		let short = Ended { real_ns: 1_500_000_000, status: 0, ..ended() };
		let text = report(&opts, &short, 16384);
		assert!(text.starts_with("\tCommand being timed"));
		assert!(text.contains("\tPercent of CPU this job got: 85%\n"));
		assert!(text.contains("(h:mm:ss or m:ss): 0:01.50\n"));
	}
}
