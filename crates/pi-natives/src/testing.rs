//! Test-only helpers shared across `pi-natives` unit tests.
//!
//! Any state exposed here MUST be gated on `#[cfg(test)]` — it does not ship
//! in release builds.

use std::{
	collections::BTreeMap,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::{Arc, Mutex, MutexGuard},
};

use async_trait::async_trait;
use pi_vfs::{
	BlockingFs, DirEntry, File, FileHandle, FileKind, FileSystem, FileType, Fs, Metadata,
	OpenOptions, Permissions, ReadDir,
};

/// Global mutex serializing tests that mutate the process-wide
/// [`std::panic`] hook.
///
/// [`std::panic::set_hook`] / [`take_hook`](std::panic::take_hook) act on a
/// single hook shared by every thread in the process. The default Rust test
/// harness runs tests in parallel, so two tests calling
/// `take_hook` + `set_hook(noop)` on their own threads can interleave: the
/// second `take_hook` captures the first test's noop, and when the drops run
/// in the opposite order the noop is restored as the global hook — silently
/// muting crash diagnostics for every later test in the crate. Serializing
/// the whole take → set → run → restore window across every hook-mutating
/// test in this crate eliminates that race.
///
/// [`take_hook`]: std::panic::take_hook
static PANIC_HOOK_MUTEX: Mutex<()> = Mutex::new(());

/// Acquire the process-global panic-hook lock. Hold the returned guard for the
/// entire take → set → run → restore window.
///
/// Recovers from mutex poisoning (a prior test panicked while holding the
/// lock) so a single failing test does not cascade into every later test
/// panicking on `Mutex::lock`.
pub fn lock_panic_hook() -> MutexGuard<'static, ()> {
	PANIC_HOOK_MUTEX
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Boxed panic hook signature, factored out so the [`SilenceHook`] wrapper
/// stays readable — matches [`std::panic::take_hook`]'s return type.
type PanicHook = Box<dyn Fn(&std::panic::PanicHookInfo<'_>) + Sync + Send + 'static>;

/// Suppress the global panic hook for the guard's lifetime, so injected panic
/// tests don't dump backtraces (or persist crash reports) onto the test run.
///
/// [`std::panic::set_hook`] is process-global, so `SilenceHook` holds
/// [`lock_panic_hook`] for the entire take → set → run → restore window.
/// Without that lock, two parallel tests could interleave their hook swaps and
/// permanently install the noop hook, muting crash diagnostics for every later
/// test in the crate.
pub struct SilenceHook {
	prev:   Option<PanicHook>,
	_guard: MutexGuard<'static, ()>,
}

impl SilenceHook {
	#[allow(clippy::new_without_default, reason = "Default acquiring a global lock would surprise")]
	pub fn new() -> Self {
		let guard = lock_panic_hook();
		let prev = std::panic::take_hook();
		std::panic::set_hook(Box::new(|_| {}));
		Self { prev: Some(prev), _guard: guard }
	}
}

impl Drop for SilenceHook {
	fn drop(&mut self) {
		if let Some(prev) = self.prev.take() {
			std::panic::set_hook(prev);
		}
	}
}

/// One node of a [`MemFs`] tree.
#[derive(Debug)]
enum MemNode {
	Dir,
	File(Arc<parking_lot::Mutex<Vec<u8>>>),
}

/// In-memory `mem://` provider, so search code runs through a non-native
/// [`BlockingFs`] with URL roots. Every operation completes immediately.
#[derive(Debug)]
pub struct MemFs {
	nodes: parking_lot::Mutex<BTreeMap<PathBuf, MemNode>>,
}

impl MemFs {
	/// A tree holding `files` (URL path, contents), every ancestor directory
	/// up to `mem://` included, and a blocking facade over it.
	pub fn with_files(files: &[(&str, &str)]) -> (Arc<Self>, BlockingFs) {
		let mut nodes = BTreeMap::new();
		for &(path, contents) in files {
			let path = Path::new(path);
			let mut dir = pi_vfs::parent_path(path);
			while let Some(parent) = dir {
				nodes.insert(parent.to_path_buf(), MemNode::Dir);
				dir = pi_vfs::parent_path(parent);
			}
			nodes.insert(
				path.to_path_buf(),
				MemNode::File(Arc::new(parking_lot::Mutex::new(contents.as_bytes().to_vec()))),
			);
		}
		let mem = Arc::new(Self { nodes: parking_lot::Mutex::new(nodes) });
		let provider: Arc<dyn FileSystem> = mem.clone();
		(mem, Fs::new(provider).blocking())
	}

	/// Current contents of the file at `path`, if it is one.
	pub fn contents(&self, path: &str) -> Option<String> {
		match self.nodes.lock().get(Path::new(path))? {
			MemNode::File(data) => Some(String::from_utf8_lossy(&data.lock()).into_owned()),
			MemNode::Dir => None,
		}
	}
}

fn mem_metadata(kind: FileKind, len: u64) -> Metadata {
	Metadata::new(FileType::from_kind(kind), len, Permissions::from_mode(0o644))
}

/// Open [`MemFs`] file: shared contents plus this handle's cursor.
#[derive(Debug)]
struct MemHandle {
	data: Arc<parking_lot::Mutex<Vec<u8>>>,
	pos:  parking_lot::Mutex<u64>,
}

#[async_trait]
impl FileHandle for MemHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		let data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = usize::try_from(*pos).map_or(data.len(), |pos| pos.min(data.len()));
		let n = buf.len().min(data.len() - start);
		buf[..n].copy_from_slice(&data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		let mut data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = usize::try_from(*pos).map_err(|_| pi_vfs::invalid_argument())?;
		if data.len() < start + buf.len() {
			data.resize(start + buf.len(), 0);
		}
		data[start..start + buf.len()].copy_from_slice(buf);
		*pos += buf.len() as u64;
		Ok(buf.len())
	}

	async fn seek(&self, seek: SeekFrom) -> io::Result<u64> {
		let len = self.data.lock().len() as i64;
		let mut pos = self.pos.lock();
		let next = match seek {
			SeekFrom::Start(n) => i64::try_from(n).map_err(|_| pi_vfs::invalid_argument())?,
			SeekFrom::End(n) => len + n,
			SeekFrom::Current(n) => *pos as i64 + n,
		};
		*pos = u64::try_from(next).map_err(|_| pi_vfs::invalid_argument())?;
		Ok(*pos)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		Ok(mem_metadata(FileKind::File, self.data.lock().len() as u64))
	}
}

