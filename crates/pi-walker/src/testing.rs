//! Test-only in-memory `mem://` provider, so walks and searches run through a
//! non-native [`Fs`] with URL roots.

use std::{
	collections::BTreeMap,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime},
};

use async_trait::async_trait;
use parking_lot::Mutex;
use pi_vfs::{
	DirEntry, File, FileHandle, FileKind, FileSystem, FileType, Fs, Metadata, OpenOptions,
	Permissions, ReadDir,
};

/// Device number every [`MemFs`] identity carries.
const MEM_DEV: u64 = 7;

/// Symlink hops before resolution fails, like `ELOOP`.
const MAX_HOPS: usize = 40;

#[derive(Debug)]
enum Kind {
	Dir,
	File(Arc<Mutex<Vec<u8>>>),
	/// Absolute URL target.
	Symlink(PathBuf),
	Fifo,
}

#[derive(Debug)]
struct Node {
	kind:  Kind,
	ino:   u64,
	mtime: u64,
}

#[derive(Debug, Default)]
struct Tree {
	nodes: BTreeMap<PathBuf, Node>,
	clock: u64,
}

impl Tree {
	fn tick(&mut self) -> u64 {
		self.clock += 1;
		self.clock
	}

	/// Inserts `path` (replacing any node there) after creating its missing
	/// ancestors, and bumps the parent directory's mtime.
	fn insert(&mut self, path: &Path, kind: Kind) {
		if let Some(parent) = pi_vfs::parent_path(path) {
			if !matches!(self.nodes.get(parent), Some(Node { kind: Kind::Dir, .. })) {
				self.insert(parent, Kind::Dir);
			}
			let now = self.tick();
			if let Some(node) = self.nodes.get_mut(parent) {
				node.mtime = now;
			}
		}
		let now = self.tick();
		self
			.nodes
			.insert(path.to_path_buf(), Node { kind, ino: now, mtime: now });
	}

	/// The stored spelling `path` resolves to: every ancestor symlink is
	/// followed, the final component only when `follow`.
	fn resolve(&self, path: &Path, follow: bool, hops: &mut usize) -> io::Result<PathBuf> {
		let real = match pi_vfs::parent_path(path) {
			Some(parent) => {
				let parent = self.resolve(parent, true, hops)?;
				let bytes = path.as_os_str().as_encoded_bytes();
				let trimmed = bytes.strip_suffix(b"/").unwrap_or(bytes);
				let start = trimmed
					.iter()
					.rposition(|&b| b == b'/')
					.map_or(0, |i| i + 1);
				let segment =
					std::str::from_utf8(&trimmed[start..]).map_err(|_| io::ErrorKind::InvalidInput)?;
				let parent = parent.to_str().ok_or(io::ErrorKind::InvalidInput)?;
				let sep = if parent.ends_with('/') { "" } else { "/" };
				PathBuf::from(format!("{parent}{sep}{segment}"))
			},
			None => path.to_path_buf(),
		};
		match self.nodes.get(&real) {
			Some(Node { kind: Kind::Symlink(target), .. }) if follow => {
				*hops += 1;
				if *hops > MAX_HOPS {
					return Err(io::Error::other("too many levels of symbolic links"));
				}
				let target = target.clone();
				self.resolve(&target, true, hops)
			},
			Some(_) => Ok(real),
			None if pi_vfs::parent_path(&real).is_none() => Ok(real),
			None => Err(io::ErrorKind::NotFound.into()),
		}
	}

	fn lookup(&self, path: &Path, follow: bool) -> io::Result<(PathBuf, &Node)> {
		let real = self.resolve(path, follow, &mut 0)?;
		let node = self.nodes.get(&real).ok_or(io::ErrorKind::NotFound)?;
		Ok((real, node))
	}
}

fn metadata_of(node: &Node) -> Metadata {
	let (kind, len) = match &node.kind {
		Kind::Dir => (FileKind::Dir, 0),
		Kind::File(data) => (FileKind::File, data.lock().len() as u64),
		Kind::Symlink(target) => (FileKind::Symlink, target.as_os_str().len() as u64),
		Kind::Fifo => (FileKind::Fifo, 0),
	};
	Metadata::new(FileType::from_kind(kind), len, Permissions::from_mode(0o644))
		.with_id(MEM_DEV, node.ino)
		.with_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(node.mtime))
}

