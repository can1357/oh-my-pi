//! Owned file metadata for host and provider objects.

use std::{
	io,
	time::{SystemTime, UNIX_EPOCH},
};

use crate::{
	error::unsupported,
	types::{FileId, FileType, Permissions},
};

/// Metadata of a host or provider filesystem object.
///
/// Host values wrap [`std::fs::Metadata`] (see [`Metadata::native`]);
/// provider values carry only what the provider reported. Identity, owner
/// and block fields are `None` when unknown — never fabricated.
#[derive(Clone, Debug)]
pub struct Metadata {
	repr: Repr,
}

#[derive(Clone, Debug)]
enum Repr {
	Native(NativeMeta),
	Virtual(VirtualMeta),
}

#[derive(Clone, Debug)]
struct NativeMeta {
	meta:   std::fs::Metadata,
	/// Identity/link count read through an open handle; std does not expose
	/// them from a Windows path stat.
	#[cfg(windows)]
	handle: Option<crate::native::HandleInfo>,
}

#[derive(Clone, Debug)]
struct VirtualMeta {
	file_type:   FileType,
	len:         u64,
	permissions: Permissions,
	modified:    Option<SystemTime>,
	accessed:    Option<SystemTime>,
	created:     Option<SystemTime>,
	changed:     Option<SystemTime>,
	id:          Option<FileId>,
	nlink:       Option<u64>,
	uid:         Option<u32>,
	gid:         Option<u32>,
	rdev:        Option<u64>,
	blocks:      Option<u64>,
	blksize:     Option<u64>,
}

impl From<std::fs::Metadata> for Metadata {
	fn from(meta: std::fs::Metadata) -> Self {
		Self {
			repr: Repr::Native(NativeMeta {
				meta,
				#[cfg(windows)]
				handle: None,
			}),
		}
	}
}

impl Metadata {
	/// Metadata of an open host file, keeping the handle identity that a
	/// Windows path stat cannot provide, so [`Metadata::same_file`] can
	/// compare it against path-side metadata.
	pub fn from_file(file: &std::fs::File) -> io::Result<Self> {
		crate::native::file_metadata(file)
	}
}

fn split_time(time: SystemTime) -> (i64, i64) {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => (after.as_secs() as i64, i64::from(after.subsec_nanos())),
		Err(before) => {
			let before = before.duration();
			let secs = -(before.as_secs() as i64);
			match before.subsec_nanos() {
				0 => (secs, 0),
				nanos => (secs - 1, 1_000_000_000 - i64::from(nanos)),
			}
		},
	}
}

#[cfg(unix)]
fn unix_time(secs: i64, nsec: i64) -> SystemTime {
	use std::time::Duration;
	let nsec = nsec.clamp(0, 999_999_999) as u32;
	if secs >= 0 {
		UNIX_EPOCH + Duration::new(secs as u64, nsec)
	} else {
		UNIX_EPOCH - Duration::from_secs(secs.unsigned_abs()) + Duration::from_nanos(u64::from(nsec))
	}
}

fn missing(what: &str) -> io::Error {
	unsupported(what)
}

#[derive(Clone, Copy)]
enum TimeField {
	Accessed,
	Modified,
	Changed,
}

impl Metadata {
	/// Provider constructor; refine with the `with_*` builders.
	pub const fn new(file_type: FileType, len: u64, permissions: Permissions) -> Self {
		Self {
			repr: Repr::Virtual(VirtualMeta {
				file_type,
				len,
				permissions,
				modified: None,
				accessed: None,
				created: None,
				changed: None,
				id: None,
				nlink: None,
				uid: None,
				gid: None,
				rdev: None,
				blocks: None,
				blksize: None,
			}),
		}
	}

	#[cfg(windows)]
	pub(crate) const fn native_with_handle(
		meta: std::fs::Metadata,
		handle: crate::native::HandleInfo,
	) -> Self {
		Self { repr: Repr::Native(NativeMeta { meta, handle: Some(handle) }) }
	}

	const fn virtual_mut(&mut self) -> Option<&mut VirtualMeta> {
		match &mut self.repr {
			Repr::Virtual(meta) => Some(meta),
			Repr::Native(_) => None,
		}
	}

	fn update(mut self, apply: impl FnOnce(&mut VirtualMeta)) -> Self {
		if let Some(meta) = self.virtual_mut() {
			apply(meta);
		}
		self
	}

	/// Provider builder: modification time. No-op on host metadata.
	pub fn with_modified(self, time: SystemTime) -> Self {
		self.update(|m| m.modified = Some(time))
	}

	/// Provider builder: access time.
	pub fn with_accessed(self, time: SystemTime) -> Self {
		self.update(|m| m.accessed = Some(time))
	}

