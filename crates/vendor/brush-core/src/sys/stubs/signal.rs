//! Signal processing utilities

use crate::{error, sys, traps};

/// A stub enum representing system signals on unsupported platforms.
#[cfg(not(windows))]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Signal {}

/// Signal representation for Windows.
///
/// Windows has no signals; these exist so scripts can name them (`kill -s
/// TERM`, `timeout -s KILL`, `trap … INT`) and so exit statuses above 128 map
/// back to a signal (`kill -l 137` is `KILL`). Only the signals whose numbers
/// every POSIX platform (Linux, macOS, the BSDs, Cygwin/MSYS) agrees on are
/// listed, with those numbers as discriminants: `signal as i32` is the number
/// a script sees.
#[cfg(windows)]
#[allow(unnameable_types)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(i32)]
pub enum Signal {
	/// Hangup.
	Hangup = 1,
	/// Interrupt signal.
	Interrupt = 2,
	/// Quit.
	Quit = 3,
	/// Illegal instruction.
	Illegal = 4,
	/// Trace/breakpoint trap.
	Trap = 5,
	/// Abort.
	Abort = 6,
	/// Floating-point exception.
	FloatingPoint = 8,
	/// Kill signal.
	Kill = 9,
	/// Segmentation fault.
	SegmentationFault = 11,
	/// Broken pipe.
	Pipe = 13,
	/// Alarm clock.
	Alarm = 14,
	/// Terminate signal.
	Terminate = 15,
}

#[cfg(windows)]
impl Signal {
	const ALL: [Self; 12] = [
		Self::Hangup,
		Self::Interrupt,
		Self::Quit,
		Self::Illegal,
		Self::Trap,
		Self::Abort,
		Self::FloatingPoint,
		Self::Kill,
		Self::SegmentationFault,
		Self::Pipe,
		Self::Alarm,
		Self::Terminate,
	];
}

impl Signal {
	/// Returns an iterator over all possible signals.
	#[cfg(windows)]
	pub fn iterator() -> impl Iterator<Item = Self> {
		Self::ALL.into_iter()
	}

	/// Returns an iterator over all possible signals.
	#[cfg(not(windows))]
	pub fn iterator() -> impl Iterator<Item = Self> {
		std::iter::empty()
	}

	/// Converts the signal into its corresponding name as a `&'static str`,
	/// spelled with the `SIG` prefix like the unix implementation.
	#[cfg(windows)]
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Hangup => "SIGHUP",
			Self::Interrupt => "SIGINT",
			Self::Quit => "SIGQUIT",
			Self::Illegal => "SIGILL",
			Self::Trap => "SIGTRAP",
			Self::Abort => "SIGABRT",
			Self::FloatingPoint => "SIGFPE",
			Self::Kill => "SIGKILL",
			Self::SegmentationFault => "SIGSEGV",
			Self::Pipe => "SIGPIPE",
			Self::Alarm => "SIGALRM",
			Self::Terminate => "SIGTERM",
		}
	}

	/// Converts the signal into its corresponding name as a `&'static str`.
	#[cfg(not(windows))]
	pub const fn as_str(self) -> &'static str {
		""
	}

	/// Creates a `Signal` from its name, with or without the `SIG` prefix.
	#[cfg(windows)]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		let upper = s.to_ascii_uppercase();
		let name = upper.strip_prefix("SIG").unwrap_or(&upper);
		Self::ALL
			.into_iter()
			.find(|signal| &signal.as_str()[3..] == name)
			.ok_or_else(|| error::ErrorKind::InvalidSignal(s.into()).into())
	}

	/// Creates a `Signal` from a string representation.
	#[cfg(not(windows))]
	pub fn from_str(s: &str) -> Result<Self, error::Error> {
		Err(error::ErrorKind::InvalidSignal(s.into()).into())
	}
}

impl TryFrom<i32> for Signal {
	type Error = error::Error;

	#[cfg(windows)]
	fn try_from(value: i32) -> Result<Self, Self::Error> {
		Self::ALL
			.into_iter()
			.find(|signal| *signal as i32 == value)
			.ok_or_else(|| error::ErrorKind::InvalidSignal(std::format!("{value}")).into())
	}

	#[cfg(not(windows))]
	fn try_from(value: i32) -> Result<Self, Self::Error> {
		Err(error::ErrorKind::InvalidSignal(std::format!("{value}")).into())
	}
}

pub(crate) fn continue_process(_pid: sys::process::ProcessId) -> Result<(), error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("continuing process").into())
}

/// Sends a signal to a specific process.
///
/// This is a stub implementation that returns an error.
pub fn kill_process(
	_pid: sys::process::ProcessId,
	_signal: traps::TrapSignal,
) -> Result<(), error::Error> {
	#[cfg(windows)]
	{
		use windows_sys::Win32::Foundation::CloseHandle;
		use windows_sys::Win32::System::Threading::{
			OpenProcess, PROCESS_TERMINATE, TerminateProcess,
		};

		let pid = u32::try_from(_pid).map_err(|_| error::ErrorKind::FailedToSendSignal)?;
		// SAFETY: OpenProcess is called with PROCESS_TERMINATE for a numeric process id
		// provided by brush's process tracking. A null handle is checked below.
		let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
		if handle.is_null() {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}

		// SAFETY: The handle was returned by OpenProcess and checked for null.
		let ok = unsafe { TerminateProcess(handle, 1) };
		// SAFETY: The handle was returned by OpenProcess and is closed exactly once here.
		let _close_result = unsafe { CloseHandle(handle) };
		if ok == 0 {
			return Err(error::ErrorKind::FailedToSendSignal.into());
		}

		Ok(())
	}
	#[cfg(not(windows))]
	Err(error::ErrorKind::NotSupportedOnThisPlatform("killing process").into())
}

pub(crate) fn lead_new_process_group() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) struct FakeSignal {}

impl FakeSignal {
	fn new() -> Self {
		Self {}
	}

	pub async fn recv(&self) {
		futures::future::pending::<()>().await;
	}
}

pub(crate) fn tstp_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) fn chld_signal_listener() -> Result<FakeSignal, error::Error> {
	Ok(FakeSignal::new())
}

pub(crate) async fn await_ctrl_c() -> std::io::Result<()> {
	FakeSignal::new().recv().await;
	Ok(())
}

pub(crate) fn mask_sigttou() -> Result<(), error::Error> {
	Ok(())
}

pub(crate) fn poll_for_stopped_processes(
	_pids: &[sys::process::ProcessId],
	_pgid: Option<sys::process::ProcessId>,
) -> Result<bool, error::Error> {
	Ok(false)
}
