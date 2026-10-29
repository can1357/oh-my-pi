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

#[cfg(windows)]
#[test]
fn drive_relative_paths_resolve_against_the_shell_cwd_not_the_process_cwd() {
	let p = Path::new;
	let cwd = p(r"C:\Temp\probe");
	// Same drive: the remainder joins onto the shell cwd; `C:` is the cwd
	// itself.
	assert_eq!(absolute_path(cwd, p("C:")), cwd);
	assert_eq!(absolute_path(cwd, p("c:sub")), p(r"C:\Temp\probe\sub"));
	assert_eq!(join_path(p(r"\\?\C:\Temp\probe"), p("C:a")), p(r"\\?\C:\Temp\probe\a"));
	// Another drive (or a URL cwd) has no shell cwd: the drive root stands in.
	assert_eq!(absolute_path(cwd, p("D:sub")), p(r"D:\sub"));
	assert_eq!(absolute_path(p("local://d"), p("C:a")), p(r"C:\a"));
	// Rooted operands are unchanged.
	assert_eq!(absolute_path(cwd, p(r"D:\x")), p(r"D:\x"));
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

/// A host file opened through a cancelled view fails its reads with the
/// cancellation error, never `Interrupted` (which std read loops retry
/// forever); so does a whole-file `read`. The same file through a view
/// without a token reads as before, and a whole-file read through a
/// cancellable view is still one allocation of the file's size.
#[test]
fn host_reads_through_a_cancelled_view_fail_with_the_cancellation_error() {
	let dir = TempDir::new("host-cancel");
	let path = dir.0.join("data");
	std::fs::write(&path, vec![b'x'; 300_000]).unwrap();
	let token = CancellationToken::new();
	let plain = BlockingFs::native();
	let scoped = plain.with_cancellation(token.clone());

	let mut contents = Vec::new();
	scoped
		.open(&path)
		.unwrap()
		.read_to_end(&mut contents)
		.unwrap();
	assert_eq!(contents.len(), 300_000);
	assert_eq!(contents.capacity(), 300_000, "sized from the file, not grown by doubling");
	assert_eq!(scoped.read(&path).unwrap().len(), 300_000);

	let mut opened_before = scoped.open(&path).unwrap();
	token.cancel();
	let errors = [
		opened_before.read(&mut [0; 8]).unwrap_err(),
		scoped
			.open(&path)
			.unwrap()
			.read_to_end(&mut Vec::new())
			.unwrap_err(),
		scoped.read(&path).unwrap_err(),
	];
	for err in errors {
		assert!(is_cancelled(&err), "{err}");
		assert_ne!(err.kind(), io::ErrorKind::Interrupted);
	}

	assert_eq!(plain.read(&path).unwrap().len(), 300_000);
	let mut text = String::new();
	plain
		.open(&path)
		.unwrap()
		.read_to_string(&mut text)
		.unwrap();
	assert_eq!(text.len(), 300_000);
}

/// Through a cancellable view, opening a FIFO waits for a writer as a
/// blocking open does, so even a reader of the bare descriptor (an external
/// child, `$(< f)`) gets a late writer's data. When no writer comes, the open
/// fails once the token fires and leaves no reader behind for a later writer.
#[cfg(unix)]
#[test]
fn fifo_opens_through_a_cancellable_view_wait_for_a_writer_and_observe_the_token() {
	use std::os::unix::fs::OpenOptionsExt;
	let dir = TempDir::new("fifo-cancel");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());

	let writer_path = fifo.clone();
	let writer = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(150));
		std::fs::write(writer_path, "hi").unwrap();
	});
	let opened = scoped.open(&fifo).unwrap();
	let mut descriptor = opened.native().unwrap();
	let mut text = String::new();
	descriptor.read_to_string(&mut text).unwrap();
	writer.join().unwrap();
	assert_eq!(text, "hi");
	drop(opened);

	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(150));
		token.cancel();
	});
	let started = std::time::Instant::now();
	let err = scoped.open(&fifo).unwrap_err();
	canceller.join().unwrap();
	assert!(is_cancelled(&err), "{err}");
	assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
	let late_writer = std::fs::OpenOptions::new()
		.write(true)
		.custom_flags(libc::O_NONBLOCK)
		.open(&fifo)
		.unwrap_err();
	assert_eq!(late_writer.raw_os_error(), Some(libc::ENXIO), "a reader was left open");
}

