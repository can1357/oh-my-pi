//! Minimal extended-attribute probes used by `ls` and `mkdir`.

#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
use std::path::Path;
#[cfg(target_os = "linux")]
use std::{ffi, ptr};
#[cfg(target_os = "linux")]
use std::{
	ffi::{OsStr, OsString},
	io,
};

#[cfg(target_os = "linux")]
use omp_core::FastHashMap;

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
	// size query without following a final symlink.
	let size = unsafe { libc::llistxattr(path.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	if size == 0 {
		return Ok(Vec::new());
	}
	let mut names = vec![0_u8; size as usize];
	// SAFETY: `names` is writable for its full reported capacity.
	let read = unsafe { libc::llistxattr(path.as_ptr(), names.as_mut_ptr().cast(), names.len()) };
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
	// SAFETY: both C strings are valid; a null value pointer performs a size
	// query without following a final symlink.
	let size = unsafe { libc::lgetxattr(path.as_ptr(), name.as_ptr(), ptr::null_mut(), 0) };
	if size < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut value = vec![0_u8; size as usize];
	// SAFETY: `value` is writable for the queried size and all pointers remain
	// live.
	let read = unsafe {
		libc::lgetxattr(path.as_ptr(), name.as_ptr(), value.as_mut_ptr().cast(), value.len())
	};
	if read < 0 {
		return Err(io::Error::last_os_error());
	}
	value.truncate(read as usize);
	Ok(value)
}

/// Reads every extended attribute attached to `path` without following a
/// final symlink.
#[cfg(target_os = "linux")]
pub(crate) fn retrieve_xattrs(
	path: impl AsRef<Path>,
) -> io::Result<FastHashMap<OsString, Vec<u8>>> {
	use std::os::unix::ffi::OsStringExt;

	let path = path.as_ref();
	let names = list_xattrs(path)?;
	let mut attrs = FastHashMap::default();
	for name in names
		.split(|byte| *byte == 0)
		.filter(|name| !name.is_empty())
	{
		let mut terminated_name = Vec::with_capacity(name.len() + 1);
		terminated_name.extend_from_slice(name);
		terminated_name.push(0);
		attrs.insert(OsString::from_vec(name.to_vec()), get_xattr(path, &terminated_name)?);
	}
	Ok(attrs)
}

/// Applies extended attributes to `path` without following a final symlink.
#[cfg(target_os = "linux")]
pub(crate) fn apply_xattrs(
	path: impl AsRef<Path>,
	xattrs: FastHashMap<OsString, Vec<u8>>,
) -> io::Result<()> {
	let path = path.as_ref();
	for (name, value) in xattrs {
		set_xattr(path, &name, &value)?;
	}
	Ok(())
}

/// Copies every extended attribute from `source` to `destination` without
/// following final symlinks.
#[cfg(target_os = "linux")]
pub(crate) fn copy_xattrs(
	source: impl AsRef<Path>,
	destination: impl AsRef<Path>,
) -> io::Result<()> {
	let xattrs = retrieve_xattrs(source)?;
	apply_xattrs(destination, xattrs)
}

#[cfg(target_os = "linux")]
fn set_xattr(path: &Path, name: &OsStr, value: &[u8]) -> io::Result<()> {
	use std::os::unix::ffi::OsStrExt;

	let path = path_cstring(path)?;
	let name = ffi::CString::new(name.as_bytes())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "attribute name contains NUL"))?;
	// SAFETY: both C strings and the value slice remain live for the call.
	let result = unsafe {
		libc::lsetxattr(path.as_ptr(), name.as_ptr(), value.as_ptr().cast(), value.len(), 0)
	};
	if result < 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(())
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
	fn copies_extended_attributes() -> io::Result<()> {
		let directory = tempfile::tempdir()?;
		let source = directory.path().join("source");
		let destination = directory.path().join("destination");
		std::fs::write(&source, b"source")?;
		std::fs::write(&destination, b"destination")?;

		let name = OsStr::new("user.omp-test");
		if let Err(error) = set_xattr(&source, name, b"value") {
			if matches!(error.raw_os_error(), Some(libc::EOPNOTSUPP | libc::EPERM)) {
				return Ok(());
			}
			return Err(error);
		}

		copy_xattrs(&source, &destination)?;
		let copied = retrieve_xattrs(&destination)?;
		assert_eq!(copied.get(name).map(Vec::as_slice), Some(b"value".as_slice()));
		Ok(())
	}

	#[test]
	fn does_not_follow_symlinks_when_copying_extended_attributes() -> io::Result<()> {
		use std::os::unix::fs::symlink;

		let directory = tempfile::tempdir()?;
		let source_dir = directory.path().join("source");
		let destination_dir = directory.path().join("destination");
		std::fs::create_dir(&source_dir)?;
		std::fs::create_dir(&destination_dir)?;

		let source_target = source_dir.join("target");
		let destination_target = destination_dir.join("target");
		std::fs::write(&source_target, b"source")?;
		std::fs::write(&destination_target, b"destination")?;

		let name = OsStr::new("user.omp-symlink-test");
		for (path, value) in
			[(&source_target, &b"source-value"[..]), (&destination_target, &b"destination-value"[..])]
		{
			if let Err(error) = set_xattr(path, name, value) {
				if matches!(error.raw_os_error(), Some(libc::EOPNOTSUPP | libc::EPERM)) {
					return Ok(());
				}
				return Err(error);
			}
		}

		let source_link = source_dir.join("link");
		let destination_link = destination_dir.join("link");
		symlink("target", &source_link)?;
		symlink("target", &destination_link)?;

		copy_xattrs(&source_link, &destination_link)?;

		let destination_attrs = retrieve_xattrs(&destination_target)?;
		assert_eq!(
			destination_attrs.get(name).map(Vec::as_slice),
			Some(b"destination-value".as_slice())
		);
		Ok(())
	}
}
