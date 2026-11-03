//! Signals on the engine's virtual signal bus.
//!
//! Signals never reach virtual processes through the OS: `kill`, cancel and
//! job control deliver them in-engine. Externals receive real signals through
//! [`ExtProc::signal`](crate::bash::ExtProc::signal), and arbitrary host
//! processes only through
//! [`Host::signal_process`](crate::bash::Host::signal_process).
//!
//! A terminating signal ends the vproc it reaches (after its trap, if any),
//! except a subshell vproc that is just one external (bash would have
//! `exec`'d it: `cmd &`, a pipeline stage, `( cmd )`, `exec cmd`) and the job
//! vproc of a pipeline or `( … )` that only waits for children the signal
//! reaches too: the program gets the signal and may trap it, and the vproc
//! ends with the program's own status once it exited, so `kill %1; wait %1`
//! returns that status after the program is gone.

use serde::{Deserialize, Serialize};

use crate::bash::ids::{JobId, Platform, Vpid};

/// A POSIX signal, by name (numbers differ per platform, see
/// [`Signal::number`]).
#[derive(
	Clone,
	Copy,
	Debug,
	PartialEq,
	Eq,
	Hash,
	PartialOrd,
	Ord,
	Serialize,
	Deserialize,
	strum::EnumString,
	strum::VariantNames,
	strum::EnumIter,
	strum::FromRepr,
)]
#[strum(serialize_all = "UPPERCASE")]
#[repr(u8)]
#[expect(missing_docs, reason = "each variant is the POSIX signal SIG<NAME>")]
pub enum Signal {
	Hup,
	Int,
	Quit,
	Ill,
	Trap,
	Abrt,
	Bus,
	Fpe,
	Kill,
	Usr1,
	Segv,
	Usr2,
	Pipe,
	Alrm,
	Term,
	Chld,
	Cont,
	Stop,
	Tstp,
	Ttin,
	Ttou,
	Urg,
	Xcpu,
	Xfsz,
	Vtalrm,
	Prof,
	Winch,
	Io,
	Sys,
	Emt,
	Info,
	Stkflt,
	Pwr,
	#[strum(serialize = "RTMIN")]
	Rtmin,
	#[strum(serialize = "RTMIN+1")]
	Rtmin1,
	#[strum(serialize = "RTMIN+2")]
	Rtmin2,
	#[strum(serialize = "RTMIN+3")]
	Rtmin3,
	#[strum(serialize = "RTMIN+4")]
	Rtmin4,
	#[strum(serialize = "RTMIN+5")]
	Rtmin5,
	#[strum(serialize = "RTMIN+6")]
	Rtmin6,
	#[strum(serialize = "RTMIN+7")]
	Rtmin7,
	#[strum(serialize = "RTMIN+8")]
	Rtmin8,
	#[strum(serialize = "RTMIN+9")]
	Rtmin9,
	#[strum(serialize = "RTMIN+10")]
	Rtmin10,
	#[strum(serialize = "RTMIN+11")]
	Rtmin11,
	#[strum(serialize = "RTMIN+12")]
	Rtmin12,
	#[strum(serialize = "RTMIN+13")]
	Rtmin13,
	#[strum(serialize = "RTMIN+14")]
	Rtmin14,
	#[strum(serialize = "RTMIN+15")]
	Rtmin15,
	#[strum(serialize = "RTMAX-14")]
	Rtmax14,
	#[strum(serialize = "RTMAX-13")]
	Rtmax13,
	#[strum(serialize = "RTMAX-12")]
	Rtmax12,
	#[strum(serialize = "RTMAX-11")]
	Rtmax11,
	#[strum(serialize = "RTMAX-10")]
	Rtmax10,
	#[strum(serialize = "RTMAX-9")]
	Rtmax9,
	#[strum(serialize = "RTMAX-8")]
	Rtmax8,
	#[strum(serialize = "RTMAX-7")]
	Rtmax7,
	#[strum(serialize = "RTMAX-6")]
	Rtmax6,
	#[strum(serialize = "RTMAX-5")]
	Rtmax5,
	#[strum(serialize = "RTMAX-4")]
	Rtmax4,
	#[strum(serialize = "RTMAX-3")]
	Rtmax3,
	#[strum(serialize = "RTMAX-2")]
	Rtmax2,
	#[strum(serialize = "RTMAX-1")]
	Rtmax1,
	#[strum(serialize = "RTMAX")]
	Rtmax,
}

crate::bash::packed_names::packed_names!(Signal, Display);

/// What a signal does to a process that neither traps nor ignores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DefaultAction {
	/// Terminate with status 128 + number.
	Terminate,
	/// Nothing.
	Ignore,
	/// Stop (job control).
	Stop,
	/// Continue a stopped process.
	Continue,
}

