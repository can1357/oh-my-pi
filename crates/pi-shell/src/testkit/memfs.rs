//! `MemFs`: an in-memory [`Fs`] with seeded latency (`Pending` answers that
//! resolve on a timer thread) and fault injection (EIO, EAGAIN, ENOSPC).
//!
//! `MemFs::with_latency(seed, 1.0, max_ms)` makes every operation `Pending`,
//! which checks that no engine path expects a synchronous filesystem answer
//!.

use std::{
	collections::{BTreeMap, VecDeque},
	io,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	task::{Context, Poll, Waker},
	thread,
	time::Duration,
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use crate::{
	bash::{
		DirEntry, DirIter, File, FileKind, Fs, FsPending, FsPoll, OpenFlags, OsHandle, Stat,
		fs::{Access, SeekFrom, StatKind, TempNode, TempPurpose},
	},
	testkit::rng::Rng,
};

/// Injected filesystem errors.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FaultKind {
	/// `EIO`.
	Eio,
	/// `EAGAIN`.
	Eagain,
	/// `ENOSPC`.
	Enospc,
}

/// The `EIO` error value (std has no `ErrorKind` for it).
#[derive(Debug)]
pub struct Eio;

impl std::fmt::Display for Eio {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str("Input/output error")
	}
}

impl std::error::Error for Eio {}

impl FaultKind {
	fn error(self) -> io::Error {
		match self {
			Self::Eio => io::Error::other(Eio),
			Self::Eagain => io::ErrorKind::WouldBlock.into(),
			Self::Enospc => io::ErrorKind::StorageFull.into(),
		}
	}
}

#[derive(Clone, Debug)]
enum Node {
	File {
		data: Arc<Mutex<Vec<u8>>>,
		mode: u32,
	},
	Dir {
		mode: u32,
	},
	/// `/dev/null`: reads end of file, writes are discarded.
	Null,
	/// A symbolic link (followed by every operation but `lstat` and
	/// `readlink`); a relative target is relative to the link's directory.
	Link {
		target: BString,
	},
}

#[derive(Clone, Debug)]
struct Faults {
	p:     f64,
	kinds: Vec<FaultKind>,
}

/// In-memory filesystem.
#[derive(Clone)]
pub struct MemFs {
	nodes:     Arc<Mutex<BTreeMap<BString, Node>>>,
	rng:       Arc<Mutex<Rng>>,
	p_pending: f64,
	max_ms:    u64,
	faults:    Option<Faults>,
	pending:   Arc<AtomicU64>,
	temp_seq:  Arc<AtomicU64>,
	/// Paths with a [`Fs::lock`] held.
	locks:     Arc<Mutex<std::collections::BTreeSet<BString>>>,
}

impl Default for MemFs {
	fn default() -> Self {
		Self::with_latency(0, 0.0, 0)
	}
}

impl MemFs {
	/// Empty filesystem (`/` and `/tmp`), every answer `Ready`.
	pub fn new() -> Self {
		Self::default()
	}

	/// Empty filesystem whose operations return `Pending` with probability
	/// `p_pending`, resolving after 0..=`max_ms` ms (seeded).
	pub fn with_latency(seed: u64, p_pending: f64, max_ms: u64) -> Self {
		let mut nodes = BTreeMap::new();
		nodes.insert(BString::from("/"), Node::Dir { mode: 0o755 });
		nodes.insert(BString::from("/tmp"), Node::Dir { mode: 0o777 });
		nodes.insert(BString::from("/dev"), Node::Dir { mode: 0o755 });
		nodes.insert(BString::from("/dev/null"), Node::Null);
		Self {
			nodes: Arc::new(Mutex::new(nodes)),
			rng: Arc::new(Mutex::new(Rng::new(seed))),
			p_pending,
			max_ms,
			faults: None,
			pending: Arc::new(AtomicU64::new(0)),
			temp_seq: Arc::new(AtomicU64::new(0)),
			locks: Arc::default(),
		}
	}

	/// Fail operations and writes with probability `p`, with a kind drawn
	/// from `kinds`.
	pub fn with_faults(mut self, p: f64, kinds: &[FaultKind]) -> Self {
		self.faults = Some(Faults { p, kinds: kinds.to_vec() });
		self
	}

