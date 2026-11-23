//! Reporting which host text files a unit of work changed.
//!
//! A [`ChangeSink`] installed on a facade ([`crate::Fs::with_change_sink`])
//! learns of changes one scope at a time. A scope is the work of one command:
//! [`crate::Fs::begin_changes`] returns a view that remembers, for every host
//! file about to be created, written, renamed or removed through it, what the
//! file held. When the view and its clones are gone the scope reads those
//! files again and reports the ones that differ. [`crate::Fs::changing`] is
//! a scope of one path, for a change made outside any view.
//!
//! A file created and removed within one scope (a temporary file renamed over
//! its target) is never reported, and neither is anything a scope did not
//! change itself: what other processes write is seen only where it lands in a
//! file the scope touched, between the touch and the scope's end.
//!
//! Only regular files holding at most [`MAX_FILE_BYTES`] of text are compared.
//! Binary files, larger files, symlinks and special files are left out, as is
//! everything past [`MAX_SCOPE_FILES`] files or [`MAX_SCOPE_BYTES`] of earlier
//! content in one scope.

use std::{
	collections::HashSet,
	fmt, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use parking_lot::Mutex;

/// Largest file a scope compares.
const MAX_FILE_BYTES: u64 = 4 << 20;
/// Most paths one scope remembers.
const MAX_SCOPE_FILES: usize = 1024;
/// Most bytes of earlier content one scope holds.
const MAX_SCOPE_BYTES: usize = 32 << 20;
/// Leading bytes searched for a NUL, which marks a file as binary.
const BINARY_SNIFF_BYTES: usize = 8192;

/// Receives the host text files that units of work changed, each with its
/// content before and after; installed with [`crate::Fs::with_change_sink`].
///
/// A unit of work is a [`crate::Fs::begin_changes`] view or a
/// [`crate::Fs::changing`] guard. Its changes arrive when it ends, net of
/// what it undid itself: a temporary file it created and renamed away is
/// never reported. Binary files, files over 4 MiB, symlinks and special files
/// are left out.
pub trait ChangeSink: Send + Sync {
	/// Whether changes of host `path` are wanted. A refused path is never
	/// read. Called before the path changes, possibly more than once.
	fn wants(&self, path: &Path) -> bool;

	/// `path` held `before` when its scope first touched it and holds `after`
	/// now that the scope has ended; `None` where there was no file.
	fn changed(&self, path: PathBuf, before: Option<Vec<u8>>, after: Option<Vec<u8>>);
}

/// What a path names at one moment.
#[derive(PartialEq, Eq)]
enum State {
	Absent,
	Text(Vec<u8>),
	Directory,
	/// Anything that is not compared: binary or oversized content, a symlink,
	/// a special file, a path that cannot be read.
	Opaque,
}

impl State {
	/// The state of `path`, reading at most `budget` bytes of content.
	fn of(path: &Path, budget: u64) -> Self {
		let meta = match std::fs::symlink_metadata(path) {
			Ok(meta) => meta,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Self::Absent,
			Err(_) => return Self::Opaque,
		};
		if meta.is_dir() {
			return Self::Directory;
		}
		if !meta.is_file() || meta.len() > MAX_FILE_BYTES.min(budget) {
			return Self::Opaque;
		}
		match std::fs::read(path) {
			Ok(bytes) if !bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) => {
				Self::Text(bytes)
			},
			_ => Self::Opaque,
		}
	}

	fn into_content(self) -> Option<Vec<u8>> {
		match self {
			Self::Text(bytes) => Some(bytes),
			Self::Absent | Self::Directory | Self::Opaque => None,
		}
	}
}

/// Regular files below `dir`, at most `limit` of them; symlinks are not
/// followed and unreadable directories are skipped.
fn files_below(dir: &Path, limit: usize) -> Vec<PathBuf> {
	let mut files = Vec::new();
	let mut pending = vec![dir.to_path_buf()];
	while let Some(dir) = pending.pop() {
		let Ok(entries) = std::fs::read_dir(&dir) else {
			continue;
		};
		for entry in entries.flatten() {
			let Ok(kind) = entry.file_type() else {
				continue;
			};
			if kind.is_dir() {
				pending.push(entry.path());
			} else if kind.is_file() {
				if files.len() == limit {
					return files;
				}
				files.push(entry.path());
			}
		}
	}
	files
}

