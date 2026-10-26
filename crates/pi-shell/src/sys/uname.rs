//! The running system's identity (`uname(2)`), for
//! [`Host::uname`](crate::bash::Host::uname).

use bstr::BString;

/// `uname`'s system name, release and machine; `None` when the call fails
/// or the platform has none.
pub fn uname() -> Option<(BString, BString, BString)> {
	#[cfg(unix)]
	{
		// SAFETY: `utsname` is plain data, valid when zeroed.
		let mut u: libc::utsname = unsafe { std::mem::zeroed() };
		// SAFETY: `u` is a valid, writable `utsname`.
		if unsafe { libc::uname(&raw mut u) } != 0 {
			return None;
		}
		let field = |f: &[libc::c_char]| -> BString {
			f.iter()
				.take_while(|&&c| c != 0)
				.map(|&c| c.to_ne_bytes()[0])
				.collect::<Vec<u8>>()
				.into()
		};
		Some((field(&u.sysname), field(&u.release), field(&u.machine)))
	}
	#[cfg(not(unix))]
	{
		None
	}
}