/// In-memory `mem://` provider: files, directories, symlinks (absolute URL
/// targets, followed by `metadata`/`open`), and FIFOs. Paths are stored as
/// spelled (percent-encoded segments); every operation completes immediately.
#[derive(Debug, Default)]
pub struct MemFs {
	tree: Mutex<Tree>,
}

impl MemFs {
	/// A tree holding `files` (URL path, contents) with every ancestor
	/// directory, and an async facade over it.
	pub fn with_files(files: &[(&str, &str)]) -> (Arc<Self>, Fs) {
		let mem = Arc::new(Self::default());
		for &(path, contents) in files {
			mem.add_file(path, contents.as_bytes());
		}
		let provider: Arc<dyn FileSystem> = mem.clone();
		(mem, Fs::new(provider))
	}

	/// Creates or replaces the file at `path` (and missing ancestors).
	pub fn add_file(&self, path: &str, contents: &[u8]) {
		self
			.tree
			.lock()
			.insert(Path::new(path), Kind::File(Arc::new(Mutex::new(contents.to_vec()))));
	}

	/// Creates the directory at `path` (and missing ancestors).
	pub fn add_dir(&self, path: &str) {
		self.tree.lock().insert(Path::new(path), Kind::Dir);
	}

	/// Creates a symlink at `path` pointing at the absolute URL `target`.
	pub fn add_symlink(&self, path: &str, target: &str) {
		self
			.tree
			.lock()
			.insert(Path::new(path), Kind::Symlink(PathBuf::from(target)));
	}

	/// Creates a FIFO at `path`; it has no contents and cannot be opened.
	pub fn add_fifo(&self, path: &str) {
		self.tree.lock().insert(Path::new(path), Kind::Fifo);
	}
}

/// Open [`MemFs`] file: shared contents plus this handle's cursor.
#[derive(Debug)]
struct MemHandle {
	data:  Arc<Mutex<Vec<u8>>>,
	pos:   Mutex<u64>,
	ino:   u64,
	mtime: u64,
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
		let node =
			Node { kind: Kind::File(Arc::clone(&self.data)), ino: self.ino, mtime: self.mtime };
		Ok(metadata_of(&node))
	}
}

#[async_trait]
impl FileSystem for MemFs {
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		let mut tree = self.tree.lock();
		let (data, ino, mtime) = match tree.lookup(path, true) {
			Ok((_, node)) => match &node.kind {
				Kind::Dir => return Err(pi_vfs::is_a_directory()),
				Kind::File(data) => (Arc::clone(data), node.ino, node.mtime),
				Kind::Symlink(_) | Kind::Fifo => return Err(pi_vfs::unsupported("open")),
			},
			Err(err)
				if err.kind() == io::ErrorKind::NotFound
					&& (options.is_create() || options.is_create_new()) =>
			{
				let data = Arc::new(Mutex::new(Vec::new()));
				tree.insert(path, Kind::File(Arc::clone(&data)));
				let node = &tree.nodes[path];
				(data, node.ino, node.mtime)
			},
			Err(err) => return Err(err),
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		Ok(File::from_handle(MemHandle { data, pos: Mutex::new(0), ino, mtime }))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		Ok(metadata_of(self.tree.lock().lookup(path, true)?.1))
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		Ok(metadata_of(self.tree.lock().lookup(path, false)?.1))
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		match &self.tree.lock().lookup(path, false)?.1.kind {
			Kind::Symlink(target) => Ok(target.clone()),
			_ => Err(pi_vfs::invalid_argument()),
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		let tree = self.tree.lock();
		let (real, node) = tree.lookup(path, true)?;
		if !matches!(node.kind, Kind::Dir) {
			return Err(pi_vfs::not_a_directory());
		}
		let entries: Vec<_> = tree
			.nodes
			.iter()
			.filter(|(child, _)| pi_vfs::parent_path(child) == Some(real.as_path()))
			.map(|(child, node)| {
				let name = pi_vfs::file_name(child).map_or_default(|name| name.into_owned());
				let bytes = child.as_os_str().as_encoded_bytes();
				let segment = &bytes[bytes.iter().rposition(|&b| b == b'/').map_or(0, |i| i + 1)..];
				let base = path.to_string_lossy();
				let sep = if base.ends_with('/') { "" } else { "/" };
				let entry_path =
					PathBuf::from(format!("{base}{sep}{}", String::from_utf8_lossy(segment)));
				let metadata = metadata_of(node);
				Ok(DirEntry::new(entry_path, name, Some(metadata.file_type())).with_metadata(metadata))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}
}
