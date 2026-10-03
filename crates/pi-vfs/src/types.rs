//! Small value types shared by the facades and providers.

use std::{
	fmt,
	hash::{Hash, Hasher},
	time::SystemTime,
};

const S_IFMT: u32 = 0o170000;
const S_IFSOCK: u32 = 0o140000;
const S_IFLNK: u32 = 0o120000;
const S_IFREG: u32 = 0o100000;
const S_IFBLK: u32 = 0o060000;
const S_IFDIR: u32 = 0o040000;
const S_IFCHR: u32 = 0o020000;
const S_IFIFO: u32 = 0o010000;

/// Kind of filesystem object.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FileKind {
	File,
	Dir,
	Symlink,
	Fifo,
	Socket,
	CharDevice,
	BlockDevice,
	Unknown,
}

impl FileKind {
	/// Decodes the `S_IFMT` bits of a Unix mode.
	pub const fn from_mode(mode: u32) -> Self {
		match mode & S_IFMT {
			S_IFREG => Self::File,
			S_IFDIR => Self::Dir,
			S_IFLNK => Self::Symlink,
			S_IFIFO => Self::Fifo,
			S_IFSOCK => Self::Socket,
			S_IFCHR => Self::CharDevice,
			S_IFBLK => Self::BlockDevice,
			_ => Self::Unknown,
		}
	}

	/// The `S_IFMT` bits for this kind (`0` for [`FileKind::Unknown`]).
	pub const fn mode_bits(self) -> u32 {
		match self {
			Self::File => S_IFREG,
			Self::Dir => S_IFDIR,
			Self::Symlink => S_IFLNK,
			Self::Fifo => S_IFIFO,
			Self::Socket => S_IFSOCK,
			Self::CharDevice => S_IFCHR,
			Self::BlockDevice => S_IFBLK,
			Self::Unknown => 0,
		}
	}
}

/// Type of a filesystem object; host values keep the original
/// [`std::fs::FileType`].
#[derive(Clone, Copy)]
pub struct FileType {
	kind:   FileKind,
	native: Option<std::fs::FileType>,
}

impl FileType {
	/// Provider constructor.
	pub const fn from_kind(kind: FileKind) -> Self {
		Self { kind, native: None }
	}

	/// Provider constructor from the `S_IFMT` bits of a Unix mode.
	pub const fn from_mode(mode: u32) -> Self {
		Self::from_kind(FileKind::from_mode(mode))
	}

	pub const fn kind(&self) -> FileKind {
		self.kind
	}

	/// The host file type, when this describes a host object.
	pub const fn native(&self) -> Option<std::fs::FileType> {
		self.native
	}

	/// The `S_IFMT` bits for this type.
	pub const fn mode_bits(&self) -> u32 {
		self.kind.mode_bits()
	}

	pub fn is_file(&self) -> bool {
		self.kind == FileKind::File
	}

	pub fn is_dir(&self) -> bool {
		self.kind == FileKind::Dir
	}

	pub fn is_symlink(&self) -> bool {
		self.kind == FileKind::Symlink
	}

	pub fn is_fifo(&self) -> bool {
		self.kind == FileKind::Fifo
	}

	pub fn is_socket(&self) -> bool {
		self.kind == FileKind::Socket
	}

	pub fn is_char_device(&self) -> bool {
		self.kind == FileKind::CharDevice
	}

	pub fn is_block_device(&self) -> bool {
		self.kind == FileKind::BlockDevice
	}

	/// Windows directory symlink (or junction); `false` for provider types.
	#[cfg(windows)]
	pub fn is_symlink_dir(&self) -> bool {
		use std::os::windows::fs::FileTypeExt;
		self.native.is_some_and(|native| native.is_symlink_dir())
	}

	/// Windows file symlink; provider symlinks count as file symlinks.
	#[cfg(windows)]
	pub fn is_symlink_file(&self) -> bool {
		use std::os::windows::fs::FileTypeExt;
		match self.native {
			Some(native) => native.is_symlink_file(),
			None => self.is_symlink(),
		}
	}
}

impl From<std::fs::FileType> for FileType {
	fn from(native: std::fs::FileType) -> Self {
		#[cfg(unix)]
		let kind = {
			use std::os::unix::fs::FileTypeExt;
			if native.is_file() {
				FileKind::File
			} else if native.is_dir() {
				FileKind::Dir
			} else if native.is_symlink() {
				FileKind::Symlink
			} else if native.is_fifo() {
				FileKind::Fifo
			} else if native.is_socket() {
				FileKind::Socket
			} else if native.is_char_device() {
				FileKind::CharDevice
			} else if native.is_block_device() {
				FileKind::BlockDevice
			} else {
				FileKind::Unknown
			}
		};
		#[cfg(not(unix))]
		let kind = if native.is_symlink() {
			FileKind::Symlink
		} else if native.is_dir() {
			FileKind::Dir
		} else if native.is_file() {
			FileKind::File
		} else {
			FileKind::Unknown
		};
		Self { kind, native: Some(native) }
	}
}

