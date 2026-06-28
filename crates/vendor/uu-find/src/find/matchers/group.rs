// This file is part of the uutils findutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;

#[cfg(unix)]
use nix::unistd::Group;

use super::{ComparableValue, Matcher, MatcherIO, WalkEntry};

pub struct GroupMatcher {
	gid: ComparableValue,
}

impl GroupMatcher {
	#[cfg(unix)]
	pub fn from_group_name(group: &str) -> Option<Self> {
		// get gid from group name
		let group = Group::from_name(group).ok()??;
		let gid = group.gid.as_raw();
		Some(Self::from_gid(gid))
	}

	pub fn from_gid(gid: u32) -> Self {
		Self::from_comparable(ComparableValue::EqualTo(gid as u64))
	}

	pub fn from_comparable(gid: ComparableValue) -> Self {
		Self { gid }
	}

	#[cfg(windows)]
	pub fn from_group_name(_group: &str) -> Option<Self> {
		None
	}
}

impl Matcher for GroupMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		match file_info.metadata() {
			Ok(metadata) => self.gid.matches(metadata.gid().into()),
			Err(_) => false,
		}
	}

	#[cfg(windows)]
	fn matches(&self, _file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		// The user group acquisition function for Windows systems is not implemented in
		// MetadataExt, so it is somewhat difficult to implement it. :(
		false
	}
}

pub struct NoGroupMatcher {}

impl Matcher for NoGroupMatcher {
	#[cfg(unix)]
	fn matches(&self, file_info: &WalkEntry, _: &mut MatcherIO) -> bool {
		use nix::unistd::Gid;

		if file_info.path().is_symlink() {
			return false;
		}

		let Ok(metadata) = file_info.metadata() else {
			return true;
		};

		let Ok(gid) = Group::from_gid(Gid::from_raw(metadata.gid())) else {
			return true;
		};

		let Some(_group) = gid else {
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
	fn test_group_matcher() {
		use std::{fs::File, os::unix::fs::MetadataExt};

		use chrono::Local;
		use nix::unistd::{Gid, Group};
		use tempfile::Builder;

		use crate::find::{
			matchers::{Matcher, group::GroupMatcher, tests::get_dir_entry_for},
			tests::FakeDependencies,
		};

		let deps = FakeDependencies::new();
		let mut matcher_io = deps.new_matcher_io();

		let temp_dir = Builder::new().prefix("group_matcher").tempdir().unwrap();
		let foo_path = temp_dir.path().join("foo");
		let _ = File::create(foo_path).expect("create temp file");
		let file_info = get_dir_entry_for(&temp_dir.path().to_string_lossy(), "foo");
		let file_gid = file_info.metadata().unwrap().gid();
		let file_group = Group::from_gid(Gid::from_raw(file_gid))
			.unwrap()
			.unwrap()
			.name;

		let matcher =
			super::GroupMatcher::from_group_name(file_group.as_str()).expect("group should exist");
		assert!(matcher.matches(&file_info, &mut matcher_io), "group should match");

		// Testing a non-existent group name
		let time_string = Local::now().format("%Y%m%d%H%M%S").to_string();
		let matcher = GroupMatcher::from_group_name(time_string.as_str());
		assert!(matcher.is_none(), "group name {} should not exist", time_string);

		// Testing group id
		let matcher = GroupMatcher::from_gid(file_gid);
		assert!(matcher.matches(&file_info, &mut matcher_io), "group id should match");
	}
}
