use std::{
	io::{self, Read},
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use omp_vfs::{BlockingFs, Metadata, ReadDir};

use crate::host::Host;

use super::{Io, PStr, Value, bad_fd, device, input_path};

/// An `opendir` stream with a replayable logical position from `telldir`.
/// `.` and `..` are synthesized because the host filesystem omits them.
pub(in crate::perl) struct DirHandle {
	fs: BlockingFs,
	path: PathBuf,
	entries: Option<ReadDir>,
	pos: u64,
}

impl DirHandle {
	/// Open an already resolved directory without remapping shell descriptors.
	pub fn open_resolved(host: &Host, path: PathBuf) -> io::Result<Self> {
		let entries = host.fs().read_dir(&path)?;
		Ok(Self { fs: host.fs().clone(), path, entries: Some(entries), pos: 0 })
	}

	/// Return one directory entry name, or `None` at end of directory.
	pub fn read(&mut self) -> io::Result<Option<PStr>> {
		let iter = self.entries.as_mut().ok_or_else(bad_fd)?;
		let name = match self.pos {
			0 => PStr::from_bytes(b"."),
			1 => PStr::from_bytes(b".."),
			_ => match iter.next().transpose()? {
				Some(entry) => PStr::new(entry.file_name().into_encoded_bytes(), false),
				None => return Ok(None),
			},
		};
		self.pos = self.pos.saturating_add(1);
		Ok(Some(name))
	}

	/// The opaque position for this stream's `seek` (`telldir`).
	pub fn tell(&self) -> io::Result<u64> {
		self.entries.as_ref().map(|_| self.pos).ok_or_else(bad_fd)
	}

	/// Return to a previously reported position (`seekdir`).
	pub fn seek(&mut self, pos: u64) -> io::Result<()> {
		let current = self.tell()?;
		if pos < current {
			self.rewind()?;
		}
		if pos > self.pos && self.pos < 2 {
			self.pos = pos.min(2);
		}
		let iter = self.entries.as_mut().ok_or_else(bad_fd)?;
		while self.pos < pos {
			match iter.next().transpose()? {
				Some(_) => self.pos += 1,
				None => break,
			}
		}
		Ok(())
	}

	/// Restart the directory stream (`rewinddir`).
	pub fn rewind(&mut self) -> io::Result<()> {
		self.tell()?;
		self.entries = Some(self.fs.read_dir(&self.path)?);
		self.pos = 0;
		Ok(())
	}

	/// Close the directory stream (`closedir`).
	pub fn close(&mut self) -> io::Result<()> {
		self.entries.take().map(|_| ()).ok_or_else(bad_fd)
	}

	fn metadata(&self) -> io::Result<Metadata> {
		self.tell()?;
		self.fs.metadata(&self.path)
	}
}

/// The operand of `stat`, `lstat`, or a unary file test.
#[derive(Clone, Copy)]
pub(in crate::perl) enum FileTestTarget<'a> {
	/// A filename in the host filesystem.
	Path(&'a [u8]),
	/// A path already mapped through the interpreter and the shell.
	ResolvedPath(&'a Path),
	/// An already-open Perl filehandle, potentially with buffered input.
	Handle(&'a Io),
	/// An already-open directory handle.
	Dir(&'a DirHandle),
	/// A numeric descriptor in the shell's fd table (primarily for `-t`).
	Descriptor(i32),
	/// The stat cache backing Perl's special `_` filehandle.
	Cached(&'a Metadata),
}

/// Get the underlying provider-neutral metadata; retain it in the
/// interpreter for subsequent `stat(_)` and `-X _` operations.
pub(in crate::perl) fn stat_metadata(host: &Host, target: FileTestTarget<'_>, follow: bool) -> io::Result<Metadata> {
	match target {
		FileTestTarget::Path(path) => {
			let path = input_path(path)?;
			if follow { host.fs().metadata(host.resolve(path)) } else { host.fs().symlink_metadata(host.paths().resolve_link(path)) }
		},
		FileTestTarget::ResolvedPath(path) => {
			if follow { host.fs().metadata(path) } else { host.fs().symlink_metadata(path) }
		},
		FileTestTarget::Handle(handle) => handle.try_borrow().map_err(|_| bad_fd())?.metadata(),
		FileTestTarget::Dir(dir) => dir.metadata(),
		FileTestTarget::Descriptor(fd) => host.paths().file(fd).ok_or_else(bad_fd).and_then(device::metadata),
		FileTestTarget::Cached(meta) => Ok(meta.clone()),
	}
}

/// Perl's ordered, 13-field `stat`/`lstat` list; missing provider fields
/// are zero (or empty for filesystem block counters).
pub(in crate::perl) fn stat(host: &Host, target: FileTestTarget<'_>, follow: bool) -> io::Result<[Value; 13]> {
	let meta = stat_metadata(host, target, follow)?;
	Ok([
		Value::Int(meta.dev().unwrap_or(0) as i64),
		uiv(meta.ino().unwrap_or(0)),
		Value::Int(i64::from(meta.mode())),
		uiv(meta.nlink().unwrap_or(0)),
		Value::Int(i64::from(meta.uid().unwrap_or(0))),
		Value::Int(i64::from(meta.gid().unwrap_or(0))),
		uiv(meta.rdev().unwrap_or(0)),
		uiv(meta.len()),
		Value::Int(meta.atime().unwrap_or(0)),
		Value::Int(meta.mtime().unwrap_or(0)),
		Value::Int(meta.ctime().unwrap_or(0)),
		meta.blksize().map_or_else(false_value, uiv),
		meta.blocks().map_or_else(false_value, uiv),
	])
}

/// Evaluate one unary `-X` file test. Err represents Perl's undef plus `$!`;
/// pass the interpreter's `$^T` as `started` for `-M`, `-A`, and `-C`.
pub(in crate::perl) fn file_test(host: &Host, op: u8, target: FileTestTarget<'_>, started: SystemTime) -> io::Result<Value> {
	if op == b't' {
		let terminal = match target {
			FileTestTarget::Handle(handle) => {
				let handle = handle.try_borrow().map_err(|_| bad_fd())?;
				if !handle.is_open() || handle.fileno() == Some(-1) {
					return Err(bad_fd());
				}
				handle.is_terminal()
			},
			FileTestTarget::Descriptor(fd) => host.paths().file(fd).is_some_and(crate::openfile::OpenFile::is_terminal),
			FileTestTarget::Path(path) => {
				let fd = std::str::from_utf8(path).ok().and_then(|n| n.parse::<i32>().ok()).ok_or_else(bad_fd)?;
				host.paths().file(fd).is_some_and(crate::openfile::OpenFile::is_terminal)
			},
			FileTestTarget::ResolvedPath(_) => return Err(bad_fd()),
			FileTestTarget::Dir(_) | FileTestTarget::Cached(_) => false,
		};
		return Ok(boolean(terminal));
	}
	if op == b'l' && !matches!(target, FileTestTarget::Path(_) | FileTestTarget::ResolvedPath(_) | FileTestTarget::Cached(_)) {
		return Err(io::Error::from_raw_os_error(libc::ENOENT));
	}
	let meta = stat_metadata(host, target, op != b'l')?;
	let ty = meta.file_type();
	let mode = meta.mode();
	Ok(match op {
		b'e' => Value::Int(1),
		b'f' => boolean(ty.is_file()),
		b'd' => boolean(ty.is_dir()),
		b'l' => boolean(ty.is_symlink()),
		b'p' => boolean(ty.is_fifo()),
		b'S' => boolean(ty.is_socket()),
		b'b' => boolean(ty.is_block_device()),
		b'c' => boolean(ty.is_char_device()),
		b's' => uiv(meta.len()),
		b'z' => boolean(meta.len() == 0),
		b'r' | b'w' | b'x' | b'R' | b'W' | b'X' => boolean(permitted(&meta, op)),
		b'o' | b'O' => boolean(owner(&meta, op == b'O')),
		b'u' => boolean(mode & 0o4000 != 0),
		b'g' => boolean(mode & 0o2000 != 0),
		b'k' => boolean(mode & 0o1000 != 0),
		b'T' | b'B' if ty.is_dir() => boolean(op == b'B'),
		b'T' | b'B' => text_test(host, target, op)?,
		b'M' => age(started, meta.mtime()),
		b'A' => age(started, meta.atime()),
		b'C' => age(started, meta.ctime()),
		_ => return Err(io::ErrorKind::InvalidInput.into()),
	})
}

const TEXT_SAMPLE: usize = 512;

fn text_test(host: &Host, target: FileTestTarget<'_>, op: u8) -> io::Result<Value> {
	let classify = |sample: &[u8]| boolean(sample.is_empty() || looks_binary(sample) == (op == b'B'));
	match target {
		FileTestTarget::Path(path) => {
			text_file(host.fs().open(host.resolve(input_path(path)?))?, classify)
		},
		FileTestTarget::ResolvedPath(path) => text_file(host.fs().open(path)?, classify),
		FileTestTarget::Handle(handle) => {
			let mut handle = handle.try_borrow_mut().map_err(|_| bad_fd())?;
			handle.with_input(|input, device| {
				let bytes = input.peek(device)?;
				Ok(classify(&bytes[..bytes.len().min(TEXT_SAMPLE)]))
			})
		},
		FileTestTarget::Descriptor(fd) => {
			use std::io::{Seek, SeekFrom};
			let file = host.paths().file(fd).ok_or_else(bad_fd)?.clone();
			let mut device = device::Device::descriptor(file, Some(host.cancel_flag()), None);
			let pos = device.stream_position()?;
			let mut bytes = [0; TEXT_SAMPLE];
			let read = device.read(&mut bytes);
			let restore = device.seek(SeekFrom::Start(pos));
			Ok(classify(&bytes[..read.and_then(|len| restore.map(|_| len))?]))
		},
		FileTestTarget::Dir(_) | FileTestTarget::Cached(_) => Err(bad_fd()),
	}
}

fn text_file(mut file: omp_vfs::File, classify: impl FnOnce(&[u8]) -> Value) -> io::Result<Value> {
	let mut bytes = [0; TEXT_SAMPLE];
	let len = file.read(&mut bytes)?;
	Ok(classify(&bytes[..len]))
}

fn looks_binary(sample: &[u8]) -> bool {
	if sample.contains(&0) {
		return true;
	}
	match xutf::decode(sample) {
		Ok(text) if !text.is_ascii() => return false,
		// A full sample may cut off a character; the next bytes weren't inspected.
		Err(xutf::DecodeError::Incomplete { valid_prefix, .. })
			if sample.len() == TEXT_SAMPLE && !valid_prefix.is_ascii() => return false,
		_ => {},
	}
	let odd = sample.iter().filter(|&&byte| !matches!(byte, 8..=10 | 12..=13 | 27 | 32..=126)).count();
	odd * 3 > sample.len()
}

fn uiv(n: u64) -> Value {
	i64::try_from(n).map_or(Value::UInt(n), Value::Int)
}

fn false_value() -> Value {
	Value::Str(PStr::default())
}

fn boolean(yes: bool) -> Value {
	if yes { Value::Int(1) } else { false_value() }
}

fn age(started: SystemTime, actual: Option<i64>) -> Value {
	let Some(actual) = actual else { return Value::Undef };
	let start = started.duration_since(UNIX_EPOCH).map_or_else(
		|before| -before.duration().as_secs_f64().ceil(),
		|since| since.as_secs() as f64,
	);
	Value::Num((start - actual as f64) / 86_400.0)
}

#[cfg(unix)]
fn owner(meta: &Metadata, real: bool) -> bool {
	use nix::unistd::{geteuid, getuid};
	let uid = if real { getuid() } else { geteuid() };
	meta.uid() == Some(uid.as_raw())
}

#[cfg(not(unix))]
fn owner(meta: &Metadata, _real: bool) -> bool {
	meta.native().is_some()
}

/// Return the process's supplementary groups using the native API.
#[cfg(unix)]
pub(in crate::perl) fn supplementary_groups() -> Vec<u32> {
	#[cfg(target_os = "macos")]
	if let Some(groups) = darwin_groups() { return groups; }
	rustix::process::getgroups().unwrap_or_default().into_iter().map(|g| g.as_raw()).collect()
}

/// The plain `getgroups` symbol on macOS stops at 16 groups; perl (built with `_DARWIN_C_SOURCE`)
/// calls the extended variant, which reports every group membership.
#[cfg(target_os = "macos")]
fn darwin_groups() -> Option<Vec<u32>> {
	unsafe extern "C" {
		#[link_name = "getgroups$DARWIN_EXTSN"]
		fn getgroups_extsn(size: libc::c_int, list: *mut libc::gid_t) -> libc::c_int;
	}
	// SAFETY: a zero size only queries the count; the null list is never written.
	let count = unsafe { getgroups_extsn(0, std::ptr::null_mut()) };
	let count = usize::try_from(count).ok()?;
	// Room for groups added between the two calls.
	let mut list: Vec<libc::gid_t> = vec![0; count + 8];
	let size = libc::c_int::try_from(list.len()).ok()?;
	// SAFETY: `list` holds exactly `size` writable gid_t slots.
	let got = unsafe { getgroups_extsn(size, list.as_mut_ptr()) };
	list.truncate(usize::try_from(got).ok()?);
	Some(list)
}

fn permitted(meta: &Metadata, op: u8) -> bool {
	let bit = match op.to_ascii_lowercase() { b'r' => 4, b'w' => 2, _ => 1 };
	let mode = meta.mode();
	#[cfg(unix)]
	if let Some(owner) = meta.uid() {
		use nix::unistd::{getegid, geteuid, getgid, getuid};
		let real = op.is_ascii_uppercase();
		let uid = if real { getuid() } else { geteuid() };
		if uid.is_root() {
			return bit != 1 || mode & 0o111 != 0;
		}
		if uid.as_raw() == owner {
			return mode & (bit << 6) != 0;
		}
		if let Some(group) = meta.gid() {
			let gid = if real { getgid() } else { getegid() };
			if gid.as_raw() == group || supplementary_groups().contains(&group) {
				return mode & (bit << 3) != 0;
			}
		}
		return mode & bit != 0;
	}
	// Some providers expose mode bits without an ownership model.
	mode & (bit << 6 | bit << 3 | bit) != 0
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn text_heuristic_distinguishes_utf8_controls_nul_and_threshold() {
		assert!(!looks_binary("éλ".as_bytes()));
		assert!(!looks_binary(b"\x08\x09\x0a\x0c\x0d\x1b"));
		assert!(!looks_binary(b"xy\xff"));
		assert!(looks_binary(b"x\xff"));
		assert!(looks_binary("é\0".as_bytes()));
	}
}