impl PartialEq for FileType {
	fn eq(&self, other: &Self) -> bool {
		self.kind == other.kind
	}
}

impl Eq for FileType {}

impl Hash for FileType {
	fn hash<H: Hasher>(&self, state: &mut H) {
		self.kind.hash(state);
	}
}

impl fmt::Debug for FileType {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("FileType").field(&self.kind).finish()
	}
}

/// Permission bits (`0o7777`), with std's `readonly` semantics on top.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Permissions {
	mode: u32,
}

impl Permissions {
	/// Keeps the permission bits (`0o7777`) of `mode`.
	pub const fn from_mode(mode: u32) -> Self {
		Self { mode: mode & 0o7777 }
	}

	pub const fn mode(&self) -> u32 {
		self.mode
	}

	pub const fn set_mode(&mut self, mode: u32) {
		self.mode = mode & 0o7777;
	}

	/// No write bit is set.
	pub const fn readonly(&self) -> bool {
		self.mode & 0o222 == 0
	}

	/// Clears all write bits, or sets all of them (std's Unix semantics).
	pub const fn set_readonly(&mut self, readonly: bool) {
		if readonly {
			self.mode &= !0o222;
		} else {
			self.mode |= 0o222;
		}
	}
}

impl From<std::fs::Permissions> for Permissions {
	fn from(native: std::fs::Permissions) -> Self {
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			Self::from_mode(native.mode())
		}
		#[cfg(not(unix))]
		{
			// Windows exposes only the read-only attribute; this matches uucore's
			// rendering of host permissions there.
			Self::from_mode(if native.readonly() { 0o555 } else { 0o777 })
		}
	}
}

/// File identity: device + inode (Windows: volume serial + file index).
///
/// Host identities and provider identities live in separate namespaces so an
/// arbitrary provider inode can never alias a host file; providers that report
/// a real host identity (for example a backing file's OS stat) use
/// [`FileId::native`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileId {
	dev:    u64,
	ino:    u64,
	native: bool,
}

impl FileId {
	/// Identity in the provider namespace.
	pub const fn new(dev: u64, ino: u64) -> Self {
		Self { dev, ino, native: false }
	}

	/// Identity of a real host filesystem object.
	pub const fn native(dev: u64, ino: u64) -> Self {
		Self { dev, ino, native: true }
	}

	pub const fn dev(&self) -> u64 {
		self.dev
	}

	pub const fn ino(&self) -> u64 {
		self.ino
	}

	pub const fn is_native(&self) -> bool {
		self.native
	}
}

/// A timestamp update: leave it, set it to the filesystem's current time
/// (`UTIME_NOW`, which also works for writable files the caller does not
/// own), or set an explicit time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FileTime {
	#[default]
	Omit,
	Now,
	At(SystemTime),
}

impl From<SystemTime> for FileTime {
	fn from(time: SystemTime) -> Self {
		Self::At(time)
	}
}

impl From<Option<SystemTime>> for FileTime {
	fn from(time: Option<SystemTime>) -> Self {
		time.map_or(Self::Omit, Self::At)
	}
}

/// Filesystem statistics (`statfs`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatFs {
	/// `f_type` magic number, where the platform has one.
	pub fs_type:          Option<i64>,
	/// Filesystem type name (`apfs`, `ext4`, `NTFS`, ...), when known.
	pub fs_type_name:     Option<String>,
	/// `f_bsize`.
	pub block_size:       u64,
	/// Optimal transfer size: Linux `f_frsize`, Apple `f_iosize`, Windows
	/// cluster size.
	pub io_size:          u64,
	pub blocks:           u64,
	pub blocks_free:      u64,
	pub blocks_available: u64,
	pub files:            u64,
	pub files_free:       u64,
	pub fsid:             Option<u64>,
	pub name_max:         Option<u64>,
}

/// Node kinds for [`crate::BlockingFs::make_node`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NodeKind {
	Regular,
	Fifo,
	Socket,
	CharDevice(u64),
	BlockDevice(u64),
}

/// Symbolic link flavour; only Windows distinguishes file and directory
/// links. `Auto` inspects the target (resolved relative to the link).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SymlinkKind {
	#[default]
	Auto,
	File,
	Dir,
}
