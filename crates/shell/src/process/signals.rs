//! Bridge trapped OS signals into the shell's virtual signal bus, and give
//! an embedded shell the default dispositions an embedding runtime replaced
//! ([`RuntimeSignals`]).
//! Linux reads inherited ignored dispositions from procfs in one query;
//! hosts without accessible procfs retain the per-signal query path.

#[cfg(not(unix))]
use std::io;

#[cfg(unix)]
mod unix {
	use std::{
		collections::{HashMap, hash_map::Entry},
		io, ptr,
		sync::atomic::{AtomicU64, Ordering},
	};

	use bstr::BStr;

	use crate::bash::{ControlHandle, Platform, SigSet, SigTarget, Signal, Vpid};

	// POSIX signals coalesce while pending. This handler does not allocate,
	// lock, or call the shell: the CLI drains the bits at scheduler boundaries.
	static PENDING: AtomicU64 = AtomicU64::new(0);

	extern "C" fn on_signal(number: libc::c_int) {
		if (1..=64).contains(&number) {
			PENDING.fetch_or(1u64 << (number - 1), Ordering::Relaxed);
		}
	}

	/// Dispositions on entry, retained so reset and drop restore the host.
	#[derive(Default)]
	pub struct Signals {
		original:  HashMap<i32, libc::sigaction>,
		/// Signals ignored on entry that may be trapped anyway (zsh,
		/// [`Self::forget_ignored`]); their default is `SIG_DFL`.
		forgotten: Vec<i32>,
	}

	/// Read Linux's disposition bitmap in one query, falling back to
	/// sigaction when procfs is unavailable or its status format changes.
	#[cfg(target_os = "linux")]
	fn ignored_from_proc() -> Option<SigSet> {
		let file = std::fs::File::open("/proc/self/status").ok()?;
		ignored_from_status(io::BufReader::new(file))
	}

	#[cfg(target_os = "linux")]
	fn ignored_from_status(mut input: impl io::BufRead) -> Option<SigSet> {
		let mut line = Vec::new();
		while input.read_until(b'\n', &mut line).ok()? != 0 {
			if let Some(mask) = line.strip_prefix(b"SigIgn:\t") {
				let mask = std::str::from_utf8(mask).ok()?.trim();
				let mut bits = u64::from_str_radix(mask, 16).ok()?;
				let mut ignored = SigSet::EMPTY;
				while bits != 0 {
					let number = bits.trailing_zeros() as u8 + 1;
					bits &= bits - 1;
					if let Some(signal) = Signal::from_number(number, Platform::current()) {
						ignored = ignored.with(signal);
					}
				}
				return Some(ignored);
			}
			line.clear();
		}
		None
	}

	#[cfg(all(test, target_os = "linux"))]
	mod tests {
		use super::*;

		#[test]
		fn proc_ignored_mask_maps_low_and_high_signals() {
			let status = b"Name:\tobash\nSigIgn:\t8000000180001002\n";
			let ignored = ignored_from_status(&status[..]).unwrap();
			assert_eq!(
				ignored,
				SigSet::EMPTY
					.with(Signal::Int)
					.with(Signal::Pipe)
					.with(Signal::Rtmax)
			);
		}

		#[test]
		fn proc_ignored_mask_after_long_groups_line() {
			let mut status = b"Groups:\t".to_vec();
			status.extend(std::iter::repeat_n(b'1', 16384));
			status.extend_from_slice(b"\nSigIgn:\t0000000000000000\n");
			let input = io::BufReader::with_capacity(128, &status[..]);
			assert_eq!(ignored_from_status(input), Some(SigSet::EMPTY));
		}

		#[test]
		fn proc_ignored_missing_or_invalid_mask_falls_back() {
			for status in [
				&b"Name:\tobash\n"[..],
				&b"SigIgn:\tnot-hex\n"[..],
				&b"SigIgn:\t10000000000000000\n"[..],
			] {
				assert_eq!(ignored_from_status(status), None);
			}
		}
	}

