//! Host calls behind [`StdFs`](super::StdFs)'s directory, permission,
//! ownership, extended-attribute and user-database operations (zsh/files,
//! zsh/stat, zsh/attr).

use std::{io, path::Path};

use crate::bash::fs::{PwEntry, PwQuery};

/// `mkdir(path, mode)` with exactly the permission bits `mode`: the kernel
/// applies the process umask (`process_umask`, `None` when unknown), so
/// the bits it may have cleared are set again with `chmod`.
pub fn mkdir(path: &Path, mode: u32, process_umask: Option<u32>) -> io::Result<()> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
		std::fs::DirBuilder::new()
			.mode(mode & 0o7777)
			.create(path)?;
		if process_umask.is_none_or(|mask| mode & 0o777 & mask != 0) {
			let have = std::fs::symlink_metadata(path)?.permissions().mode();
			let want = (have & !0o777) | (mode & 0o777);
			if want != have {
				std::fs::set_permissions(path, std::fs::Permissions::from_mode(want))?;
			}
		}
		Ok(())
	}
	#[cfg(not(unix))]
	{
		let _ = (mode, process_umask);
		std::fs::create_dir(path)
	}
}

/// `chmod(path, mode)`.
pub fn chmod(path: &Path, mode: u32) -> io::Result<()> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o7777))
	}
	#[cfg(not(unix))]
	{
		let mut perm = std::fs::metadata(path)?.permissions();
		perm.set_readonly(mode & 0o222 == 0);
		std::fs::set_permissions(path, perm)
	}
}

/// `chown`/`lchown`.
pub fn chown(path: &Path, uid: Option<u32>, gid: Option<u32>, follow: bool) -> io::Result<()> {
	#[cfg(unix)]
	{
		if follow {
			std::os::unix::fs::chown(path, uid, gid)
		} else {
			std::os::unix::fs::lchown(path, uid, gid)
		}
	}
	#[cfg(not(unix))]
	{
		let _ = (path, uid, gid, follow);
		Err(io::ErrorKind::Unsupported.into())
	}
}

/// `sync(2)`.
pub fn sync() {
	#[cfg(unix)]
	// SAFETY: `sync` takes no arguments and cannot fail.
	unsafe {
		libc::sync();
	}
}