	/// Create a file (and its parent directories).
	pub fn add_file(&self, path: &str, contents: &[u8], mode: u32) {
		self.add_parents(path);
		self.nodes.lock().insert(BString::from(path), Node::File {
			data: Arc::new(Mutex::new(contents.to_vec())),
			mode,
		});
	}

	/// Create a directory (and its parents).
	pub fn add_dir(&self, path: &str) {
		self.add_parents(path);
		self
			.nodes
			.lock()
			.insert(BString::from(path), Node::Dir { mode: 0o755 });
	}

	fn add_parents(&self, path: &str) {
		let mut nodes = self.nodes.lock();
		let mut at = 0;
		while let Some(i) = path[at + 1..].find('/') {
			at += 1 + i;
			nodes
				.entry(BString::from(&path[..at]))
				.or_insert(Node::Dir { mode: 0o755 });
		}
	}

	/// Contents of a file.
	pub fn read(&self, path: &str) -> Option<Vec<u8>> {
		match self.nodes.lock().get(path.as_bytes()) {
			Some(Node::File { data, .. }) => Some(data.lock().clone()),
			_ => None,
		}
	}

	/// Operations answered `Pending` so far.
	pub fn pending_count(&self) -> u64 {
		self.pending.load(Ordering::Relaxed)
	}

	fn fault(&self) -> Option<io::Error> {
		let f = self.faults.as_ref()?;
		let mut rng = self.rng.lock();
		if f.kinds.is_empty() || !rng.chance(f.p) {
			return None;
		}
		let kind = f.kinds[rng.below(f.kinds.len() as u64) as usize];
		Some(kind.error())
	}

	/// Answer `res`, now or after a seeded delay.
	fn answer<T: Send + 'static>(&self, res: io::Result<T>) -> FsPoll<T> {
		let res = match self.fault() {
			Some(err) => Err(err),
			None => res,
		};
		let delay = {
			let mut rng = self.rng.lock();
			if !rng.chance(self.p_pending) {
				return FsPoll::Ready(res);
			}
			rng.below(self.max_ms + 1)
		};
		self.pending.fetch_add(1, Ordering::Relaxed);
		FsPoll::Pending(Box::new(Delayed::start(res, delay)))
	}

	/// The node at `path`, following symbolic links.
	fn node(&self, path: &[u8]) -> io::Result<Node> {
		let path = self.resolve_links(path);
		self.lnode(&path)
	}

	/// The node at `path` itself.
	fn lnode(&self, path: &[u8]) -> io::Result<Node> {
		self
			.nodes
			.lock()
			.get(trim(path))
			.cloned()
			.ok_or_else(|| io::ErrorKind::NotFound.into())
	}

	/// `path` with symbolic links at its end followed (at most 40, as
	/// `SYMLOOP_MAX`).
	fn resolve_links(&self, path: &[u8]) -> BString {
		let mut path = BString::from(trim(path));
		let nodes = self.nodes.lock();
		for _ in 0..40 {
			match nodes.get(path.as_slice()) {
				Some(Node::Link { target }) => path = link_target(&path, target),
				_ => break,
			}
		}
		path
	}

	/// The node at `path` with `f` applied to it (following links).
	fn update(&self, path: &[u8], f: impl FnOnce(&mut Node) -> io::Result<()>) -> io::Result<()> {
		let path = self.resolve_links(path);
		match self.nodes.lock().get_mut(path.as_slice()) {
			Some(node) => f(node),
			None => Err(io::ErrorKind::NotFound.into()),
		}
	}

	fn open_now(&self, path: &[u8], flags: OpenFlags, mode: u32) -> io::Result<Box<dyn File>> {
		let resolved = self.resolve_links(path);
		let path = resolved.as_slice();
		let mut nodes = self.nodes.lock();
		let data = match nodes.get(path) {
			Some(Node::Dir { .. }) if flags.contains(OpenFlags::WRITE) => {
				return Err(io::ErrorKind::IsADirectory.into());
			},
			Some(Node::Dir { .. }) => Arc::new(Mutex::new(Vec::new())),
			Some(Node::Null) => return Ok(Box::new(NullFile)),
			// A link loop.
			Some(Node::Link { .. }) => {
				return Err(io::Error::other("Too many levels of symbolic links"));
			},
			Some(Node::File { .. }) if flags.contains(OpenFlags::EXCL) => {
				return Err(io::ErrorKind::AlreadyExists.into());
			},
			Some(Node::File { data, .. }) => Arc::clone(data),
			None if flags.contains(OpenFlags::CREATE) => {
				let parent = path
					.rfind_byte(b'/')
					.map_or(&b"/"[..], |i| if i == 0 { &b"/"[..] } else { &path[..i] });
				if !matches!(nodes.get(parent), Some(Node::Dir { .. })) {
					return Err(io::ErrorKind::NotFound.into());
				}
				let data = Arc::new(Mutex::new(Vec::new()));
				nodes.insert(BString::from(path), Node::File {
					data: Arc::clone(&data),
					mode: mode & 0o777,
				});
				data
			},
			None => return Err(io::ErrorKind::NotFound.into()),
		};
		if flags.contains(OpenFlags::TRUNC) {
			data.lock().clear();
		}
		Ok(Box::new(MemFile {
			data,
			pos: 0,
			append: flags.contains(OpenFlags::APPEND),
			faults: self
				.faults
				.clone()
				.map(|f| (f, Rng::new(self.rng.lock().next_u64()))),
		}))
	}
}

