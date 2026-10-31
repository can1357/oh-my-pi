//! Windows directory reads:
//!
//! - Children open with `NtCreateFile` relative to the parent's handle
//!   (`OBJECT_ATTRIBUTES.RootDirectory`) and the raw entry name: no Win32 path
//!   parsing, no DOS-to-NT path conversion, no per-component re-traversal from
//!   the drive root, and no `MAX_PATH` limit. Files read through a directory
//!   handle open the same way.
//! - Listings use `NtQueryDirectoryFile` with `FileDirectoryInformation`, the
//!   smallest class that carries attributes, size, and mtime, so Full detail
//!   costs nothing extra and each call returns as many entries as possible.
//! - Names convert from UTF-16 straight into the listing arena as WTF-8, which
//!   round-trips unpaired surrogates back to the exact on-disk name.
//! - Following path stats use `NtQueryFullAttributesFile`, which answers
//!   without the caller opening a handle.
//!
//! Reparse points (symlinks, junctions, mount points, cloud placeholders) are
//! reported as symlinks and never descended.

use std::{
	io,
	os::windows::{
		fs::{MetadataExt, OpenOptionsExt},
		io::{AsRawHandle, FromRawHandle, OwnedHandle},
	},
	path::Path,
	ptr::{null, null_mut},
};

use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			FILE_DIRECTORY_FILE, FILE_NETWORK_OPEN_INFORMATION, FILE_OPEN,
			FILE_OPEN_FOR_BACKUP_INTENT, FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
			FileDirectoryInformation, FileNetworkOpenInformation, NtCreateFile, NtQueryDirectoryFile,
			NtQueryFullAttributesFile, NtQueryInformationFile,
		},
	},
	Win32::{
		Foundation::{
			ERROR_DIRECTORY, ERROR_HANDLE_EOF, ERROR_INVALID_DATA, ERROR_INVALID_NAME, HANDLE,
			NTSTATUS, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError, STATUS_NO_MORE_FILES,
			STATUS_NO_SUCH_FILE, UNICODE_STRING,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
			FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_DATA,
			FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
			GetVolumeInformationByHandleW, ReadFile, SYNCHRONIZE,
		},
		System::IO::{IO_STATUS_BLOCK, OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0},
	},
};

use super::{aligned_buf, le32, le64};
use crate::fs::{
	Detail, FileId, FileInfo, FileType, Listing, Stamp, not_regular,
	wtf8::{push_wide, push_wtf8},
};

/// An open directory or file handle, closed on drop.
pub(crate) type Handle = OwnedHandle;

/// See [`crate::fs::Fs::workers`] (unmeasured on Windows).
pub(crate) const WORKERS: usize = 4;

const LIST_BUF: usize = 64 << 10;

// FILE_DIRECTORY_INFORMATION field offsets.
const FDI_NEXT_ENTRY_OFFSET: usize = 0;
const FDI_LAST_WRITE_TIME: usize = 24;
const FDI_END_OF_FILE: usize = 40;
const FDI_FILE_ATTRIBUTES: usize = 56;
const FDI_FILE_NAME_LENGTH: usize = 60;
const FDI_FILE_NAME: usize = 64;

/// 100ns ticks between 1601-01-01 and 1970-01-01.
const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;

/// Longest `UNICODE_STRING`, in UTF-16 units.
const MAX_NAME_UNITS: usize = 0x7fff;

const SHARE_ALL: u32 = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
/// Lists entries and reads attributes (for stamps).
const DIR_ACCESS: u32 = FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const FILE_ACCESS: u32 = FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

/// Per-session syscall scratch.
#[derive(Default)]
pub(crate) struct Scratch {
	/// Listing buffer (8-aligned, as `NtQueryDirectoryFile` requires).
	buf:   Vec<u64>,
	/// UTF-16 name for NT calls.
	wname: Vec<u16>,
}