#[cfg(any(target_os = "macos", target_os = "ios", target_os = "linux", target_os = "android"))]
mod xattr {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt, path::Path};

	use bstr::BString;

	fn cpath(path: &Path) -> io::Result<CString> {
		CString::new(path.as_os_str().as_bytes()).map_err(|_| io::ErrorKind::InvalidInput.into())
	}

	fn cname(name: &[u8]) -> io::Result<CString> {
		CString::new(name).map_err(|_| io::ErrorKind::InvalidInput.into())
	}

	/// `ssize_t` result → length or the `errno` error.
	fn len(n: isize) -> io::Result<usize> {
		usize::try_from(n).map_err(|_| io::Error::last_os_error())
	}

	#[cfg(any(target_os = "macos", target_os = "ios"))]
	const fn options(follow: bool) -> libc::c_int {
		if follow { 0 } else { libc::XATTR_NOFOLLOW }
	}

	/// `getxattr` (`size` 0 asks for the length).
	fn get_raw(p: &CString, n: &CString, buf: &mut [u8], follow: bool) -> io::Result<usize> {
		let (ptr, size) = if buf.is_empty() {
			(std::ptr::null_mut(), 0)
		} else {
			(buf.as_mut_ptr().cast(), buf.len())
		};
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: `p` and `n` are NUL-terminated; `ptr` is null with size 0
		// or valid for `size` bytes.
		let r = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), ptr, size, 0, options(follow)) };
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: as above.
		let r = unsafe {
			if follow {
				libc::getxattr(p.as_ptr(), n.as_ptr(), ptr, size)
			} else {
				libc::lgetxattr(p.as_ptr(), n.as_ptr(), ptr, size)
			}
		};
		len(r)
	}

	/// `listxattr` (`size` 0 asks for the length).
	fn list_raw(p: &CString, buf: &mut [u8], follow: bool) -> io::Result<usize> {
		let (ptr, size) = if buf.is_empty() {
			(std::ptr::null_mut(), 0)
		} else {
			(buf.as_mut_ptr().cast(), buf.len())
		};
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: `p` is NUL-terminated; `ptr` is null with size 0 or valid
		// for `size` bytes.
		let r = unsafe { libc::listxattr(p.as_ptr(), ptr, size, options(follow)) };
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: as above.
		let r = unsafe {
			if follow {
				libc::listxattr(p.as_ptr(), ptr, size)
			} else {
				libc::llistxattr(p.as_ptr(), ptr, size)
			}
		};
		len(r)
	}

	/// Size, then fetch; again when it grew in between (`ERANGE`).
	fn sized(mut call: impl FnMut(&mut [u8]) -> io::Result<usize>) -> io::Result<Vec<u8>> {
		loop {
			let want = call(&mut [])?;
			if want == 0 {
				return Ok(Vec::new());
			}
			let mut buf = vec![0u8; want];
			match call(&mut buf) {
				Ok(n) => {
					buf.truncate(n);
					return Ok(buf);
				},
				Err(e) if e.raw_os_error() == Some(libc::ERANGE) => {},
				Err(e) => return Err(e),
			}
		}
	}

	pub fn get(path: &Path, name: &[u8], follow: bool) -> io::Result<BString> {
		let (p, n) = (cpath(path)?, cname(name)?);
		sized(|buf| get_raw(&p, &n, buf, follow)).map(BString::from)
	}

	pub fn list(path: &Path, follow: bool) -> io::Result<Vec<BString>> {
		let p = cpath(path)?;
		let raw = sized(|buf| list_raw(&p, buf, follow))?;
		Ok(raw
			.split(|&c| c == 0)
			.filter(|n| !n.is_empty())
			.map(BString::from)
			.collect())
	}

	pub fn set(path: &Path, name: &[u8], value: &[u8], follow: bool) -> io::Result<()> {
		let (p, n) = (cpath(path)?, cname(name)?);
		let v = value.as_ptr().cast();
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: `p` and `n` are NUL-terminated; `v` is valid for
		// `value.len()` bytes.
		let r = unsafe { libc::setxattr(p.as_ptr(), n.as_ptr(), v, value.len(), 0, options(follow)) };
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: as above.
		let r = unsafe {
			if follow {
				libc::setxattr(p.as_ptr(), n.as_ptr(), v, value.len(), 0)
			} else {
				libc::lsetxattr(p.as_ptr(), n.as_ptr(), v, value.len(), 0)
			}
		};
		if r == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	pub fn remove(path: &Path, name: &[u8], follow: bool) -> io::Result<()> {
		let (p, n) = (cpath(path)?, cname(name)?);
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: `p` and `n` are NUL-terminated.
		let r = unsafe { libc::removexattr(p.as_ptr(), n.as_ptr(), options(follow)) };
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: as above.
		let r = unsafe {
			if follow {
				libc::removexattr(p.as_ptr(), n.as_ptr())
			} else {
				libc::lremovexattr(p.as_ptr(), n.as_ptr())
			}
		};
		if r == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}
}

#[cfg(not(any(
	target_os = "macos",
	target_os = "ios",
	target_os = "linux",
	target_os = "android"
)))]
mod xattr {
	use std::{io, path::Path};

	use bstr::BString;

	pub fn get(_: &Path, _: &[u8], _: bool) -> io::Result<BString> {
		Err(io::ErrorKind::Unsupported.into())
	}

	pub fn list(_: &Path, _: bool) -> io::Result<Vec<BString>> {
		Err(io::ErrorKind::Unsupported.into())
	}

	pub fn set(_: &Path, _: &[u8], _: &[u8], _: bool) -> io::Result<()> {
		Err(io::ErrorKind::Unsupported.into())
	}

	pub fn remove(_: &Path, _: &[u8], _: bool) -> io::Result<()> {
		Err(io::ErrorKind::Unsupported.into())
	}
}

pub use xattr::{get as getxattr, list as listxattr, remove as removexattr, set as setxattr};