	impl Signals {
		/// Signals ignored when the process started (inherited dispositions).
		pub fn ignored() -> SigSet {
			#[cfg(target_os = "linux")]
			if let Some(ignored) = ignored_from_proc() {
				return ignored;
			}
			let mut ignored = SigSet::EMPTY;
			for number in 1..=64 {
				let Some(sig) = Signal::from_number(number, Platform::current()) else {
					continue;
				};
				// SAFETY: the kernel initializes the action on success.
				let mut action: libc::sigaction = unsafe { std::mem::zeroed() };
				// SAFETY: a null new action queries the current disposition.
				if unsafe { libc::sigaction(i32::from(number), ptr::null(), &raw mut action) } == 0
					&& action.sa_sigaction == libc::SIG_IGN
				{
					ignored = ignored.with(sig);
				}
			}
			ignored
		}

		pub fn set(&mut self, sig: Signal, action: Option<&BStr>) -> io::Result<bool> {
			if matches!(sig, Signal::Kill | Signal::Stop) {
				return Ok(true);
			}
			let number = i32::from(sig.number(Platform::current()));
			let original = match self.original.entry(number) {
				Entry::Occupied(saved) => saved.into_mut(),
				Entry::Vacant(slot) => {
					// SAFETY: the kernel initializes the writable sigaction on
					// success.
					let mut original: libc::sigaction = unsafe { std::mem::zeroed() };
					// SAFETY: a null new action queries the current disposition.
					if unsafe { libc::sigaction(number, ptr::null(), &raw mut original) } != 0 {
						return Err(io::Error::last_os_error());
					}
					slot.insert(original)
				},
			};
			let forgotten = self.forgotten.contains(&number);
			if original.sa_sigaction == libc::SIG_IGN && !forgotten {
				return Ok(false);
			}
			if action.is_none() {
				let mut default: libc::sigaction = *original;
				if forgotten {
					default.sa_sigaction = libc::SIG_DFL;
				}
				// SAFETY: the saved action came from a successful sigaction query.
				if unsafe { libc::sigaction(number, &raw const default, ptr::null_mut()) } != 0 {
					return Err(io::Error::last_os_error());
				}
				crate::sys::dispositions_changed();
				return Ok(true);
			}
			// SAFETY: sigemptyset initializes the signal mask before use.
			let mut next: libc::sigaction = unsafe { std::mem::zeroed() };
			next.sa_sigaction = if action.is_some_and(|s| s.is_empty()) {
				libc::SIG_IGN
			} else {
				let handler: extern "C" fn(libc::c_int) = on_signal;
				handler as libc::sighandler_t
			};
			next.sa_flags = libc::SA_RESTART;
			// SAFETY: next is initialized and the mask is a valid writable
			// sigset_t.
			unsafe { libc::sigemptyset(&raw mut next.sa_mask) };
			// SAFETY: next is a valid signal disposition.
			if unsafe { libc::sigaction(number, &raw const next, ptr::null_mut()) } != 0 {
				return Err(io::Error::last_os_error());
			}
			crate::sys::dispositions_changed();
			Ok(true)
		}

		/// Let `sig`, even if ignored on entry, be trapped: zsh has no POSIX
		/// rule against it. Dropping the table still restores the entry
		/// disposition.
		pub fn forget_ignored(&mut self, sig: Signal) {
			let number = i32::from(sig.number(Platform::current()));
			if !self.forgotten.contains(&number) {
				self.forgotten.push(number);
			}
		}

		/// Deliver the OS signals caught since the last call to the root vproc.
		pub fn dispatch(ctl: &ControlHandle, root: Vpid) {
			let mut pending = PENDING.swap(0, Ordering::AcqRel);
			while pending != 0 {
				let number = pending.trailing_zeros() as u8 + 1;
				pending &= pending - 1;
				if let Some(signal) = Signal::from_number(number, Platform::current()) {
					ctl.signal(SigTarget::Vpid(root), signal);
				}
			}
		}
	}

