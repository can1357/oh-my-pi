//! Copy-on-write file cloning, shared by the tree-cloning backends and the
//! shell's `cp`.
//!
//! A clone shares the source's storage extents until either file is written:
//!
//! | Platform | Primitive | Filesystems |
//! |---|---|---|
//! | Linux, Android | `FICLONE` | btrfs, XFS, bcachefs, OCFS2, … |
//! | macOS | `clonefile(2)` | APFS |
//! | Windows | `FSCTL_DUPLICATE_EXTENTS_TO_FILE` | `ReFS`, Dev Drive |
//!
//! Elsewhere, and between files that cannot share extents (different
//! filesystems, NTFS, ext4, …), [`clone_file`] fails with an error
//! [`is_unsupported`] recognizes; callers then copy the data instead.
//!
//! # Example
//!
//! ```ignore
//! match pi_iso::cow::clone_file(src, dst) {
//!     Ok(()) => {},
//!     Err(err) if pi_iso::cow::is_unsupported(&err) => drop(std::fs::copy(src, dst)?),
//!     Err(err) => return Err(err),
//! }
//! ```

use std::{
	fs::{self, File, Metadata},
	io,
	path::Path,
	sync::atomic::{AtomicU64, Ordering},
};

/// Makes `dst` a copy-on-write clone of the regular file `src`, following
/// symlinks at either path.
///
/// A missing `dst` is created. Only its data is guaranteed: an APFS clone
/// also carries `src`'s mode, flags, extended attributes, and timestamps,
/// while elsewhere `dst` gets default permissions.
///
/// An existing `dst` is never written in place: the clone is made beside it
/// and renamed over it, so a failed clone leaves `dst` untouched. The swap
/// keeps what an in-place copy keeps: `dst`'s mode, its owner and group
/// (Unix), and its hard links, which is why `dst` must be a writable regular
/// file with one link whose owner the clone can take on. `dst`'s extended
/// attributes and ACL do not survive; on Windows the clone gets the
/// directory's inherited ACL and the caller as owner.
///
/// # Errors
///
/// An [`is_unsupported`] error when the files cannot share extents
/// (different filesystems, a filesystem without cloning, an unsupported
/// platform) or `dst` cannot be swapped for a clone; otherwise the failing
/// call. On error no clone is left behind and an existing `dst` is unchanged.
pub fn clone_file(src: &Path, dst: &Path) -> io::Result<()> {
	let existing = match fs::metadata(dst) {
		Ok(metadata) if metadata.is_file() => Some(metadata),
		Ok(_) => return Err(unsupported("destination is not a regular file")),
		Err(err) if err.kind() == io::ErrorKind::NotFound => None,
		Err(err) => return Err(err),
	};
	#[cfg(unix)]
	check_same_device(src, dst, existing.as_ref())?;
	match existing {
		None => {
			clone_new(src, dst)?;
			Ok(())
		},
		// Swap the file a symlinked `dst` names, as an in-place copy writes it.
		Some(metadata) => clone_over(src, &fs::canonicalize(dst)?, &metadata),
	}
}

/// Whether `err` from [`clone_file`] means the files cannot be cloned, as
/// opposed to an I/O failure a data copy would hit too.
pub fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(any(target_os = "linux", target_os = "android", target_os = "macos", windows))]
	{
		err.raw_os_error().is_some_and(imp::is_unsupported_code)
	}
	#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
	{
		false
	}
}

/// Clones `src`'s data into `dst`, two files the caller already holds open.
///
/// `dst` must be writable and empty (just created or truncated). This is the
/// copy GNU `cp` issues on its open descriptors, without [`clone_file`]'s
/// path lookups, probe file and rename.
///
/// # Errors
///
/// As [`clone_file`]. A failed clone leaves `dst` empty and, on Windows, not
/// sparse, so the caller can copy the data into it instead.
#[cfg(any(target_os = "linux", target_os = "android", windows))]
pub fn clone_open(src: &File, dst: &File) -> io::Result<()> {
	let cloned = imp::clone_into(src, dst);
	#[cfg(windows)]
	if cloned.is_err() {
		// The block clone extends `dst` and makes it sparse before cloning.
		let _ = dst.set_len(0);
		let _ = imp::set_sparse(dst, false);
	}
	cloned
}

