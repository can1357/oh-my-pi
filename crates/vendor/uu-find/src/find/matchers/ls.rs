// This file is part of the uutils findutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::{fs::File, io::Write};

use chrono::DateTime;
use pi_uutils_ctx::stderr;

use super::{Matcher, MatcherIO, WalkEntry};

#[cfg(unix)]
fn format_permissions(mode: uucore::libc::mode_t) -> String {
	let file_type = match mode & (uucore::libc::S_IFMT as uucore::libc::mode_t) {
		uucore::libc::S_IFDIR => "d",
		uucore::libc::S_IFREG => "-",
		_ => "?",
	};

	// S_$$USR means "user permissions"
	let user_perms = format!(
		"{}{}{}",
		if mode & uucore::libc::S_IRUSR != 0 {
			"r"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IWUSR != 0 {
			"w"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IXUSR != 0 {
			"x"
		} else {
			"-"
		}
	);

	// S_$$GRP means "group permissions"
	let group_perms = format!(
		"{}{}{}",
		if mode & uucore::libc::S_IRGRP != 0 {
			"r"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IWGRP != 0 {
			"w"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IXGRP != 0 {
			"x"
		} else {
			"-"
		}
	);

	// S_$$OTH means "other permissions"
	let other_perms = format!(
		"{}{}{}",
		if mode & uucore::libc::S_IROTH != 0 {
			"r"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IWOTH != 0 {
			"w"
		} else {
			"-"
		},
		if mode & uucore::libc::S_IXOTH != 0 {
			"x"
		} else {
			"-"
		}
	);

	format!("{}{}{}{}", file_type, user_perms, group_perms, other_perms)
}

#[cfg(windows)]
fn format_permissions(file_attributes: u32) -> String {
	let mut attributes = Vec::new();

	// https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants
	if file_attributes & 0x0001 != 0 {
		attributes.push("read-only");
	}
	if file_attributes & 0x0002 != 0 {
		attributes.push("hidden");
	}
	if file_attributes & 0x0004 != 0 {
		attributes.push("system");
	}
	if file_attributes & 0x0020 != 0 {
		attributes.push("archive");
	}
	if file_attributes & 0x0040 != 0 {
		attributes.push("compressed");
	}
	if file_attributes & 0x0080 != 0 {
		attributes.push("offline");
	}

	attributes.join(", ")
}

pub struct Ls {
	output_file: Option<File>,
}

impl Ls {
	pub fn new(output_file: Option<File>) -> Self {
		Self { output_file }
	}

	#[cfg(unix)]
	fn print(
		&self,
		file_info: &WalkEntry,
		matcher_io: &mut MatcherIO,
		mut out: impl Write,
		print_error_message: bool,
	) {
		use std::os::unix::fs::{MetadataExt, PermissionsExt};

		use nix::unistd::{Gid, Group, Uid, User};

		let metadata = file_info.metadata().unwrap();

		let inode_number = metadata.ino();
		let number_of_blocks = {
			let size = metadata.size();
			let number_of_blocks = size / 1024;
			let remainder = number_of_blocks % 4;

			if remainder == 0 {
				if number_of_blocks == 0 {
					4
				} else {
					number_of_blocks
				}
			} else {
				number_of_blocks + (4 - (remainder))
			}
		};
		let permission =
			{ format_permissions(metadata.permissions().mode() as uucore::libc::mode_t) };
		let hard_links = metadata.nlink();
		let user = {
			let uid = metadata.uid();
			User::from_uid(Uid::from_raw(uid)).unwrap().unwrap().name
		};
		let group = {
			let gid = metadata.gid();
			Group::from_gid(Gid::from_raw(gid)).unwrap().unwrap().name
		};
		let size = metadata.size();
		let last_modified = {
			let system_time = metadata.modified().unwrap();
			let now_utc: DateTime<chrono::Utc> = system_time.into();
			now_utc.format("%b %e %H:%M")
		};
		let path = file_info.display_path().to_string_lossy();

		match writeln!(
			out,
			" {:<4} {:>6} {:<10} {:>3} {:<8} {:<8} {:>8} {} {}",
			inode_number,
			number_of_blocks,
			permission,
			hard_links,
			user,
			group,
			size,
			last_modified,
			path,
		) {
			Ok(_) => {},
			Err(e) => {
				if print_error_message {
					writeln!(
						&mut stderr(),
						"Error writing {:?} for {}",
						file_info.display_path().to_string_lossy(),
						e
					)
					.unwrap();
					matcher_io.set_exit_code(1);
				}
			},
		}
	}

	#[cfg(windows)]
	fn print(
		&self,
		file_info: &WalkEntry,
		matcher_io: &mut MatcherIO,
		mut out: impl Write,
		print_error_message: bool,
	) {
		use std::os::windows::fs::MetadataExt;

		let metadata = file_info.metadata().unwrap();

		let inode_number = 0;
		let number_of_blocks = {
			let size = metadata.file_size();
			let number_of_blocks = size / 1024;
			let remainder = number_of_blocks % 4;

			if remainder == 0 {
				if number_of_blocks == 0 {
					4
				} else {
					number_of_blocks
				}
			} else {
				number_of_blocks + (4 - (remainder))
			}
		};
		let permission = { format_permissions(metadata.file_attributes()) };
		let hard_links = 0;
		let user = 0;
		let group = 0;
		let size = metadata.file_size();
		let last_modified = {
			let system_time = metadata.modified().unwrap();
			let now_utc: DateTime<chrono::Utc> = system_time.into();
			now_utc.format("%b %e %H:%M")
		};
		let path = file_info.display_path().to_string_lossy();

		match write!(
			out,
			" {:<4} {:>6} {:<10} {:>3} {:<8} {:<8} {:>8} {} {}\n",
			inode_number,
			number_of_blocks,
			permission,
			hard_links,
			user,
			group,
			size,
			last_modified,
			path,
		) {
			Ok(_) => {},
			Err(e) => {
				if print_error_message {
					writeln!(
						&mut stderr(),
						"Error writing {:?} for {}",
						file_info.display_path().to_string_lossy(),
						e
					)
					.unwrap();
					matcher_io.set_exit_code(1);
				}
			},
		}
	}
}

impl Matcher for Ls {
	fn matches(&self, file_info: &WalkEntry, matcher_io: &mut MatcherIO) -> bool {
		if let Some(file) = &self.output_file {
			self.print(file_info, matcher_io, file, true);
		} else {
			self.print(file_info, matcher_io, &mut *matcher_io.deps.get_output().borrow_mut(), false);
		}
		true
	}

	fn has_side_effects(&self) -> bool {
		true
	}
}

#[cfg(test)]
mod tests {
	#[test]
	#[cfg(unix)]
	fn test_format_permissions() {
		use super::format_permissions;

		let mode: uucore::libc::mode_t = 0o100644;
		let expected = "-rw-r--r--";
		assert_eq!(format_permissions(mode), expected);

		let mode: uucore::libc::mode_t = 0o040755;
		let expected = "drwxr-xr-x";
		assert_eq!(format_permissions(mode), expected);

		let mode: uucore::libc::mode_t = 0o100777;
		let expected = "-rwxrwxrwx";
		assert_eq!(format_permissions(mode), expected);
	}
}