fn nt_error(status: NTSTATUS) -> io::Error {
	// SAFETY: a pure status-code conversion.
	io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
}

fn win_error(code: u32) -> io::Error {
	io::Error::from_raw_os_error(code as i32)
}

/// Unix nanoseconds of a FILETIME tick count.
const fn filetime_nanos(ticks: i64) -> i64 {
	ticks.saturating_sub(UNIX_EPOCH_TICKS).saturating_mul(100)
}

const fn info_of(info: &FILE_NETWORK_OPEN_INFORMATION) -> FileInfo {
	let dir = info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
	FileInfo {
		file_type: Some(if dir { FileType::Dir } else { FileType::File }),
		size:      if dir { 0 } else { info.EndOfFile as u64 },
		stamp:     Stamp {
			dev:   0,
			ino:   info.CreationTime as u64,
			mtime: filetime_nanos(info.LastWriteTime),
			ctime: filetime_nanos(info.ChangeTime),
		},
	}
}

/// Opens an absolute path through the Win32 layer, which resolves
/// drive-relative forms, UNC paths, `\\?\` prefixes, and long paths.
fn open_path(path: &Path, access: u32) -> io::Result<Handle> {
	let file = std::fs::OpenOptions::new()
		.access_mode(access)
		.share_mode(SHARE_ALL)
		.custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
		.open(path)?;
	Ok(OwnedHandle::from(file))
}

/// Opens `name` (WTF-8, `/`-separated components) relative to `parent`.
fn nt_open(
	s: &mut Scratch,
	parent: &Handle,
	name: &[u8],
	access: u32,
	options: u32,
) -> io::Result<Handle> {
	s.wname.clear();
	push_wide(&mut s.wname, name);
	if s.wname.is_empty() || s.wname.len() > MAX_NAME_UNITS {
		return Err(win_error(ERROR_INVALID_NAME));
	}
	let bytes = (s.wname.len() * 2) as u16;
	let us = UNICODE_STRING {
		Length:        bytes,
		MaximumLength: bytes,
		Buffer:        s.wname.as_mut_ptr(),
	};
	let oa = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            parent.as_raw_handle(),
		ObjectName:               &raw const us,
		Attributes:               0,
		SecurityDescriptor:       null(),
		SecurityQualityOfService: null(),
	};
	let mut handle: HANDLE = null_mut();
	let mut iosb = IO_STATUS_BLOCK::default();
	// SAFETY: every pointer refers to a live local or the session's name
	// buffer, which `us` describes exactly.
	let status = unsafe {
		NtCreateFile(
			&raw mut handle,
			access,
			&raw const oa,
			&raw mut iosb,
			null(),
			0,
			SHARE_ALL,
			FILE_OPEN,
			options | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT,
			null(),
			0,
		)
	};
	if status < 0 {
		return Err(nt_error(status));
	}
	// SAFETY: `NtCreateFile` succeeded and returned a handle this call owns.
	Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

/// Stamps an open handle and reports its type and size (reparse points
/// opened without `FILE_OPEN_REPARSE_POINT` report their target).
fn stat_handle(h: &Handle) -> io::Result<FileInfo> {
	let mut info = FILE_NETWORK_OPEN_INFORMATION::default();
	let mut iosb = IO_STATUS_BLOCK::default();
	// SAFETY: `info` is a writable buffer of the size passed.
	let status = unsafe {
		NtQueryInformationFile(
			h.as_raw_handle(),
			&raw mut iosb,
			(&raw mut info).cast(),
			size_of::<FILE_NETWORK_OPEN_INFORMATION>() as u32,
			FileNetworkOpenInformation,
		)
	};
	if status < 0 {
		return Err(nt_error(status));
	}
	Ok(info_of(&info))
}

pub(crate) fn open_dir(_s: &mut Scratch, path: &Path) -> io::Result<Handle> {
	let h = open_path(path, DIR_ACCESS)?;
	// FILE_FLAG_BACKUP_SEMANTICS also opens regular files.
	if stat_handle(&h)?.file_type != Some(FileType::Dir) {
		return Err(win_error(ERROR_DIRECTORY));
	}
	Ok(h)
}