/// The entries of the user/group database `query` asks for.
#[cfg(unix)]
pub fn user_db(query: &PwQuery) -> io::Result<Vec<PwEntry>> {
	use std::ffi::{CStr, CString};

	use bstr::BString;

	/// Run a `get*_r` call with a growing buffer: `Ok(None)` when there is
	/// no such entry.
	fn reentrant<T>(
		mut call: impl FnMut(*mut T, *mut libc::c_char, usize, *mut *mut T) -> libc::c_int,
		read: impl FnOnce(&T) -> PwEntry,
	) -> io::Result<Option<PwEntry>> {
		let mut size = 1024;
		loop {
			let mut buf = vec![0 as libc::c_char; size];
			let mut ent = std::mem::MaybeUninit::<T>::zeroed();
			let mut found: *mut T = std::ptr::null_mut();
			let rc = call(ent.as_mut_ptr(), buf.as_mut_ptr(), buf.len(), &raw mut found);
			if rc == libc::ERANGE && size < 1 << 20 {
				size *= 4;
				continue;
			}
			if rc != 0 {
				return Err(io::Error::from_raw_os_error(rc));
			}
			if found.is_null() {
				return Ok(None);
			}
			// SAFETY: the call succeeded and filled `ent`; its strings
			// point into `buf`, alive until the end of this scope.
			return Ok(Some(read(unsafe { ent.assume_init_ref() })));
		}
	}

	/// A C string field (null: empty).
	fn text(p: *const libc::c_char) -> BString {
		if p.is_null() {
			return BString::default();
		}
		// SAFETY: a non-null database field is NUL-terminated.
		BString::from(unsafe { CStr::from_ptr(p) }.to_bytes())
	}

	fn user(pw: &libc::passwd) -> PwEntry {
		PwEntry {
			name:  text(pw.pw_name),
			id:    pw.pw_uid,
			gid:   pw.pw_gid,
			dir:   text(pw.pw_dir),
			shell: text(pw.pw_shell),
		}
	}

	fn group(gr: &libc::group) -> PwEntry {
		PwEntry {
			name:  text(gr.gr_name),
			id:    gr.gr_gid,
			gid:   gr.gr_gid,
			dir:   BString::default(),
			shell: BString::default(),
		}
	}

	let cname = |n: &BString| {
		CString::new(n.as_slice()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
	};
	let one = match query {
		PwQuery::UserName(n) => {
			let n = cname(n)?;
			// SAFETY: every pointer is valid for the call (see `reentrant`).
			reentrant(|e, b, l, f| unsafe { libc::getpwnam_r(n.as_ptr(), e, b, l, f) }, user)?
		},
		PwQuery::Uid(uid) => {
			// SAFETY: as above.
			reentrant(|e, b, l, f| unsafe { libc::getpwuid_r(*uid, e, b, l, f) }, user)?
		},
		PwQuery::GroupName(n) => {
			let n = cname(n)?;
			// SAFETY: as above.
			reentrant(|e, b, l, f| unsafe { libc::getgrnam_r(n.as_ptr(), e, b, l, f) }, group)?
		},
		PwQuery::Gid(gid) => {
			// SAFETY: as above.
			reentrant(|e, b, l, f| unsafe { libc::getgrgid_r(*gid, e, b, l, f) }, group)?
		},
		PwQuery::AllUsers => {
			// `getpwent` keeps one cursor per process.
			static WALK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
			let _walk = WALK.lock();
			let mut out = Vec::new();
			// SAFETY: the cursor calls are serialized by `WALK`; each entry
			// is copied out before the next call overwrites it.
			unsafe {
				libc::setpwent();
				loop {
					let pw = libc::getpwent();
					if pw.is_null() {
						break;
					}
					out.push(user(&*pw));
				}
				libc::endpwent();
			}
			return Ok(out);
		},
	};
	Ok(one.into_iter().collect())
}

/// No user database off Unix.
#[cfg(not(unix))]
pub fn user_db(_query: &PwQuery) -> io::Result<Vec<PwEntry>> {
	Err(io::ErrorKind::Unsupported.into())
}