#[async_trait]
impl FileSystem for MemFs {
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		let mut nodes = self.nodes.lock();
		let data = match nodes.get(path) {
			Some(MemNode::Dir) => return Err(pi_vfs::is_a_directory()),
			Some(MemNode::File(data)) => Arc::clone(data),
			None if options.is_create() || options.is_create_new() => {
				let parent = pi_vfs::parent_path(path).ok_or(io::ErrorKind::NotFound)?;
				if !matches!(nodes.get(parent), Some(MemNode::Dir)) {
					return Err(io::ErrorKind::NotFound.into());
				}
				let data = Arc::new(parking_lot::Mutex::new(Vec::new()));
				nodes.insert(path.to_path_buf(), MemNode::File(Arc::clone(&data)));
				data
			},
			None => return Err(io::ErrorKind::NotFound.into()),
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		Ok(File::from_handle(MemHandle { data, pos: parking_lot::Mutex::new(0) }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		match self.nodes.lock().get(path).ok_or(io::ErrorKind::NotFound)? {
			MemNode::Dir => Ok(mem_metadata(FileKind::Dir, 0)),
			MemNode::File(data) => Ok(mem_metadata(FileKind::File, data.lock().len() as u64)),
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		let nodes = self.nodes.lock();
		match nodes.get(path) {
			Some(MemNode::Dir) => {},
			Some(MemNode::File(_)) => return Err(pi_vfs::not_a_directory()),
			None => return Err(io::ErrorKind::NotFound.into()),
		}
		let entries: Vec<_> = nodes
			.iter()
			.filter(|(child, _)| child.as_path() != path && pi_vfs::parent_path(child) == Some(path))
			.map(|(child, node)| {
				let kind = match node {
					MemNode::Dir => FileKind::Dir,
					MemNode::File(_) => FileKind::File,
				};
				let name = pi_vfs::file_name(child)
					.map(|name| name.into_owned())
					.unwrap_or_default();
				Ok(DirEntry::new(child.clone(), name, Some(FileType::from_kind(kind))))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}
}