/// Opens the subdirectory `name` of `parent` without following a reparse
/// point that replaced it since the listing.
pub(crate) fn open_child(s: &mut Scratch, parent: &Handle, name: &[u8]) -> io::Result<Handle> {
	nt_open(s, parent, name, DIR_ACCESS, FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT)
}

const fn is_dot_or_dot_dot_utf16(name: &[u8]) -> bool {
	matches!(name, [b'.', 0] | [b'.', 0, b'.', 0])
}

/// Reads every entry of `dir` into `out`. Sizes and mtimes are always filled
/// because the listing returns them for free.
pub(crate) fn list(
	s: &mut Scratch,
	dir: &Handle,
	_detail: Detail,
	_children: u32,
	out: &mut Listing,
) -> io::Result<()> {
	let buf = aligned_buf(&mut s.buf, LIST_BUF);
	let mut restart = true;
	loop {
		let mut iosb = IO_STATUS_BLOCK::default();
		// SAFETY: `buf` is 8-aligned and writable for the length passed.
		let status = unsafe {
			NtQueryDirectoryFile(
				dir.as_raw_handle(),
				null_mut(),
				None,
				null(),
				&raw mut iosb,
				buf.as_mut_ptr().cast(),
				buf.len() as u32,
				FileDirectoryInformation,
				false,
				null(),
				restart,
			)
		};
		restart = false;
		match status {
			STATUS_NO_MORE_FILES | STATUS_NO_SUCH_FILE => return Ok(()),
			..0 => return Err(nt_error(status)),
			_ => {},
		}
		let n = iosb.Information;
		if n == 0 {
			return Ok(());
		}
		if n > buf.len() {
			return Err(win_error(ERROR_INVALID_DATA));
		}
		let mut off = 0;
		loop {
			if off + FDI_FILE_NAME > n {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			let rec = &buf[off..n];
			let next = le32(rec, FDI_NEXT_ENTRY_OFFSET) as usize;
			let name_len = le32(rec, FDI_FILE_NAME_LENGTH) as usize;
			if !name_len.is_multiple_of(2) || FDI_FILE_NAME + name_len > rec.len() {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			let wname = &rec[FDI_FILE_NAME..FDI_FILE_NAME + name_len];
			if name_len > 0 && !is_dot_or_dot_dot_utf16(wname) {
				let attrs = le32(rec, FDI_FILE_ATTRIBUTES);
				let (file_type, size) = if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
					(FileType::Symlink, None)
				} else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
					(FileType::Dir, None)
				} else {
					(FileType::File, Some(le64(rec, FDI_END_OF_FILE)))
				};
				let mtime = filetime_nanos(le64(rec, FDI_LAST_WRITE_TIME) as i64);
				out.push_with(
					|names| {
						push_wtf8(
							names,
							wname
								.as_chunks::<2>()
								.0
								.iter()
								.map(|&unit| u16::from_le_bytes(unit)),
						);
					},
					file_type,
					size,
					Some(mtime),
					0,
				);
			}
			if next == 0 {
				break;
			}
			if next < FDI_FILE_NAME || off + next > n {
				return Err(win_error(ERROR_INVALID_DATA));
			}
			off += next;
		}
	}
}

fn regular(h: Handle) -> io::Result<(Handle, FileInfo)> {
	let info = stat_handle(&h)?;
	if info.file_type != Some(FileType::File) {
		return Err(not_regular());
	}
	Ok((h, info))
}

pub(crate) fn open_file_at(
	s: &mut Scratch,
	dir: &Handle,
	name: &[u8],
) -> io::Result<(Handle, FileInfo)> {
	regular(nt_open(s, dir, name, FILE_ACCESS, 0)?)
}

