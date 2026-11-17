//! `VfsFs`: provider paths pend on the runtime and wake the engine's waker;
//! host paths answer at once through the native filesystem.

use std::{
	collections::HashMap,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll, Wake, Waker},
	thread::{self, Thread},
	time::{Duration, Instant, UNIX_EPOCH},
};

use async_trait::async_trait;
use bstr::{BStr, BString};
use parking_lot::Mutex;
use pi_vfs::{
	CanonicalizeOptions, DirEntry, FileHandle, FileSystem, FileType, Metadata, OpenOptions,
	Permissions, ReadDir,
};
use tokio::runtime::Runtime;

use crate::{
	bash::{
		DirIter, File, FileKind, Fs, FsPoll, OpenFlags,
		fs::{Access, StatKind},
	},
	vfs::VfsFs,
};

const HELLO: &[u8] = b"hello world\n";

/// Modification time of every provider file.
const MTIME_SECS: u64 = 1_000;

#[derive(Clone, Debug)]
enum Node {
	File(Arc<Mutex<Vec<u8>>>),
	Dir,
	Link(PathBuf),
}

/// In-memory provider for `mem://` paths that answers every call after a
/// timer, so no answer is available when the operation starts.
///
/// - `mem://stall` never answers; the future records that it started and that
///   it was dropped.
/// - Entries named `untyped…` are listed without a type.
/// - Files named `stream…` cannot seek.
#[derive(Debug, Default)]
struct MemFs {
	nodes:   Mutex<HashMap<PathBuf, Node>>,
	stalled: Arc<AtomicBool>,
	dropped: Arc<AtomicBool>,
}

impl MemFs {
	fn seeded() -> Arc<Self> {
		let fs = Self::default();
		{
			let mut nodes = fs.nodes.lock();
			let file = |bytes: &[u8]| Node::File(Arc::new(Mutex::new(bytes.to_vec())));
			nodes.insert("mem://d".into(), Node::Dir);
			nodes.insert("mem://d/sub".into(), Node::Dir);
			nodes.insert("mem://d/hello".into(), file(HELLO));
			nodes.insert("mem://d/untyped.txt".into(), file(b""));
			nodes.insert("mem://d/stream".into(), file(HELLO));
			nodes.insert("mem://d/link".into(), Node::Link("mem://d/hello".into()));
		}
		Arc::new(fs)
	}

	fn node(&self, path: &Path) -> io::Result<Node> {
		self
			.nodes
			.lock()
			.get(path)
			.cloned()
			.ok_or_else(|| io::ErrorKind::NotFound.into())
	}

	/// `path` and its node, through one symlink.
	fn resolve(&self, path: &Path) -> io::Result<(PathBuf, Node)> {
		match self.node(path)? {
			Node::Link(target) => {
				let node = self.node(&target)?;
				Ok((target, node))
			},
			node => Ok((path.to_path_buf(), node)),
		}
	}

	async fn stall_on(&self, path: &Path) {
		if path == Path::new("mem://stall") {
			let _released = SetOnDrop(Arc::clone(&self.dropped));
			self.stalled.store(true, Ordering::SeqCst);
			std::future::pending::<()>().await;
		}
	}
}

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::SeqCst);
	}
}

async fn delay() {
	tokio::time::sleep(Duration::from_millis(5)).await;
}

fn meta_of(node: &Node) -> Metadata {
	let (kind, len, mode) = match node {
		Node::File(data) => (pi_vfs::FileKind::File, data.lock().len() as u64, 0o644),
		Node::Dir => (pi_vfs::FileKind::Dir, 0, 0o755),
		Node::Link(_) => (pi_vfs::FileKind::Symlink, 0, 0o777),
	};
	Metadata::new(FileType::from_kind(kind), len, Permissions::from_mode(mode))
		.with_modified(UNIX_EPOCH + Duration::from_secs(MTIME_SECS))
}