/// Where the link at `link` holding `target` points: `target` itself when
/// absolute, else `target` under the link's directory with `.` and `..`
/// resolved lexically.
fn link_target(link: &[u8], target: &[u8]) -> BString {
	if target.starts_with(b"/") {
		return BString::from(trim(target));
	}
	let dir = parent(link);
	let mut parts: Vec<&[u8]> = dir
		.split(|&c| c == b'/')
		.filter(|p| !p.is_empty())
		.collect();
	for part in target.split(|&c| c == b'/') {
		match part {
			b"" | b"." => {},
			b".." => {
				parts.pop();
			},
			p => parts.push(p),
		}
	}
	let mut out = BString::from("/");
	out.extend_from_slice(&parts.join(&b'/'));
	out
}

/// Whether anything lives under the directory `dir`.
fn has_children(nodes: &BTreeMap<BString, Node>, dir: &[u8]) -> bool {
	let mut prefix = BString::from(dir);
	if !prefix.ends_with(b"/") {
		prefix.push(b'/');
	}
	nodes
		.range::<[u8], _>((std::ops::Bound::Excluded(prefix.as_slice()), std::ops::Bound::Unbounded))
		.next()
		.is_some_and(|(k, _)| k.starts_with(prefix.as_slice()))
}

/// The directory holding `path` (`/` for a top-level name).
fn parent(path: &[u8]) -> &[u8] {
	let path = trim(path);
	match path.rfind_byte(b'/') {
		Some(0) | None => b"/",
		Some(i) => &path[..i],
	}
}

const fn trim(path: &[u8]) -> &[u8] {
	match path {
		[b'/'] => path,
		[rest @ .., b'/'] => rest,
		_ => path,
	}
}

/// A `Pending` answer that becomes ready on a timer thread.
struct Delayed<T> {
	res:   Option<io::Result<T>>,
	ready: Arc<AtomicBool>,
	waker: Arc<Mutex<Option<Waker>>>,
}

impl<T> Delayed<T> {
	fn start(res: io::Result<T>, delay_ms: u64) -> Self {
		let ready = Arc::new(AtomicBool::new(false));
		let waker: Arc<Mutex<Option<Waker>>> = Arc::new(Mutex::new(None));
		let (r, w) = (Arc::clone(&ready), Arc::clone(&waker));
		thread::spawn(move || {
			thread::sleep(Duration::from_millis(delay_ms));
			r.store(true, Ordering::Release);
			let waker = w.lock().take();
			if let Some(waker) = waker {
				waker.wake();
			}
		});
		Self { res: Some(res), ready, waker }
	}
}

impl<T: Send> FsPending<T> for Delayed<T> {
	fn poll(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
		if !self.ready.load(Ordering::Acquire) {
			*self.waker.lock() = Some(cx.waker().clone());
			if !self.ready.load(Ordering::Acquire) {
				return Poll::Pending;
			}
		}
		Poll::Ready(
			self
				.res
				.take()
				.unwrap_or_else(|| Err(io::ErrorKind::Other.into())),
		)
	}
}

/// An open in-memory file.
struct MemFile {
	data:   Arc<Mutex<Vec<u8>>>,
	pos:    usize,
	append: bool,
	faults: Option<(Faults, Rng)>,
}