pub(crate) fn open_file(_s: &mut Scratch, path: &Path) -> io::Result<(Handle, FileInfo)> {
	regular(open_path(path, FILE_ACCESS)?)
}

/// `ReadFile` at offset `off`. The offset rides in an OVERLAPPED, which on a
/// synchronous handle makes the read positional; at end of file such a read
/// fails with `ERROR_HANDLE_EOF` instead of returning 0 bytes.
fn read_raw(h: &Handle, ptr: *mut u8, len: usize, off: u64) -> io::Result<usize> {
	let mut overlapped = OVERLAPPED {
		Anonymous: OVERLAPPED_0 {
			Anonymous: OVERLAPPED_0_0 {
				Offset:     off as u32,
				OffsetHigh: (off >> u32::BITS) as u32,
			},
		},
		..OVERLAPPED::default()
	};
	let mut n = 0u32;
	let want = u32::try_from(len).unwrap_or(u32::MAX).min(1 << 30);
	// SAFETY: `ptr` is writable for `want <= len` bytes per the caller.
	let ok = unsafe { ReadFile(h.as_raw_handle(), ptr, want, &raw mut n, &raw mut overlapped) };
	if ok == 0 {
		let err = io::Error::last_os_error();
		if err.raw_os_error() == Some(ERROR_HANDLE_EOF as i32) {
			return Ok(0);
		}
		return Err(err);
	}
	Ok(n as usize)
}

/// Appends the file's bytes at offset `buf.len()` into `buf`'s spare
/// capacity, up to length `end`; returns the count read (0 at end of file).
pub(crate) fn read_append(h: &Handle, buf: &mut Vec<u8>, end: usize) -> io::Result<usize> {
	let len = buf.len();
	let spare = buf.spare_capacity_mut();
	let want = end.saturating_sub(len).min(spare.len());
	let n = read_raw(h, spare.as_mut_ptr().cast(), want, len as u64)?;
	// SAFETY: `ReadFile` initialized the first `n <= want` spare bytes.
	unsafe { buf.set_len(len + n) };
	Ok(n)
}

/// Reads into `buf` at file offset `off`.
pub(crate) fn read_at(h: &Handle, buf: &mut [u8], off: u64) -> io::Result<usize> {
	read_raw(h, buf.as_mut_ptr(), buf.len(), off)
}

pub(crate) fn stat(s: &mut Scratch, path: &Path, follow: bool) -> io::Result<FileInfo> {
	if !follow || !path.is_absolute() {
		return stat_win32(path, follow);
	}
	// The NT layer takes names as spelled; Win32 rewriting (`/`, `.`/`..`,
	// trailing dots and spaces) must happen first, as `std::fs` does.
	let normalized;
	let mut bytes = path.as_os_str().as_encoded_bytes();
	if !bytes.starts_with(br"\\?\") && needs_win32_normalizing(bytes) {
		normalized = std::path::absolute(path)?;
		bytes = normalized.as_os_str().as_encoded_bytes();
	}
	s.wname.clear();
	let rest = if let Some(rest) = bytes.strip_prefix(br"\\?\") {
		push_wide(&mut s.wname, br"\??\");
		rest
	} else if let Some(rest) = bytes.strip_prefix(br"\\") {
		push_wide(&mut s.wname, br"\??\UNC\");
		rest
	} else {
		push_wide(&mut s.wname, br"\??\");
		bytes
	};
	push_wide(&mut s.wname, rest);
	if s.wname.len() > MAX_NAME_UNITS {
		return Err(win_error(windows_sys::Win32::Foundation::ERROR_FILENAME_EXCED_RANGE));
	}
	let len = (s.wname.len() * 2) as u16;
	let us = UNICODE_STRING {
		Length:        len,
		MaximumLength: len,
		Buffer:        s.wname.as_mut_ptr(),
	};
	let oa = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            null_mut(),
		ObjectName:               &raw const us,
		Attributes:               OBJ_CASE_INSENSITIVE,
		SecurityDescriptor:       null(),
		SecurityQualityOfService: null(),
	};
	let mut info = FILE_NETWORK_OPEN_INFORMATION::default();
	// SAFETY: `oa` describes the session's name buffer and `info` is a valid
	// out-pointer.
	let status = unsafe { NtQueryFullAttributesFile(&raw const oa, &raw mut info) };
	if status < 0 {
		return Err(nt_error(status));
	}
	// The attribute query describes a reparse point (symlink, junction)
	// itself, not its target.
	if info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return stat_win32(path, true);
	}
	Ok(info_of(&info))
}

/// [`stat`] through `std::fs`, which follows reparse points when `follow`.
fn stat_win32(path: &Path, follow: bool) -> io::Result<FileInfo> {
	let meta = if follow {
		std::fs::metadata(path)?
	} else {
		std::fs::symlink_metadata(path)?
	};
	let attrs = meta.file_attributes();
	let file_type = if attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		FileType::Symlink
	} else if attrs & FILE_ATTRIBUTE_DIRECTORY != 0 {
		FileType::Dir
	} else {
		FileType::File
	};
	let mtime = filetime_nanos(meta.last_write_time() as i64);
	Ok(FileInfo {
		file_type: Some(file_type),
		size:      if file_type == FileType::File {
			meta.file_size()
		} else {
			0
		},
		stamp:     Stamp { dev: 0, ino: meta.creation_time(), mtime, ctime: mtime },
	})
}

