#![allow(
	clippy::missing_const_for_fn,
	clippy::unnecessary_wraps,
	reason = "Windows implementations retain the Unix-compatible fallible user API"
)]

use std::{env, io, mem, path::PathBuf, ptr, sync::LazyLock};

use crate::error;

/// Placeholder UID for non-elevated Windows processes.
///
/// Real Unix-style UIDs don't exist on Windows; this value is a
/// conventional non-root sentinel (matching the typical first
/// regular-user UID on Linux).
const NON_ELEVATED_UID: u32 = 1000;

/// Placeholder GID for non-elevated Windows processes (see
/// [`NON_ELEVATED_UID`]).
const NON_ELEVATED_GID: u32 = 1000;

/// Cached elevation status. The underlying check queries the process token,
/// which can't change after process start, so it's safe to memoize.
static IS_ELEVATED: LazyLock<bool> = LazyLock::new(|| {
	query_elevation().unwrap_or_else(|err| {
		tracing::warn!(error = %err, "failed to determine process elevation");
		false
	})
});

fn query_elevation() -> io::Result<bool> {
	use windows_sys::Win32::{
		Foundation::{CloseHandle, HANDLE},
		Security::{GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	let mut token: HANDLE = ptr::null_mut();
	// SAFETY: GetCurrentProcess returns a valid pseudo-handle and `token` is
	// writable.
	if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
		return Err(io::Error::last_os_error());
	}

	let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
	let mut returned = 0_u32;
	// SAFETY: `token` is live and `elevation` is writable for its reported size.
	let succeeded = unsafe {
		GetTokenInformation(
			token,
			TokenElevation,
			(&raw mut elevation).cast(),
			mem::size_of::<TOKEN_ELEVATION>() as u32,
			&mut returned,
		)
	};
	// SAFETY: `token` was returned by OpenProcessToken and is closed exactly once.
	unsafe {
		CloseHandle(token);
	}
	if succeeded == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(elevation.TokenIsElevated != 0)
}

pub(crate) fn get_user_home_dir(_username: &str) -> Option<PathBuf> {
	// std::env::home_dir() doesn't support getting home dir for arbitrary users
	// For now, we only support getting the current user's home dir
	None
}

pub(crate) fn get_current_user_home_dir() -> Option<PathBuf> {
	env::home_dir()
}

pub(crate) fn get_current_user_default_shell() -> Option<PathBuf> {
	None
}

fn is_elevated() -> bool {
	*IS_ELEVATED
}

pub(crate) fn is_root() -> bool {
	is_elevated()
}

pub(crate) fn get_current_uid() -> Result<u32, error::Error> {
	Ok(if is_elevated() { 0 } else { NON_ELEVATED_UID })
}

pub(crate) fn get_current_gid() -> Result<u32, error::Error> {
	Ok(if is_elevated() { 0 } else { NON_ELEVATED_GID })
}

pub(crate) fn get_effective_uid() -> Result<u32, error::Error> {
	Ok(if is_elevated() { 0 } else { NON_ELEVATED_UID })
}

pub(crate) fn get_effective_gid() -> Result<u32, error::Error> {
	Ok(if is_elevated() { 0 } else { NON_ELEVATED_GID })
}

pub(crate) fn get_current_username() -> Result<String, error::Error> {
	use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

	let mut units = 0_u32;
	// SAFETY: null/zero is the documented buffer sizing query.
	unsafe {
		GetUserNameW(ptr::null_mut(), &mut units);
	}
	if units == 0 {
		return Err(io::Error::last_os_error().into());
	}
	let mut name = vec![0_u16; units as usize];
	// SAFETY: `name` has `units` writable UTF-16 code units.
	if unsafe { GetUserNameW(name.as_mut_ptr(), &mut units) } == 0 {
		return Err(io::Error::last_os_error().into());
	}
	let length = name
		.iter()
		.position(|unit| *unit == 0)
		.unwrap_or(name.len());
	String::from_utf16(&name[..length])
		.map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error).into())
}

pub(crate) fn get_user_group_ids() -> Result<Vec<u32>, error::Error> {
	// TODO(windows): implement some version of this for Windows
	Ok(vec![])
}

#[expect(clippy::unnecessary_wraps)]
pub(crate) fn get_all_users() -> Result<Vec<String>, error::Error> {
	// TODO(windows): implement some version of this for Windows
	Ok(vec![])
}

#[expect(clippy::unnecessary_wraps)]
pub(crate) fn get_all_groups() -> Result<Vec<String>, error::Error> {
	// TODO(windows): implement some version of this for Windows
	Ok(vec![])
}
