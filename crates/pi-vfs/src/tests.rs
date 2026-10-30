//! Regression tests for URL path handling, provider handle semantics, close
//! tracking, cancellation, and uucore canonicalization parity.

use std::{
	collections::BTreeMap,
	ffi::OsStr,
	io::{self, Read, Seek, SeekFrom, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use async_trait::async_trait;
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::*;

#[derive(Debug, Clone)]
enum Node {
	File(Arc<Mutex<Vec<u8>>>),
	Dir,
}

/// In-memory provider for `mem://`; every handle operation yields to the
/// runtime timer so synchronous callers must really drive the reactor.
#[derive(Debug)]
struct MemFs {
	nodes:  Mutex<BTreeMap<PathBuf, Node>>,
	closes: Arc<AtomicUsize>,
}

impl MemFs {
	fn new() -> Arc<Self> {
		let mut nodes = BTreeMap::new();
		nodes.insert(PathBuf::from("mem://"), Node::Dir);
		Arc::new(Self { nodes: Mutex::new(nodes), closes: Arc::default() })
	}
}

#[derive(Debug)]
struct MemHandle {
	data:   Arc<Mutex<Vec<u8>>>,
	pos:    Mutex<u64>,
	append: bool,
	closes: Arc<AtomicUsize>,
}

async fn tick() {
	tokio::time::sleep(Duration::from_millis(1)).await;
}

#[async_trait]
impl FileHandle for MemHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		tick().await;
		let data = self.data.lock();
		let mut pos = self.pos.lock();
		let start = (*pos as usize).min(data.len());
		let n = buf.len().min(data.len() - start);
		buf[..n].copy_from_slice(&data[start..start + n]);
		*pos += n as u64;
		Ok(n)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		tick().await;
		let mut data = self.data.lock();
		let mut pos = self.pos.lock();
		if self.append {
			*pos = data.len() as u64;
		}
		let start = *pos as usize;
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
			SeekFrom::Start(n) => n as i64,
			SeekFrom::End(n) => len + n,
			SeekFrom::Current(n) => *pos as i64 + n,
		};
		*pos = u64::try_from(next).map_err(|_| invalid_argument())?;
		Ok(*pos)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		let len = self.data.lock().len() as u64;
		Ok(Metadata::new(FileType::from_kind(FileKind::File), len, Permissions::from_mode(0o644)))
	}

	async fn close(&self) -> io::Result<()> {
		tick().await;
		self.closes.fetch_add(1, Ordering::SeqCst);
		Ok(())
	}
}

fn not_found() -> io::Error {
	io::Error::from(io::ErrorKind::NotFound)
}

#[async_trait]
impl FileSystem for MemFs {
	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		let mut nodes = self.nodes.lock();
		let data = match nodes.get(path) {
			Some(_) if options.is_create_new() => {
				return Err(io::Error::from(io::ErrorKind::AlreadyExists));
			},
			Some(Node::Dir) => return Err(is_a_directory()),
			Some(Node::File(data)) => Arc::clone(data),
			None if options.is_create() || options.is_create_new() => {
				let parent = parent_path(path).ok_or_else(not_found)?;
				if !matches!(nodes.get(parent), Some(Node::Dir)) {
					return Err(not_found());
				}
				let data = Arc::new(Mutex::new(Vec::new()));
				nodes.insert(path.to_path_buf(), Node::File(Arc::clone(&data)));
				data
			},
			None => return Err(not_found()),
		};
		if options.is_truncate() {
			data.lock().clear();
		}
		Ok(File::from_handle(MemHandle {
			data,
			pos: Mutex::new(0),
			append: options.is_append(),
			closes: Arc::clone(&self.closes),
		}))
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		match self.nodes.lock().get(path).ok_or_else(not_found)? {
			Node::Dir => {
				Ok(Metadata::new(FileType::from_kind(FileKind::Dir), 0, Permissions::from_mode(0o755)))
			},
			Node::File(data) => Ok(Metadata::new(
				FileType::from_kind(FileKind::File),
				data.lock().len() as u64,
				Permissions::from_mode(0o644),
			)),
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		let nodes = self.nodes.lock();
		let entries: Vec<_> = nodes
			.iter()
			.filter(|(child, _)| child.as_path() != path && parent_path(child) == Some(path))
			.map(|(child, node)| {
				let kind = if matches!(node, Node::Dir) {
					FileKind::Dir
				} else {
					FileKind::File
				};
				let name = file_name(child).unwrap().to_os_string();
				Ok(DirEntry::new(child.clone(), name, Some(FileType::from_kind(kind))))
			})
			.collect();
		Ok(ReadDir::from_entries(entries))
	}