	impl Drop for Signals {
		fn drop(&mut self) {
			for (number, action) in &self.original {
				// SAFETY: each saved disposition came from sigaction; the CLI owns
				// these registrations until it exits.
				unsafe { libc::sigaction(*number, action, ptr::null_mut()) };
			}
			crate::sys::dispositions_changed();
			PENDING.store(0, Ordering::Relaxed);
		}
	}

	/// The job-control and termination signals a shell relies on the
	/// default actions of.
	const SHELL_SET: [libc::c_int; 12] = [
		libc::SIGHUP,
		libc::SIGINT,
		libc::SIGQUIT,
		libc::SIGTERM,
		libc::SIGPIPE,
		libc::SIGALRM,
		libc::SIGTSTP,
		libc::SIGTTIN,
		libc::SIGTTOU,
		libc::SIGCHLD,
		libc::SIGWINCH,
		libc::SIGCONT,
	];

	/// The dispositions an embedding runtime (Bun) installed for the
	/// shell's signals, put back to `SIG_DFL` for the shell's run and
	/// restored when dropped. Only [`SHELL_SET`] is touched: the runtime's
	/// engine may use any other signal. A handler function is the
	/// runtime's own; an ignored signal was inherited and stays ignored,
	/// except `SIGPIPE`, which the runtime ignores itself (a pipeline stage
	/// writing into a closed pipe must die of it).
	pub struct RuntimeSignals {
		saved: Vec<(libc::c_int, libc::sigaction)>,
	}

	impl RuntimeSignals {
		/// Reset the runtime's dispositions.
		///
		/// # Errors
		///
		/// When a disposition cannot be read or set (the ones already reset
		/// are restored).
		pub fn reset() -> io::Result<Self> {
			let mut this = Self { saved: Vec::new() };
			for number in SHELL_SET {
				// SAFETY: the kernel initializes the action on success.
				let mut old: libc::sigaction = unsafe { std::mem::zeroed() };
				// SAFETY: a null new action queries the current disposition.
				if unsafe { libc::sigaction(number, ptr::null(), &raw mut old) } != 0 {
					return Err(io::Error::last_os_error());
				}
				let foreign = match old.sa_sigaction {
					libc::SIG_DFL => false,
					libc::SIG_IGN => number == libc::SIGPIPE,
					_ => true,
				};
				if !foreign {
					continue;
				}
				// SAFETY: an all-zero sigaction with SIG_DFL and an emptied
				// mask is a valid disposition.
				let mut dfl: libc::sigaction = unsafe { std::mem::zeroed() };
				dfl.sa_sigaction = libc::SIG_DFL;
				// SAFETY: the mask is a valid writable sigset_t.
				unsafe { libc::sigemptyset(&raw mut dfl.sa_mask) };
				// SAFETY: `dfl` is a valid disposition.
				if unsafe { libc::sigaction(number, &raw const dfl, ptr::null_mut()) } != 0 {
					return Err(io::Error::last_os_error());
				}
				crate::sys::dispositions_changed();
				this.saved.push((number, old));
			}
			Ok(this)
		}
	}

	impl Drop for RuntimeSignals {
		fn drop(&mut self) {
			for (number, action) in self.saved.drain(..).rev() {
				// SAFETY: each saved disposition came from sigaction.
				unsafe { libc::sigaction(number, &raw const action, ptr::null_mut()) };
			}
			crate::sys::dispositions_changed();
		}
	}
}

#[cfg(unix)]
pub use unix::{RuntimeSignals, Signals};

/// Nothing to reset off Unix.
#[cfg(not(unix))]
pub struct RuntimeSignals;

#[cfg(not(unix))]
impl RuntimeSignals {
	/// No dispositions to reset off Unix.
	#[expect(clippy::unnecessary_wraps, reason = "mirrors the Unix signature")]
	pub const fn reset() -> io::Result<Self> {
		Ok(Self)
	}
}

