use std::{
	io,
	path::{Path, PathBuf},
	sync::atomic::{AtomicUsize, Ordering},
	time::UNIX_EPOCH,
};

use super::*;
use crate::testing::MemFs;

/// A unique temporary directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
	fn new(tag: &str) -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let n = NEXT.fetch_add(1, Ordering::Relaxed);
		let path = std::env::temp_dir()
			.canonicalize()
			.unwrap()
			.join(format!("pg-fs-{tag}-{}-{n}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).unwrap();
		Self(path)
	}

	fn write(&self, rel: &str, contents: &[u8]) -> PathBuf {
		let path = self.0.join(rel);
		std::fs::create_dir_all(path.parent().unwrap()).unwrap();
		std::fs::write(&path, contents).unwrap();
		path
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

fn names(listing: &Listing) -> Vec<(String, FileType)> {
	let mut names: Vec<_> = listing
		.records()
		.iter()
		.map(|r| (String::from_utf8_lossy(listing.name(r)).into_owned(), r.file_type))
		.collect();
	names.sort_by(|a, b| a.0.cmp(&b.0));
	names
}

async fn read_all(session: &mut Session, dir: &Dir, name: &str, limit: u64) -> (Vec<u8>, FileInfo) {
	let (mut file, info) = session.open_file_at(dir, name.as_bytes()).await.unwrap();
	let mut buf = Vec::new();
	file.read_into(&mut buf, limit).await.unwrap();
	(buf, info)
}

fn mtime_nanos(path: &Path) -> i64 {
	let modified = std::fs::symlink_metadata(path).unwrap().modified().unwrap();
	modified.duration_since(UNIX_EPOCH).unwrap().as_nanos() as i64
}

#[cfg(unix)]
fn mkfifo(path: &Path) {
	use std::os::unix::ffi::OsStrExt;
	let cpath = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
	// SAFETY: `cpath` is a valid NUL-terminated path.
	assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o644) }, 0, "mkfifo {}", path.display());
}

/// Listings omit `.`/`..` and special files and report symlinks unresolved,
/// in both detail levels.
#[tokio::test(flavor = "multi_thread")]
async fn native_listing_reports_names_and_types() {
	let tmp = TempDir::new("list");
	tmp.write("a.txt", b"hello");
	tmp.write("dir/b.txt", b"0123456789");
	#[cfg(unix)]
	{
		std::os::unix::fs::symlink("a.txt", tmp.0.join("link")).unwrap();
		mkfifo(&tmp.0.join("fifo"));
		let _socket = std::os::unix::net::UnixListener::bind(tmp.0.join("sock")).unwrap();
	}
	let fs = Fs::native();
	let mut s = fs.session();
	let mut want = vec![("a.txt".to_owned(), FileType::File), ("dir".to_owned(), FileType::Dir)];
	#[cfg(unix)]
	want.push(("link".to_owned(), FileType::Symlink));
	want.sort_by(|a, b| a.0.cmp(&b.0));
	for detail in [Detail::Minimal, Detail::Full] {
		let dir = s.open_dir(&tmp.0).await.unwrap();
		assert_eq!(names(s.list(&dir, detail, 0).await.unwrap()), want, "{detail:?}");
	}
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let child = s.open_child(&dir, b"dir").await.unwrap();
	assert_eq!(names(s.list(&child, Detail::Minimal, 0).await.unwrap()), [(
		"b.txt".to_owned(),
		FileType::File
	)]);
}