	/// Provider builder: creation (birth) time.
	pub fn with_created(self, time: SystemTime) -> Self {
		self.update(|m| m.created = Some(time))
	}

	/// Provider builder: status change time (`ctime`).
	pub fn with_changed(self, time: SystemTime) -> Self {
		self.update(|m| m.changed = Some(time))
	}

	/// Provider builder: identity in the provider namespace.
	pub fn with_id(self, dev: u64, ino: u64) -> Self {
		self.update(|m| m.id = Some(FileId::new(dev, ino)))
	}

	/// Provider builder: a real host identity (the backing file's OS stat),
	/// comparable with host metadata.
	pub fn with_native_id(self, dev: u64, ino: u64) -> Self {
		self.update(|m| m.id = Some(FileId::native(dev, ino)))
	}

	/// Provider builder: hard link count.
	pub fn with_nlink(self, nlink: u64) -> Self {
		self.update(|m| m.nlink = Some(nlink))
	}

	/// Provider builder: owner.
	pub fn with_owner(self, uid: u32, gid: u32) -> Self {
		self.update(|m| {
			m.uid = Some(uid);
			m.gid = Some(gid);
		})
	}

	/// Provider builder: device number of a device node.
	pub fn with_rdev(self, rdev: u64) -> Self {
		self.update(|m| m.rdev = Some(rdev))
	}

	/// Provider builder: allocated 512-byte blocks and preferred I/O size.
	pub fn with_blocks(self, blocks: u64, blksize: u64) -> Self {
		self.update(|m| {
			m.blocks = Some(blocks);
			m.blksize = Some(blksize);
		})
	}

	/// The host metadata, when this describes a host object.
	pub const fn native(&self) -> Option<&std::fs::Metadata> {
		match &self.repr {
			Repr::Native(native) => Some(&native.meta),
			Repr::Virtual(_) => None,
		}
	}

	pub fn file_type(&self) -> FileType {
		match &self.repr {
			Repr::Native(native) => native.meta.file_type().into(),
			Repr::Virtual(meta) => meta.file_type,
		}
	}

	pub fn is_file(&self) -> bool {
		self.file_type().is_file()
	}

	pub fn is_dir(&self) -> bool {
		self.file_type().is_dir()
	}

	pub fn is_symlink(&self) -> bool {
		self.file_type().is_symlink()
	}

	#[allow(clippy::len_without_is_empty, reason = "mirrors std::fs::Metadata::len")]
	pub fn len(&self) -> u64 {
		match &self.repr {
			Repr::Native(native) => native.meta.len(),
			Repr::Virtual(meta) => meta.len,
		}
	}

	/// Alias of [`Metadata::len`] (`st_size`).
	pub fn size(&self) -> u64 {
		self.len()
	}

	pub fn permissions(&self) -> Permissions {
		match &self.repr {
			Repr::Native(native) => native.meta.permissions().into(),
			Repr::Virtual(meta) => meta.permissions,
		}
	}