/// Windows has no signals, only console control events: Ctrl-C
/// (`SIGINT`), Ctrl-Break (`SIGQUIT`, as a terminal's `^\`) and the
/// console closing (`SIGHUP`). A handler registered while the shell traps
/// or ignores one of them turns the event into a pending signal (or drops
/// it) instead of letting Windows end the process; an event the shell
/// leaves at its default goes on to the next handler (the embedding
/// runtime's, else Windows ends the process, as the default action does).
#[cfg(windows)]
mod windows {
	use std::{
		io,
		sync::atomic::{AtomicBool, AtomicU64, Ordering},
	};

	use bstr::BStr;
	use windows_sys::{
		Win32::System::Console::{
			CTRL_BREAK_EVENT, CTRL_C_EVENT, CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
			SetConsoleCtrlHandler,
		},
		core::BOOL,
	};

	use crate::bash::{ControlHandle, Platform, SigSet, SigTarget, Signal, Vpid};

	/// Caught signals not yet delivered, one bit per number.
	static PENDING: AtomicU64 = AtomicU64::new(0);
	/// Signals the shell traps (caught into [`PENDING`]).
	static TRAPPED: AtomicU64 = AtomicU64::new(0);
	/// Signals the shell ignores.
	static IGNORED: AtomicU64 = AtomicU64::new(0);
	/// [`on_event`] is registered.
	static REGISTERED: AtomicBool = AtomicBool::new(false);

	fn bit(sig: Signal) -> u64 {
		1u64 << (u32::from(sig.number(Platform::Windows)) - 1)
	}

	/// The signal a console control event stands for.
	const fn signal_of(event: u32) -> Option<Signal> {
		match event {
			CTRL_C_EVENT => Some(Signal::Int),
			CTRL_BREAK_EVENT => Some(Signal::Quit),
			CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => Some(Signal::Hup),
			_ => None,
		}
	}

	/// The console control handler. Windows runs it on a thread of its own,
	/// not interrupting the shell's (no async-signal constraints): no shell
	/// calls; the one lock it takes is the spawner's short group registry.
	pub(super) unsafe extern "system" fn on_event(event: u32) -> BOOL {
		let Some(sig) = signal_of(event) else {
			return 0;
		};
		let b = bit(sig);
		if event == CTRL_C_EVENT {
			// The job `fg` brought to the foreground leads console groups of
			// its own (one per stage), out of the console's Ctrl-C: they get
			// it as `CTRL_BREAK`, as a Unix terminal sends `SIGINT` to its
			// foreground group, and the shell, not in them, does not. A job
			// whose stages all ended leaves the event to the shell.
			let fg = crate::sys::console::ctrl_c_forward();
			if fg != 0 && crate::sys::break_console_groups(fg) {
				return 1;
			}
		}
		if TRAPPED.load(Ordering::Relaxed) & b != 0 {
			PENDING.fetch_or(b, Ordering::Relaxed);
			if sig == Signal::Int {
				crate::sys::console::ctrl_c_claimed();
			}
			return 1;
		}
		let ignored = IGNORED.load(Ordering::Relaxed) & b != 0;
		if ignored && sig == Signal::Int {
			crate::sys::console::ctrl_c_claimed();
		}
		BOOL::from(ignored)
	}

	/// The process host's console events; dropping it unregisters the
	/// handler.
	#[derive(Default)]
	pub struct Signals;

	impl Signals {
		/// Signals ignored when the process started: Windows exposes no
		/// inherited console-event disposition, so none.
		pub const fn ignored() -> SigSet {
			SigSet::EMPTY
		}

