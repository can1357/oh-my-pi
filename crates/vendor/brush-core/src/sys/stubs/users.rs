use std::path::PathBuf;

use crate::error;

pub(crate) fn get_user_home_dir(_username: &str) -> Option<PathBuf> {
	None
}

pub(crate) fn get_current_user_home_dir() -> Option<PathBuf> {
	std::env::home_dir()
}

pub(crate) fn get_current_user_default_shell() -> Option<PathBuf> {
	None
}

pub(crate) fn is_root() -> bool {
	false
}

pub(crate) fn get_current_uid() -> Result<u32, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("getting current uid").into())
}

pub(crate) fn get_current_gid() -> Result<u32, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("getting current gid").into())
}

pub(crate) fn get_effective_uid() -> Result<u32, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("getting effective uid").into())
}

pub(crate) fn get_effective_gid() -> Result<u32, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("getting effective gid").into())
}

pub(crate) fn get_current_username() -> Result<String, error::Error> {
	Err(error::ErrorKind::NotSupportedOnThisPlatform("getting current username").into())
}

pub(crate) fn get_user_group_ids() -> Result<Vec<u32>, error::Error> {
	Ok(vec![])
}

pub(crate) fn get_all_users() -> Result<Vec<String>, error::Error> {
	Ok(vec![])
}

pub(crate) fn get_all_groups() -> Result<Vec<String>, error::Error> {
	Ok(vec![])
}