impl MemFile {
	fn fault(&mut self) -> Option<io::Error> {
		let (f, rng) = self.faults.as_mut()?;
		if f.kinds.is_empty() || !rng.chance(f.p) {
			return None;
		}
		Some(f.kinds[rng.below(f.kinds.len() as u64) as usize].error())
	}
}

impl File for MemFile {
	fn poll_read(&mut self, _cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		if let Some(err) = self.fault() {
			return Poll::Ready(Err(err));
		}
		let data = self.data.lock();
		let n = buf.len().min(data.len().saturating_sub(self.pos));
		buf[..n].copy_from_slice(&data[self.pos..self.pos + n]);
		self.pos += n;
		Poll::Ready(Ok(n))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		if let Some(err) = self.fault() {
			return Poll::Ready(Err(err));
		}
		let mut data = self.data.lock();
		if self.append {
			self.pos = data.len();
		}
		let end = self.pos + buf.len();
		if data.len() < end {
			data.resize(end, 0);
		}
		data[self.pos..end].copy_from_slice(buf);
		self.pos = end;
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		let len = self.data.lock().len() as i64;
		let to = match pos {
			SeekFrom::Start(n) => n as i64,
			SeekFrom::End(d) => len + d,
			SeekFrom::Current(d) => self.pos as i64 + d,
		};
		self.pos = usize::try_from(to).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
		Ok(self.pos as u64)
	}

	fn kind(&self) -> FileKind {
		FileKind::Regular
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self {
			data:   Arc::clone(&self.data),
			pos:    self.pos,
			append: self.append,
			faults: self.faults.clone(),
		}))
	}
}

struct MemDir(VecDeque<DirEntry>);

impl DirIter for MemDir {
	fn poll_next(&mut self, _cx: &mut Context<'_>) -> Poll<Option<io::Result<DirEntry>>> {
		Poll::Ready(self.0.pop_front().map(Ok))
	}
}

/// The open `/dev/null`.
struct NullFile;

impl File for NullFile {
	fn poll_read(&mut self, _cx: &mut Context<'_>, _buf: &mut [u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(0))
	}

	fn poll_write(&mut self, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		Poll::Ready(Ok(buf.len()))
	}

	fn poll_flush(&mut self, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		Poll::Ready(Ok(()))
	}

	fn seek(&mut self, _pos: SeekFrom) -> io::Result<u64> {
		Ok(0)
	}

	fn kind(&self) -> FileKind {
		FileKind::Device
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		Ok(Box::new(Self))
	}
}

fn stat_of(node: &Node) -> Stat {
	let (kind, mode, size) = match node {
		Node::File { data, mode } => (StatKind::File, *mode, data.lock().len() as u64),
		Node::Dir { mode } => (StatKind::Dir, *mode, 0),
		Node::Null => (StatKind::CharDev, 0o666, 0),
		Node::Link { target } => (StatKind::Symlink, 0o755, target.len() as u64),
	};
	Stat {
		kind,
		mode,
		size,
		uid: 0,
		gid: 0,
		dev: 1,
		ino: 0,
		nlink: 1,
		mtime_ns: 0,
		atime_ns: 0,
		ctime_ns: 0,
		blocks: size.div_ceil(512),
		rdev: 0,
		blksize: 4096,
	}
}

impl Fs for MemFs {
	fn open(&mut self, path: &BStr, flags: OpenFlags, mode: u32) -> FsPoll<Box<dyn File>> {
		let res = self.open_now(path, flags, mode);
		self.answer(res)
	}

	fn stat(&mut self, path: &BStr, follow: bool) -> FsPoll<Stat> {
		let node = if follow {
			self.node(path)
		} else {
			self.lnode(path)
		};
		let res = node.map(|n| stat_of(&n));
		self.answer(res)
	}

	fn access(&mut self, path: &BStr, mode: Access) -> FsPoll<()> {
		let res = self.node(path).and_then(|n| {
			let bits = match n {
				Node::File { mode, .. } | Node::Dir { mode } => mode,
				Node::Null => 0o666,
				Node::Link { .. } => 0,
			};
			let need = [(Access::READ, 0o444), (Access::WRITE, 0o222), (Access::EXEC, 0o111)];
			if need
				.iter()
				.all(|&(a, b)| !mode.contains(a) || bits & b != 0)
			{
				Ok(())
			} else {
				Err(io::ErrorKind::PermissionDenied.into())
			}
		});
		self.answer(res)
	}

