//! Paths encountered during a walk.

#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;
use std::{
	cell::OnceCell,
	error::Error,
	ffi::OsStr,
	fmt::{self, Display, Formatter},
	fs::{self, Metadata},
	io::{self, ErrorKind},
	path::{Path, PathBuf},
};

use walkdir::DirEntry;

use super::Follow;

/// Wrapper for a directory entry.
#[derive(Debug)]
enum Entry {
	/// Wraps an explicit path and depth.
	Explicit(PathBuf, usize),
	/// Wraps a WalkDir entry.
	WalkDir(DirEntry),
}

/// File types.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FileType {
	Unknown,
	Fifo,
	CharDevice,
	Directory,
	BlockDevice,
	Regular,
	Symlink,
	Socket,
}

impl FileType {
	pub fn is_dir(self) -> bool {
		self == Self::Directory
	}

	pub fn is_file(self) -> bool {
		self == Self::Regular
	}

	pub fn is_symlink(self) -> bool {
		self == Self::Symlink
	}
}

impl From<fs::FileType> for FileType {
	fn from(t: fs::FileType) -> Self {
		if t.is_dir() {
			return Self::Directory;
		}
		if t.is_file() {
			return Self::Regular;
		}
		if t.is_symlink() {
			return Self::Symlink;
		}

		#[cfg(unix)]
		{
			if t.is_fifo() {
				return Self::Fifo;
			}
			if t.is_char_device() {
				return Self::CharDevice;
			}
			if t.is_block_device() {
				return Self::BlockDevice;
			}
			if t.is_socket() {
				return Self::Socket;
			}
		}

		Self::Unknown
	}
}

/// An error encountered while walking a file system.
#[derive(Clone, Debug)]
pub struct WalkError {
	/// The path that caused the error, if known.
	path:  Option<PathBuf>,
	/// The depth below the root path, if known.
	depth: Option<usize>,
	/// The io::Error::raw_os_error(), if known.
	raw:   Option<i32>,
}

impl WalkError {
	/// Get the path this error occurred on, if known.
	pub fn path(&self) -> Option<&Path> {
		self.path.as_deref()
	}

	/// Get the traversal depth when this error occurred, if known.
	pub fn depth(&self) -> Option<usize> {
		self.depth
	}

	/// Get the kind of I/O error.
	pub fn kind(&self) -> ErrorKind {
		io::Error::from(self).kind()
	}

	/// Check for ErrorKind::{NotFound,NotADirectory}.
	pub fn is_not_found(&self) -> bool {
		if self.kind() == ErrorKind::NotFound {
			return true;
		}

		// NotADirectory is nightly-only
		#[cfg(unix)]
		{
			if self.raw == Some(uucore::libc::ENOTDIR) {
				return true;
			}
		}

		false
	}

	/// Check for ErrorKind::FilesystemLoop.
	pub fn is_loop(&self) -> bool {
		#[cfg(unix)]
		return self.raw == Some(uucore::libc::ELOOP);

		#[cfg(not(unix))]
		return false;
	}
}

impl Display for WalkError {
	fn fmt(&self, f: &mut Formatter<'_>) -> Result<(), fmt::Error> {
		let ioe = io::Error::from(self);
		if let Some(path) = &self.path {
			write!(f, "{}: {}", path.display(), ioe)
		} else {
			write!(f, "{}", ioe)
		}
	}
}

impl Error for WalkError {}

impl From<io::Error> for WalkError {
	fn from(e: io::Error) -> Self {
		Self::from(&e)
	}
}

impl From<&io::Error> for WalkError {
	fn from(e: &io::Error) -> Self {
		Self { path: None, depth: None, raw: e.raw_os_error() }
	}
}

impl From<walkdir::Error> for WalkError {
	fn from(e: walkdir::Error) -> Self {
		Self::from(&e)
	}
}

impl From<&walkdir::Error> for WalkError {
	fn from(e: &walkdir::Error) -> Self {
		Self {
			path:  e.path().map(|p| p.to_owned()),
			depth: Some(e.depth()),
			raw:   e.io_error().and_then(|e| e.raw_os_error()),
		}
	}
}

impl From<WalkError> for io::Error {
	fn from(e: WalkError) -> Self {
		Self::from(&e)
	}
}

impl From<&WalkError> for io::Error {
	fn from(e: &WalkError) -> Self {
		e.raw
			.map(Self::from_raw_os_error)
			.unwrap_or_else(|| ErrorKind::Other.into())
	}
}

/// A path encountered while walking a file system.
#[derive(Debug)]
pub struct WalkEntry {
	/// The wrapped path/dirent.
	inner:   Entry,
	/// Whether to follow symlinks.
	follow:  Follow,
	/// Cached metadata.
	meta:    OnceCell<Result<Metadata, WalkError>>,
	/// Operand-relative path used for display and path-based matching, when it
	/// differs from the real filesystem path. The shell host roots the walk at
	/// a working-directory-resolved (often absolute) path so stat/exec/delete
	/// target the correct files even though the process cwd differs from the
	/// shell cwd; this preserves the operand-prefixed path GNU find prints and
	/// matches against (e.g. `find .` -> `./a`). `None` falls back to `path()`.
	display: Option<PathBuf>,
}