/// Whether an [`is_unsupported`] error from [`clone_open`] says the files
/// are on different devices, rather than that the source's filesystem
/// cannot clone: only the latter holds for every later copy from it.
pub fn is_cross_device(err: &io::Error) -> bool {
	#[cfg(unix)]
	{
		err.raw_os_error() == Some(libc::EXDEV)
	}
	#[cfg(windows)]
	{
		err.raw_os_error()
			.is_some_and(|code| code as u32 == windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE)
	}
	#[cfg(not(any(unix, windows)))]
	{
		let _ = err;
		false
	}
}

#[cfg(target_os = "macos")]
pub(crate) use imp::{CLONE_NOFOLLOW, clonefile};

fn unsupported(reason: &str) -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, reason)
}

/// Fails before touching `dst` when it is on another device than `src`, which
/// no platform can clone across.
#[cfg(unix)]
fn check_same_device(src: &Path, dst: &Path, existing: Option<&Metadata>) -> io::Result<()> {
	use std::os::unix::fs::MetadataExt as _;

	let dst_dev = if let Some(metadata) = existing {
		metadata.dev()
	} else {
		let parent = dst.parent().filter(|parent| !parent.as_os_str().is_empty());
		// Let the clone itself report a missing directory.
		let Ok(metadata) = fs::metadata(parent.unwrap_or_else(|| Path::new("."))) else {
			return Ok(());
		};
		metadata.dev()
	};
	if fs::metadata(src)?.dev() == dst_dev {
		Ok(())
	} else {
		Err(unsupported("source and destination are on different devices"))
	}
}

/// Replaces the regular file `dst` (described by `metadata`) with a clone of
/// `src` made beside it, when the swap passes for an in-place copy.
fn clone_over(src: &Path, dst: &Path, metadata: &Metadata) -> io::Result<()> {
	/// Keeps the temporaries of concurrent clones in one process apart.
	static SEQUENCE: AtomicU64 = AtomicU64::new(0);

	let file = fs::OpenOptions::new()
		.write(true)
		.open(dst)
		.map_err(|_| unsupported("destination is not writable"))?;
	if link_count(&file, metadata)? != 1 {
		return Err(unsupported("destination has other hard links"));
	}
	drop(file);

	let temp = dst.with_file_name(format!(
		".cow-clone-{}-{}",
		std::process::id(),
		SEQUENCE.fetch_add(1, Ordering::Relaxed)
	));
	clone_new(src, &temp)?;
	let swapped = (|| {
		#[cfg(unix)]
		take_owner(&temp, metadata)?;
		fs::set_permissions(&temp, metadata.permissions())?;
		fs::rename(&temp, dst)
	})();
	if swapped.is_err() {
		let _ = fs::remove_file(&temp);
	}
	swapped
}

/// Gives `clone` the owner and group of the file it replaces.
#[cfg(unix)]
fn take_owner(clone: &Path, metadata: &Metadata) -> io::Result<()> {
	use std::os::unix::fs::{MetadataExt as _, chown};

	let current = fs::symlink_metadata(clone)?;
	if (current.uid(), current.gid()) == (metadata.uid(), metadata.gid()) {
		return Ok(());
	}
	chown(clone, Some(metadata.uid()), Some(metadata.gid()))
		.map_err(|_| unsupported("clone cannot take the destination's owner"))
}

/// The number of hard links to the file open as `file`.
#[cfg(unix)]
#[expect(clippy::unnecessary_wraps, reason = "the Windows lookup through `file` can fail")]
fn link_count(_file: &File, metadata: &Metadata) -> io::Result<u64> {
	Ok(std::os::unix::fs::MetadataExt::nlink(metadata))
}

#[cfg(windows)]
fn link_count(file: &File, _metadata: &Metadata) -> io::Result<u64> {
	imp::link_count(file)
}

#[cfg(not(any(unix, windows)))]
fn link_count(_file: &File, _metadata: &Metadata) -> io::Result<u64> {
	Err(unsupported("copy-on-write cloning is not implemented on this platform"))
}

/// Creates `dst` as a clone of `src`.
#[cfg(target_os = "macos")]
fn clone_new(src: &Path, dst: &Path) -> io::Result<()> {
	clonefile(src, dst, 0)
}