	fn read_dir(&mut self, path: &BStr) -> FsPoll<Box<dyn DirIter>> {
		let dir = trim(path);
		let res = match self.node(dir) {
			Ok(Node::Dir { .. }) => {
				let mut prefix = BString::from(dir);
				if !prefix.ends_with(b"/") {
					prefix.push(b'/');
				}
				let entries: VecDeque<DirEntry> = self
					.nodes
					.lock()
					.iter()
					.filter_map(|(p, n)| {
						let name = p.strip_prefix(prefix.as_slice())?;
						(!name.is_empty() && !name.contains(&b'/'))
							.then(|| DirEntry { name: BString::from(name), kind: Some(stat_of(n).kind) })
					})
					.collect();
				Ok(Box::new(MemDir(entries)) as Box<dyn DirIter>)
			},
			Ok(Node::File { .. } | Node::Null | Node::Link { .. }) => {
				Err(io::ErrorKind::NotADirectory.into())
			},
			Err(e) => Err(e),
		};
		self.answer(res)
	}

	fn readlink(&mut self, path: &BStr) -> FsPoll<BString> {
		let res = match self.lnode(path) {
			Ok(Node::Link { target }) => Ok(target),
			Ok(_) => Err(io::ErrorKind::InvalidInput.into()),
			Err(e) => Err(e),
		};
		self.answer(res)
	}

	fn realpath(&mut self, path: &BStr) -> FsPoll<BString> {
		let res = self.node(path).map(|_| BString::from(trim(path)));
		self.answer(res)
	}

	fn mkfifo_or_temp(&mut self, _purpose: TempPurpose) -> FsPoll<TempNode> {
		let n = self.temp_seq.fetch_add(1, Ordering::Relaxed);
		let path = format!("/tmp/obash-mem-{n}");
		self.add_file(&path, b"", 0o600);
		self.answer(Ok(TempNode { path: path.into(), fifo: false }))
	}

	fn chdir_check(&mut self, path: &BStr) -> FsPoll<()> {
		let res = match self.node(path) {
			Ok(Node::Dir { .. }) => Ok(()),
			Ok(Node::File { .. } | Node::Null | Node::Link { .. }) => {
				Err(io::ErrorKind::NotADirectory.into())
			},
			Err(e) => Err(e),
		};
		self.answer(res)
	}

	fn unlink(&mut self, path: &BStr) -> FsPoll<()> {
		let res = {
			let mut nodes = self.nodes.lock();
			match nodes.get(trim(path)) {
				Some(Node::Dir { .. }) => Err(io::ErrorKind::IsADirectory.into()),
				Some(_) => {
					nodes.remove(trim(path));
					Ok(())
				},
				None => Err(io::ErrorKind::NotFound.into()),
			}
		};
		self.answer(res)
	}

	fn rename(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		let res = {
			let (from, to) = (trim(from), trim(to));
			let mut nodes = self.nodes.lock();
			match (nodes.get(from), nodes.get(to)) {
				(None, _) => Err(io::ErrorKind::NotFound.into()),
				_ if !matches!(nodes.get(parent(to)), Some(Node::Dir { .. })) => {
					Err(io::ErrorKind::NotFound.into())
				},
				(Some(Node::Dir { .. }), Some(n)) if !matches!(n, Node::Dir { .. }) => {
					Err(io::ErrorKind::NotADirectory.into())
				},
				(Some(n), Some(Node::Dir { .. })) if !matches!(n, Node::Dir { .. }) => {
					Err(io::ErrorKind::IsADirectory.into())
				},
				(Some(Node::Dir { .. }), Some(Node::Dir { .. })) if has_children(&nodes, to) => {
					Err(io::ErrorKind::DirectoryNotEmpty.into())
				},
				_ if to.starts_with(from) && to.get(from.len()) == Some(&b'/') => {
					Err(io::ErrorKind::InvalidInput.into())
				},
				_ => {
					// The node and, for a directory, everything under it.
					let mut prefix = BString::from(from);
					prefix.push(b'/');
					let moved: Vec<BString> = nodes
						.keys()
						.filter(|k| k.as_slice() == from || k.starts_with(prefix.as_slice()))
						.cloned()
						.collect();
					for key in moved {
						if let Some(node) = nodes.remove(&key) {
							let mut dest = BString::from(to);
							dest.extend_from_slice(&key[from.len()..]);
							nodes.insert(dest, node);
						}
					}
					Ok(())
				},
			}
		};
		self.answer(res)
	}

