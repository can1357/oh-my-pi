//! Keeps the process's own SQLite locks from being released by unrelated
//! closes of the same files (issue #15586).
//!
//! SQLite's unix VFS takes POSIX record locks, which belong to the process and
//! the inode: closing *any* descriptor of the file releases every one of them.
//! A builtin `cat agent.db-shm`, a grep walk over `~/.omp`, or a `Bun.file`
//! read of `agent.db` used to release a live connection's locks; a peer omp
//! then saw no other connection, checkpointed and unlinked the WAL under it,
//! and the two later wrote diverging pages into the shared file.
//!
//! [`install_sqlite_lock_shim`] moves Bun's SQLite onto open-file-description
//! locks, which no other close releases ([`ofd_locks`]). [`held_file_kind`]
//! reports a file the process holds that way, so tools can refuse to overwrite
//! a live database.

#[cfg(target_os = "linux")]
mod ofd_locks;

use napi_derive::napi;

/// What a file this process holds locked is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum HeldFileKind {
	/// A SQLite database this process has open with its locks.
	#[napi(value = "database")]
	Database,
	/// A SQLite WAL-index (`-shm`) file this process has open with its locks.
	#[napi(value = "wal-index")]
	WalIndex,
	/// Another file this process holds open with a record lock.
	#[napi(value = "locked")]
	Locked,
}

/// How `path` is held by this process: open through another descriptor and
/// locked. `null` when it is not, and always outside Linux.
///
/// Looks at the path's inode through the descriptors already open, without
/// opening the file.
#[napi(js_name = "heldFileKind")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn held_file_kind(path: String) -> Option<HeldFileKind> {
	#[cfg(target_os = "linux")]
	{
		linux::path_kind(std::path::Path::new(&path))
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		None
	}
}

/// Moves this process's SQLite record locks onto open-file-description locks.
///
/// No other close of the file can release those (see `ofd_locks.rs`). Call it
/// before the process opens any SQLite database. Returns whether SQLite now
/// uses them: `false` outside Linux, or when Bun's SQLite is not found.
#[napi(js_name = "installSqliteLockShim")]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn install_sqlite_lock_shim() -> bool {
	#[cfg(target_os = "linux")]
	{
		ofd_locks::install()
	}
	#[cfg(not(target_os = "linux"))]
	{
		false
	}
}

#[cfg(target_os = "linux")]
mod linux {
	use std::{
		ffi::c_int,
		fs::File,
		mem::ManuallyDrop,
		os::{
			fd::FromRawFd,
			unix::fs::{FileExt, MetadataExt},
		},
		path::Path,
	};

	use super::HeldFileKind;

	/// `"SQLite format 3\0"`, the first 16 bytes of every database file.
	const DATABASE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
	/// `WALINDEX_MAX_VERSION`: `iVersion` of both copies of a `-shm` header.
	const WAL_INDEX_VERSION: u32 = 3_007_000;
	/// Size of one `WalIndexHdr` copy; the second starts right after the first.
	const WAL_INDEX_HEADER: usize = 48;

	/// Whether any record lock exists on `fd`'s inode. An open-file-description
	/// lock probe conflicts with the process's own POSIX and OFD locks on other
	/// descriptions too, so unlike `F_GETLK` it reports them.
	fn is_locked(fd: c_int) -> bool {
		// SAFETY: `flock` is plain data; all-zero is a valid value.
		let mut probe: libc::flock = unsafe { std::mem::zeroed() };
		probe.l_type = libc::F_WRLCK as libc::c_short;
		probe.l_whence = libc::SEEK_SET as libc::c_short;
		// SAFETY: `probe` is a valid `flock` for the call; `l_pid` must be 0.
		let probed = unsafe { libc::fcntl(fd, libc::F_OFD_GETLK, &mut probe) };
		probed == 0 && probe.l_type != libc::F_UNLCK as libc::c_short
	}

	/// The SQLite file kind a header shows.
	fn header_kind(file: &File) -> Option<HeldFileKind> {
		let mut header = [0_u8; 2 * WAL_INDEX_HEADER];
		let read = file.read_at(&mut header, 0).ok()?;
		let header = &header[..read];
		if header.starts_with(DATABASE_MAGIC) {
			return Some(HeldFileKind::Database);
		}
		let version = |at: usize| {
			header
				.get(at..at + 4)
				.map(|b| u32::from_ne_bytes([b[0], b[1], b[2], b[3]]))
		};
		(version(0) == Some(WAL_INDEX_VERSION)
			&& version(WAL_INDEX_HEADER) == Some(WAL_INDEX_VERSION))
		.then_some(HeldFileKind::WalIndex)
	}

	pub(super) fn path_kind(path: &Path) -> Option<HeldFileKind> {
		let target = std::fs::metadata(path).ok()?;
		if !target.is_file() {
			return None;
		}
		// Descriptors of the same inode already open in this process; reading a
		// header through one opens nothing of our own to close. Every match is
		// probed: the OFD lock shim's private descriptor of a held inode reports
		// no conflict with its own locks, while SQLite's descriptors do.
		for entry in std::fs::read_dir("/proc/self/fd").ok()?.flatten() {
			let link = entry.path();
			let Ok(meta) = std::fs::metadata(&link) else {
				continue;
			};
			if meta.dev() != target.dev() || meta.ino() != target.ino() {
				continue;
			}
			let Some(fd) = entry
				.file_name()
				.to_str()
				.and_then(|name| name.parse::<c_int>().ok())
			else {
				continue;
			};
			if !is_locked(fd) {
				continue;
			}
			// SAFETY: `fd` names the open descriptor just found; `ManuallyDrop`
			// keeps it from being closed.
			let holder = ManuallyDrop::new(unsafe { File::from_raw_fd(fd) });
			return Some(header_kind(&holder).unwrap_or(HeldFileKind::Locked));
		}
		None
	}
}