#[derive(Default)]
struct Touched {
	/// Every remembered path with what it held, in the order first touched.
	paths: Vec<(PathBuf, State)>,
	seen:  HashSet<PathBuf>,
	/// Bytes of content held in `paths`.
	bytes: usize,
}

impl Touched {
	/// Remembers what `path` holds unless it is already remembered, refused
	/// by `sink`, or past the scope's limits. Returns what it holds.
	fn remember(&mut self, path: &Path, sink: &dyn ChangeSink) -> Option<&State> {
		if self.paths.len() >= MAX_SCOPE_FILES || self.seen.contains(path) || !sink.wants(path) {
			return None;
		}
		let state = State::of(path, (MAX_SCOPE_BYTES - self.bytes) as u64);
		if let State::Text(bytes) = &state {
			self.bytes += bytes.len();
		}
		self.seen.insert(path.to_path_buf());
		let (_, state) = self.paths.push_mut((path.to_path_buf(), state));
		Some(state)
	}
}

/// The host files one unit of work is about to change; reports the ones that
/// did change to its sink when dropped.
pub(crate) struct ChangeScope {
	sink:    Arc<dyn ChangeSink>,
	touched: Mutex<Touched>,
}

impl ChangeScope {
	pub(crate) fn new(sink: Arc<dyn ChangeSink>) -> Self {
		Self { sink, touched: Mutex::default() }
	}

	/// Remembers what host `path` holds before it changes; for a directory,
	/// what every file below it holds (it is about to be removed or renamed).
	pub(crate) fn touch(&self, path: &Path) {
		let mut touched = self.touched.lock();
		if !matches!(touched.remember(path, &*self.sink), Some(State::Directory)) {
			return;
		}
		for file in files_below(path, MAX_SCOPE_FILES) {
			touched.remember(&file, &*self.sink);
		}
	}
}

impl Drop for ChangeScope {
	fn drop(&mut self) {
		let Touched { paths, seen, .. } = std::mem::take(self.touched.get_mut());
		for (path, before) in paths {
			match (before, State::of(&path, MAX_FILE_BYTES)) {
				(State::Opaque | State::Directory, _) | (_, State::Opaque) => {},
				// A directory renamed or copied into place: its files are new.
				(State::Absent, State::Directory) => {
					for file in files_below(&path, MAX_SCOPE_FILES) {
						if seen.contains(&file) || !self.sink.wants(&file) {
							continue;
						}
						if let State::Text(after) = State::of(&file, MAX_FILE_BYTES) {
							self.sink.changed(file, None, Some(after));
						}
					}
				},
				(before, after) if before == after => {},
				(before, after) => self
					.sink
					.changed(path, before.into_content(), after.into_content()),
			}
		}
	}
}

/// Reports what became of one host path once it and its clones are dropped;
/// see [`crate::Fs::changing`].
#[derive(Clone)]
pub struct ChangeGuard {
	_scope: Arc<ChangeScope>,
}

/// Change reporting of a facade view: the installed sink, and the scope that
/// remembers what the view is about to change.
#[derive(Clone, Default)]
pub(crate) struct Changes {
	sink:  Option<Arc<dyn ChangeSink>>,
	scope: Option<Arc<ChangeScope>>,
}

impl fmt::Debug for Changes {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("Changes")
			.field("sink", &self.sink.is_some())
			.field("scope", &self.scope.is_some())
			.finish()
	}
}

impl Changes {
	/// Reports to `sink`, with no scope begun.
	pub(crate) fn to(sink: Arc<dyn ChangeSink>) -> Self {
		Self { sink: Some(sink), scope: None }
	}

	/// The same sink with a fresh scope; nothing without a sink.
	pub(crate) fn begin(&self) -> Self {
		Self {
			sink:  self.sink.clone(),
			scope: self
				.sink
				.as_ref()
				.map(|sink| Arc::new(ChangeScope::new(Arc::clone(sink)))),
		}
	}

	/// See [`ChangeScope::touch`]; nothing without a scope.
	pub(crate) fn touch(&self, path: &Path) {
		if let Some(scope) = &self.scope {
			scope.touch(path);
		}
	}

	/// A scope of its own that has touched host `path`; `None` without a sink
	/// or when the sink refuses the path.
	pub(crate) fn guard(&self, path: &Path) -> Option<ChangeGuard> {
		let scope = ChangeScope::new(Arc::clone(self.sink.as_ref()?));
		scope.touch(path);
		let remembered = !scope.touched.lock().paths.is_empty();
		remembered.then(|| ChangeGuard { _scope: Arc::new(scope) })
	}
}