#[async_trait]
impl FileSystem for MemFs {
	fn is_native_local(&self, path: &Path) -> bool {
		!pi_vfs::is_virtual_path(path)
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<pi_vfs::File> {
		delay().await;
		let data = {
			let mut nodes = self.nodes.lock();
			match nodes.get(path) {
				Some(_) if options.is_create_new() => return Err(io::ErrorKind::AlreadyExists.into()),
				Some(Node::File(data)) => Arc::clone(data),
				Some(Node::Dir) => return Err(io::ErrorKind::IsADirectory.into()),
				Some(Node::Link(_)) => return Err(io::ErrorKind::Unsupported.into()),
				None if options.is_create() || options.is_create_new() => {
					let data = Arc::new(Mutex::new(Vec::new()));
					nodes.insert(path.to_path_buf(), Node::File(Arc::clone(&data)));
					data
				},
				None => return Err(io::ErrorKind::NotFound.into()),
			}
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		let seekable =
			!pi_vfs::file_name(path).is_some_and(|name| name.to_string_lossy().starts_with("stream"));
		Ok(pi_vfs::File::from_handle(MemHandle {
			data,
			pos: Mutex::new(0),
			append: options.is_append(),
			seekable,
		}))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		self.stall_on(path).await;
		delay().await;
		Ok(meta_of(&self.resolve(path)?.1))
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		delay().await;
		Ok(meta_of(&self.node(path)?))
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		delay().await;
		if !matches!(self.resolve(path)?.1, Node::Dir) {
			return Err(io::ErrorKind::NotADirectory.into());
		}
		let entries: Vec<io::Result<DirEntry>> = self
			.nodes
			.lock()
			.iter()
			.filter(|(child, _)| pi_vfs::parent_path(child) == Some(path))
			.map(|(child, node)| {
				let name = pi_vfs::file_name(child).unwrap_or_default().into_owned();
				let listed = !name.to_string_lossy().starts_with("untyped");
				let kind = listed.then(|| meta_of(node).file_type());
				Ok(DirEntry::new(child.clone(), name, kind))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		delay().await;
		match self.node(path)? {
			Node::Link(target) => Ok(target),
			_ => Err(io::ErrorKind::InvalidInput.into()),
		}
	}

	async fn canonicalize(
		&self,
		path: &Path,
		_options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		delay().await;
		Ok(self.resolve(path)?.0)
	}
}

/// An open `mem://` file; writes move at most four bytes per call.
#[derive(Debug)]
struct MemHandle {
	data:     Arc<Mutex<Vec<u8>>>,
	pos:      Mutex<u64>,
	append:   bool,
	seekable: bool,
}

#[async_trait]
impl FileHandle for MemHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		delay().await;
		let data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = usize::try_from(*pos).unwrap().min(data.len());
		let n = (data.len() - start).min(buf.len());
		buf[..n].copy_from_slice(&data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		delay().await;
		let mut data = self.data.lock();
		let mut pos = self.pos.lock();
		if self.append {
			*pos = data.len() as u64;
		}
		let start = usize::try_from(*pos).unwrap();
		let n = buf.len().min(4);
		if data.len() < start + n {
			data.resize(start + n, 0);
		}
		data[start..start + n].copy_from_slice(&buf[..n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn seek(&self, to: SeekFrom) -> io::Result<u64> {
		delay().await;
		if !self.seekable {
			return Err(io::ErrorKind::NotSeekable.into());
		}
		let len = self.data.lock().len() as u64;
		let mut pos = self.pos.lock();
		let next = match to {
			SeekFrom::Start(at) => Some(at),
			SeekFrom::Current(by) => pos.checked_add_signed(by),
			SeekFrom::End(by) => len.checked_add_signed(by),
		}
		.ok_or(io::ErrorKind::InvalidInput)?;
		*pos = next;
		Ok(next)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		delay().await;
		Ok(meta_of(&Node::File(Arc::clone(&self.data))))
	}
}

/// Wakes record themselves and unpark the polling thread.
struct Wakeup {
	woken:  AtomicBool,
	thread: Thread,
}

impl Wake for Wakeup {
	fn wake(self: Arc<Self>) {
		self.woken.store(true, Ordering::SeqCst);
		self.thread.unpark();
	}
}

/// Poll `poll` until ready, as the engine does: after `Pending` only a wake
/// of the waker it was polled with brings the next poll (none within ten
/// seconds fails the test).
fn drive<T>(mut poll: impl FnMut(&mut Context<'_>) -> Poll<T>) -> T {
	let wakeup = Arc::new(Wakeup { woken: AtomicBool::new(false), thread: thread::current() });
	let waker = Waker::from(Arc::clone(&wakeup));
	let mut cx = Context::from_waker(&waker);
	loop {
		if let Poll::Ready(value) = poll(&mut cx) {
			return value;
		}
		let deadline = Instant::now() + Duration::from_secs(10);
		while !wakeup.woken.swap(false, Ordering::SeqCst) {
			let left = deadline
				.checked_duration_since(Instant::now())
				.expect("a pending operation never woke its waker");
			thread::park_timeout(left);
		}
	}
}

/// The result of an operation that must pend first.
fn pending<T>(op: FsPoll<T>) -> io::Result<T> {
	match op {
		FsPoll::Ready(_) => panic!("a provider operation answered without waiting"),
		FsPoll::Pending(mut op) => drive(|cx| op.poll(cx)),
	}
}

/// The result of an operation that must answer at once.
fn ready<T>(op: FsPoll<T>) -> io::Result<T> {
	match op {
		FsPoll::Ready(result) => result,
		FsPoll::Pending(_) => panic!("a native-local operation pended"),
	}
}

fn runtime() -> Runtime {
	tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.enable_all()
		.build()
		.unwrap()
}

fn vfs(rt: &Runtime, provider: Arc<MemFs>) -> VfsFs {
	VfsFs::new(pi_vfs::Fs::new(provider), rt.handle().clone())
}

fn p(path: &str) -> &BStr {
	BStr::new(path)
}

fn host(path: &Path) -> BString {
	BString::from(path.as_os_str().as_encoded_bytes())
}

fn read_to_end(file: &mut dyn File) -> Vec<u8> {
	let mut out = Vec::new();
	let mut buf = [0u8; 5];
	loop {
		let n = drive(|cx| file.poll_read(cx, &mut buf)).unwrap();
		if n == 0 {
			return out;
		}
		out.extend_from_slice(&buf[..n]);
	}
}

fn write_all(file: &mut dyn File, mut bytes: &[u8]) {
	while !bytes.is_empty() {
		let n = drive(|cx| file.poll_write(cx, bytes)).unwrap();
		assert!(n > 0 && n <= bytes.len(), "wrote {n} of {}", bytes.len());
		bytes = &bytes[n..];
	}
	drive(|cx| file.poll_flush(cx)).unwrap();
}

/// Names and kinds of a listing, sorted by name.
fn list(mut dir: Box<dyn DirIter>) -> Vec<(BString, Option<StatKind>)> {
	let mut entries = Vec::new();
	while let Some(entry) = drive(|cx| dir.poll_next(cx)) {
		let entry = entry.unwrap();
		entries.push((entry.name, entry.kind));
	}
	entries.sort_by(|a, b| a.0.cmp(&b.0));
	entries
}

#[test]
fn provider_operations_pend_then_answer() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());

	let hello = pending(fs.stat(p("mem://d/hello"), true)).unwrap();
	assert_eq!(hello.kind, StatKind::File);
	assert_eq!(hello.size, HELLO.len() as u64);
	assert_eq!(hello.mode, 0o644);
	assert_eq!(hello.nlink, 1);
	assert_eq!(hello.blocks, 1);
	let mtime_ns = i64::try_from(MTIME_SECS).unwrap() * 1_000_000_000;
	assert_eq!((hello.mtime_ns, hello.atime_ns, hello.ctime_ns), (mtime_ns, mtime_ns, mtime_ns));
	// Unidentified objects get a per-path identity: `-ef` holds only for the
	// same path.
	let again = pending(fs.stat(p("mem://d/hello"), true)).unwrap();
	let sub = pending(fs.stat(p("mem://d/sub"), true)).unwrap();
	assert_eq!((hello.dev, hello.ino), (again.dev, again.ino));
	assert_ne!((hello.dev, hello.ino), (sub.dev, sub.ino));
	assert_eq!(sub.kind, StatKind::Dir);
	assert_eq!(pending(fs.stat(p("mem://d/link"), false)).unwrap().kind, StatKind::Symlink);
	assert_eq!(pending(fs.stat(p("mem://d/link"), true)).unwrap().kind, StatKind::File);
	let missing = pending(fs.stat(p("mem://d/missing"), true)).unwrap_err();
	assert_eq!(missing.kind(), io::ErrorKind::NotFound);

	pending(fs.access(p("mem://d/hello"), Access::READ.with(Access::WRITE))).unwrap();
	let exec = pending(fs.access(p("mem://d/hello"), Access::EXEC)).unwrap_err();
	assert_eq!(exec.kind(), io::ErrorKind::PermissionDenied);
	let absent = pending(fs.access(p("mem://d/missing"), Access::EXISTS)).unwrap_err();
	assert_eq!(absent.kind(), io::ErrorKind::NotFound);

	let listing = list(pending(fs.read_dir(p("mem://d"))).unwrap());
	assert_eq!(listing, [
		(BString::from("hello"), Some(StatKind::File)),
		(BString::from("link"), Some(StatKind::Symlink)),
		(BString::from("stream"), Some(StatKind::File)),
		(BString::from("sub"), Some(StatKind::Dir)),
		// Listed without a type: left to the engine, not looked up.
		(BString::from("untyped.txt"), None),
	]);

	assert_eq!(pending(fs.readlink(p("mem://d/link"))).unwrap(), "mem://d/hello");
	assert_eq!(pending(fs.realpath(p("mem://d/link"))).unwrap(), "mem://d/hello");

	pending(fs.chdir_check(p("mem://d/sub"))).unwrap();
	let not_dir = pending(fs.chdir_check(p("mem://d/hello"))).unwrap_err();
	assert_eq!(not_dir.kind(), io::ErrorKind::NotADirectory);

	let mut file = pending(fs.open(p("mem://d/hello"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(file.kind(), FileKind::Regular);
	assert!(file.os_handle().is_none());
	assert_eq!(read_to_end(file.as_mut()), HELLO);
}

#[test]
fn native_local_paths_answer_at_once() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let dir = tempfile::tempdir().unwrap();
	let file_path = dir.path().join("f");
	std::fs::write(&file_path, b"abc").unwrap();
	std::fs::create_dir(dir.path().join("sub")).unwrap();
	let (dir_b, file_b) = (host(dir.path()), host(&file_path));

	let stat = ready(fs.stat(file_b.as_ref(), true)).unwrap();
	assert_eq!((stat.kind, stat.size), (StatKind::File, 3));
	ready(fs.access(file_b.as_ref(), Access::READ)).unwrap();
	ready(fs.chdir_check(dir_b.as_ref())).unwrap();
	// The resolved path a user writes: `canonicalize` without Windows'
	// verbatim `\\?\` prefix (`cd -P`, `pwd -P` and `$PWD` show it).
	let real = host(&std::fs::canonicalize(dir.path()).unwrap());
	let real = real
		.strip_prefix(br"\\?\")
		.map_or(real.clone(), BString::from);
	assert_eq!(ready(fs.realpath(dir_b.as_ref())).unwrap(), real);

	let mut listing = Vec::new();
	let mut entries = ready(fs.read_dir(dir_b.as_ref())).unwrap();
	while let Poll::Ready(Some(entry)) = entries.poll_next(&mut Context::from_waker(Waker::noop())) {
		let entry = entry.unwrap();
		listing.push((entry.name, entry.kind));
	}
	listing.sort_by(|a, b| a.0.cmp(&b.0));
	assert_eq!(listing, [
		(BString::from("f"), Some(StatKind::File)),
		(BString::from("sub"), Some(StatKind::Dir)),
	]);

	let mut file = ready(fs.open(file_b.as_ref(), OpenFlags::READ, 0)).unwrap();
	assert_eq!(file.kind(), FileKind::Regular);
	assert!(file.os_handle().is_some(), "host files keep their OS handle");
	assert_eq!(read_to_end(file.as_mut()), b"abc");

	#[cfg(unix)]
	{
		let link = dir.path().join("link");
		std::os::unix::fs::symlink(&file_path, &link).unwrap();
		assert_eq!(ready(fs.readlink(host(&link).as_ref())).unwrap(), file_b);
	}
}

#[test]
fn dropping_a_pending_operation_cancels_it() {
	let rt = runtime();
	let mem = MemFs::seeded();
	let mut fs = vfs(&rt, Arc::clone(&mem));

	let FsPoll::Pending(stalled) = fs.stat(p("mem://stall"), true) else {
		panic!("a provider operation answered without waiting");
	};
	let deadline = Instant::now() + Duration::from_secs(10);
	while !mem.stalled.load(Ordering::SeqCst) {
		assert!(Instant::now() < deadline, "the stalled operation never started");
		thread::sleep(Duration::from_millis(1));
	}
	drop(stalled);
	while !mem.dropped.load(Ordering::SeqCst) {
		assert!(Instant::now() < deadline, "dropping the operation left it running");
		thread::sleep(Duration::from_millis(1));
	}
	// The filesystem keeps serving.
	assert_eq!(pending(fs.stat(p("mem://d/hello"), true)).unwrap().kind, StatKind::File);
}

#[test]
fn provider_file_write_then_read_round_trips() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let text = b"the quick brown fox jumps over the lazy dog";

	let create = OpenFlags::WRITE
		.with(OpenFlags::CREATE)
		.with(OpenFlags::TRUNC);
	let mut out = pending(fs.open(p("mem://d/new"), create, 0o644)).unwrap();
	assert_eq!(
		drive(|cx| out.poll_read(cx, &mut [])).unwrap_err().kind(),
		io::ErrorKind::Unsupported
	);
	assert_eq!(drive(|cx| out.poll_write(cx, &[])).unwrap(), 0);
	// The provider takes four bytes per write: only those are reported.
	assert_eq!(drive(|cx| out.poll_write(cx, text)).unwrap(), 4);
	write_all(out.as_mut(), &text[4..]);
	drop(out);

	let mut append = pending(fs.open(p("mem://d/new"), OpenFlags::APPEND, 0o644)).unwrap();
	write_all(append.as_mut(), b"!");
	drop(append);

	let mut back = pending(fs.open(p("mem://d/new"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(drive(|cx| back.poll_read(cx, &mut [])).unwrap(), 0);
	assert_eq!(read_to_end(back.as_mut()), [&text[..], &b"!"[..]].concat());
}

#[test]
fn seeks_apply_to_the_next_read_of_every_duplicate() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let mut file = pending(fs.open(p("mem://d/hello"), OpenFlags::READ, 0)).unwrap();

	let mut buf = [0u8; 8];
	assert_eq!(drive(|cx| file.poll_read(cx, &mut buf)).unwrap(), 8);
	assert_eq!(&buf, b"hello wo");
	// `read` gives back what followed the delimiter.
	assert_eq!(file.seek(SeekFrom::Current(-3)).unwrap(), 5);
	let mut dup = file.dup().unwrap();
	assert_eq!(read_to_end(dup.as_mut()), b" world\n");

	assert_eq!(file.seek(SeekFrom::Start(6)).unwrap(), 6);
	assert_eq!(read_to_end(file.as_mut()), b"world\n");
	assert_eq!(file.seek(SeekFrom::End(0)).unwrap_err().kind(), io::ErrorKind::NotSeekable);
	assert_eq!(file.seek(SeekFrom::Current(-100)).unwrap_err().kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn unseekable_provider_files_are_streams() {
	let rt = runtime();
	let mut fs = vfs(&rt, MemFs::seeded());
	let mut stream = pending(fs.open(p("mem://d/stream"), OpenFlags::READ, 0)).unwrap();
	assert_eq!(stream.kind(), FileKind::Device);
	assert_eq!(stream.seek(SeekFrom::Current(0)).unwrap_err().kind(), io::ErrorKind::NotSeekable);
	assert_eq!(read_to_end(stream.as_mut()), HELLO);
}