/// Whether `GetFullPathNameW` would rewrite a non-verbatim path: `/`
/// separators, empty components, `.`/`..` components, or a component
/// ending in a dot or space.
fn needs_win32_normalizing(bytes: &[u8]) -> bool {
	let body = bytes.strip_prefix(br"\\").unwrap_or(bytes);
	body.contains(&b'/')
		|| body.windows(2).any(|pair| pair == br"\\")
		|| body
			.split(|&b| b == b'\\')
			.any(|part| matches!(part.last(), Some(b'.' | b' ')))
}

pub(crate) fn stat_dir(h: &Handle) -> io::Result<Stamp> {
	stat_handle(h).map(|info| info.stamp)
}

/// Opens the path because path queries carry no file index.
pub(crate) fn identify(_s: &mut Scratch, path: &Path) -> io::Result<FileId> {
	identify_dir(&open_path(path, FILE_READ_ATTRIBUTES)?)
}

pub(crate) fn identify_dir(h: &Handle) -> io::Result<FileId> {
	let mut fi = BY_HANDLE_FILE_INFORMATION::default();
	// SAFETY: `fi` is a valid out-pointer.
	if unsafe { GetFileInformationByHandle(h.as_raw_handle(), &raw mut fi) } == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(FileId {
		dev:    u64::from(fi.dwVolumeSerialNumber),
		ino:    (u64::from(fi.nFileIndexHigh) << 32) | u64::from(fi.nFileIndexLow),
		native: true,
	})
}

/// Admits NTFS and `ReFS`, which keep 100ns timestamps and update a
/// directory's write time when its entries change. Path stamps carry no
/// volume identity, so the verdict is not memoized per device.
pub(crate) fn stable_stamps(h: &Handle, _stamp: &Stamp) -> bool {
	let mut name = [0u16; 261];
	// SAFETY: `name` is writable for the length passed; other outputs are
	// not requested.
	let ok = unsafe {
		GetVolumeInformationByHandleW(
			h.as_raw_handle(),
			null_mut(),
			0,
			null_mut(),
			null_mut(),
			null_mut(),
			name.as_mut_ptr(),
			name.len() as u32,
		)
	};
	if ok == 0 {
		return false;
	}
	let name = name.split(|&unit| unit == 0).next().unwrap_or_default();
	["NTFS", "ReFS"]
		.iter()
		.any(|fs| fs.encode_utf16().eq(name.iter().copied()))
}
