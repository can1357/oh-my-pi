//! Windows host operations.

use std::{
	ffi::{OsStr, OsString},
	fs, io,
	os::windows::{
		ffi::{OsStrExt, OsStringExt},
		fs::OpenOptionsExt,
		io::{AsRawHandle, IntoRawHandle},
	},
	path::{Path, PathBuf},
	sync::LazyLock,
	time::SystemTime,
};

use windows_sys::Win32::{
	Foundation::{CloseHandle, GetLastError, HANDLE, MAX_PATH, NO_ERROR},
	Storage::FileSystem::{
		BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
		FILE_NAME_NORMALIZED, FILE_WRITE_ATTRIBUTES, GetCompressedFileSizeW, GetDiskFreeSpaceExW,
		GetDiskFreeSpaceW, GetFileInformationByHandle, GetFinalPathNameByHandleW,
		GetVolumeInformationW, GetVolumePathNameW, INVALID_FILE_SIZE, VOLUME_NAME_DOS,
	},
};

use crate::{
	error::{permission_denied, unsupported},
	metadata::Metadata,
	types::{FileId, FileTime, NodeKind, Permissions, StatFs, SymlinkKind},
};

/// Identity fields std does not expose for a Windows path stat.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HandleInfo {
	pub(crate) volume_serial: u64,
	pub(crate) file_index:    u64,
	pub(crate) nlink:         u64,
}

fn wide(path: &Path) -> io::Result<Vec<u16>> {
	let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
	if wide.contains(&0) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"file name contained an unexpected NUL byte",
		));
	}
	wide.push(0);
	Ok(wide)
}