/// Creates the missing `dst` as a clone of `src`, removing it again on
/// failure.
///
/// Returns `src` and `dst` still open, so the tree-cloning backends, which
/// clone into fresh directories, read the source's metadata and apply it to
/// the clone through the handles rather than by path, and skip
/// [`clone_file`]'s existence probe and device check: a clone across devices
/// fails with an [`is_unsupported`] error anyway.
#[cfg(any(target_os = "linux", target_os = "android", windows))]
pub(crate) fn clone_new(src: &Path, dst: &Path) -> io::Result<(File, File)> {
	let src = File::open(src)?;
	let dst_file = fs::OpenOptions::new()
		.write(true)
		.create_new(true)
		.open(dst)?;
	if let Err(err) = imp::clone_into(&src, &dst_file) {
		drop(dst_file);
		let _ = fs::remove_file(dst);
		return Err(err);
	}
	Ok((src, dst_file))
}

#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos", windows)))]
fn clone_new(_src: &Path, _dst: &Path) -> io::Result<()> {
	Err(unsupported("copy-on-write cloning is not implemented on this platform"))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
mod imp {
	use std::{fs::File, io, os::fd::AsRawFd as _};

	// `libc::Ioctl` is `c_int` on musl and `c_ulong` on glibc; the constant
	// fits both.
	const FICLONE: libc::Ioctl = 0x4004_9409;

	/// Clones `src`'s data into the empty `dst`.
	pub fn clone_into(src: &File, dst: &File) -> io::Result<()> {
		// SAFETY: both descriptors are borrowed from live files for the call,
		// and the kernel retains neither.
		if unsafe { libc::ioctl(dst.as_raw_fd(), FICLONE, src.as_raw_fd()) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::EXDEV | libc::EOPNOTSUPP | libc::ENOTTY | libc::EINVAL | libc::ENOSYS)
	}
}

#[cfg(target_os = "macos")]
mod imp {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt as _, path::Path};

	/// Clones a symlink itself rather than its target. Darwin's `clonefile.h`
	/// defines it; `libc` does not.
	pub const CLONE_NOFOLLOW: u32 = 0x0001;

	/// `clonefile(src, dst, flags)`; a directory `src` clones its whole tree.
	pub fn clonefile(src: &Path, dst: &Path, flags: u32) -> io::Result<()> {
		let src = CString::new(src.as_os_str().as_bytes())?;
		let dst = CString::new(dst.as_os_str().as_bytes())?;
		// SAFETY: both strings are NUL-terminated and outlive the call, which
		// retains neither pointer.
		if unsafe { libc::clonefile(src.as_ptr(), dst.as_ptr(), flags) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	pub const fn is_unsupported_code(code: i32) -> bool {
		matches!(code, libc::ENOTSUP | libc::EOPNOTSUPP | libc::EXDEV)
	}
}

#[cfg(windows)]
mod imp {
	use std::{
		ffi::c_void,
		fs::File,
		io,
		os::windows::{fs::MetadataExt as _, io::AsRawHandle as _},
	};

	use windows_sys::Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
			ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_SPARSE_FILE, GetFileInformationByHandle,
		},
		System::{
			IO::DeviceIoControl,
			Ioctl::{
				DUPLICATE_EXTENTS_DATA, FILE_SET_SPARSE_BUFFER, FSCTL_DUPLICATE_EXTENTS_TO_FILE,
				FSCTL_GET_INTEGRITY_INFORMATION, FSCTL_GET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_INTEGRITY_INFORMATION, FSCTL_SET_INTEGRITY_INFORMATION_BUFFER,
				FSCTL_SET_SPARSE,
			},
		},
	};

	/// Block-clones `src` into the empty `dst`, following the `ReFS` rules
	/// from <https://learn.microsoft.com/windows/win32/fileio/block-cloning>:
	/// each region is cluster-aligned and under 4 GiB, `dst` is extended to
	/// the source length first, and it matches `src`'s integrity-stream and
	/// sparse settings. The last region is rounded up to the whole cluster
	/// holding the end of file, as the `reflink` tools do
	/// (`0xbadfca11/reflink`, `reflink-copy`).
	pub fn clone_into(src: &File, dst: &File) -> io::Result<()> {
		/// The largest cloned region is under 4 GiB.
		const MAX_REGION: u64 = (4 << 30) - 1;

		// Filesystems without block cloning fail here.
		let mut integrity = FSCTL_GET_INTEGRITY_INFORMATION_BUFFER::default();
		fsctl(src, FSCTL_GET_INTEGRITY_INFORMATION, &(), &mut integrity)?;
		let metadata = src.metadata()?;
		let len = metadata.len();
		let cluster = u64::from(integrity.ClusterSizeInBytes).max(1);

		// Best effort: some volumes (reportedly Dev Drive) refuse the change,
		// and a real mismatch then fails the clone itself.
		let _ = fsctl(
			dst,
			FSCTL_SET_INTEGRITY_INFORMATION,
			&FSCTL_SET_INTEGRITY_INFORMATION_BUFFER {
				ChecksumAlgorithm: integrity.ChecksumAlgorithm,
				Reserved:          0,
				Flags:             integrity.Flags,
			},
			&mut (),
		);
		// Sparse while cloning, so extending the end of file allocates no
		// clusters the clone replaces anyway; ReFS also requires it of the
		// destination of a sparse source.
		set_sparse(dst, true)?;
		dst.set_len(len)?;

		let region_limit = MAX_REGION / cluster * cluster;
		let end = len.div_ceil(cluster) * cluster;
		let mut offset = 0;
		while offset < end {
			let count = region_limit.min(end - offset);
			let offset_i64 = i64::try_from(offset).map_err(|_| io::ErrorKind::FileTooLarge)?;
			let data = DUPLICATE_EXTENTS_DATA {
				FileHandle:       src.as_raw_handle() as _,
				SourceFileOffset: offset_i64,
				TargetFileOffset: offset_i64,
				ByteCount:        i64::try_from(count).map_err(|_| io::ErrorKind::FileTooLarge)?,
			};
			fsctl(dst, FSCTL_DUPLICATE_EXTENTS_TO_FILE, &data, &mut ())?;
			offset += count;
		}

		if metadata.file_attributes() & FILE_ATTRIBUTE_SPARSE_FILE == 0 {
			set_sparse(dst, false)?;
		}
		Ok(())
	}

	/// The number of hard links to `file`.
	pub fn link_count(file: &File) -> io::Result<u64> {
		let mut info = BY_HANDLE_FILE_INFORMATION::default();
		// SAFETY: `file` owns a valid handle for the call, and `info` is a live,
		// writable buffer of the expected type.
		if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &raw mut info) } == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(u64::from(info.nNumberOfLinks))
		}
	}

	pub fn set_sparse(file: &File, sparse: bool) -> io::Result<()> {
		fsctl(file, FSCTL_SET_SPARSE, &FILE_SET_SPARSE_BUFFER { SetSparse: sparse }, &mut ())
	}

	/// Issues the filesystem control `code` on `file` with the plain-data
	/// `input` and `output` buffers; `()` passes no buffer.
	fn fsctl<I, O>(file: &File, code: u32, input: &I, output: &mut O) -> io::Result<()> {
		fn buffer_size<T>() -> u32 {
			u32::try_from(size_of::<T>()).expect("FSCTL buffer fits u32")
		}
		let input_ptr: *const c_void = if size_of::<I>() == 0 {
			std::ptr::null()
		} else {
			std::ptr::from_ref(input).cast()
		};
		let output_ptr: *mut c_void = if size_of::<O>() == 0 {
			std::ptr::null_mut()
		} else {
			std::ptr::from_mut(output).cast()
		};
		let mut returned = 0u32;
		// SAFETY: `file` owns a valid handle for the call, and each buffer
		// pointer is either null with size 0 or points to a live `I`/`O` of the
		// stated size. The call is synchronous, so no pointer outlives it.
		let ok = unsafe {
			DeviceIoControl(
				file.as_raw_handle() as _,
				code,
				input_ptr,
				buffer_size::<I>(),
				output_ptr,
				buffer_size::<O>(),
				&raw mut returned,
				std::ptr::null_mut(),
			)
		};
		if ok == 0 {
			Err(io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	pub fn is_unsupported_code(code: i32) -> bool {
		u32::try_from(code).is_ok_and(|code| {
			matches!(
				code,
				ERROR_INVALID_FUNCTION
					| ERROR_NOT_SUPPORTED
					| ERROR_NOT_SAME_DEVICE
					| ERROR_INVALID_PARAMETER
					| ERROR_ACCESS_DENIED
			)
		})
	}
}
