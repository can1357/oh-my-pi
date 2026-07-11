// This file is part of the uutils findutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(unix)]
use nix::unistd::User;

use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

pub struct UserMatcher {
	uid: ComparableValue,
}

impl UserMatcher {
	#[cfg(unix)]
	pub fn from_user_name(user: &str) -> Option<Self> {
		// get uid from user name
		let user = User::from_name(user).ok()??;
		let uid = user.uid.as_raw();
		Some(Self::from_uid(uid))
	}

	pub fn from_uid(uid: u32) -> Self {
		Self::from_comparable(ComparableValue::EqualTo(uid as u64))
	}

	pub fn from_comparable(uid: ComparableValue) -> Self {
		Self { uid }
	}

	#[cfg(windows)]
	pub fn from_user_name(_user: &str) -> Option<Self> {
		None
	}
}

impl Matcher for UserMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match file_info.metadata() {
			Ok(metadata) => self.uid.matches(metadata.uid().into()),
			Err(_) => false,
		}
	}

	#[cfg(windows)]
	fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		false
	}
}

pub struct NoUserMatcher {}

impl Matcher for NoUserMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		use nix::unistd::Uid;

		if file_info.path().is_symlink() {
			return false;
		}

		let Ok(metadata) = file_info.metadata() else {
			return true;
		};

		let Ok(uid) = User::from_uid(Uid::from_raw(metadata.uid())) else {
			return true;
		};

		let Some(_user) = uid else {
			return true;
		};

		false
	}

	#[cfg(windows)]
	fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		false
	}
}

#[cfg(test)]
mod tests {
	#[test]
	#[cfg(unix)]
	fn test_user_matcher() {
		use std::{fs::File, os::unix::fs::MetadataExt};

		use chrono::Local;
		use nix::unistd::{Uid, User};
		use tempfile::Builder;

		use crate::find::{
			matchers::{Matcher, tests::get_dir_entry_for, user::UserMatcher},
			tests::FakeDependencies,
		};

		let deps = FakeDependencies::new();
		let mut matcher_io = deps.new_matcher_io();

		let temp_dir = Builder::new().prefix("user_matcher").tempdir().unwrap();
		let foo_path = temp_dir.path().join("foo");
		let _ = File::create(foo_path).expect("create temp file");
		let file_info = get_dir_entry_for(&temp_dir.path().to_string_lossy(), "foo");
		let file_uid = file_info.metadata().unwrap().uid();
		let file_user = User::from_uid(Uid::from_raw(file_uid))
			.unwrap()
			.unwrap()
			.name;

		let matcher = UserMatcher::from_user_name(file_user.as_str()).expect("user should exist");
		assert!(matcher.matches(&file_info, &mut matcher_io), "user should be the same");

		// Testing a non-existent group name
		let time_string = Local::now().format("%Y%m%d%H%M%S").to_string();
		let matcher = UserMatcher::from_user_name(time_string.as_str());
		assert!(matcher.is_none(), "user {} should not be the same", time_string);

		// Testing user id
		let matcher = UserMatcher::from_uid(file_uid);
		assert!(matcher.matches(&file_info, &mut matcher_io), "user id should match");
	}
}