	async fn create_dir(&self, path: &Path, _mode: Option<u32>) -> io::Result<()> {
		let mut nodes = self.nodes.lock();
		if nodes.contains_key(path) {
			return Err(io::Error::from(io::ErrorKind::AlreadyExists));
		}
		if !matches!(parent_path(path).and_then(|parent| nodes.get(parent)), Some(Node::Dir)) {
			return Err(not_found());
		}
		nodes.insert(path.to_path_buf(), Node::Dir);
		Ok(())
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		if url_scheme(to) != Some("mem") {
			return Err(crosses_devices());
		}
		let mut nodes = self.nodes.lock();
		let node = nodes.remove(from).ok_or_else(not_found)?;
		nodes.insert(to.to_path_buf(), node);
		Ok(())
	}
}

#[test]
fn url_lexical_helpers_keep_the_scheme_root() {
	let p = Path::new;
	assert_eq!(parent_path(p("local://out")), Some(p("local://")));
	assert_eq!(parent_path(p("skill://name/SKILL.md")), Some(p("skill://name")));
	assert_eq!(parent_path(p("skill://name/")), Some(p("skill://")));
	assert_eq!(parent_path(p("local://")), None);
	assert_eq!(parent_path(p("x")), Some(p("")));
	assert_eq!(file_name(p("local://out")).as_deref(), Some(OsStr::new("out")));
	assert_eq!(file_name(p("local://")), None);
	assert_eq!(with_file_name(p("local://a/b.txt"), "b.bak"), p("local://a/b.bak"));
	assert_eq!(with_file_name(p("local://b.txt"), "b.bak"), p("local://b.bak"));
	assert_eq!(join_path(p("local://"), p("a")), p("local://a"));
	assert_eq!(join_path(p("local://a"), p("b/c/")).as_os_str(), "local://a/b/c/");
	assert_eq!(join_path(p(""), p("x")), p("x"));
	assert_eq!(join_path(p("local://tmp"), p("")).as_os_str(), "local://tmp/");
	assert_eq!(absolute_path(p("/work"), p("local://a")), p("local://a"));
	assert_eq!(absolute_path(p("skill://s"), p("../t")), p("skill://s/../t"));
	assert_eq!(normalize_lexically(p("skill://s/../../t/./u/")), p("skill://t/u"));
	assert_eq!(normalize_lexically(p("local://..")), p("local://"));
	assert_eq!(relative_path(p("local://a/b/c"), p("local://a/d")), Some(PathBuf::from("../b/c")));
	assert_eq!(relative_path(p("local://a"), p("skill://a")), None);
	assert_eq!(relative_path(p("/x/y"), p("local://x")), None);
	assert_eq!(relative_path(p("/x/y"), p("/x/y")), Some(PathBuf::from(".")));
}

#[test]
fn raw_names_round_trip_through_url_segments() {
	let p = Path::new;
	let raw = OsStr::new("a?b#c% d\\e");
	let child = child_path(p("local://d"), raw);
	assert_eq!(child, p("local://d/a%3Fb%23c%25%20d%5Ce"));
	assert_eq!(file_name(&child).as_deref(), Some(raw));
	assert_eq!(join_path(p("local://d"), p("x y/z?")), p("local://d/x%20y/z%3F"));
	assert_eq!(with_file_name(&child, "n#1"), p("local://d/n%231"));
	// Typed absolute URLs are already spelled; nothing is re-encoded.
	assert_eq!(join_path(p("local://d"), p("local://a%3Fb")), p("local://a%3Fb"));
	assert_eq!(decode_segment(OsStr::new("100%")), OsStr::new("100%"));
	assert_eq!(child_path(p("/host"), raw), p("/host").join(raw));
	// Drive letters and single-letter schemes stay host paths.
	assert!(!is_virtual_path(p("C://x")));
	assert!(is_virtual_path(p("git+ssh://h/r")));
}

