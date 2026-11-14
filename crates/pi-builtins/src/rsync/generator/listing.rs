//! `--list-only` output (upstream list_file_entry).

use super::Gen;
use crate::rsync::{
	flist::FileEntry,
	log::{LogCode, big_num, permstring, timestring},
};

/// One `--list-only` line: permissions, size (11 columns with `--no-h`, else 14),
/// mtime, optional atime/crtime columns, the name, and ` -> target` for symlinks.
pub(super) fn list_line(
	f: &FileEntry,
	human: u8,
	tz: &jiff::tz::TimeZone,
	atimes: bool,
	crtimes: bool,
	preserve_links: bool,
	missing_args: bool,
) -> Vec<u8> {
	let mtime_str = timestring(f.mtime, tz);
	let size_width = if human != 0 { 14 } else { 11 };
	let mtime_width = 1 + mtime_str.len();
	let atime_width = if atimes { mtime_width } else { 0 };
	let crtime_width = if crtimes { mtime_width } else { 0 };
	let name = f.name();
	let mut line = Vec::with_capacity(80 + name.len());
	if missing_args && f.mode == 0 {
		let width = 10 + 1 + size_width + mtime_width + atime_width + crtime_width;
		line.extend_from_slice(format!("{:<width$} ", "*missing").as_bytes());
		line.extend_from_slice(&name);
		line.push(b'\n');
		return line;
	}
	let atime_str = if atimes && !f.is_dir() { timestring(f.atime, tz) } else { String::new() };
	let crtime_str = if crtimes { timestring(f.crtime, tz) } else { String::new() };
	line.extend_from_slice(&permstring(f.mode));
	let size = big_num(f.size as i64, human);
	line.extend_from_slice(
		format!(" {size:>size_width$} {mtime_str}{atime_str:>atime_width$}{crtime_str:>crtime_width$} ").as_bytes(),
	);
	line.extend_from_slice(&name);
	if preserve_links && f.is_symlink() {
		line.extend_from_slice(b" -> ");
		line.extend_from_slice(f.link.as_deref().unwrap_or_default());
	}
	line.push(b'\n');
	line
}

impl Gen<'_> {
	/// list_file_entry.
	pub(super) fn list_file_entry(&self, f: &FileEntry) {
		if !f.is_active() {
			// Duplicate names removed from the list.
			return;
		}
		let cfg = self.log.config();
		let tz = cfg.time_zone.clone().unwrap_or_else(jiff::tz::TimeZone::system);
		let line = list_line(
			f,
			cfg.human_readable,
			&tz,
			self.opts.preserve_atimes > 0,
			self.opts.preserve_crtimes,
			self.opts.preserve_links,
			self.opts.missing_args == 2,
		);
		self.say(LogCode::Info, &line);
	}
}
