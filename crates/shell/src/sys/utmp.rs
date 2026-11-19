//! The system's login database (utmpx), as zsh's `zsh/watch` reads it:
//! `setutxent`/`getutxent`/`endutxent` for the `USER_PROCESS` entries and
//! the utmpx file's modification time.

use std::io;

use crate::bash::Logins;

/// The utmpx file whose modification time tells zsh/watch the database
/// changed (`_PATH_UTMPX`).
#[cfg(target_os = "macos")]
const UTMPX_FILE: &str = "/var/run/utmpx";
/// The utmpx file whose modification time tells zsh/watch the database
/// changed (`_PATH_UTMPX`).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const UTMPX_FILE: &str = "/var/run/utmp";

/// The login sessions and the utmpx file's mtime
/// ([`Host::logins`](crate::bash::Host::logins)).
///
/// # Errors
/// The `stat` error of the utmpx file; `Unsupported` on platforms
/// without a utmpx database.
#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
pub fn logins() -> io::Result<Logins> {
	use std::{sync::Mutex, time::UNIX_EPOCH};

	use bstr::BString;

	use crate::bash::Login;

	/// `getutxent` walks one process-wide cursor.
	static CURSOR: Mutex<()> = Mutex::new(());

	/// A NUL-padded utmpx field as bytes.
	#[allow(clippy::cast_sign_loss, clippy::unnecessary_cast, reason = "c_char bytes")]
	fn field(f: &[libc::c_char]) -> BString {
		f.iter()
			.take_while(|&&c| c != 0)
			.map(|&c| c as u8)
			.collect::<Vec<u8>>()
			.into()
	}

	let modified = std::fs::metadata(UTMPX_FILE)?.modified()?;
	let mtime = match modified.duration_since(UNIX_EPOCH) {
		Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
		Err(e) => -i64::try_from(e.duration().as_secs()).unwrap_or(i64::MAX),
	};
	let mut entries = Vec::new();
	let _guard = CURSOR
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner);
	// SAFETY: the cursor functions run under `CURSOR`; each entry is read
	// before the next `getutxent` call replaces it.
	unsafe {
		libc::setutxent();
		loop {
			let u = libc::getutxent();
			if u.is_null() {
				break;
			}
			let u = &*u;
			if u.ut_type == libc::USER_PROCESS {
				#[allow(
					clippy::useless_conversion,
					reason = "`ut_tv.tv_sec` is i32 on glibc and i64 on macOS"
				)]
				entries.push(Login {
					user: field(&u.ut_user),
					line: field(&u.ut_line),
					host: field(&u.ut_host),
					time: i64::from(u.ut_tv.tv_sec),
				});
			}
		}
		libc::endutxent();
	}
	Ok(Logins { mtime, entries })
}

/// The login sessions ([`Host::logins`](crate::bash::Host::logins)):
/// this platform has no utmpx database.
///
/// # Errors
/// Always `Unsupported`.
#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
pub fn logins() -> io::Result<Logins> {
	Err(io::ErrorKind::Unsupported.into())
}

#[cfg(all(test, any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
mod tests {
	#[test]
	fn entries_are_user_sessions_with_names() {
		// A build machine may have no sessions; those it has carry a user.
		if let Ok(l) = super::logins() {
			assert!(l.entries.iter().all(|e| !e.user.is_empty()));
		}
	}
}