fn cvt(ok: i32) -> io::Result<()> {
	if ok == 0 {
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

fn handle_info(file: &fs::File) -> io::Result<HandleInfo> {
	// SAFETY: plain C output struct, fully written on success.
	let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
	// SAFETY: `file` owns a valid handle and `info` is writable.
	cvt(unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &raw mut info) })?;
	Ok(HandleInfo {
		volume_serial: u64::from(info.dwVolumeSerialNumber),
		file_index:    (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
		nlink:         u64::from(info.nNumberOfLinks),
	})
}

/// Opens `path` (file or directory) for attribute queries only.
fn open_for_info(path: &Path, follow: bool, access: u32) -> io::Result<fs::File> {
	let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
	if !follow {
		flags |= FILE_FLAG_OPEN_REPARSE_POINT;
	}
	fs::OpenOptions::new()
		.access_mode(access)
		.custom_flags(flags)
		.open(path)
}

pub(crate) const fn set_dir_mode(_builder: &mut fs::DirBuilder, _mode: Option<u32>) {
	// Windows directories have no POSIX mode; access is governed by ACLs.
}

pub(crate) fn symlink(target: &Path, link: &Path, kind: SymlinkKind) -> io::Result<()> {
	let dir = match kind {
		SymlinkKind::File => false,
		SymlinkKind::Dir => true,
		SymlinkKind::Auto => {
			let resolved = if target.is_absolute() {
				target.to_path_buf()
			} else {
				link.parent().unwrap_or_else(|| Path::new("")).join(target)
			};
			fs::metadata(resolved).is_ok_and(|meta| meta.is_dir())
		},
	};
	if dir {
		std::os::windows::fs::symlink_dir(target, link)
	} else {
		std::os::windows::fs::symlink_file(target, link)
	}
}

pub(crate) fn set_permissions(path: &Path, permissions: Permissions) -> io::Result<()> {
	let mut native = fs::metadata(path)?.permissions();
	native.set_readonly(permissions.readonly());
	fs::set_permissions(path, native)
}

pub(crate) fn file_set_permissions(file: &fs::File, permissions: Permissions) -> io::Result<()> {
	let mut native = file.metadata()?.permissions();
	native.set_readonly(permissions.readonly());
	file.set_permissions(native)
}

pub(crate) fn file_set_times(
	file: &fs::File,
	accessed: FileTime,
	modified: FileTime,
) -> io::Result<()> {
	let now = SystemTime::now();
	let resolve = |time: FileTime| match time {
		FileTime::Omit => None,
		FileTime::Now => Some(now),
		FileTime::At(time) => Some(time),
	};
	let mut times = fs::FileTimes::new();
	if let Some(time) = resolve(accessed) {
		times = times.set_accessed(time);
	}
	if let Some(time) = resolve(modified) {
		times = times.set_modified(time);
	}
	file.set_times(times)
}

pub(crate) fn set_times(
	path: &Path,
	accessed: FileTime,
	modified: FileTime,
	follow: bool,
) -> io::Result<()> {
	let file = open_for_info(path, follow, FILE_WRITE_ATTRIBUTES)?;
	file_set_times(&file, accessed, modified)
}

pub(crate) fn chown(
	_path: &Path,
	_uid: Option<u32>,
	_gid: Option<u32>,
	_follow: bool,
) -> io::Result<()> {
	Err(unsupported("chown"))
}

static PATHEXT: LazyLock<Vec<String>> = LazyLock::new(|| {
	let parsed: Vec<String> = std::env::var_os("PATHEXT")
		.map(|value| {
			value
				.to_string_lossy()
				.split(';')
				.map(|entry| entry.trim().trim_start_matches('.').to_ascii_lowercase())
				.filter(|entry| !entry.is_empty())
				.collect()
		})
		.unwrap_or_default();
	if parsed.is_empty() {
		["com", "exe", "bat", "cmd"].map(str::to_owned).to_vec()
	} else {
		parsed
	}
});

/// Windows has no `access(2)`: readability/writability are probed by opening
/// (honouring ACLs and the read-only attribute) and executability follows
/// `PATHEXT`, matching the shell's historical Windows test operators.
pub(crate) fn access(path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
	let meta = fs::metadata(path)?;
	if meta.is_dir() {
		if write && meta.permissions().readonly() {
			return Err(permission_denied());
		}
		return Ok(());
	}
	if read {
		fs::OpenOptions::new().read(true).open(path)?;
	}
	if write {
		fs::OpenOptions::new().write(true).open(path)?;
	}
	if execute {
		let executable = path.extension().is_some_and(|ext| {
			PATHEXT
				.iter()
				.any(|known| ext.eq_ignore_ascii_case(known.as_str()))
		});
		if !executable {
			return Err(permission_denied());
		}
	}
	Ok(())
}

pub(crate) fn file_id(path: &Path, follow: bool) -> io::Result<FileId> {
	file_id_of(&open_for_info(path, follow, 0)?)
}

pub(crate) fn file_id_of(file: &fs::File) -> io::Result<FileId> {
	let info = handle_info(file)?;
	if info.file_index == 0 {
		return Err(unsupported("file identity"));
	}
	Ok(FileId::native(info.volume_serial, info.file_index))
}

pub(crate) fn link_count(path: &Path, follow: bool) -> io::Result<u64> {
	Ok(handle_info(&open_for_info(path, follow, 0)?)?.nlink)
}

pub(crate) fn allocated_size(path: &Path) -> io::Result<u64> {
	let name = wide(path)?;
	let mut high = 0u32;
	// SAFETY: `name` is NUL-terminated and `high` is writable.
	let low = unsafe { GetCompressedFileSizeW(name.as_ptr(), &raw mut high) };
	// SAFETY: plain thread-local error query.
	if low == INVALID_FILE_SIZE && unsafe { GetLastError() } != NO_ERROR {
		return Err(io::Error::last_os_error());
	}
	Ok((u64::from(high) << 32) | u64::from(low))
}

/// Host metadata plus handle identity; non-disk handles (pipes, consoles)
/// simply lack the identity fields.
pub(crate) fn file_metadata(file: &fs::File) -> io::Result<Metadata> {
	let meta = file.metadata()?;
	Ok(match handle_info(file) {
		Ok(info) => Metadata::native_with_handle(meta, info),
		Err(_) => Metadata::from(meta),
	})
}

/// Path metadata with handle identity.
///
/// A Windows path stat cannot carry the volume serial and file index that
/// identity comparisons need. Read both metadata and identity from one
/// attribute-query handle so a rename between separate path lookups cannot
/// combine two different objects. Objects that cannot be opened for identity
/// queries keep path metadata with unknown identity.
pub(crate) fn path_metadata(path: &Path, follow: bool) -> io::Result<Metadata> {
	if let Ok(file) = open_for_info(path, follow, 0)
		&& let Ok(meta) = file.metadata()
	{
		return Ok(match handle_info(&file) {
			Ok(info) => Metadata::native_with_handle(meta, info),
			Err(_) => Metadata::from(meta),
		});
	}
	if follow {
		fs::metadata(path).map(Metadata::from)
	} else {
		fs::symlink_metadata(path).map(Metadata::from)
	}
}

pub(crate) fn file_is_locked(_file: &fs::File) -> io::Result<bool> {
	Err(unsupported("lock query"))
}

/// Closes the handle and reports the error `Drop` would discard.
pub(crate) fn close(file: fs::File) -> io::Result<()> {
	let handle = file.into_raw_handle();
	// SAFETY: `handle` was just released from an owned `File`, so this is its
	// only close.
	cvt(unsafe { CloseHandle(handle as HANDLE) })
}

pub(crate) fn list_xattr(_path: &Path, _follow: bool) -> io::Result<Vec<OsString>> {
	Err(unsupported("listxattr"))
}

pub(crate) fn get_xattr(_path: &Path, _name: &OsStr, _follow: bool) -> io::Result<Option<Vec<u8>>> {
	Err(unsupported("getxattr"))
}

pub(crate) fn set_xattr(
	_path: &Path,
	_name: &OsStr,
	_value: &[u8],
	_follow: bool,
) -> io::Result<()> {
	Err(unsupported("setxattr"))
}

pub(crate) fn remove_xattr(_path: &Path, _name: &OsStr, _follow: bool) -> io::Result<()> {
	Err(unsupported("removexattr"))
}

pub(crate) fn make_node(_path: &Path, _kind: NodeKind, _mode: u32) -> io::Result<()> {
	Err(unsupported("mknod"))
}

fn until_nul(buf: &[u16]) -> &[u16] {
	&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]
}