		/// Trap (`Some`), ignore (`Some("")`) or default (`None`) `sig`.
		#[expect(
			clippy::needless_pass_by_ref_mut,
			clippy::unused_self,
			reason = "the signature of the Unix `Signals::set`"
		)]
		pub fn set(&mut self, sig: Signal, action: Option<&BStr>) -> io::Result<bool> {
			if !matches!(sig, Signal::Int | Signal::Quit | Signal::Hup) {
				return Ok(true);
			}
			let b = bit(sig);
			let (trap, ignore) = match action {
				None => (false, false),
				Some(a) if a.is_empty() => (false, true),
				Some(_) => (true, false),
			};
			if (trap || ignore)
				&& !REGISTERED.swap(true, Ordering::AcqRel)
				// SAFETY: `on_event` is a valid handler for the process's
				// lifetime.
				&& unsafe { SetConsoleCtrlHandler(Some(on_event), 1) } == 0
			{
				REGISTERED.store(false, Ordering::Release);
				return Err(io::Error::last_os_error());
			}
			if trap {
				if sig == Signal::Int {
					// A process started in a new group, or under a host that
					// turned Ctrl-C off, gets no `CTRL_C_EVENT` at all, handler
					// or not: a shell catching `SIGINT` takes it back on, as
					// an interactive Unix shell catches a `SIGINT` ignored on
					// entry.
					// SAFETY: a null handler with FALSE only clears the flag.
					unsafe { SetConsoleCtrlHandler(None, 0) };
				}
				TRAPPED.fetch_or(b, Ordering::AcqRel);
			} else {
				TRAPPED.fetch_and(!b, Ordering::AcqRel);
			}
			if ignore {
				IGNORED.fetch_or(b, Ordering::AcqRel);
			} else {
				IGNORED.fetch_and(!b, Ordering::AcqRel);
			}
			if sig == Signal::Int {
				crate::sys::console::claim_ctrl_c(trap || ignore);
			}
			Ok(true)
		}

		/// Nothing to remember: no disposition is inherited but Ctrl-C's.
		#[expect(
			clippy::unused_self,
			clippy::needless_pass_by_ref_mut,
			clippy::missing_const_for_fn,
			reason = "mirrors the Unix `Signals::forget_ignored` signature"
		)]
		pub fn forget_ignored(&mut self, _sig: Signal) {}

		/// Deliver the console events caught since the last call to the
		/// root vproc.
		pub fn dispatch(ctl: &ControlHandle, root: Vpid) {
			let mut pending = PENDING.swap(0, Ordering::AcqRel);
			while pending != 0 {
				let number = pending.trailing_zeros() as u8 + 1;
				pending &= pending - 1;
				if let Some(signal) = Signal::from_number(number, Platform::Windows) {
					ctl.signal(SigTarget::Vpid(root), signal);
				}
			}
		}
	}

	impl Drop for Signals {
		fn drop(&mut self) {
			TRAPPED.store(0, Ordering::Release);
			crate::sys::console::claim_ctrl_c(false);
			IGNORED.store(0, Ordering::Release);
			PENDING.store(0, Ordering::Release);
			if REGISTERED.swap(false, Ordering::AcqRel) {
				// SAFETY: removes the handler registered above.
				unsafe { SetConsoleCtrlHandler(Some(on_event), 0) };
			}
		}
	}

	#[cfg(test)]
	mod tests {
		use super::*;

		/// Ctrl-C killed the shell at its prompt: a trapped event must be
		/// claimed (TRUE) and become a pending `SIGINT`; an untrapped one
		/// goes on to Windows' default (FALSE).
		#[test]
		fn trapped_ctrl_c_becomes_a_pending_sigint() {
			let mut signals = Signals;
			// SAFETY: the handler only touches atomics.
			assert_eq!(unsafe { on_event(CTRL_C_EVENT) }, 0);
			signals.set(Signal::Int, Some(BStr::new("x"))).unwrap();
			// SAFETY: as above.
			assert_eq!(unsafe { on_event(CTRL_C_EVENT) }, 1);
			assert_eq!(PENDING.swap(0, Ordering::AcqRel), bit(Signal::Int));
			signals.set(Signal::Int, Some(BStr::new(""))).unwrap();
			// SAFETY: as above.
			assert_eq!(unsafe { on_event(CTRL_C_EVENT) }, 1);
			assert_eq!(PENDING.load(Ordering::Acquire), 0);
			drop(signals);
		}
	}
}

#[cfg(windows)]
pub use windows::Signals;
