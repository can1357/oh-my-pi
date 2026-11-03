//! Bridge trapped OS signals into the shell's virtual signal bus.

#[cfg(not(unix))]
use std::io;

#[cfg(not(unix))]
use bstr::BStr;
#[cfg(not(unix))]
use pi_shell::bash::{ControlHandle, SigSet, Signal, Vpid};

#[cfg(unix)]
mod unix {
	use std::{
		collections::{HashMap, hash_map::Entry},
		io, ptr,
		sync::atomic::{AtomicU64, Ordering},
	};

	use bstr::BStr;
	use pi_shell::bash::{ControlHandle, Platform, SigSet, SigTarget, Signal, Vpid};

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
		original: HashMap<i32, libc::sigaction>,
	}

	impl Signals {
		/// Signals ignored when the process started (inherited dispositions).
		pub fn ignored() -> SigSet {
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
			if original.sa_sigaction == libc::SIG_IGN {
				return Ok(false);
			}
			if action.is_none() {
				// SAFETY: the saved action came from a successful sigaction query.
				if unsafe { libc::sigaction(number, original, ptr::null_mut()) } != 0 {
					return Err(io::Error::last_os_error());
				}
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
			Ok(true)
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
			PENDING.store(0, Ordering::Relaxed);
		}
	}
}

#[cfg(unix)]
pub use unix::Signals;

#[cfg(not(unix))]
#[derive(Default)]
pub struct Signals;

#[cfg(not(unix))]
impl Signals {
	/// Signals ignored when the process started (none tracked off Unix).
	pub const fn ignored() -> SigSet {
		SigSet::EMPTY
	}

	/// Accept every trap disposition (no OS signals to rewire off Unix).
	#[expect(
		clippy::unused_self,
		clippy::needless_pass_by_ref_mut,
		clippy::missing_const_for_fn,
		clippy::unnecessary_wraps,
		reason = "mirrors the Unix `Signals::set` signature"
	)]
	pub fn set(&mut self, _sig: Signal, _action: Option<&BStr>) -> io::Result<bool> {
		Ok(true)
	}

	/// Deliver caught OS signals (none off Unix).
	pub const fn dispatch(_ctl: &ControlHandle, _root: Vpid) {}
}
