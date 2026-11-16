//! Which process sent a termination signal.
//!
//! The runtime's own handler for `process.on("SIGTERM")` takes no `siginfo_t`,
//! so the sender the kernel reports is lost before JavaScript runs.
//! [`capture_signal_sender`] puts an `SA_SIGINFO` handler in front of the
//! handler already installed for a signal: it stores the sender's pid and uid
//! in atomics, then calls the previous handler with the same arguments, so the
//! runtime still sees every delivery. [`take_signal_sender`] reads the stored
//! sender from the JavaScript listener.
//!
//! What the sender means differs by platform:
//! - Linux stores it only when `si_code` says a process sent the signal
//!   (`kill`, `killpg`, `sigqueue`, `tgkill`). Signals the kernel generates,
//!   such as a terminal hangup, report pid 0 and uid 0, which would read as
//!   root; those clear the stored sender instead.
//! - macOS sets `si_code` to 0 for every caught signal and `si_pid` to the
//!   process the kernel was running for when it raised the signal (XNU
//!   `psignal_internal`). That is the `kill` caller, or for a signal the kernel
//!   raises on a process's behalf, that process, e.g. the one that closed the
//!   terminal. A pid of 0 (the kernel itself) clears the stored sender.
//!
//! The wrapper is reinstated by the runtime if every JavaScript listener for
//! the signal is later removed, which would make the signal a no-op. Install it
//! only alongside a listener that is never removed.

use napi_derive::napi;

/// The process that sent a signal, as the kernel reported it on delivery.
#[napi(object)]
pub struct SignalSender {
	/// Sender process id.
	pub pid:        i32,
	/// Sender real user id.
	pub uid:        u32,
	/// Sender command name (never its arguments), when the process could still
	/// be identified after the signal arrived.
	pub command:    Option<String>,
	/// Sender parent process id, under the same condition as `command`.
	pub parent_pid: Option<i32>,
}

/// Records the sender of each later delivery of `signal`, in front of the
/// handler currently installed for it.
///
/// Returns false, changing nothing, when the signal has no handler (default or
/// ignored disposition), when the platform has no sender information, or on
/// failure. Installing twice is a no-op that returns true.
#[napi]
pub fn capture_signal_sender(signal: i32) -> bool {
	platform::capture(signal)
}

