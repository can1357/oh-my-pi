#![allow(clippy::missing_const_for_fn)]
#![allow(clippy::unnecessary_wraps)]

use std::{path::PathBuf, sync::LazyLock};

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
	check_elevation::is_elevated().unwrap_or_else(|err| {
		tracing::warn!("failed to determine process elevation: {err}");
		false
	})
});

pub(crate) fn get_user_home_dir(_username: &str) -> Option<PathBuf> {
	// std::env::home_dir() doesn't support getting home dir for arbitrary users
	// For now, we only support getting the current user's home dir
	None
}

pub(crate) fn get_current_user_home_dir() -> Option<PathBuf> {
	std::env::home_dir()
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
	let username = whoami::username().map_err(std::io::Error::from)?;
	Ok(username)
}

#[allow(clippy::unnecessary_wraps)]
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
