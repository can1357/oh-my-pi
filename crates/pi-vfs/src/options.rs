//! Option structs for opening, directory creation, canonicalization, and
//! temporary files.

use std::ffi::OsString;

/// std-style open options; see [`crate::Fs::open_with`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenOptions {
	read:         bool,
	write:        bool,
	append:       bool,
	truncate:     bool,
	create:       bool,
	create_new:   bool,
	mode:         Option<u32>,
	custom_flags: i32,
}

impl OpenOptions {
	pub fn new() -> Self {
		Self::default()
	}

	pub const fn read(&mut self, read: bool) -> &mut Self {
		self.read = read;
		self
	}

	pub const fn write(&mut self, write: bool) -> &mut Self {
		self.write = write;
		self
	}

	pub const fn append(&mut self, append: bool) -> &mut Self {
		self.append = append;
		self
	}

	pub const fn truncate(&mut self, truncate: bool) -> &mut Self {
		self.truncate = truncate;
		self
	}

	pub const fn create(&mut self, create: bool) -> &mut Self {
		self.create = create;
		self
	}

	/// Atomically fail with `AlreadyExists` if the path exists.
	pub const fn create_new(&mut self, create_new: bool) -> &mut Self {
		self.create_new = create_new;
		self
	}

	/// Creation mode (before umask); default `0o666`.
	pub const fn mode(&mut self, mode: u32) -> &mut Self {
		self.mode = Some(mode);
		self
	}

	/// Extra platform `open` flags (`O_NONBLOCK`, ...). Providers may reject
	/// flags they do not understand.
	pub const fn custom_flags(&mut self, flags: i32) -> &mut Self {
		self.custom_flags = flags;
		self
	}

	pub const fn is_read(&self) -> bool {
		self.read
	}

	pub const fn is_write(&self) -> bool {
		self.write
	}

	pub const fn is_append(&self) -> bool {
		self.append
	}

	pub const fn is_truncate(&self) -> bool {
		self.truncate
	}

	pub const fn is_create(&self) -> bool {
		self.create
	}

	pub const fn is_create_new(&self) -> bool {
		self.create_new
	}

	pub const fn get_mode(&self) -> Option<u32> {
		self.mode
	}

	pub const fn get_custom_flags(&self) -> i32 {
		self.custom_flags
	}

	/// Whether the open may modify file contents.
	pub const fn is_writable(&self) -> bool {
		self.write || self.append
	}

	pub(crate) fn to_std(&self) -> std::fs::OpenOptions {
		let mut options = std::fs::OpenOptions::new();
		options
			.read(self.read)
			.write(self.write)
			.append(self.append)
			.truncate(self.truncate)
			.create(self.create)
			.create_new(self.create_new);
		#[cfg(unix)]
		{
			use std::os::unix::fs::OpenOptionsExt;
			if let Some(mode) = self.mode {
				options.mode(mode);
			}
			options.custom_flags(self.custom_flags);
		}
		#[cfg(windows)]
		{
			use std::os::windows::fs::OpenOptionsExt;
			options.custom_flags(self.custom_flags as u32);
			// POSIX creation mode without any write bit: the new file is read-only.
			if self.mode.is_some_and(|mode| mode & 0o222 == 0) {
				options.attributes(windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_READONLY);
			}
		}
		options
	}
}

/// Directory creation options; see [`crate::Fs::create_dir_with`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DirOptions {
	recursive: bool,
	mode:      Option<u32>,
}

impl DirOptions {
	pub const fn new() -> Self {
		Self { recursive: false, mode: None }
	}

	/// Create missing parents; an existing directory is not an error.
	pub const fn recursive(mut self, recursive: bool) -> Self {
		self.recursive = recursive;
		self
	}

	/// Creation mode (before umask); default `0o777`. Ignored on Windows.
	pub const fn mode(mut self, mode: u32) -> Self {
		self.mode = Some(mode);
		self
	}

	pub const fn is_recursive(&self) -> bool {
		self.recursive
	}

	pub const fn get_mode(&self) -> Option<u32> {
		self.mode
	}
}

/// How missing components are handled by [`crate::Fs::canonicalize_with`]
/// (uucore `MissingHandling`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MissingHandling {
	/// Every component but the last must exist (`realpath -E`).
	Normal,
	/// Every component must exist (`realpath -e`, `readlink -e`).
	Existing,
	/// No component needs to exist (`realpath -m`, `readlink -m`).
	Missing,
}

/// When symbolic links are resolved (uucore `ResolveMode`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ResolveMode {
	/// Never; purely lexical.
	None,
	/// As encountered (`..` applies to the resolved path).
	Physical,
	/// After resolving `..` lexically.
	Logical,
}

/// Options for [`crate::Fs::canonicalize_with`]; the default (all
/// components must exist, symlinks resolved physically) matches
/// `std::fs::canonicalize`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CanonicalizeOptions {
	pub missing: MissingHandling,
	pub resolve: ResolveMode,
}

impl CanonicalizeOptions {
	pub const fn new(missing: MissingHandling, resolve: ResolveMode) -> Self {
		Self { missing, resolve }
	}
}

impl Default for CanonicalizeOptions {
	fn default() -> Self {
		Self::new(MissingHandling::Existing, ResolveMode::Physical)
	}
}

/// Temporary file/directory naming; see [`crate::Fs::create_temp`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TempOptions {
	prefix:     OsString,
	suffix:     OsString,
	random_len: usize,
	mode:       Option<u32>,
}

impl Default for TempOptions {
	fn default() -> Self {
		Self {
			prefix:     ".tmp".into(),
			suffix:     OsString::new(),
			random_len: 6,
			mode:       None,
		}
	}
}

impl TempOptions {
	pub fn new() -> Self {
		Self::default()
	}

	pub fn prefix(mut self, prefix: impl Into<OsString>) -> Self {
		self.prefix = prefix.into();
		self
	}

	pub fn suffix(mut self, suffix: impl Into<OsString>) -> Self {
		self.suffix = suffix.into();
		self
	}

	/// Number of random characters; `0` creates exactly `prefix + suffix`
	/// without retrying.
	pub const fn random_len(mut self, len: usize) -> Self {
		self.random_len = len;
		self
	}

	/// Creation mode before umask; default `0o600` for files, `0o700` for
	/// directories.
	pub const fn mode(mut self, mode: u32) -> Self {
		self.mode = Some(mode);
		self
	}

	pub const fn get_mode(&self) -> Option<u32> {
		self.mode
	}

	pub const fn get_random_len(&self) -> usize {
		self.random_len
	}

	pub(crate) fn name(&self, random: &str) -> OsString {
		let mut name = self.prefix.clone();
		name.push(random);
		name.push(&self.suffix);
		name
	}
}