	fn symlink(&mut self, target: &BStr, path: &BStr) -> FsPoll<()> {
		let res = {
			let mut nodes = self.nodes.lock();
			if nodes.contains_key(trim(path)) {
				Err(io::ErrorKind::AlreadyExists.into())
			} else if !matches!(nodes.get(parent(path)), Some(Node::Dir { .. })) {
				Err(io::ErrorKind::NotFound.into())
			} else {
				nodes.insert(BString::from(trim(path)), Node::Link { target: BString::from(target) });
				Ok(())
			}
		};
		self.answer(res)
	}

	fn link(&mut self, from: &BStr, to: &BStr) -> FsPoll<()> {
		let res = match self.lnode(from) {
			Ok(node) => {
				let mut nodes = self.nodes.lock();
				if nodes.contains_key(trim(to)) {
					Err(io::ErrorKind::AlreadyExists.into())
				} else {
					// Files share their data, as hard links do.
					nodes.insert(BString::from(trim(to)), node);
					Ok(())
				}
			},
			Err(e) => Err(e),
		};
		self.answer(res)
	}

	fn mkdir(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		let res = {
			let path = trim(path);
			let mut nodes = self.nodes.lock();
			if nodes.contains_key(path) {
				Err(io::ErrorKind::AlreadyExists.into())
			} else {
				match nodes.get(parent(path)) {
					Some(Node::Dir { .. }) => {
						nodes.insert(BString::from(path), Node::Dir { mode: mode & 0o7777 });
						Ok(())
					},
					Some(_) => Err(io::ErrorKind::NotADirectory.into()),
					None => Err(io::ErrorKind::NotFound.into()),
				}
			}
		};
		self.answer(res)
	}

	fn rmdir(&mut self, path: &BStr) -> FsPoll<()> {
		let res = {
			let path = trim(path);
			let mut nodes = self.nodes.lock();
			match nodes.get(path) {
				Some(Node::Dir { .. }) if has_children(&nodes, path) => {
					Err(io::ErrorKind::DirectoryNotEmpty.into())
				},
				Some(Node::Dir { .. }) => {
					nodes.remove(path);
					Ok(())
				},
				Some(_) => Err(io::ErrorKind::NotADirectory.into()),
				None => Err(io::ErrorKind::NotFound.into()),
			}
		};
		self.answer(res)
	}

	fn chmod(&mut self, path: &BStr, mode: u32) -> FsPoll<()> {
		let res = self.update(path, |node| match node {
			Node::File { mode: m, .. } | Node::Dir { mode: m } => {
				*m = mode & 0o7777;
				Ok(())
			},
			// `/dev/null` keeps its bits; a dangling link has no target.
			Node::Null => Ok(()),
			Node::Link { .. } => Err(io::ErrorKind::NotFound.into()),
		});
		self.answer(res)
	}

	fn sync(&mut self) -> FsPoll<()> {
		// Nothing is buffered on the way to memory.
		self.answer(Ok(()))
	}

	fn lock(&mut self, path: &BStr) -> FsPoll<Box<dyn File>> {
		let resolved = self.resolve_links(path);
		let res = if self.locks.lock().contains(&resolved) {
			Err(io::ErrorKind::WouldBlock.into())
		} else {
			self
				.open_now(&resolved, OpenFlags::READ.with(OpenFlags::WRITE), 0)
				.map(|file| {
					self.locks.lock().insert(resolved.clone());
					Box::new(LockedFile { file, locks: Arc::clone(&self.locks), path: resolved })
						as Box<dyn File>
				})
		};
		self.answer(res)
	}
}

/// A file a [`Fs::lock`] holds; dropping it releases the lock.
struct LockedFile {
	file:  Box<dyn File>,
	locks: Arc<Mutex<std::collections::BTreeSet<BString>>>,
	path:  BString,
}

impl Drop for LockedFile {
	fn drop(&mut self) {
		self.locks.lock().remove(&self.path);
	}
}

impl File for LockedFile {
	fn poll_read(&mut self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
		self.file.poll_read(cx, buf)
	}

	fn poll_write(&mut self, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
		self.file.poll_write(cx, buf)
	}