impl Signal {
	/// Signal number on `platform`, or zero when the platform has no such
	/// signal.
	pub const fn number(self, platform: Platform) -> u8 {
		let linux = match self {
			Self::Hup => 1,
			Self::Int => 2,
			Self::Quit => 3,
			Self::Ill => 4,
			Self::Trap => 5,
			Self::Abrt => 6,
			Self::Bus => 7,
			Self::Fpe => 8,
			Self::Kill => 9,
			Self::Usr1 => 10,
			Self::Segv => 11,
			Self::Usr2 => 12,
			Self::Pipe => 13,
			Self::Alrm => 14,
			Self::Term => 15,
			Self::Chld => 17,
			Self::Cont => 18,
			Self::Stop => 19,
			Self::Tstp => 20,
			Self::Ttin => 21,
			Self::Ttou => 22,
			Self::Urg => 23,
			Self::Xcpu => 24,
			Self::Xfsz => 25,
			Self::Vtalrm => 26,
			Self::Prof => 27,
			Self::Winch => 28,
			Self::Io => 29,
			Self::Sys => 31,
			Self::Emt | Self::Info => 0,
			Self::Stkflt => 16,
			Self::Pwr => 30,
			_ => 34 + self as u8 - Self::Rtmin as u8,
		};
		match platform {
			Platform::Linux => linux,
			Platform::Windows => {
				if (self as u8) >= Self::Rtmin as u8 {
					0
				} else {
					linux
				}
			},
			Platform::MacOs => match self {
				Self::Bus => 10,
				Self::Usr1 => 30,
				Self::Usr2 => 31,
				Self::Chld => 20,
				Self::Cont => 19,
				Self::Stop => 17,
				Self::Tstp => 18,
				Self::Urg => 16,
				Self::Io => 23,
				Self::Sys => 12,
				Self::Emt => 7,
				Self::Info => 29,
				Self::Stkflt | Self::Pwr => 0,
				_ => {
					if (self as u8) >= Self::Rtmin as u8 {
						0
					} else {
						linux
					}
				},
			},
		}
	}

	/// The signal numbered `n` on `platform`.
	pub fn from_number(n: u8, platform: Platform) -> Option<Self> {
		use strum::IntoEnumIterator;
		(n != 0)
			.then(|| Self::iter().find(|s| s.number(platform) == n))
			.flatten()
	}