/// Takes the sender of the latest delivery of `signal`, if a process sent it.
///
/// Absent when no sender was captured: the wrapper is not installed, the kernel
/// generated the signal (see the module docs per platform), or the sender was
/// already taken.
#[napi]
pub fn take_signal_sender(signal: i32) -> Option<SignalSender> {
	platform::take(signal)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod platform {
	use std::{
		mem,
		sync::atomic::{AtomicI32, AtomicU64, AtomicUsize, Ordering},
		time::Duration,
	};

	use libc::{c_int, c_void, siginfo_t};
	use pi_builtins::ProcInfo;

	use super::SignalSender;

	#[cfg(target_os = "linux")]
	const SENT_BY_PROCESS: [c_int; 3] = [libc::SI_USER, libc::SI_QUEUE, libc::SI_TKILL];
	// XNU fills `si_code` with 0 for every caught signal other than SIGCHLD,
	// never with `<sys/signal.h>`'s SI_USER (0x10001); see the module docs.
	#[cfg(target_os = "macos")]
	const SENT_BY_PROCESS: [c_int; 1] = [0];

	/// One slot per signal number the platform defines.
	const SLOTS: usize = 65;

	/// Process start times on Linux come from clock ticks (10 ms); an older
	/// sender must not be dropped for that rounding.
	const START_TIME_RESOLUTION: Duration = Duration::from_millis(20);

	struct Slot {
		/// The previous handler and its flags, written before ours is installed.
		previous:       AtomicUsize,
		previous_flags: AtomicI32,
		/// pid in the high half, uid in the low half; 0 when there is none.
		/// One word, so a later delivery can never pair one sender's pid with
		/// another's uid.
		sender:         AtomicU64,
		/// `CLOCK_MONOTONIC` at delivery, in nanoseconds.
		delivered_at:   AtomicU64,
	}

	static SLOT_TABLE: [Slot; SLOTS] = [const {
		Slot {
			previous:       AtomicUsize::new(0),
			previous_flags: AtomicI32::new(0),
			sender:         AtomicU64::new(0),
			delivered_at:   AtomicU64::new(0),
		}
	}; SLOTS];

	fn slot(signal: c_int) -> Option<&'static Slot> {
		usize::try_from(signal)
			.ok()
			.filter(|index| *index > 0)
			.and_then(|index| SLOT_TABLE.get(index))
	}

	/// Async-signal-safe: `clock_gettime` is on the POSIX list.
	fn monotonic_nanos() -> u64 {
		// SAFETY: timespec is plain data and the pointer is valid for the call.
		let mut now = unsafe { mem::zeroed::<libc::timespec>() };
		// SAFETY: as above.
		unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) };
		u64::try_from(now.tv_sec).unwrap_or(0) * 1_000_000_000
			+ u64::try_from(now.tv_nsec).unwrap_or(0)
	}

	/// The installed handler. Only atomics and `clock_gettime`, then the
	/// previous handler, so it is async-signal-safe.
	extern "C" fn on_signal(signal: c_int, info: *mut siginfo_t, context: *mut c_void) {
		let Some(slot) = slot(signal) else { return };
		if !info.is_null() {
			// SAFETY: the kernel passes a valid siginfo_t to an SA_SIGINFO
			// handler.
			let info = unsafe { &*info };
			// SAFETY: the fields are plain integers in a valid siginfo_t; their
			// values are used only for the codes checked below.
			let (pid, uid) = unsafe { (info.si_pid(), info.si_uid()) };
			let sender = if pid > 0 && SENT_BY_PROCESS.contains(&info.si_code) {
				(u64::from(pid.cast_unsigned()) << 32) | u64::from(uid)
			} else {
				0
			};
			slot
				.delivered_at
				.store(monotonic_nanos(), Ordering::Relaxed);
			slot.sender.store(sender, Ordering::Release);
		}
		let previous = slot.previous.load(Ordering::Acquire);
		if slot.previous_flags.load(Ordering::Acquire) & libc::SA_SIGINFO != 0 {
			// SAFETY: `capture` stored a real SA_SIGINFO handler for this signal.
			let handler: extern "C" fn(c_int, *mut siginfo_t, *mut c_void) =
				unsafe { mem::transmute(previous) };
			handler(signal, info, context);
		} else {
			// SAFETY: `capture` stored a real one-argument handler for this
			// signal.
			let handler: extern "C" fn(c_int) = unsafe { mem::transmute(previous) };
			handler(signal);
		}
	}

	pub fn capture(signal: c_int) -> bool {
		let Some(slot) = slot(signal) else {
			return false;
		};
		// SAFETY: sigaction is plain data; a null new action only reads.
		let mut current = unsafe { mem::zeroed::<libc::sigaction>() };
		// SAFETY: current is writable for the call.
		if unsafe { libc::sigaction(signal, std::ptr::null(), &raw mut current) } != 0 {
			return false;
		}
		let ours = on_signal as *const () as usize;
		if current.sa_sigaction == ours {
			return true;
		}
		// Nothing to wrap: the signal keeps its default or ignored disposition.
		if current.sa_sigaction == libc::SIG_DFL || current.sa_sigaction == libc::SIG_IGN {
			return false;
		}
		slot.previous.store(current.sa_sigaction, Ordering::Release);
		slot
			.previous_flags
			.store(current.sa_flags, Ordering::Release);
		let mut wrapper = current;
		wrapper.sa_sigaction = ours;
		wrapper.sa_flags |= libc::SA_SIGINFO;
		// SAFETY: wrapper is a valid action; the previous one is not needed.
		unsafe { libc::sigaction(signal, &raw const wrapper, std::ptr::null_mut()) == 0 }
	}

	pub fn take(signal: c_int) -> Option<SignalSender> {
		let slot = slot(signal)?;
		let sender = slot.sender.swap(0, Ordering::Acquire);
		if sender == 0 {
			return None;
		}
		let pid = ((sender >> 32) as u32).cast_signed();
		let uid = sender as u32;
		let since_delivery = Duration::from_nanos(
			monotonic_nanos().saturating_sub(slot.delivered_at.load(Ordering::Relaxed)),
		);
		// A process younger than the signal took over a reaped sender's pid.
		let process = ProcInfo::from_pid(pid).filter(|process| {
			process
				.age()
				.is_some_and(|age| age + START_TIME_RESOLUTION >= since_delivery)
		});
		Some(SignalSender {
			pid,
			uid,
			command: process
				.as_ref()
				.map(ProcInfo::command_name)
				.filter(|name| !name.is_empty()),
			parent_pid: process
				.and_then(|process| process.ppid())
				.filter(|ppid| *ppid > 0),
		})
	}
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
	use super::SignalSender;

	pub const fn capture(_signal: i32) -> bool {
		false
	}

	pub const fn take(_signal: i32) -> Option<SignalSender> {
		None
	}
}
