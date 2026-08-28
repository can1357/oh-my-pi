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

#[cfg(target_os = "linux")]
fn list_xattrs(path: &Path) -> io::Result<Vec<u8>> {
	let path = path_cstring(path)?;
	// SAFETY: the C path is valid and a null buffer with length zero performs a
	// size query.
	let size = unsafe { libc::listxattr(path.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	if size == 0 {
		return Ok(Vec::new());
	}
	let mut names = vec![0_u8; size as usize];
	// SAFETY: `names` is writable for its full reported capacity.
	let read = unsafe { libc::listxattr(path.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
	if read < 0 {
		return Err(io::Error::last_os_error());
	}
	names.truncate(read as usize);
	Ok(names)
}

#[cfg(target_os = "linux")]
fn get_xattr(path: &Path, name: &[u8]) -> io::Result<Vec<u8>> {
	let path = path_cstring(path)?;
	let name = ffi::CStr::from_bytes_with_nul(name)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid attribute name"))?;
	// SAFETY: both C strings are valid; a null value pointer performs a size query.
	let size = unsafe { libc::getxattr(path.as_ptr(), name.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut value = vec![0_u8; size as usize];
	// SAFETY: `value` is writable for the queried size and all pointers remain
	// live.
	let read = unsafe {
		libc::getxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len())
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
fn set_xattr(path: &Path, name: &[u8], value: &[u8]) -> io::Result<()> {
	let path = path_cstring(path)?;
	let name = ffi::CStr::from_bytes_with_nul(name)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid attribute name"))?;
	// SAFETY: both C strings are valid.
	let rc = unsafe {
		libc::setxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0)
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
	let path = path.as_ref();
	let names = list_xattrs(path)?;
	let mut map = omp_core::FastHashMap::default();
	for name in names.split_inclusive(|b| *b == 0) {
		if name.len() <= 1 {
			continue;
		}
		map.insert(name.to_vec(), get_xattr(path, name)?);
	}
	Ok(map)
}

#[cfg(target_os = "linux")]
pub(crate) fn apply_xattrs(
	path: impl AsRef<Path>,
	xattrs: omp_core::FastHashMap<Vec<u8>, Vec<u8>>,
) -> io::Result<()> {
	let path = path.as_ref();
	for (name, value) in &xattrs {
		set_xattr(path, name, value)?;
	}
	Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn copy_xattrs(from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
	apply_xattrs(to, retrieve_xattrs(from)?)
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
		if let Err(error) = set_xattr(&src, b"user.omp-test\0", b"value") {
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
}