impl WalkEntry {
	/// Create a new WalkEntry for a specific file.
	pub fn new(path: impl Into<PathBuf>, depth: usize, follow: Follow) -> Self {
		Self {
			inner: Entry::Explicit(path.into(), depth),
			follow,
			meta: OnceCell::new(),
			display: None,
		}
	}

	/// Convert a [walkdir::DirEntry] to a [WalkEntry].  Errors due to broken
	/// symbolic links will be converted to valid entries, but other errors will
	/// be propagated.
	pub fn from_walkdir(
		result: walkdir::Result<DirEntry>,
		follow: Follow,
	) -> Result<Self, WalkError> {
		let result = result.map_err(WalkError::from);

		match result {
			Ok(entry) => {
				let ret = if entry.depth() == 0 && follow != Follow::Never {
					// DirEntry::file_type() is wrong for root symlinks when follow_root_links is
					// set
					Self::new(entry.path(), 0, follow)
				} else {
					Self { inner: Entry::WalkDir(entry), follow, meta: OnceCell::new(), display: None }
				};
				Ok(ret)
			},
			Err(e) if e.is_not_found() => {
				// Detect broken symlinks and replace them with explicit entries
				if let (Some(path), Some(depth)) = (e.path(), e.depth())
					&& let Ok(meta) = path.symlink_metadata()
				{
					return Ok(Self {
						inner:   Entry::Explicit(path.into(), depth),
						follow:  Follow::Never,
						meta:    Ok(meta).into(),
						display: None,
					});
				}

				Err(e)
			},
			Err(e) => Err(e),
		}
	}

	/// Get the path to this entry.
	pub fn path(&self) -> &Path {
		match &self.inner {
			Entry::Explicit(path, _) => path.as_path(),
			Entry::WalkDir(ent) => ent.path(),
		}
	}

	/// Get the path to this entry.
	pub fn into_path(self) -> PathBuf {
		match self.inner {
			Entry::Explicit(path, _) => path,
			Entry::WalkDir(ent) => ent.into_path(),
		}
	}

	/// Path used for display (`-print`, `-ls`) and path-based matching
	/// (`-path`, `-regex`, `-printf %p/%h/%P/%H`). Falls back to [`Self::path`]
	/// when no display override was installed (explicit entries, unit tests).
	pub fn display_path(&self) -> &Path {
		self.display.as_deref().unwrap_or_else(|| self.path())
	}

	/// Install an operand-relative display path derived from the original
	/// starting-point `operand` and the `resolved_root` the walk was rooted at.
	/// The real filesystem path is left untouched. When this entry's path is
	/// not under `resolved_root` (e.g. a followed symlink escaping the root)
	/// the override is left unset and display falls back to the real path.
	pub fn set_display_root(&mut self, operand: &Path, resolved_root: &Path) {
		let display = match self.path().strip_prefix(resolved_root) {
			Ok(rel) if rel.as_os_str().is_empty() => operand.to_path_buf(),
			Ok(rel) => operand.join(rel),
			Err(_) => return,
		};
		self.display = Some(display);
	}

	/// Get the name of this entry.
	pub fn file_name(&self) -> &OsStr {
		match &self.inner {
			Entry::Explicit(path, _) => {
				// Path::file_name() only works if the last component is normal
				path
					.components()
					.next_back()
					.map(|c| c.as_os_str())
					.unwrap_or_else(|| path.as_os_str())
			},
			Entry::WalkDir(ent) => ent.file_name(),
		}
	}

	/// Get the depth of this entry below the root.
	pub fn depth(&self) -> usize {
		match &self.inner {
			Entry::Explicit(_, depth) => *depth,
			Entry::WalkDir(ent) => ent.depth(),
		}
	}

	/// Get whether symbolic links are followed for this entry.
	pub fn follow(&self) -> bool {
		self.follow.follow_at_depth(self.depth())
	}

	/// Get the metadata on a cache miss.
	fn get_metadata(&self) -> Result<Metadata, WalkError> {
		self.follow.metadata_at_depth(self.path(), self.depth())
	}

	/// Get the [Metadata] for this entry, following symbolic links if
	/// appropriate. Multiple calls to this function will cache and re-use the
	/// same [Metadata].
	pub fn metadata(&self) -> Result<&Metadata, WalkError> {
		let result = self.meta.get_or_init(|| match &self.inner {
			Entry::Explicit(..) => Ok(self.get_metadata()?),
			Entry::WalkDir(ent) => Ok(ent.metadata()?),
		});
		result.as_ref().map_err(|e| e.clone())
	}

	/// Get the file type of this entry.
	pub fn file_type(&self) -> FileType {
		match &self.inner {
			Entry::Explicit(..) => self
				.metadata()
				.map(|m| m.file_type().into())
				.unwrap_or(FileType::Unknown),
			Entry::WalkDir(ent) => ent.file_type().into(),
		}
	}

	/// Check whether this entry is a symbolic link, regardless of whether links
	/// are being followed.
	pub fn path_is_symlink(&self) -> bool {
		match &self.inner {
			Entry::Explicit(path, _) => {
				if self.follow() {
					path
						.symlink_metadata()
						.is_ok_and(|m| m.file_type().is_symlink())
				} else {
					self.file_type().is_symlink()
				}
			},
			Entry::WalkDir(ent) => ent.path_is_symlink(),
		}
	}
}
