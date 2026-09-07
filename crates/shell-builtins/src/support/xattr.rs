//! Minimal extended-attribute probes used by `ls` and `mkdir`.

#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::{ffi, io, ptr};

#[cfg(target_os = "linux")]
use {
	omp_core::FastHashMap,
	rustix::buffer::spare_capacity,
	rustix::fs::{XattrFlags, lgetxattr, llistxattr, lsetxattr},
};

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
/// Returns the NUL-separated names of all l*xattrs for `path`.
///
/// Uses `llistxattr` so the last path component is not followed, matching
/// the upstream `uucore::fsxattr` no-follow contract that `mv` expects.
#[cfg(target_os = "linux")]
fn list_xattr_names(path: &Path) -> io::Result<Vec<u8>> {
	let mut size = match llistxattr(path, &mut [0_u8; 0]) {
		Ok(0) => return Ok(Vec::new()),
		Ok(size) => size,
		Err(e) => return Err(e.into()),
	};

	loop {
		let mut names = Vec::with_capacity(size);
		match llistxattr(path, spare_capacity(&mut names)) {
			Ok(0) => return Ok(Vec::new()),
			Ok(_) => return Ok(names),
			Err(rustix::io::Errno::RANGE) => {
				size = size.saturating_mul(2).max(1024);
			},
			Err(e) => return Err(e.into()),
		}
	}
}

/// Returns the value for a single l*xattr name, or `None` if the attribute
/// disappeared between listing and reading (`ENODATA`).
#[cfg(target_os = "linux")]
fn lgetxattr_value(path: &Path, name: &[u8]) -> io::Result<Option<Vec<u8>>> {
	let mut size = match lgetxattr(path, name, &mut [0_u8; 0]) {
		Ok(size) => size,
		Err(rustix::io::Errno::NODATA) => return Ok(None),
		Err(e) => return Err(e.into()),
	};

	loop {
		if size == 0 {
			match lgetxattr(path, name, &mut [0_u8; 0]) {
				Ok(0) => return Ok(Some(Vec::new())),
				Ok(next_size) => {
					size = next_size;
					continue;
				},
				Err(rustix::io::Errno::NODATA) => return Ok(None),
				Err(e) => return Err(e.into()),
			}
		}

		let mut value = Vec::with_capacity(size);
		match lgetxattr(path, name, spare_capacity(&mut value)) {
			Ok(_) => return Ok(Some(value)),
			Err(rustix::io::Errno::RANGE) => {
				size = size.saturating_mul(2).max(1024);
			},
			Err(rustix::io::Errno::NODATA) => return Ok(None),
			Err(e) => return Err(e.into()),
		}
	}
}

/// Retrieves all extended attributes for a path.
#[cfg(target_os = "linux")]
pub(crate) fn retrieve_xattrs(path: impl AsRef<Path>) -> io::Result<FastHashMap<Vec<u8>, Vec<u8>>> {
	let path = path.as_ref();
	let names = list_xattr_names(path)?;
	let mut xattrs = FastHashMap::default();
	for name in names
		.split(|byte| *byte == 0)
		.filter(|name| !name.is_empty())
	{
		if let Some(value) = lgetxattr_value(path, name)? {
			xattrs.insert(name.to_vec(), value);
		}
	}
	Ok(xattrs)
}

/// Applies a map of extended attributes to a path.
#[cfg(target_os = "linux")]
pub(crate) fn apply_xattrs(
	path: impl AsRef<Path>,
	xattrs: FastHashMap<Vec<u8>, Vec<u8>>,
) -> io::Result<()> {
	for (name, value) in xattrs {
		lsetxattr(path.as_ref(), name.as_slice(), value.as_slice(), XattrFlags::empty())
			.map_err(std::io::Error::from)?;
	}
	Ok(())
}

/// Copies all extended attributes from one path to another.
#[cfg(target_os = "linux")]
pub(crate) fn copy_xattrs(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()> {
	let xattrs = retrieve_xattrs(src)?;
	apply_xattrs(dst, xattrs)
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

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use omp_core::FastHashMap;

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
	fn round_trip_xattrs() -> std::io::Result<()> {
		let src = tempfile::NamedTempFile::new()?;
		let dst = tempfile::NamedTempFile::new()?;

		let mut expected: FastHashMap<Vec<u8>, Vec<u8>> = FastHashMap::default();
		expected.insert(b"user.omp.test".to_vec(), b"value".to_vec());

		apply_xattrs(src.path(), expected)?;
		copy_xattrs(src.path(), dst.path())?;

		let found = retrieve_xattrs(dst.path())?;
		assert_eq!(found.get(b"user.omp.test".as_slice()).map(Vec::as_slice), Some(b"value".as_slice()));
		Ok(())
	}
}