	/// `st_mode`: type bits plus permission bits. Windows host objects report
	/// `0o555`/`0o777` from the read-only attribute.
	pub fn mode(&self) -> u32 {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => std::os::unix::fs::MetadataExt::mode(&native.meta),
			#[cfg(not(unix))]
			Repr::Native(native) => {
				let kind = FileType::from(native.meta.file_type()).mode_bits();
				kind | Permissions::from(native.meta.permissions()).mode()
			},
			Repr::Virtual(meta) => meta.file_type.mode_bits() | meta.permissions.mode(),
		}
	}

	pub fn modified(&self) -> io::Result<SystemTime> {
		match &self.repr {
			Repr::Native(native) => native.meta.modified(),
			Repr::Virtual(meta) => meta.modified.ok_or_else(|| missing("modification time")),
		}
	}

	pub fn accessed(&self) -> io::Result<SystemTime> {
		match &self.repr {
			Repr::Native(native) => native.meta.accessed(),
			Repr::Virtual(meta) => meta.accessed.ok_or_else(|| missing("access time")),
		}
	}

	pub fn created(&self) -> io::Result<SystemTime> {
		match &self.repr {
			Repr::Native(native) => native.meta.created(),
			Repr::Virtual(meta) => meta.created.ok_or_else(|| missing("creation time")),
		}
	}

	/// Status change time (`ctime`).
	pub fn changed(&self) -> io::Result<SystemTime> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => {
				use std::os::unix::fs::MetadataExt;
				Ok(unix_time(native.meta.ctime(), native.meta.ctime_nsec()))
			},
			#[cfg(not(unix))]
			Repr::Native(_) => Err(missing("status change time")),
			Repr::Virtual(meta) => meta.changed.ok_or_else(|| missing("status change time")),
		}
	}

	/// Identity, when known.
	pub fn file_id(&self) -> Option<FileId> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => {
				use std::os::unix::fs::MetadataExt;
				Some(FileId::native(native.meta.dev(), native.meta.ino()))
			},
			#[cfg(windows)]
			Repr::Native(native) => native
				.handle
				.filter(|handle| handle.file_index != 0)
				.map(|handle| FileId::native(handle.volume_serial, handle.file_index)),
			#[cfg(not(any(unix, windows)))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.id,
		}
	}

	/// Both sides have an identity and it is the same object.
	pub fn same_file(&self, other: &Self) -> bool {
		matches!((self.file_id(), other.file_id()), (Some(a), Some(b)) if a == b)
	}

	pub fn dev(&self) -> Option<u64> {
		self.file_id().map(|id| id.dev())
	}

	pub fn ino(&self) -> Option<u64> {
		self.file_id().map(|id| id.ino())
	}

	pub fn nlink(&self) -> Option<u64> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::nlink(&native.meta)),
			#[cfg(windows)]
			Repr::Native(native) => native.handle.map(|handle| handle.nlink),
			#[cfg(not(any(unix, windows)))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.nlink,
		}
	}

	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	pub fn uid(&self) -> Option<u32> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::uid(&native.meta)),
			#[cfg(not(unix))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.uid,
		}
	}

	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	pub fn gid(&self) -> Option<u32> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::gid(&native.meta)),
			#[cfg(not(unix))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.gid,
		}
	}

	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	pub fn rdev(&self) -> Option<u64> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::rdev(&native.meta)),
			#[cfg(not(unix))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.rdev,
		}
	}

	/// Preferred I/O block size (`st_blksize`).
	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	pub fn blksize(&self) -> Option<u64> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::blksize(&native.meta)),
			#[cfg(not(unix))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.blksize,
		}
	}

	/// Allocated 512-byte blocks (`st_blocks`).
	#[cfg_attr(not(unix), allow(clippy::missing_const_for_fn, reason = "const only off Unix"))]
	pub fn blocks(&self) -> Option<u64> {
		match &self.repr {
			#[cfg(unix)]
			Repr::Native(native) => Some(std::os::unix::fs::MetadataExt::blocks(&native.meta)),
			#[cfg(not(unix))]
			Repr::Native(_) => None,
			Repr::Virtual(meta) => meta.blocks,
		}
	}

	/// `(seconds, nanoseconds)` of a timestamp; host Unix values come straight
	/// from `stat`, everything else is derived from the `SystemTime`.
	fn time_parts(&self, field: TimeField) -> Option<(i64, i64)> {
		#[cfg(unix)]
		if let Repr::Native(native) = &self.repr {
			use std::os::unix::fs::MetadataExt;
			let m = &native.meta;
			return Some(match field {
				TimeField::Accessed => (m.atime(), m.atime_nsec()),
				TimeField::Modified => (m.mtime(), m.mtime_nsec()),
				TimeField::Changed => (m.ctime(), m.ctime_nsec()),
			});
		}
		let time = match field {
			TimeField::Accessed => self.accessed(),
			TimeField::Modified => self.modified(),
			TimeField::Changed => self.changed(),
		};
		time.ok().map(split_time)
	}

	/// `st_atime` seconds.
	pub fn atime(&self) -> Option<i64> {
		self.time_parts(TimeField::Accessed).map(|(secs, _)| secs)
	}

	/// `st_atime` nanoseconds.
	pub fn atime_nsec(&self) -> Option<i64> {
		self.time_parts(TimeField::Accessed).map(|(_, nsec)| nsec)
	}

	/// `st_mtime` seconds.
	pub fn mtime(&self) -> Option<i64> {
		self.time_parts(TimeField::Modified).map(|(secs, _)| secs)
	}

	/// `st_mtime` nanoseconds.
	pub fn mtime_nsec(&self) -> Option<i64> {
		self.time_parts(TimeField::Modified).map(|(_, nsec)| nsec)
	}

	/// `st_ctime` seconds.
	pub fn ctime(&self) -> Option<i64> {
		self.time_parts(TimeField::Changed).map(|(secs, _)| secs)
	}

	/// `st_ctime` nanoseconds.
	pub fn ctime_nsec(&self) -> Option<i64> {
		self.time_parts(TimeField::Changed).map(|(_, nsec)| nsec)
	}

	/// Windows `FILE_ATTRIBUTE_*` bits of a host object.
	#[cfg(windows)]
	pub fn file_attributes(&self) -> Option<u32> {
		use std::os::windows::fs::MetadataExt;
		self.native().map(MetadataExt::file_attributes)
	}
}