pub(crate) fn stat_fs(path: &Path) -> io::Result<StatFs> {
	let name = wide(path)?;
	let mut root = vec![0u16; name.len().max(MAX_PATH as usize) + 1];
	// SAFETY: `name` is NUL-terminated; `root` is writable for its length.
	cvt(unsafe { GetVolumePathNameW(name.as_ptr(), root.as_mut_ptr(), root.len() as u32) })?;

	let (mut serial, mut max_component, mut flags) = (0u32, 0u32, 0u32);
	let mut fs_name = [0u16; MAX_PATH as usize + 1];
	// SAFETY: `root` is NUL-terminated; every output pointer is writable and
	// the name buffer length is passed.
	cvt(unsafe {
		GetVolumeInformationW(
			root.as_ptr(),
			std::ptr::null_mut(),
			0,
			&raw mut serial,
			&raw mut max_component,
			&raw mut flags,
			fs_name.as_mut_ptr(),
			fs_name.len() as u32,
		)
	})?;

	let (mut sectors_per_cluster, mut bytes_per_sector, mut free_clusters, mut total_clusters) =
		(0u32, 0u32, 0u32, 0u32);
	// SAFETY: `root` is NUL-terminated and all outputs are writable.
	cvt(unsafe {
		GetDiskFreeSpaceW(
			root.as_ptr(),
			&raw mut sectors_per_cluster,
			&raw mut bytes_per_sector,
			&raw mut free_clusters,
			&raw mut total_clusters,
		)
	})?;
	let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
	// SAFETY: `root` is NUL-terminated and all outputs are writable.
	cvt(unsafe {
		GetDiskFreeSpaceExW(root.as_ptr(), &raw mut available, &raw mut total, &raw mut free)
	})?;

	let cluster = (u64::from(sectors_per_cluster) * u64::from(bytes_per_sector)).max(1);
	Ok(StatFs {
		fs_type:          None,
		fs_type_name:     Some(String::from_utf16_lossy(until_nul(&fs_name))),
		block_size:       cluster,
		io_size:          cluster,
		blocks:           total / cluster,
		blocks_free:      free / cluster,
		blocks_available: available / cluster,
		// NTFS/ReFS keep no inode table to count.
		files:            0,
		files_free:       0,
		fsid:             Some(u64::from(serial)),
		name_max:         Some(u64::from(max_component)),
	})
}

pub(crate) fn fstat_fs(file: &fs::File) -> io::Result<StatFs> {
	let mut buf = vec![0u16; MAX_PATH as usize + 1];
	loop {
		// SAFETY: `file` owns a valid handle; `buf` is writable for its length.
		let len = unsafe {
			GetFinalPathNameByHandleW(
				file.as_raw_handle() as HANDLE,
				buf.as_mut_ptr(),
				buf.len() as u32,
				FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
			)
		} as usize;
		if len == 0 {
			return Err(io::Error::last_os_error());
		}
		if len < buf.len() {
			buf.truncate(len);
			return stat_fs(&PathBuf::from(OsString::from_wide(&buf)));
		}
		buf.resize(len + 1, 0);
	}
}