	/// Parse a signal name (with an optional `SIG` prefix) or platform number.
	pub fn parse_spec(spec: &[u8], platform: Platform) -> Option<Self> {
		if spec.is_empty() {
			return None;
		}
		if spec.iter().all(u8::is_ascii_digit) {
			let n = std::str::from_utf8(spec).ok()?.parse::<u8>().ok()?;
			return Self::from_number(n, platform);
		}
		use strum::IntoEnumIterator;
		let name = if spec
			.get(..3)
			.is_some_and(|s| s.eq_ignore_ascii_case(b"SIG"))
		{
			&spec[3..]
		} else {
			spec
		};
		if platform == Platform::Linux {
			let offset = |bytes: &[u8]| -> Option<u8> {
				if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
					return None;
				}
				std::str::from_utf8(bytes).ok()?.parse().ok()
			};
			if name.eq_ignore_ascii_case(b"RTMIN") {
				return Self::from_number(34, platform);
			}
			if name.eq_ignore_ascii_case(b"RTMAX") {
				return Self::from_number(64, platform);
			}
			if name
				.get(..6)
				.is_some_and(|s| s.eq_ignore_ascii_case(b"RTMIN+"))
			{
				let n = offset(&name[6..])?;
				return (n <= 30)
					.then(|| Self::from_number(34 + n, platform))
					.flatten();
			}
			if name
				.get(..6)
				.is_some_and(|s| s.eq_ignore_ascii_case(b"RTMAX-"))
			{
				let n = offset(&name[6..])?;
				return (n <= 30)
					.then(|| Self::from_number(64 - n, platform))
					.flatten();
			}
		}
		if name.eq_ignore_ascii_case(b"IOT") {
			return Some(Self::Abrt);
		}
		if name.eq_ignore_ascii_case(b"CLD") {
			return Some(Self::Chld);
		}
		if name.eq_ignore_ascii_case(b"POLL") && platform != Platform::MacOs {
			return Some(Self::Io);
		}
		Self::iter().find(|sig| {
			let display: &'static str = (*sig).into();
			sig.number(platform) != 0 && name.eq_ignore_ascii_case(display.as_bytes())
		})
	}

	/// Exit status of a process killed by this signal.
	pub const fn exit_status(self, platform: Platform) -> i32 {
		128 + self.number(platform) as i32
	}

	/// What happens when the signal is neither trapped nor ignored.
	pub const fn default_action(self) -> DefaultAction {
		match self {
			Self::Chld | Self::Urg | Self::Winch | Self::Info => DefaultAction::Ignore,
			Self::Stop | Self::Tstp | Self::Ttin | Self::Ttou => DefaultAction::Stop,
			Self::Cont => DefaultAction::Continue,
			_ => DefaultAction::Terminate,
		}
	}

	/// The C library's `strsignal` text on `platform` (glibc on Linux and
	/// Windows, Darwin libc on macOS, which appends `: N`). The job builtins
	/// print it for a job that a signal stopped or killed (`jobs -l`, death
	/// notices), as bash's `j_strsignal` does.
	pub fn description(self, platform: Platform) -> String {
		let n = self.number(platform);
		if platform == Platform::MacOs {
			let text = match self {
				Self::Hup => "Hangup",
				Self::Int => "Interrupt",
				Self::Quit => "Quit",
				Self::Ill => "Illegal instruction",
				Self::Trap => "Trace/BPT trap",
				Self::Abrt => "Abort trap",
				Self::Emt => "EMT trap",
				Self::Fpe => "Floating point exception",
				Self::Kill => "Killed",
				Self::Bus => "Bus error",
				Self::Segv => "Segmentation fault",
				Self::Sys => "Bad system call",
				Self::Pipe => "Broken pipe",
				Self::Alrm => "Alarm clock",
				Self::Term => "Terminated",
				Self::Urg => "Urgent I/O condition",
				Self::Stop => "Suspended (signal)",
				Self::Tstp => "Suspended",
				Self::Cont => "Continued",
				Self::Chld => "Child exited",
				Self::Ttin => "Stopped (tty input)",
				Self::Ttou => "Stopped (tty output)",
				Self::Io => "I/O possible",
				Self::Xcpu => "Cputime limit exceeded",
				Self::Xfsz => "Filesize limit exceeded",
				Self::Vtalrm => "Virtual timer expired",
				Self::Prof => "Profiling timer expired",
				Self::Winch => "Window size changes",
				Self::Info => "Information request",
				Self::Usr1 => "User defined signal 1",
				Self::Usr2 => "User defined signal 2",
				_ => return format!("Unknown signal: {n}"),
			};
			return format!("{text}: {n}");
		}
		let text = match self {
			Self::Hup => "Hangup",
			Self::Int => "Interrupt",
			Self::Quit => "Quit",
			Self::Ill => "Illegal instruction",
			Self::Trap => "Trace/breakpoint trap",
			Self::Abrt => "Aborted",
			Self::Bus => "Bus error",
			Self::Fpe => "Floating point exception",
			Self::Kill => "Killed",
			Self::Usr1 => "User defined signal 1",
			Self::Segv => "Segmentation fault",
			Self::Usr2 => "User defined signal 2",
			Self::Pipe => "Broken pipe",
			Self::Alrm => "Alarm clock",
			Self::Term => "Terminated",
			Self::Stkflt => "Stack fault",
			Self::Chld => "Child exited",
			Self::Cont => "Continued",
			Self::Stop => "Stopped (signal)",
			Self::Tstp => "Stopped",
			Self::Ttin => "Stopped (tty input)",
			Self::Ttou => "Stopped (tty output)",
			Self::Urg => "Urgent I/O condition",
			Self::Xcpu => "CPU time limit exceeded",
			Self::Xfsz => "File size limit exceeded",
			Self::Vtalrm => "Virtual timer expired",
			Self::Prof => "Profiling timer expired",
			Self::Winch => "Window changed",
			Self::Io => "I/O possible",
			Self::Pwr => "Power failure",
			Self::Sys => "Bad system call",
			_ if (34..=64).contains(&n) => return format!("Real-time signal {}", n - 34),
			_ => return format!("Unknown signal {n}"),
		};
		text.to_owned()
	}
}

/// A set of signals (e.g. those ignored on entry, passed to spawned externals).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SigSet(u64);

impl SigSet {
	/// The empty set.
	pub const EMPTY: Self = Self(0);

	/// The set with `sig` added.
	pub const fn with(self, sig: Signal) -> Self {
		Self(self.0 | (1 << sig as u8))
	}

	/// The set with `sig` removed.
	pub const fn without(self, sig: Signal) -> Self {
		Self(self.0 & !(1 << sig as u8))
	}

	/// Whether `sig` is in the set.
	pub const fn contains(self, sig: Signal) -> bool {
		self.0 & (1 << sig as u8) != 0
	}

	/// Members in declaration order.
	pub fn iter(self) -> impl Iterator<Item = Signal> {
		use strum::IntoEnumIterator;
		Signal::iter().filter(move |s| self.contains(*s))
	}
}

/// Recipient of a virtual signal
/// ([`ControlHandle::signal`](crate::bash::ControlHandle::signal)).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SigTarget {
	/// One virtual process.
	Vpid(Vpid),
	/// Every process of a job (and its externals' process group).
	Job(JobId),
	/// Every virtual process of the shell.
	All,
	/// Every virtual process whose
	/// [`Lineage::label`](crate::bash::Lineage::label) is this (nonzero)
	/// label: a host callout's child tree, like a process group.
	Label(u32),
}
