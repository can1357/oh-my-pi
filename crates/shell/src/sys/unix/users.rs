#[cfg(not(target_vendor = "apple"))]
use std::ffi::CString;
use std::path::PathBuf;
#[cfg(target_vendor = "apple")]
use std::{io, ptr};

use nix::unistd::{Gid, Group, Uid, User};

use crate::error;

pub(crate) fn is_root() -> bool {
	Uid::current().is_root()
}

pub(crate) fn get_user_home_dir(username: &str) -> Option<PathBuf> {
	User::from_name(username)
		.ok()
		.flatten()
		.map(|user| user.dir)
}

pub(crate) fn get_current_user_home_dir() -> Option<PathBuf> {
	User::from_uid(Uid::current())
		.ok()
		.flatten()
		.map(|user| user.dir)
}

pub(crate) fn get_current_user_default_shell() -> Option<PathBuf> {
	User::from_uid(Uid::current())
		.ok()
		.flatten()
		.map(|user| user.shell)
}

#[expect(
	clippy::unnecessary_wraps,
	reason = "the cross-platform interface returns fallible identity values"
)]
pub(crate) fn get_current_uid() -> Result<u32, error::Error> {
	Ok(Uid::current().as_raw())
}

#[expect(
	clippy::unnecessary_wraps,
	reason = "the cross-platform interface returns fallible identity values"
)]
pub(crate) fn get_current_gid() -> Result<u32, error::Error> {
	Ok(Gid::current().as_raw())
}

#[expect(
	clippy::unnecessary_wraps,
	reason = "the cross-platform interface returns fallible identity values"
)]
pub(crate) fn get_effective_uid() -> Result<u32, error::Error> {
	Ok(Uid::effective().as_raw())
}

#[expect(
	clippy::unnecessary_wraps,
	reason = "the cross-platform interface returns fallible identity values"
)]
pub(crate) fn get_effective_gid() -> Result<u32, error::Error> {
	Ok(Gid::effective().as_raw())
}

pub(crate) fn get_current_username() -> Result<String, error::Error> {
	User::from_uid(Uid::current())?
		.map(|user| user.name)
		.ok_or_else(|| error::ErrorKind::NoCurrentUser.into())
}

pub(crate) fn get_user_group_ids() -> Result<Vec<u32>, error::Error> {
	Ok(get_current_user_groups()?
		.into_iter()
		.map(Gid::as_raw)
		.collect())
}

pub(crate) fn get_all_users() -> Result<Vec<String>, error::Error> {
	// Keep the prior deliberately bounded behavior: completion exposes the current
	// account rather than traversing the process-global passwd iterator.
	Ok(vec![get_current_username()?])
}

pub(crate) fn get_all_groups() -> Result<Vec<String>, error::Error> {
	Ok(get_current_user_groups()?
		.into_iter()
		.filter_map(|gid| Group::from_gid(gid).ok().flatten().map(|group| group.name))
		.collect())
}

#[cfg(not(target_vendor = "apple"))]
fn get_current_user_groups() -> Result<Vec<Gid>, error::Error> {
	let username =
		CString::new(get_current_username()?).map_err(|_| error::ErrorKind::NoCurrentUser)?;
	Ok(nix::unistd::getgrouplist(&username, Gid::current()).unwrap_or_default())
}

#[cfg(target_vendor = "apple")]
fn get_current_user_groups() -> Result<Vec<Gid>, error::Error> {
	let primary = Gid::current();
	// SAFETY: a null buffer with zero length is the documented sizing query.
	let count = unsafe { libc::getgroups(0, ptr::null_mut()) };
	if count < 0 {
		return Err(io::Error::last_os_error().into());
	}
	let mut raw_groups = vec![0 as libc::gid_t; count as usize];
	// SAFETY: `raw_groups` contains `count` writable gid_t slots.
	let filled = unsafe { libc::getgroups(count, raw_groups.as_mut_ptr()) };
	if filled < 0 {
		return Err(io::Error::last_os_error().into());
	}
	raw_groups.truncate(filled as usize);
	let mut groups: Vec<Gid> = raw_groups.into_iter().map(Gid::from_raw).collect();
	if !groups.contains(&primary) {
		groups.push(primary);
	}
	Ok(groups)
}