/// A cancel releases a waiting FIFO open by opening the FIFO for writing,
/// which this process may not do to a FIFO it can only read. Such an open
/// must still return as a blocking open does: as soon as a writer connects,
/// before it writes (a producer may wait for the consumer to act first). It
/// hands back a blocking descriptor that reads all of the writer's data, and
/// a cancel still ends the open.
#[cfg(unix)]
#[test]
fn fifo_this_process_cannot_write_still_opens_on_connect_and_observes_the_token() {
	use std::{
		io::Write,
		os::unix::{ffi::OsStrExt, fs::PermissionsExt},
		sync::mpsc,
	};
	let set_mode = |path: &std::path::Path, mode: u32| {
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
	};
	let dir = TempDir::new("fifo-read-only");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	set_mode(&fifo, 0o400);
	let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
	// SAFETY: `c_path` is a NUL-terminated string alive for the call.
	if unsafe { libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::W_OK, libc::AT_EACCESS) } == 0
	{
		eprintln!(
			"skipped: this process may write a mode 0400 FIFO (root), so the case cannot arise"
		);
		return;
	}
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());

	// The writer connects, then writes only once the reader's open has
	// returned, and pauses between two writes, so a descriptor left
	// non-blocking fails the second read with `WouldBlock`.
	let (opened_tx, opened_rx) = mpsc::channel::<()>();
	let writer_path = fifo.clone();
	let writer = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(150));
		set_mode(&writer_path, 0o600);
		let mut file = std::fs::OpenOptions::new()
			.write(true)
			.open(&writer_path)
			.unwrap();
		set_mode(&writer_path, 0o400);
		let waited = opened_rx.recv_timeout(Duration::from_secs(2));
		file.write_all(b"h").unwrap();
		std::thread::sleep(Duration::from_millis(200));
		file.write_all(b"i").unwrap();
		waited
	});
	let opened = scoped.open(&fifo).unwrap();
	let _ = opened_tx.send(());
	let mut descriptor = opened.native().unwrap();
	let mut text = String::new();
	descriptor.read_to_string(&mut text).unwrap();
	let waited = writer.join().unwrap();
	assert!(waited.is_ok(), "the open waited for the writer's first byte, not its connection");
	assert_eq!(text, "hi");
	drop(opened);

	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(150));
		token.cancel();
	});
	let started = std::time::Instant::now();
	let err = scoped.open(&fifo).unwrap_err();
	canceller.join().unwrap();
	assert!(is_cancelled(&err), "{err}");
	assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
}

/// An async whole-file read of a host file under a token can wait without
/// yielding: `Fs::read` for a FIFO's writer that never comes,
/// `File::read_to_end_async` for data from a writer that connected and never
/// writes. On a current-thread runtime the task that cancels the token then
/// never ran, so the read never ended. Both end at the token now.
#[cfg(unix)]
#[test]
fn async_whole_file_reads_end_at_the_token_on_a_current_thread_runtime() {
	use std::sync::mpsc;
	let dir = TempDir::new("fifo-current-thread");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();

	for idle_writer in [false, true] {
		let token = CancellationToken::new();
		let writer = idle_writer.then(|| {
			let path = fifo.clone();
			std::thread::spawn(move || std::fs::OpenOptions::new().write(true).open(path).unwrap())
		});
		let (done_tx, done_rx) = mpsc::channel();
		let (path, task_token) = (fifo.clone(), token.clone());
		std::thread::spawn(move || {
			let runtime = tokio::runtime::Builder::new_current_thread()
				.enable_all()
				.build()
				.unwrap();
			let result = runtime.block_on(async move {
				let fs = Fs::native().with_cancellation(task_token.clone());
				tokio::spawn(async move {
					tokio::time::sleep(Duration::from_millis(200)).await;
					task_token.cancel();
				});
				if idle_writer {
					fs.open(&path)
						.await?
						.read_to_end_async(&mut Vec::new())
						.await
				} else {
					fs.read(&path).await.map(|contents| contents.len())
				}
			});
			let _ = done_tx.send(result);
		});
		let result = done_rx.recv_timeout(Duration::from_secs(5));
		// Ends a read that ignored the runtime's cancellation.
		token.cancel();
		if let Some(writer) = writer {
			drop(writer.join().unwrap());
		}
		let err = result
			.unwrap_or_else(|_| panic!("idle_writer={idle_writer}: the read ignored its token"))
			.unwrap_err();
		assert!(is_cancelled(&err), "idle_writer={idle_writer}: {err}");
	}
}