/// Full listings carry regular-file sizes and every entry's mtime.
#[tokio::test(flavor = "multi_thread")]
async fn native_full_listing_has_sizes_and_mtimes() {
	let tmp = TempDir::new("full");
	let file = tmp.write("a.txt", b"hello");
	tmp.write("sub/x", b"");
	tmp.write("sub/y", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let listing = s.list(&dir, Detail::Full, 0).await.unwrap().clone();
	let record = |name: &str| {
		*listing
			.records()
			.iter()
			.find(|r| listing.name(r) == name.as_bytes())
			.unwrap()
	};
	let a = record("a.txt");
	assert_eq!(a.size, Some(5));
	assert_eq!(a.mtime, Some(mtime_nanos(&file)));
	let sub = record("sub");
	assert_eq!(sub.size, None);
	// NTFS refreshes a directory's entry in its parent's index lazily, so a
	// listing can trail the directory's own mtime there.
	if !cfg!(windows) {
		assert_eq!(sub.mtime, Some(mtime_nanos(&tmp.0.join("sub"))));
	}
	if cfg!(target_os = "macos") {
		assert_eq!(sub.children, 2);
	}
	// The parent's entry count lets the child stop early without losing entries.
	let child = s.open_child(&dir, b"sub").await.unwrap();
	let got = names(s.list(&child, Detail::Full, sub.children).await.unwrap());
	assert_eq!(got, [("x".to_owned(), FileType::File), ("y".to_owned(), FileType::File)]);
}

/// Directories larger than one listing buffer need several listing calls;
/// none may lose or repeat entries.
#[tokio::test(flavor = "multi_thread")]
async fn native_listing_spans_several_buffers() {
	let tmp = TempDir::new("big");
	let pad = "n".repeat(100);
	for i in 0..2500 {
		std::fs::write(tmp.0.join(format!("{pad}{i:05}")), b"").unwrap();
	}
	let fs = Fs::native();
	let mut s = fs.session();
	for detail in [Detail::Minimal, Detail::Full] {
		let dir = s.open_dir(&tmp.0).await.unwrap();
		let got = names(s.list(&dir, detail, 0).await.unwrap());
		assert_eq!(got.len(), 2500, "{detail:?}");
		assert!(got.is_sorted_by(|a, b| a.0 < b.0), "{detail:?}: duplicates");
		let dir = s.open_dir(&tmp.0).await.unwrap();
		let mut out = Listing::default();
		s.list_into(&dir, detail, 0, &mut out).await.unwrap();
		assert_eq!(out.len(), 2500);
	}
}

/// A symlink that replaced a listed directory is not followed by
/// `open_child`, while `open_dir` follows symlinks.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn open_child_refuses_symlink_that_replaced_dir() {
	let tmp = TempDir::new("swap");
	tmp.write("d/inner", b"");
	tmp.write("elsewhere/secret", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	assert!(
		s.list(&dir, Detail::Minimal, 0)
			.await
			.unwrap()
			.records()
			.iter()
			.any(|r| r.file_type == FileType::Dir)
	);
	std::fs::rename(tmp.0.join("d"), tmp.0.join("d-old")).unwrap();
	std::os::unix::fs::symlink(tmp.0.join("elsewhere"), tmp.0.join("d")).unwrap();
	assert!(s.open_child(&dir, b"d").await.is_err());
	assert!(s.open_dir(&tmp.0.join("d")).await.is_ok());
}

/// Directories and FIFOs are rejected as not regular, and opening a FIFO
/// does not wait for a writer.
#[tokio::test(flavor = "multi_thread")]
async fn open_file_rejects_dirs_and_special_files() {
	let tmp = TempDir::new("special");
	tmp.write("dir/x", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	let err = s.open_file_at(&dir, b"dir").await.unwrap_err();
	assert!(is_not_regular(&err), "{err:?}");
	assert!(is_not_regular(&s.open_file(&tmp.0.join("dir")).await.unwrap_err()));
	let missing = s.open_file_at(&dir, b"missing").await.unwrap_err();
	assert_eq!(missing.kind(), io::ErrorKind::NotFound);
	assert!(!is_not_regular(&missing));
	#[cfg(unix)]
	{
		mkfifo(&tmp.0.join("fifo"));
		assert!(is_not_regular(&s.open_file_at(&dir, b"fifo").await.unwrap_err()));
		assert!(is_not_regular(&s.open_file(&tmp.0.join("fifo")).await.unwrap_err()));
	}
}

/// `read_into` honours the limit, stops at the open-time size, and reads
/// size-0 files to end of file; `File::read` streams the same bytes.
#[tokio::test(flavor = "multi_thread")]
async fn read_into_honours_limit_and_open_time_size() {
	let tmp = TempDir::new("read");
	let path = tmp.write("f", b"0123456789");
	tmp.write("empty", b"");
	let fs = Fs::native();
	let mut s = fs.session();
	let dir = s.open_dir(&tmp.0).await.unwrap();
	assert_eq!(read_all(&mut s, &dir, "f", 4).await.0, b"0123");
	let (data, info) = read_all(&mut s, &dir, "f", 1 << 20).await;
	assert_eq!((data.as_slice(), info.size), (&b"0123456789"[..], 10));

	// Growth after open is not read; a file empty at open is read to EOF.
	let (mut grown, _) = s.open_file_at(&dir, b"f").await.unwrap();
	let (mut was_empty, info) = s.open_file_at(&dir, b"empty").await.unwrap();
	assert_eq!(info.size, 0);
	std::fs::write(&path, b"0123456789abcdef").unwrap();
	std::fs::write(tmp.0.join("empty"), b"late").unwrap();
	let mut buf = b"stale".to_vec();
	grown.read_into(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"0123456789");
	was_empty.read_into(&mut buf, u64::MAX).await.unwrap();
	assert_eq!(buf, b"late");

	let (mut file, _) = s.open_file(&path).await.unwrap();
	let mut streamed = Vec::new();
	let mut chunk = [0u8; 4];
	loop {
		let n = file.read(&mut chunk).await.unwrap();
		if n == 0 {
			break;
		}
		streamed.extend_from_slice(&chunk[..n]);
	}
	assert_eq!(streamed, b"0123456789abcdef");
	assert_eq!(read_all(&mut s, &dir, "f", 0).await.0, b"");
}

/// Short reads continue until the open-time size, without a confirming
/// zero-length read once it is reached; size 0 reads until a zero-length
/// read.
#[test]
fn read_into_short_reads() {
	let source = b"abcdefghij";
	for (size, want_calls) in [(10, 4), (0, 5)] {
		let mut calls = 0;
		let mut buf = Vec::new();
		fill(&mut buf, size, u64::MAX, |buf, end| {
			calls += 1;
			let start = buf.len();
			let n = (end - start).min(3).min(source.len() - start);
			buf.extend_from_slice(&source[start..start + n]);
			Ok(n)
		})
		.unwrap();
		assert_eq!(buf, source, "size {size}");
		assert_eq!(calls, want_calls, "size {size}");
	}
	let mut buf = Vec::new();
	let mut interrupted = false;
	fill(&mut buf, 10, 6, |buf, end| {
		if !interrupted {
			interrupted = true;
			return Err(io::ErrorKind::Interrupted.into());
		}
		let start = buf.len();
		buf.extend_from_slice(&source[start..end]);
		Ok(end - start)
	})
	.unwrap();
	assert_eq!(buf, b"abcdef");
}

/// Pseudo files report size 0 yet have contents.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn read_into_reads_proc_pseudo_files() {
	let mut s = Fs::native().session();
	let (mut file, info) = s.open_file(Path::new("/proc/self/status")).await.unwrap();
	assert_eq!(info.size, 0);
	let mut buf = Vec::new();
	file.read_into(&mut buf, 1 << 20).await.unwrap();
	assert!(buf.starts_with(b"Name:"), "{}", String::from_utf8_lossy(&buf));
}

/// Stats follow symlinks only when asked; identities agree between path and
/// handle and across a symlink.
#[tokio::test(flavor = "multi_thread")]
async fn stat_and_identify() {
	let tmp = TempDir::new("stat");
	tmp.write("d/f", b"abc");
	let fs = Fs::native();
	let mut s = fs.session();
	let info = s.stat(&tmp.0.join("d/f"), true).await.unwrap();
	assert_eq!((info.file_type, info.size), (Some(FileType::File), 3));
	let dir = s.open_dir(&tmp.0.join("d")).await.unwrap();
	let id = s.identify(&tmp.0.join("d")).await.unwrap();
	assert!(id.native);
	assert_eq!(s.identify_dir(&dir).await.unwrap(), id);
	assert_eq!(
		s.stat_dir(&dir).await.unwrap().ino,
		s.stat(&tmp.0.join("d"), true).await.unwrap().stamp.ino
	);
	// A `.` component (fd's default `CWD/.` root) names the directory itself.
	assert_eq!(
		s.stat(&tmp.0.join("d").join("."), true)
			.await
			.unwrap()
			.file_type,
		Some(FileType::Dir)
	);
	#[cfg(unix)]
	{
		std::os::unix::fs::symlink(tmp.0.join("d"), tmp.0.join("l")).unwrap();
		assert_eq!(s.stat(&tmp.0.join("l"), false).await.unwrap().file_type, Some(FileType::Symlink));
		assert_eq!(s.stat(&tmp.0.join("l"), true).await.unwrap().file_type, Some(FileType::Dir));
		assert_eq!(s.identify(&tmp.0.join("l")).await.unwrap(), id);
	}
	assert_eq!(
		s.stat(&tmp.0.join("missing"), true)
			.await
			.unwrap_err()
			.kind(),
		io::ErrorKind::NotFound
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn join_host_paths() {
	let root = Path::new("/r");
	assert_eq!(Fs::native().join(root, b""), root);
	assert_eq!(Fs::native().join(root, b"a b/c"), root.join("a b").join("c"));
}

/// Provider listings and reads mirror native ones; raw names round-trip
/// through `Fs::join` as percent-encoded URL segments.
#[tokio::test(flavor = "multi_thread")]
async fn provider_lists_and_reads_url_trees() {
	let (mem, vfs) = MemFs::with_files(&[
		("mem://root/a%20b.txt", "hello"),
		("mem://root/dir/c.txt", "0123456789"),
	]);
	mem.add_symlink("mem://root/link", "mem://root/dir");
	mem.add_fifo("mem://root/fifo");
	let root = Path::new("mem://root");
	let fs = Fs::new(&vfs, root);
	assert!(!fs.is_native());
	let mut s = fs.session();
	let dir = s.open_dir(root).await.unwrap();
	let want = [
		("a b.txt".to_owned(), FileType::File),
		("dir".to_owned(), FileType::Dir),
		("link".to_owned(), FileType::Symlink),
	];
	assert_eq!(names(s.list(&dir, Detail::Minimal, 0).await.unwrap()), want);
	let listing = s.list(&dir, Detail::Full, 0).await.unwrap();
	let a = listing
		.records()
		.iter()
		.find(|r| listing.name(r) == b"a b.txt")
		.unwrap();
	assert_eq!(a.size, Some(5));
	assert!(a.mtime.is_some());

	let joined = fs.join(root, b"a b.txt");
	assert_eq!(joined, Path::new("mem://root/a%20b.txt"));
	assert_eq!(fs.join(root, b"dir/c.txt"), Path::new("mem://root/dir/c.txt"));
	let (mut file, info) = s.open_file(&joined).await.unwrap();
	assert_eq!(info.size, 5);
	let mut buf = Vec::new();
	file.read_into(&mut buf, 1 << 20).await.unwrap();
	assert_eq!(buf, b"hello");
	file.read_into(&mut buf, 3).await.unwrap();
	assert_eq!(buf, b"hel");
	assert_eq!(read_all(&mut s, &dir, "a b.txt", 2).await.0, b"he");

	assert!(is_not_regular(&s.open_file_at(&dir, b"dir").await.unwrap_err()));
	assert!(is_not_regular(&s.open_file_at(&dir, b"fifo").await.unwrap_err()));
	assert!(s.open_child(&dir, b"link").await.is_err());
	let child = s.open_child(&dir, b"dir").await.unwrap();
	let (data, _) = read_all(&mut s, &child, "c.txt", 4).await;
	assert_eq!(data, b"0123");
	let stamp = s.stat_dir(&child).await.unwrap();
	assert!(!s.stable_stamps(&child, &stamp));
	assert_eq!(
		s.stat(Path::new("mem://root/link"), false)
			.await
			.unwrap()
			.file_type,
		Some(FileType::Symlink)
	);
	let id = s.identify(Path::new("mem://root/link")).await.unwrap();
	assert!(!id.native);
	assert_eq!(s.identify_dir(&child).await.unwrap(), id);
}

/// Provider names that are not one path component fail the listing.
#[tokio::test(flavor = "multi_thread")]
async fn provider_rejects_invalid_entry_names() {
	let (_mem, vfs) = MemFs::with_files(&[("mem://bad/x%2Fy", "")]);
	let fs = Fs::Provider(vfs);
	let mut s = fs.session();
	let dir = s.open_dir(Path::new("mem://bad")).await.unwrap();
	let err = s.list(&dir, Detail::Minimal, 0).await.unwrap_err();
	assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}

/// A directory from one filesystem kind is refused by another's session.
#[tokio::test(flavor = "multi_thread")]
async fn sessions_refuse_foreign_dirs() {
	let tmp = TempDir::new("foreign");
	let (_mem, vfs) = MemFs::with_files(&[("mem://r/a", "")]);
	let mut native = Fs::native().session();
	let mut provider = Fs::Provider(vfs).session();
	let host_dir = native.open_dir(&tmp.0).await.unwrap();
	let mem_dir = provider.open_dir(Path::new("mem://r")).await.unwrap();
	assert!(native.list(&mem_dir, Detail::Minimal, 0).await.is_err());
	assert!(provider.open_file_at(&host_dir, b"a").await.is_err());
}