#[test]
fn native_backend_never_resolves_urls_against_the_process_cwd() {
	let fs = BlockingFs::native();
	let err = fs.create("vfs-kernel-test://x").unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::NotFound);
	assert!(!Path::new("vfs-kernel-test:").exists());
	assert!(!fs.exists("vfs-kernel-test://x"));
	assert!(!fs.is_native_local("vfs-kernel-test://x"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_handles_share_offsets_and_honour_open_flags() {
	let mem = MemFs::new();
	let fs = Fs::new(mem.clone()).blocking();
	tokio::task::spawn_blocking(move || {
		fs.write("mem://f", b"hello").unwrap();

		let err = fs
			.open_with("mem://f", OpenOptions::new().write(true).create_new(true))
			.unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);

		let a = fs.open("mem://f").unwrap();
		let b = a.try_clone().unwrap();
		let mut two = [0; 2];
		(&a).read_exact(&mut two).unwrap();
		let mut rest = String::new();
		(&b).read_to_string(&mut rest).unwrap();
		assert_eq!((&two, rest.as_str()), (b"he", "llo"));
		assert_eq!((&a).stream_position().unwrap(), 5);

		let mut appender = fs
			.open_with("mem://f", OpenOptions::new().append(true))
			.unwrap();
		appender.write_all(b"!").unwrap();
		appender.close().unwrap();
		assert_eq!(fs.read_to_string("mem://f").unwrap(), "hello!");

		fs.create("mem://f").unwrap().close().unwrap();
		assert_eq!(fs.metadata("mem://f").unwrap().len(), 0);

		let err = fs.rename("mem://f", "/tmp/elsewhere").unwrap_err();
		assert_eq!(err.kind(), io::ErrorKind::CrossesDevices);
	})
	.await
	.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_provider_files_close_in_background_and_drain() {
	let mem = MemFs::new();
	let fs = Fs::new(mem.clone());
	let file = fs.create("mem://log").await.unwrap();
	file.write_all_async(b"x").await.unwrap();
	let clone = file.try_clone().unwrap();
	drop(file);
	assert_eq!(mem.closes.load(Ordering::SeqCst), 0, "a live clone keeps the handle open");
	drop(clone);
	fs.drain_closes().await.unwrap();
	assert_eq!(mem.closes.load(Ordering::SeqCst), 1);

	let blocking = fs.blocking();
	let closes = Arc::clone(&mem.closes);
	tokio::task::spawn_blocking(move || {
		drop(blocking.open("mem://log").unwrap());
		blocking.drain_closes().unwrap();
		assert_eq!(closes.load(Ordering::SeqCst), 2);
	})
	.await
	.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancellation_is_not_a_retryable_interrupt_and_close_still_runs() {
	let mem = MemFs::new();
	let token = CancellationToken::new();
	let fs = Fs::new(mem.clone()).with_cancellation(token.clone());
	let file = fs.create("mem://c").await.unwrap();
	token.cancel();

	let err = file.write_all_async(b"late").await.unwrap_err();
	assert!(is_cancelled(&err));
	assert_ne!(err.kind(), io::ErrorKind::Interrupted);
	assert!(is_cancelled(&fs.metadata("mem://c").await.unwrap_err()));

	file.close_async().await.unwrap();
	assert_eq!(mem.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_canonicalize_stays_inside_the_url_root() {
	let fs = Fs::new(MemFs::new());
	fs.create_dir_all("mem://a/b").await.unwrap();
	let missing = CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical);
	assert_eq!(
		fs.canonicalize_with("mem://a/./b/../../../x", &missing)
			.await
			.unwrap(),
		Path::new("mem://x")
	);
	assert_eq!(fs.canonicalize("mem://a/b/").await.unwrap(), Path::new("mem://a/b"));
	let err = fs.canonicalize("mem://a/nope/c").await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::NotFound);
}

struct TempDir(PathBuf);

impl TempDir {
	fn new(tag: &str) -> Self {
		let fs = BlockingFs::native();
		let path = fs
			.create_temp_dir(
				std::env::temp_dir(),
				&TempOptions::new().prefix(format!("pi-vfs-{tag}-")),
			)
			.unwrap();
		Self(std::fs::canonicalize(path).unwrap())
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

#[cfg(windows)]
#[test]
fn native_path_metadata_matches_the_open_file_identity() {
	let dir = TempDir::new("identity");
	let path = dir.0.join("file");
	std::fs::write(&path, "content").unwrap();
	let fs = BlockingFs::native();
	let path_meta = fs.metadata(&path).unwrap();
	let file_meta = fs.open(&path).unwrap().metadata().unwrap();
	assert!(path_meta.same_file(&file_meta));
	assert_eq!(path_meta.len(), file_meta.len());
	let missing_identity =
		Metadata::native_with_handle(std::fs::metadata(&path).unwrap(), crate::native::HandleInfo {
			volume_serial: 1,
			file_index:    0,
			nlink:         1,
		});
	assert!(missing_identity.file_id().is_none());
	assert!(!missing_identity.same_file(&path_meta));
	let link = dir.0.join("link");
	if std::os::windows::fs::symlink_file("file", &link).is_ok() {
		assert!(fs.symlink_metadata(&link).unwrap().is_symlink());
		assert!(fs.metadata(&link).unwrap().same_file(&path_meta));
	}
}

#[cfg(unix)]
#[test]
fn native_canonicalize_matches_uucore_modes() {
	let dir = TempDir::new("canon");
	let fs = BlockingFs::native();
	let file = dir.0.join("file");
	std::fs::write(&file, "x").unwrap();
	std::os::unix::fs::symlink("loop-b", dir.0.join("loop-a")).unwrap();
	std::os::unix::fs::symlink("loop-a", dir.0.join("loop-b")).unwrap();
	std::os::unix::fs::symlink("file", dir.0.join("link")).unwrap();

	let opts = |missing| CanonicalizeOptions::new(missing, ResolveMode::Physical);
	assert_eq!(
		fs.canonicalize_with(dir.0.join("link"), &opts(MissingHandling::Existing))
			.unwrap(),
		file
	);
	// Normal: only the last component may be missing, and its parent must be a
	// directory.
	assert_eq!(
		fs.canonicalize_with(dir.0.join("new"), &opts(MissingHandling::Normal))
			.unwrap(),
		dir.0.join("new")
	);
	let err = fs
		.canonicalize_with(dir.0.join("file/new"), &opts(MissingHandling::Normal))
		.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
	// A trailing slash demands a directory.
	let mut slashed = file.clone().into_os_string();
	slashed.push("/");
	let err = fs
		.canonicalize_with(&slashed, &opts(MissingHandling::Existing))
		.unwrap_err();
	assert_eq!(err.raw_os_error(), Some(libc::ENOTDIR));
	let err = fs
		.canonicalize_with(dir.0.join("loop-a"), &opts(MissingHandling::Missing))
		.unwrap_err();
	assert_eq!(err.to_string(), "Too many levels of symbolic links");
	assert_eq!(
		fs.canonicalize_with(
			dir.0.join("link/../file"),
			&CanonicalizeOptions::new(MissingHandling::Existing, ResolveMode::Logical)
		)
		.unwrap(),
		file
	);
}

/// A creation mask stands in for the process umask on host files,
/// directories, and temp files created through the facade, without touching
/// the process umask.
#[cfg(unix)]
#[test]
fn creation_mask_clears_bits_from_host_creations() {
	use std::os::unix::fs::PermissionsExt;

	let dir = TempDir::new("mask");
	let fs = Fs::native().with_creation_mask(Some(0o077)).blocking();
	let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

	fs.create(dir.0.join("file")).unwrap();
	fs.create_dir(dir.0.join("dir")).unwrap();
	let (temp, _file) = fs
		.create_temp(&dir.0, &TempOptions::new().prefix("t").mode(0o644))
		.unwrap();
	assert_eq!(mode(&dir.0.join("file")), 0o600);
	assert_eq!(mode(&dir.0.join("dir")), 0o700);
	assert_eq!(mode(&temp), 0o600);

	// Opening an existing file never re-applies the mask.
	std::fs::set_permissions(dir.0.join("file"), std::fs::Permissions::from_mode(0o644)).unwrap();
	fs.open_with(dir.0.join("file"), OpenOptions::new().write(true).create(true))
		.unwrap();
	assert_eq!(mode(&dir.0.join("file")), 0o644);

	// A mask looser than the process umask keeps the bits the umask clears,
	// for every kind of entry, and for each directory a recursive create
	// makes.
	let loose = Fs::native().with_creation_mask(Some(0)).blocking();
	loose.create(dir.0.join("open")).unwrap();
	loose.create_dir(dir.0.join("loose")).unwrap();
	loose.create_dir_all(dir.0.join("deep/er")).unwrap();
	loose
		.make_node(dir.0.join("fifo"), crate::NodeKind::Fifo, 0o666)
		.unwrap();
	assert_eq!(mode(&dir.0.join("open")), 0o666);
	assert_eq!(mode(&dir.0.join("loose")), 0o777);
	assert_eq!(mode(&dir.0.join("deep")), 0o777);
	assert_eq!(mode(&dir.0.join("deep/er")), 0o777);
	assert_eq!(mode(&dir.0.join("fifo")), 0o666);
}

#[test]
fn descriptor_overlay_shares_the_pinned_file() {
	let dir = TempDir::new("mount");
	let path = dir.0.join("backing");
	std::fs::write(&path, "abcdef").unwrap();
	let pinned = File::from(std::fs::File::open(&path).unwrap());
	let fs = BlockingFs::native().mount_file("/dev/fd/77", pinned);

	let mut first = [0; 3];
	fs.open("/dev/fd/77")
		.unwrap()
		.read_exact(&mut first)
		.unwrap();
	let mut rest = String::new();
	fs.open("/dev/fd/77")
		.unwrap()
		.read_to_string(&mut rest)
		.unwrap();
	assert_eq!((&first, rest.as_str()), (b"abc", "def"));
	assert_eq!(fs.metadata("/dev/fd/77").unwrap().len(), 6);
	assert!(!fs.is_native_local("/dev/fd/77"));
	assert!(fs.remove_file("/dev/fd/77").is_err());
	assert!(path.exists());
}

/// Byte-level opens of a SQLite file this process holds would release the
/// connection's POSIX locks when they close (#15586), so host opens refuse
/// exactly those inodes: held database and WAL-index headers, not other held
/// files nor SQLite files nobody holds. The holders open right after another
/// guarded open and are checked immediately: no scan result may go stale.
#[cfg(unix)]
#[test]
fn host_opens_refuse_sqlite_files_this_process_holds() {
	let dir = TempDir::new("held-sqlite");
	let db = dir.0.join("agent.db");
	let shm = dir.0.join("agent.db-shm");
	let text = dir.0.join("notes.txt");
	let idle = dir.0.join("idle.db");
	let mut wal_index = 3_007_000_u32.to_ne_bytes().to_vec();
	wal_index.resize(136, 0);
	std::fs::write(&db, b"SQLite format 3\0rest of page").unwrap();
	std::fs::write(&shm, &wal_index).unwrap();
	std::fs::write(&text, b"needle").unwrap();
	std::fs::write(&idle, b"SQLite format 3\0idle").unwrap();
	let fs = BlockingFs::native();
	assert!(fs.read(&idle).is_ok());

	let held = [&db, &shm, &text].map(|path| std::fs::File::open(path).unwrap());
	let locks_on_db = lock_db(&held[0]);
	for path in [&db, &shm] {
		assert!(held_by_sqlite(path), "{} should be held", path.display());
		// The first refusal sniffs the fresh descriptor and keeps it open;
		// later ones are refused before opening.
		assert_eq!(fs.open(path).unwrap_err().kind(), io::ErrorKind::ResourceBusy);
		assert_eq!(fs.read(path).unwrap_err().kind(), io::ErrorKind::ResourceBusy);
	}
	assert_eq!(locks_on_db(), 1, "a refused open released the holder's lock");
	assert_eq!(
		fs.open_with(&db, OpenOptions::new().write(true))
			.unwrap_err()
			.kind(),
		io::ErrorKind::ResourceBusy
	);
	assert_eq!(fs.copy(&db, dir.0.join("copy.db")).unwrap_err().kind(), io::ErrorKind::ResourceBusy);
	assert_eq!(fs.copy(&idle, &db).unwrap_err().kind(), io::ErrorKind::ResourceBusy);
	assert_eq!(fs.read(&text).unwrap(), b"needle");
	assert!(!held_by_sqlite(&idle));
	assert!(fs.read(&idle).is_ok());

	drop(held);
	assert!(!held_by_sqlite(&db));
	assert!(fs.read(&db).is_ok());
	assert!(fs.read(&shm).is_ok());
}

/// Both write facades must refuse held database and WAL-index files before
/// truncating them or opening a descriptor whose close would drop POSIX locks.
#[cfg(unix)]
#[tokio::test]
async fn native_writes_preserve_held_sqlite_files_and_locks() {
	let dir = TempDir::new("held-sqlite-write");
	let db = dir.0.join("agent.db");
	let shm = dir.0.join("agent.db-shm");
	let db_contents = b"SQLite format 3\0original database";
	let mut shm_contents = 3_007_000_u32.to_ne_bytes().to_vec();
	shm_contents.resize(136, 42);
	std::fs::write(&db, db_contents).unwrap();
	std::fs::write(&shm, &shm_contents).unwrap();

	let held = [&db, &shm].map(|path| std::fs::File::open(path).unwrap());
	let locks = held.each_ref().map(lock_db);
	let async_fs = Fs::native();
	let blocking_fs = BlockingFs::native();
	for path in [&db, &shm] {
		assert_eq!(
			async_fs
				.write(path, b"replacement")
				.await
				.unwrap_err()
				.kind(),
			io::ErrorKind::ResourceBusy
		);
		assert_eq!(
			blocking_fs.write(path, b"replacement").unwrap_err().kind(),
			io::ErrorKind::ResourceBusy
		);
	}
	for lock in locks {
		assert_eq!(lock(), 1, "a refused write released a holder's lock");
	}
	use std::os::unix::fs::FileExt;
	let mut db_after = vec![0; db_contents.len()];
	let mut shm_after = vec![0; shm_contents.len()];
	held[0].read_at(&mut db_after, 0).unwrap();
	held[1].read_at(&mut shm_after, 0).unwrap();
	assert_eq!(db_after, db_contents);
	assert_eq!(shm_after, shm_contents);
}

/// Takes a POSIX read lock on `file` the way SQLite does and returns a probe
/// counting this process's locks on that inode (`/proc/locks`; `1` elsewhere,
/// where there is no such table to read).
#[cfg(unix)]
fn lock_db(file: &std::fs::File) -> impl Fn() -> usize + use<> {
	use std::os::{fd::AsRawFd, unix::fs::MetadataExt};

	// SAFETY: `flock` is a plain C struct; zero is valid before the fields
	// below are set.
	let mut lock: libc::flock = unsafe { std::mem::zeroed() };
	lock.l_type = libc::F_RDLCK as _;
	lock.l_whence = libc::SEEK_SET as _;
	// SAFETY: `file` owns a valid descriptor and `lock` is readable for
	// F_SETLK.
	assert_eq!(unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &raw const lock) }, 0);
	let inode = format!(":{} ", file.metadata().unwrap().ino());
	let pid = format!(" {} ", std::process::id());
	move || match std::fs::read_to_string("/proc/locks") {
		Ok(table) => table
			.lines()
			.filter(|line| line.contains(&pid) && line.contains(&inode))
			.count(),
		Err(_) => 1,
	}
}