/// A FIFO opened non-blocking (`dd iflag=nonblock`) must read without
/// waiting. On Linux such a FIFO with no writer reports no readiness, so a
/// read that first waited for readiness blocked until the token fired
/// instead of returning EOF at once.
#[cfg(unix)]
#[test]
fn fifo_opened_non_blocking_reads_without_waiting() {
	let dir = TempDir::new("fifo-nonblock");
	let fifo = dir.0.join("fifo");
	BlockingFs::native()
		.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
		.unwrap();
	let token = CancellationToken::new();
	let scoped = BlockingFs::native().with_cancellation(token.clone());
	let mut options = OpenOptions::new();
	options.read(true).custom_flags(libc::O_NONBLOCK);
	let mut file = scoped.open_with(&fifo, &options).unwrap();

	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_secs(2));
		token.cancel();
	});
	let started = std::time::Instant::now();
	let read = file.read(&mut [0; 8]);
	let elapsed = started.elapsed();
	assert_eq!(read.ok(), Some(0), "EOF at once");
	assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
	canceller.join().unwrap();
}

/// A write-only open of a FIFO (`echo hi > f`) waits for a reader. Through a
/// cancellable view it still hands the reader its data, and with no reader it
/// fails once the token fires. With mode 0600 a non-blocking read open
/// releases the wait, so no writer is left behind: a later reader reads EOF at
/// once instead of waiting. Mode 0200, which this process may not read,
/// cannot be released, and the open still ends.
#[cfg(unix)]
#[test]
fn fifo_write_opens_through_a_cancellable_view_wait_for_a_reader_and_observe_the_token() {
	use std::os::unix::{
		ffi::OsStrExt,
		fs::{OpenOptionsExt, PermissionsExt},
	};
	for mode in [0o600, 0o200] {
		let dir = TempDir::new("fifo-write");
		let fifo = dir.0.join("fifo");
		BlockingFs::native()
			.make_node(&fifo, crate::NodeKind::Fifo, 0o600)
			.unwrap();
		std::fs::set_permissions(&fifo, std::fs::Permissions::from_mode(mode)).unwrap();
		let c_path = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
		// SAFETY: `c_path` is a NUL-terminated string alive for the call.
		let readable =
			unsafe { libc::faccessat(libc::AT_FDCWD, c_path.as_ptr(), libc::R_OK, libc::AT_EACCESS) }
				== 0;
		if mode == 0o200 && readable {
			eprintln!("skipped mode 0200: this process may read it (root), so the case cannot arise");
			continue;
		}
		let token = CancellationToken::new();
		let scoped = BlockingFs::native().with_cancellation(token.clone());
		let mut redirect = OpenOptions::new();
		redirect.write(true).create(true).truncate(true);

		let reader_path = fifo.clone();
		let reader = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(150));
			let set = |mode| {
				std::fs::set_permissions(&reader_path, std::fs::Permissions::from_mode(mode)).unwrap();
			};
			set(0o600);
			let mut file = std::fs::File::open(&reader_path).unwrap();
			set(mode);
			let mut text = String::new();
			file.read_to_string(&mut text).unwrap();
			text
		});
		let mut writer = scoped.open_with(&fifo, &redirect).unwrap();
		writer.write_all(b"hi").unwrap();
		drop(writer);
		assert_eq!(reader.join().unwrap(), "hi", "mode {mode:o}");

		let canceller = std::thread::spawn(move || {
			std::thread::sleep(Duration::from_millis(150));
			token.cancel();
		});
		let started = std::time::Instant::now();
		let err = scoped.open_with(&fifo, &redirect).unwrap_err();
		canceller.join().unwrap();
		assert!(is_cancelled(&err), "mode {mode:o}: {err}");
		assert!(started.elapsed() < Duration::from_secs(2), "mode {mode:o}: {:?}", started.elapsed());
		if mode == 0o600 {
			let mut late_reader = std::fs::OpenOptions::new()
				.read(true)
				.custom_flags(libc::O_NONBLOCK)
				.open(&fifo)
				.unwrap();
			let read = late_reader.read(&mut [0; 8]);
			assert_eq!(read.ok(), Some(0), "a writer was left open");
		}
	}
}
