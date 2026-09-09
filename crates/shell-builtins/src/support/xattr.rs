//! Minimal extended-attribute probes used by `ls` and `mkdir`.

#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::{ffi, io, ptr};

/// Returns whether a path has at least one extended ACL or attribute.
#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
pub(crate) fn has_acl(path: impl AsRef<Path>) -> bool {
	#[cfg(target_os = "linux")]
	return list_xattrs(path.as_ref()).is_ok_and(|names| !names.is_empty());
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		false
	}
}

/// Returns whether Linux's `security.capability` extended attribute is present.
#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
pub(crate) fn has_security_cap_acl(path: impl AsRef<Path>) -> bool {
	#[cfg(target_os = "linux")]
	return list_xattrs(path.as_ref()).is_ok_and(|names| {
		names
			.split(|byte| *byte == 0)
			.any(|name| name == b"security.capability")
	});
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		false
	}
}

/// Extracts inherited owner, group, and other permission bits from a Linux
/// default ACL.
#[cfg(target_os = "linux")]
pub(crate) fn get_acl_perm_bits_from_xattr(path: impl AsRef<Path>) -> u32 {
	get_xattr(path.as_ref(), b"system.posix_acl_default\0")
		.ok()
		.and_then(|value| parse_default_acl_permissions(&value))
		.unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn path_cstring(path: &Path) -> io::Result<ffi::CString> {
	use std::os::unix::ffi::OsStrExt;
	ffi::CString::new(path.as_os_str().as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

/// Listing, reading, and writing syscalls for one symlink traversal mode.
#[cfg(target_os = "linux")]
struct XattrSyscalls {
	list: ListXattrs,
	get:  GetXattr,
	set:  SetXattr,
}

#[cfg(target_os = "linux")]
type ListXattrs =
	unsafe extern "C" fn(*const libc::c_char, *mut libc::c_char, libc::size_t) -> libc::ssize_t;
#[cfg(target_os = "linux")]
type GetXattr = unsafe extern "C" fn(
	*const libc::c_char,
	*const libc::c_char,
	*mut libc::c_void,
	libc::size_t,
) -> libc::ssize_t;
#[cfg(target_os = "linux")]
type SetXattr = unsafe extern "C" fn(
	*const libc::c_char,
	*const libc::c_char,
	*const libc::c_void,
	libc::size_t,
	libc::c_int,
) -> libc::c_int;

/// The standard syscalls, which resolve a symlink operand to its target.
#[cfg(target_os = "linux")]
const FOLLOWING: XattrSyscalls =
	XattrSyscalls { list: libc::listxattr, get: libc::getxattr, set: libc::setxattr };

/// The `l`-prefixed syscalls, which treat a symlink operand as the link
/// itself so a copied link keeps its own attributes instead of inheriting or
/// overwriting its target's.
#[cfg(target_os = "linux")]
const LINK: XattrSyscalls =
	XattrSyscalls { list: libc::llistxattr, get: libc::lgetxattr, set: libc::lsetxattr };

#[cfg(target_os = "linux")]
fn list_xattrs(path: &Path) -> io::Result<Vec<u8>> {
	list_xattrs_with(path, &FOLLOWING)
}

#[cfg(target_os = "linux")]
fn list_xattrs_with(path: &Path, syscalls: &XattrSyscalls) -> io::Result<Vec<u8>> {
	let path = path_cstring(path)?;
	// SAFETY: the C path is valid and a null buffer with length zero performs a
	// size query.
	let size = unsafe { (syscalls.list)(path.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	if size == 0 {
		return Ok(Vec::new());
	}
	let mut names = vec![0_u8; size as usize];
	// SAFETY: `names` is writable for its full reported capacity.
	let read = unsafe { (syscalls.list)(path.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
	if read < 0 {
		return Err(io::Error::last_os_error());
	}
	names.truncate(read as usize);
	Ok(names)
}

#[cfg(target_os = "linux")]
fn get_xattr(path: &Path, name: &[u8]) -> io::Result<Vec<u8>> {
	get_xattr_with(path, name, &FOLLOWING)
}

#[cfg(target_os = "linux")]
fn get_xattr_with(path: &Path, name: &[u8], syscalls: &XattrSyscalls) -> io::Result<Vec<u8>> {
	let path = path_cstring(path)?;
	let name = ffi::CStr::from_bytes_with_nul(name)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid attribute name"))?;
	// SAFETY: both C strings are valid; a null value pointer performs a size query.
	let size = unsafe { (syscalls.get)(path.as_ptr(), name.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut value = vec![0_u8; size as usize];
	// SAFETY: `value` is writable for the queried size and all pointers remain
	// live.
	let read = unsafe {
		(syscalls.get)(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len())
	};
	if read < 0 {
		return Err(io::Error::last_os_error());
	}
	value.truncate(read as usize);
	Ok(value)
}

#[cfg(target_os = "linux")]
fn parse_default_acl_permissions(value: &[u8]) -> Option<u32> {
	const ACL_USER_OBJ: u16 = 0x01;
	const ACL_GROUP_OBJ: u16 = 0x04;
	const ACL_MASK: u16 = 0x10;
	const ACL_OTHER: u16 = 0x20;
	if value.len() < 4 || u32::from_le_bytes(value[..4].try_into().ok()?) != 2 {
		return None;
	}
	let mut owner = None;
	let mut group = None;
	let mut mask = None;
	let mut other = None;
	for entry in value[4..].chunks_exact(8) {
		let tag = u16::from_le_bytes([entry[0], entry[1]]);
		let permissions = u32::from(u16::from_le_bytes([entry[2], entry[3]]) & 0o7);
		match tag {
			ACL_USER_OBJ => owner = Some(permissions),
			ACL_GROUP_OBJ => group = Some(permissions),
			ACL_MASK => mask = Some(permissions),
			ACL_OTHER => other = Some(permissions),
			_ => {},
		}
	}
	Some((owner? << 6) | (mask.or(group)? << 3) | other?)
}

#[cfg(target_os = "linux")]
fn set_xattr_with(
	path: &Path,
	name: &[u8],
	value: &[u8],
	syscalls: &XattrSyscalls,
) -> io::Result<()> {
	let path = path_cstring(path)?;
	let name = ffi::CStr::from_bytes_with_nul(name)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid attribute name"))?;
	// SAFETY: both C strings are valid.
	let rc = unsafe {
		(syscalls.set)(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0)
	};
	if rc < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
}
#[cfg(target_os = "linux")]
pub(crate) fn retrieve_xattrs(
	path: impl AsRef<Path>,
) -> io::Result<omp_core::FastHashMap<Vec<u8>, Vec<u8>>> {
	retrieve_xattrs_with(path.as_ref(), &FOLLOWING)
}

#[cfg(target_os = "linux")]
fn retrieve_xattrs_with(
	path: &Path,
	syscalls: &XattrSyscalls,
) -> io::Result<omp_core::FastHashMap<Vec<u8>, Vec<u8>>> {
	let names = list_xattrs_with(path, syscalls)?;
	let mut map = omp_core::FastHashMap::default();
	for name in names.split_inclusive(|b| *b == 0) {
		if name.len() <= 1 {
			continue;
		}
		map.insert(name.to_vec(), get_xattr_with(path, name, syscalls)?);
	}
	Ok(map)
}

#[cfg(target_os = "linux")]
pub(crate) fn apply_xattrs(
	path: impl AsRef<Path>,
	xattrs: omp_core::FastHashMap<Vec<u8>, Vec<u8>>,
) -> io::Result<()> {
	apply_xattrs_with(path.as_ref(), xattrs, &FOLLOWING)
}

#[cfg(target_os = "linux")]
fn apply_xattrs_with(
	path: &Path,
	xattrs: omp_core::FastHashMap<Vec<u8>, Vec<u8>>,
	syscalls: &XattrSyscalls,
) -> io::Result<()> {
	for (name, value) in &xattrs {
		set_xattr_with(path, name, value, syscalls)?;
	}
	Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn copy_xattrs(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
	apply_xattrs_with(to.as_ref(), retrieve_xattrs_with(from.as_ref(), &FOLLOWING)?, &FOLLOWING)
}

/// Copies the attributes a symlink itself carries. Neither operand is
/// resolved, so moving a link across filesystems cannot read or write the
/// file it points to.
#[cfg(target_os = "linux")]
pub(crate) fn copy_link_xattrs(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
	apply_xattrs_with(to.as_ref(), retrieve_xattrs_with(from.as_ref(), &LINK)?, &LINK)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use super::*;

	#[test]
	fn parses_default_acl_mode_bits() {
		let mut value = 2_u32.to_le_bytes().to_vec();
		for (tag, permissions) in [(1_u16, 7_u16), (4, 5), (16, 4), (32, 1)] {
			value.extend_from_slice(&tag.to_le_bytes());
			value.extend_from_slice(&permissions.to_le_bytes());
			value.extend_from_slice(&u32::MAX.to_le_bytes());
		}
		assert_eq!(parse_default_acl_permissions(&value), Some(0o741));
	}

	#[test]
	fn retrieve_apply_round_trips_a_user_attribute() {
		let dir = tempfile::tempdir().expect("tempdir");
		let src = dir.path().join("src");
		let dst = dir.path().join("dst");
		std::fs::write(&src, b"").expect("src");
		std::fs::write(&dst, b"").expect("dst");
		if let Err(error) = set_xattr_with(&src, b"user.omp-test\0", b"value", &FOLLOWING) {
			if error.raw_os_error() == Some(libc::EOPNOTSUPP) {
				return;
			}
			panic!("{error}");
		}
		let map = retrieve_xattrs(&src).expect("retrieve");
		assert_eq!(
			map.get(b"user.omp-test\0".as_slice()).map(Vec::as_slice),
			Some(b"value".as_slice())
		);
		apply_xattrs(&dst, map).expect("apply");
		assert_eq!(get_xattr(&dst, b"user.omp-test\0").expect("get"), b"value");
	}

	#[test]
	fn copies_a_symlinks_own_attributes_without_following() {
		let dir = tempfile::tempdir().expect("tempdir");
		let source_target = dir.path().join("source-target");
		let destination_target = dir.path().join("destination-target");
		let source_link = dir.path().join("source-link");
		let destination_link = dir.path().join("destination-link");
		std::fs::write(&source_target, b"").expect("write source target");
		std::fs::write(&destination_target, b"").expect("write destination target");
		if let Err(error) = set_xattr_with(&source_target, b"user.omp-test\0", b"source", &FOLLOWING)
		{
			if error.raw_os_error() == Some(libc::EOPNOTSUPP) {
				return;
			}
			panic!("{error}");
		}
		set_xattr_with(&destination_target, b"user.omp-test\0", b"destination", &FOLLOWING)
			.expect("set destination target");
		std::os::unix::fs::symlink("source-target", &source_link).expect("symlink source");
		std::os::unix::fs::symlink("destination-target", &destination_link)
			.expect("symlink destination");
		// Best effort: not every kernel and filesystem lets a symlink carry
		// its own user.* attributes.
		let link_has_own_attributes =
			set_xattr_with(&source_link, b"user.omp-link\0", b"link", &LINK).is_ok();
		copy_link_xattrs(&source_link, &destination_link).expect("copy link xattrs");
		if link_has_own_attributes {
			assert_eq!(
				get_xattr_with(&destination_link, b"user.omp-link\0", &LINK)
					.ok()
					.as_deref(),
				Some(b"link".as_slice())
			);
		}
		// Neither target file was read or written through the links.
		assert_eq!(
			get_xattr(&source_target, b"user.omp-test\0")
				.ok()
				.as_deref(),
			Some(b"source".as_slice())
		);
		assert_eq!(
			get_xattr(&destination_target, b"user.omp-test\0")
				.ok()
				.as_deref(),
			Some(b"destination".as_slice())
		);
	}
}