	fn poll_flush(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
		self.file.poll_flush(cx)
	}

	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		self.file.seek(pos)
	}

	fn kind(&self) -> FileKind {
		FileKind::Regular
	}

	fn os_handle(&self) -> Option<OsHandle> {
		None
	}

	fn dup(&self) -> io::Result<Box<dyn File>> {
		self.file.dup()
	}
}

#[cfg(test)]
mod tests {
	use std::task::Wake;

	use super::*;

	struct Unpark(thread::Thread);

	impl Wake for Unpark {
		fn wake(self: Arc<Self>) {
			self.0.unpark();
		}
	}

	fn resolve<T>(p: FsPoll<T>) -> io::Result<T> {
		match p {
			FsPoll::Ready(r) => r,
			FsPoll::Pending(mut f) => {
				let waker = Waker::from(Arc::new(Unpark(thread::current())));
				let mut cx = Context::from_waker(&waker);
				loop {
					if let Poll::Ready(r) = f.poll(&mut cx) {
						return r;
					}
					thread::park_timeout(Duration::from_millis(20));
				}
			},
		}
	}

	#[test]
	fn full_latency_makes_every_operation_pending_but_correct() {
		let mut fs = MemFs::with_latency(7, 1.0, 3);
		fs.add_file("/bin/tool", b"x", 0o755);
		assert!(matches!(fs.stat(b"/bin/tool".as_bstr(), true), FsPoll::Pending(_)));
		assert_eq!(resolve(fs.stat(b"/bin/tool".as_bstr(), true)).unwrap().kind, StatKind::File);
		assert!(resolve(fs.access(b"/bin/tool".as_bstr(), Access::EXEC)).is_ok());
		assert_eq!(
			resolve(fs.stat(b"/nope".as_bstr(), true))
				.unwrap_err()
				.kind(),
			io::ErrorKind::NotFound
		);
		assert_eq!(fs.pending_count(), 4);
	}

	#[test]
	fn access_checks_mode_bits() {
		let mut fs = MemFs::new();
		fs.add_file("/a", b"", 0o644);
		assert_eq!(
			resolve(fs.access(b"/a".as_bstr(), Access::EXEC))
				.unwrap_err()
				.kind(),
			io::ErrorKind::PermissionDenied
		);
		assert!(resolve(fs.access(b"/a".as_bstr(), Access::READ)).is_ok());
	}

	#[test]
	fn injected_faults_surface_as_their_errno_text() {
		let mut fs = MemFs::new().with_faults(1.0, &[FaultKind::Eio]);
		let err = resolve(fs.stat(b"/".as_bstr(), true)).unwrap_err();
		assert_eq!(crate::bash::diag::strerror(&err), "Input/output error");
		let mut fs = MemFs::new().with_faults(1.0, &[FaultKind::Enospc]);
		let err = resolve(fs.stat(b"/".as_bstr(), true)).unwrap_err();
		assert_eq!(crate::bash::diag::strerror(&err), "No space left on device");
	}

	#[test]
	fn directories_list_direct_children_only() {
		let mut fs = MemFs::new();
		fs.add_file("/d/a", b"", 0o644);
		fs.add_file("/d/sub/b", b"", 0o644);
		let mut it = resolve(fs.read_dir(b"/d".as_bstr())).unwrap();
		let waker = Waker::noop();
		let mut cx = Context::from_waker(waker);
		let mut names = Vec::new();
		while let Poll::Ready(Some(Ok(e))) = it.poll_next(&mut cx) {
			names.push(e.name.to_string());
		}
		assert_eq!(names, ["a", "sub"]);
	}

	#[test]
	fn create_truncate_and_append() {
		let mut fs = MemFs::new();
		let waker = Waker::noop();
		let mut cx = Context::from_waker(waker);
		let w = OpenFlags::WRITE.with(OpenFlags::CREATE);
		let mut f = resolve(fs.open(b"/tmp/x".as_bstr(), w.with(OpenFlags::TRUNC), 0o644)).unwrap();
		let _ = f.poll_write(&mut cx, b"abc");
		let mut f = resolve(fs.open(b"/tmp/x".as_bstr(), w.with(OpenFlags::APPEND), 0o644)).unwrap();
		let _ = f.poll_write(&mut cx, b"de");
		assert_eq!(fs.read("/tmp/x").unwrap(), b"abcde");
		assert!(resolve(fs.open(b"/missing/x".as_bstr(), w, 0o644)).is_err());
	}
}
