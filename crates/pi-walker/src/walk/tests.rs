use std::{
	future::Future,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use futures::StreamExt;

use super::*;
use crate::testing::MemFs;

/// A unique, canonical temporary directory removed on drop.
struct TempDir(PathBuf);

impl TempDir {
	fn new(name: &str) -> Self {
		static NEXT: AtomicUsize = AtomicUsize::new(0);
		let n = NEXT.fetch_add(1, Ordering::Relaxed);
		let base = std::env::temp_dir()
			.canonicalize()
			.expect("temp dir canonicalizes");
		let path = base.join(format!("pi-walker-walk-{}-{n}-{name}", std::process::id()));
		let _ = std::fs::remove_dir_all(&path);
		std::fs::create_dir_all(&path).expect("temp dir is created");
		Self(path)
	}

	fn path(&self) -> &Path {
		&self.0
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		#[cfg(unix)]
		restore_permissions(&self.0);
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

/// Makes every directory below `path` accessible again so it can be removed.
#[cfg(unix)]
fn restore_permissions(path: &Path) {
	use std::os::unix::fs::PermissionsExt;
	let Ok(meta) = std::fs::symlink_metadata(path) else {
		return;
	};
	if !meta.is_dir() {
		return;
	}
	let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
	if let Ok(entries) = std::fs::read_dir(path) {
		for entry in entries.flatten() {
			restore_permissions(&entry.path());
		}
	}
}

/// A temporary tree of files (contents after `=`) and directories (trailing
/// `/`).
fn make_tree(name: &str, specs: &[&str]) -> TempDir {
	let dir = TempDir::new(name);
	for spec in specs {
		let (name, contents) = spec.split_once('=').unwrap_or((spec, ""));
		let path = dir.path().join(name);
		if name.ends_with('/') {
			std::fs::create_dir_all(&path).expect("directory is created");
			continue;
		}
		std::fs::create_dir_all(path.parent().expect("file has a parent"))
			.expect("parent is created");
		std::fs::write(&path, contents).expect("file is written");
	}
	dir
}

#[cfg(unix)]
fn symlink(target: &str, link: &Path) {
	std::os::unix::fs::symlink(target, link).expect("symlink is created");
}

fn lossy(entry: &Entry<'_>) -> String {
	entry.path_lossy().into_owned()
}

/// Runs a walk to its end: every output and the directory errors.
async fn drain<T, V>(
	fs: &Fs,
	root: &Path,
	opts: &Options,
	visit: V,
) -> Result<(Vec<T>, Vec<DirError>), WalkError>
where
	T: Send + 'static,
	V: Fn(&mut Worker<'_>, &Entry<'_>, &mut Vec<T>) -> Action + Send + Sync + 'static,
{
	let mut walked = walk(fs, root, opts, visit).await?;
	let mut out = Vec::new();
	while let Some(batch) = walked.next().await {
		assert!(!batch.items.is_empty(), "empty batches are never sent");
		out.extend(batch.items);
	}
	Ok((out, walked.into_errors()))
}

/// Walks `root` and reads every file through the directory handle its batch
/// carries: (path, absolute path, contents).
async fn read_through_batches(
	fs: &Fs,
	root: &Path,
	opts: &Options,
) -> Vec<(String, PathBuf, Vec<u8>)> {
	let mut walked =
		walk(fs, root, opts, |worker, entry, out: &mut Vec<(String, Vec<u8>, PathBuf)>| {
			if entry.file_type == FileType::File {
				out.push((lossy(entry), entry.name().to_vec(), worker.abs(entry).to_path_buf()));
			}
			Action::Continue
		})
		.await
		.expect("walk");
	let mut session = fs.session();
	let mut seen = Vec::new();
	while let Some(batch) = walked.next().await {
		let dir = batch
			.dir
			.expect("an uncached walk keeps its directories open");
		for (path, name, abs) in batch.items {
			let (mut file, info) = session.open_file_at(&dir, &name).await.expect("open");
			assert_eq!(info.size, file.size());
			let mut buf = Vec::new();
			file.read_into(&mut buf, 1 << 20).await.expect("read");
			seen.push((path, abs, buf));
		}
	}
	seen.sort();
	seen
}

/// Runs `fut` on a runtime whose threads have small stacks, so a traversal
/// that recursed (or held a deep ignore chain's drop on the stack) would
/// overflow.
async fn on_small_stack<F>(fut: F) -> F::Output
where
	F: Future + Send + 'static,
	F::Output: Send + 'static,
{
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(1)
		.thread_stack_size(256 * 1024)
		.enable_all()
		.build()
		.expect("runtime");
	let out = runtime.spawn(fut).await.expect("no stack overflow");
	runtime.shutdown_background();
	out
}

/// A listing cache that lives as long as the process, as walks require.
fn leaked_cache(max_bytes: i64) -> &'static cache::Cache {
	Box::leak(Box::new(cache::Cache::new(max_bytes)))
}

/// Collects the paths `opts` admits below `root`, checking that sorted
/// collect is in byte order and that unsorted collect and walk agree with it.
async fn paths_in(fs: &Fs, root: &Path, opts: &Options) -> Vec<String> {
	let sorted = collect(fs, root, opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<String> = sorted.iter().map(|entry| lossy(&entry)).collect();
	assert!(got.is_sorted(), "sorted collect out of order: {got:?}");
	let unordered = collect(fs, root, opts, false, |_, _| Action::Continue)
		.await
		.expect("collect");
	let mut unordered: Vec<String> = unordered.iter().map(|entry| lossy(&entry)).collect();
	unordered.sort();
	assert_eq!(unordered, got, "unsorted collect disagrees");
	let (mut streamed, _) = drain(fs, root, opts, |_, entry, out: &mut Vec<String>| {
		out.push(lossy(entry));
		Action::Continue
	})
	.await
	.expect("walk");
	streamed.sort();
	assert_eq!(streamed, got, "walk disagrees");
	got
}

async fn paths(root: &Path, opts: &Options) -> Vec<String> {
	paths_in(&Fs::native(), root, opts).await
}

fn sorted(mut want: Vec<&str>) -> Vec<String> {
	want.sort_unstable();
	want.into_iter().map(str::to_owned).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn pruning_options() {
	let tmp = make_tree("pruning", &[
		"a.txt",
		".env",
		".hidden/x.txt",
		".git/config",
		"node_modules/m/i.js",
		"src/main.go",
		"src/node_modules",
		"src/.git",
	]);
	assert_eq!(
		paths(tmp.path(), &Options::default()).await,
		sorted(vec![
			"a.txt",
			"node_modules",
			"node_modules/m",
			"node_modules/m/i.js",
			"src",
			"src/main.go",
			"src/node_modules",
		])
	);
	let opts =
		Options { hidden: true, skip_git: true, skip_node_modules: true, ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec![".env", ".hidden", ".hidden/x.txt", "a.txt", "src", "src/main.go"])
	);
	let opts = Options { hidden: true, max_depth: Some(1), ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec![".env", ".git", ".hidden", "a.txt", "node_modules", "src"])
	);
	let opts = Options { hidden: true, max_depth: Some(0), ..Default::default() };
	assert!(paths(tmp.path(), &opts).await.is_empty());
	// One filesystem throughout: staying on it prunes nothing.
	let all = paths(tmp.path(), &Options { hidden: true, ..Default::default() }).await;
	let opts = Options { hidden: true, same_file_system: true, ..Default::default() };
	assert_eq!(paths(tmp.path(), &opts).await, all);
	let tree_opts = TreeOptions { same_file_system: true, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &tree_opts).await, all);
}

#[tokio::test(flavor = "multi_thread")]
async fn ignore_precedence() {
	let tmp = make_tree("precedence", &[
		".git/info/exclude=excluded.txt\n",
		".gitignore=*.log\n!keep.log\nbuild/\n",
		".ignore=!forced.log\n",
		"keep.log",
		"drop.log",
		"forced.log",
		"excluded.txt",
		"build/out.txt",
		"plain/build",
		"sub/.gitignore=!drop.log\n",
		"sub/drop.log",
		"sub/x.log",
	]);
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(
		paths(tmp.path(), &opts).await,
		sorted(vec!["forced.log", "keep.log", "plain", "plain/build", "sub", "sub/drop.log"])
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn ancestor_rules_covering_the_root_are_dropped() {
	let repo = make_tree("ancestors", &[
		".git/",
		".gitignore=target/\n*.o\n",
		"target/sub/a.o",
		"target/sub/b.txt",
	]);
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(paths(&repo.path().join("target/sub"), &opts).await, sorted(vec!["b.txt"]));
	assert_eq!(paths(&repo.path().join("target"), &opts).await, sorted(vec!["sub", "sub/b.txt"]));
	assert!(paths(repo.path(), &opts).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn sorted_collect_matches_full_path_order() {
	let tmp = make_tree("order", &["a/x", "a-b", "a.c", "B", "_", "a/y/z", "a0", "é"]);
	let opts = Options { workers: Some(3), ..Default::default() };
	let got = collect(&Fs::native(), tmp.path(), &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(got, ["B", "_", "a", "a-b", "a.c", "a/x", "a/y", "a/y/z", "a0", "é"]);
}

/// Enough directories and long names that work is shared between workers
/// and paths span several arena chunks.
#[tokio::test(flavor = "multi_thread")]
async fn wide_trees_agree_on_every_worker_count() {
	let tmp = TempDir::new("wide");
	let long = "n".repeat(120);
	for d in 0..60 {
		for s in 0..3 {
			let dir = tmp.path().join(format!("d{d:02}/s{s}"));
			std::fs::create_dir_all(&dir).expect("dir");
			for f in 0..6 {
				std::fs::write(dir.join(format!("{long}-{f}")), "").expect("file");
			}
		}
	}
	let baseline = paths(tmp.path(), &Options { workers: Some(1), ..Default::default() }).await;
	assert_eq!(baseline.len(), 60 + 60 * 3 + 60 * 3 * 6);
	for workers in [2, 4, 8] {
		let opts = Options { workers: Some(workers), ..Default::default() };
		assert_eq!(paths(tmp.path(), &opts).await, baseline, "workers={workers}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn visitor_actions() {
	let tmp = make_tree("actions", &["keep/a", "skip/b", "skip/c/d"]);
	let opts = Options { workers: Some(1), ..Default::default() };
	let (mut seen, _) =
		drain(&Fs::native(), tmp.path(), &opts, |_, entry, out: &mut Vec<String>| {
			out.push(lossy(entry));
			if entry.path == b"skip" {
				Action::SkipDir
			} else {
				Action::Continue
			}
		})
		.await
		.expect("walk");
	seen.sort();
	assert_eq!(seen, ["keep", "keep/a", "skip"]);

	let (visits, _) = drain(&Fs::native(), tmp.path(), &opts, |_, _, out: &mut Vec<()>| {
		out.push(());
		Action::Stop
	})
	.await
	.expect("a visitor stop is not an error");
	assert_eq!(visits.len(), 1);

	// Skip leaves a directory out of a collection but keeps its contents.
	let kept = collect(&Fs::native(), tmp.path(), &opts, true, |_, entry| {
		if entry.file_type == FileType::Dir {
			Action::Skip
		} else {
			Action::Continue
		}
	})
	.await
	.expect("collect");
	let kept: Vec<String> = kept.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(kept, ["keep/a", "skip/b", "skip/c/d"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn collect_filter_rewrites_kept_entries() {
	let tmp = make_tree("rewrite", &["a", "b"]);
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, entry| {
		entry.size = Some(42);
		entry.file_type = FileType::Symlink;
		Action::Continue
	})
	.await
	.expect("collect");
	assert!(
		got.iter()
			.all(|entry| entry.size == Some(42) && entry.file_type == FileType::Symlink)
	);
	assert_eq!(got.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn full_detail_reports_sizes_and_mtimes() {
	let tmp = make_tree("full", &["dir/five=12345", "empty="]);
	let opts = Options { detail: Detail::Full, ..Default::default() };
	let got = collect(&Fs::native(), tmp.path(), &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	for entry in got.iter() {
		let want_size = match entry.path {
			b"dir" => None,
			b"dir/five" => Some(5),
			_ => Some(0),
		};
		assert_eq!(entry.size, want_size, "{}", lossy(&entry));
		let meta = std::fs::symlink_metadata(tmp.path().join(lossy(&entry))).expect("stat");
		let nanos = meta
			.modified()
			.expect("mtime")
			.duration_since(std::time::UNIX_EPOCH)
			.expect("after epoch")
			.as_nanos();
		// NTFS refreshes a directory's entry in its parent's index lazily, so a
		// listing can trail the directory's own mtime there.
		if !(cfg!(windows) && meta.is_dir()) {
			assert_eq!(entry.mtime, Some(i64::try_from(nanos).expect("fits")), "{}", lossy(&entry));
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn batches_carry_the_directory_their_files_open_from() {
	let tmp = make_tree("open", &["x/one=1", "two=22"]);
	let seen = read_through_batches(&Fs::native(), tmp.path(), &Options::default()).await;
	assert_eq!(seen, [
		("two".to_owned(), tmp.path().join("two"), b"22".to_vec()),
		("x/one".to_owned(), tmp.path().join("x").join("one"), b"1".to_vec()),
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_root_is_a_root_error() {
	let tmp = TempDir::new("missing");
	let root = tmp.path().join("nope");
	let err = collect(&Fs::native(), &root, &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect_err("missing root");
	assert!(matches!(err, WalkError::Root { ref path, .. } if *path == root), "{err:?}");
	let file = make_tree("file-root", &["f"]);
	let err =
		drain(&Fs::native(), &file.path().join("f"), &Options::default(), |_, _, _: &mut Vec<()>| {
			Action::Continue
		})
		.await
		.expect_err("file root");
	assert!(matches!(err, WalkError::Root { .. }));
}

/// Dropping a walk before it ends cancels the tasks still listing: the
/// visitor stops being called.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_walk_cancels_it() {
	let tmp = TempDir::new("drop");
	for d in 0..200 {
		let dir = tmp.path().join(format!("d{d:03}"));
		std::fs::create_dir_all(&dir).expect("dir");
		std::fs::write(dir.join("f"), "").expect("file");
	}
	let visits = Arc::new(AtomicUsize::new(0));
	let counted = Arc::clone(&visits);
	let opts = Options { workers: Some(1), ..Default::default() };
	let mut walked = walk(&Fs::native(), tmp.path(), &opts, move |_, _, out: &mut Vec<()>| {
		counted.fetch_add(1, Ordering::Relaxed);
		out.push(());
		Action::Continue
	})
	.await
	.expect("walk");
	assert!(walked.next().await.is_some());
	drop(walked);
	tokio::time::sleep(Duration::from_millis(100)).await;
	let settled = visits.load(Ordering::Relaxed);
	assert!(settled < 300, "walk kept visiting after it was dropped: {settled}");
	tokio::time::sleep(Duration::from_millis(100)).await;
	assert_eq!(visits.load(Ordering::Relaxed), settled);
}

/// Signals when dropped.
struct DropSignal(Option<tokio::sync::oneshot::Sender<()>>);

impl Drop for DropSignal {
	fn drop(&mut self) {
		if let Some(signal) = self.0.take() {
			let _ = signal.send(());
		}
	}
}

/// A provider whose first directory listing signals `entered` and then waits
/// on a gate that is never opened, signalling `dropped` if that listing is
/// dropped.
#[derive(Debug)]
struct GatedListing {
	mem:     Arc<MemFs>,
	entered: parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
	dropped: parking_lot::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

#[async_trait::async_trait]
impl pi_vfs::FileSystem for GatedListing {
	async fn open(
		&self,
		path: &Path,
		options: &pi_vfs::OpenOptions,
	) -> std::io::Result<pi_vfs::File> {
		pi_vfs::FileSystem::open(&*self.mem, path, options).await
	}

	async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
		pi_vfs::FileSystem::metadata(&*self.mem, path).await
	}

	async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
		let _dropped = DropSignal(self.dropped.lock().take());
		let entered = self.entered.lock().take();
		if let Some(entered) = entered {
			let _ = entered.send(());
		}
		match std::future::pending::<std::convert::Infallible>().await {}
	}
}

/// Dropping a [`walk`] or [`collect`] future while the root listing is still
/// awaiting the provider cancels that listing, and no visitor ever runs.
#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_starting_walk_cancels_the_root_listing() {
	for streaming in [true, false] {
		let (mem, _) = MemFs::with_files(&[("mem://h/dir/a.txt", "")]);
		let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
		let (dropped_tx, dropped_rx) = tokio::sync::oneshot::channel();
		let provider = GatedListing {
			mem,
			entered: parking_lot::Mutex::new(Some(entered_tx)),
			dropped: parking_lot::Mutex::new(Some(dropped_tx)),
		};
		let vfs = pi_vfs::Fs::new(Arc::new(provider));
		let root = Path::new("mem://h/dir");
		let fs = Fs::new(&vfs, root);
		let visits = Arc::new(AtomicUsize::new(0));
		let counted = Arc::clone(&visits);
		let starting = async move {
			let opts = Options::default();
			if streaming {
				let _ = walk(&fs, root, &opts, move |_, _, out: &mut Vec<()>| {
					counted.fetch_add(1, Ordering::Relaxed);
					out.push(());
					Action::Continue
				})
				.await;
			} else {
				let _ = collect(&fs, root, &opts, false, move |_, _| {
					counted.fetch_add(1, Ordering::Relaxed);
					Action::Continue
				})
				.await;
			}
		};
		let mut starting = Box::pin(starting);
		tokio::select! {
			() = &mut starting => panic!("a walk over a gated listing cannot finish"),
			entered = entered_rx => entered.expect("the listing is entered"),
		}
		drop(starting);
		tokio::time::timeout(Duration::from_secs(10), dropped_rx)
			.await
			.expect("the dropped walk cancels its pending root listing")
			.expect("the listing signals when dropped");
		assert_eq!(visits.load(Ordering::Relaxed), 0, "streaming {streaming}");
	}
}

#[cfg(unix)]
fn unreadable_dir(path: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).expect("chmod");
	// Privileged runs can read anyway; their tests have nothing to check.
	std::fs::read_dir(path).is_err()
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn unreadable_directories_are_reported() {
	let tmp = make_tree("unreadable", &["locked/x", "open/y"]);
	let locked = tmp.path().join("locked");
	if !unreadable_dir(&locked) {
		return;
	}
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let paths: Vec<String> = got.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(paths, ["locked", "open", "open/y"]);
	let errors: Vec<&Path> = got
		.errors()
		.iter()
		.map(|error| error.path.as_path())
		.collect();
	assert_eq!(errors, [locked.as_path()]);
	let (_, errors) =
		drain(&Fs::native(), tmp.path(), &Options::default(), |_, _, _: &mut Vec<()>| {
			Action::Continue
		})
		.await
		.expect("walk");
	assert_eq!(errors.len(), 1);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn symlinks_are_reported_not_followed() {
	let tmp = make_tree("links", &["real/f"]);
	symlink("real", &tmp.path().join("link"));
	let got = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let got: Vec<(String, FileType)> = got
		.iter()
		.map(|entry| (lossy(&entry), entry.file_type))
		.collect();
	assert_eq!(got, [
		("link".to_owned(), FileType::Symlink),
		("real".to_owned(), FileType::Dir),
		("real/f".to_owned(), FileType::File),
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn follow_links_resolves_targets_and_drops_cycles() {
	let tmp = make_tree("follow", &["real/f=12345", "a/b/g", ".gitignore=ignored\n", "ignored/x"]);
	let root = tmp.path();
	for (name, target) in [
		("link", "real"),
		("file", "real/f"),
		("dangling", "missing"),
		("a/b/up", ".."),
		("a/b/top", "../.."),
		("a/sibling", "../real"),
		("ignoredlnk", "ignored"),
	] {
		symlink(target, &root.join(name));
	}
	let opts =
		Options { gitignore: true, follow_links: true, detail: Detail::Full, ..Default::default() };
	let got = collect(&Fs::native(), root, &opts, true, |_, _| Action::Continue)
		.await
		.expect("collect");
	let typed: Vec<(String, FileType)> = got
		.iter()
		.map(|entry| (lossy(&entry), entry.file_type))
		.collect();
	let dir = FileType::Dir;
	let file = FileType::File;
	let want = [
		("a", dir),
		("a/b", dir),
		("a/b/g", file),
		("a/sibling", dir),
		("a/sibling/f", file),
		("file", file),
		("ignoredlnk", dir),
		("ignoredlnk/x", file),
		("link", dir),
		("link/f", file),
		("real", dir),
		("real/f", file),
	];
	let want: Vec<(String, FileType)> = want
		.iter()
		.map(|&(path, kind)| (path.to_owned(), kind))
		.collect();
	assert_eq!(typed, want);
	let linked = got
		.iter()
		.find(|entry| entry.path == b"file")
		.expect("file link");
	assert_eq!(linked.size, Some(5), "a followed file reports its target's size");
	assert_eq!(
		paths(root, &opts).await,
		want
			.iter()
			.map(|(path, _)| path.clone())
			.collect::<Vec<_>>()
	);

	// Cached listings re-resolve links: retargeting one shows the new tree.
	let cache = leaked_cache(1 << 20);
	let opts = Options { follow_links: true, ..Default::default() };
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	collect_in(&Fs::native(), root, &opts, true, filter, Some(cache))
		.await
		.expect("fill");
	std::fs::remove_file(root.join("link")).expect("unlink");
	symlink("a", &root.join("link"));
	settle();
	let got = collect_in(&Fs::native(), root, &opts, true, filter, Some(cache))
		.await
		.expect("cached");
	let below: Vec<String> = got
		.iter()
		.map(|entry| lossy(&entry))
		.filter(|path| path.starts_with("link/"))
		.collect();
	assert_eq!(below, ["link/b", "link/b/g", "link/sibling", "link/sibling/f"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_walks_use_raw_relative_names_and_url_spellings() {
	let (_mem, blocking) = MemFs::with_files(&[
		("mem://root/dir/a%20b.rs", "alpha"),
		("mem://root/dir/sub/c.rs", "gamma"),
		("mem://root/dir/.gitignore", "*.log\n"),
		("mem://root/dir/x.log", ""),
	]);
	let fs = Fs::Provider(blocking);
	let root = Path::new("mem://root/dir");
	let opts = Options { gitignore: true, ..Default::default() };
	assert_eq!(paths_in(&fs, root, &opts).await, ["a b.rs", "sub", "sub/c.rs"]);
	let seen = read_through_batches(&fs, root, &opts).await;
	assert_eq!(seen, [
		("a b.rs".to_owned(), PathBuf::from("mem://root/dir/a%20b.rs"), b"alpha".to_vec()),
		("sub/c.rs".to_owned(), PathBuf::from("mem://root/dir/sub/c.rs"), b"gamma".to_vec()),
	]);
}

/// Lets every stamp in a tree age past the cache's racy window.
fn settle() {
	std::thread::sleep(Duration::from_millis(120));
}

/// Walks `root` with and without `cache`, requiring identical results.
async fn cached_matches_fresh(
	root: &Path,
	cache: &'static cache::Cache,
	opts: &Options,
) -> Vec<String> {
	let fresh = paths(root, opts).await;
	let cached = collect_in(&Fs::native(), root, opts, true, |_, _| Action::Continue, Some(cache))
		.await
		.expect("cached collect");
	let cached: Vec<String> = cached.iter().map(|entry| lossy(&entry)).collect();
	assert_eq!(cached, fresh);
	fresh
}

#[tokio::test(flavor = "multi_thread")]
async fn cache_follows_tree_changes() {
	let tmp = make_tree("cache-changes", &[
		".git/info/",
		".gitignore=*.log\n",
		"a/b/c/keep.txt",
		"a/b/c/drop.log",
		"a/x.txt",
		"gone.txt",
		"swap",
		"moved/inner.txt",
	]);
	let root = tmp.path();
	let cache = leaked_cache(1 << 20);
	let opts = Options { gitignore: true, workers: Some(2), ..Default::default() };
	let steps: [(&str, &dyn Fn()); 6] = [
		("add deep file", &|| std::fs::write(root.join("a/b/c/new.txt"), "").expect("write")),
		("remove file", &|| std::fs::remove_file(root.join("gone.txt")).expect("remove")),
		("rename dir", &|| {
			std::fs::rename(root.join("moved"), root.join("renamed")).expect("rename");
		}),
		("replace file with dir", &|| {
			std::fs::remove_file(root.join("swap")).expect("remove");
			std::fs::create_dir_all(root.join("swap/child")).expect("mkdir");
		}),
		// Editing an ignore file leaves its directory's stamp alone.
		("edit .gitignore", &|| std::fs::write(root.join(".gitignore"), "*.txt\n").expect("write")),
		// So does creating the exclude file inside .git/info.
		("create exclude", &|| {
			std::fs::write(root.join(".git/info/exclude"), "a/\n").expect("write");
		}),
	];
	for (name, mutate) in steps {
		// Age the tree, then fill the cache, so the mutation is checked
		// against trusted cached listings.
		settle();
		cached_matches_fresh(root, cache, &opts).await;
		mutate();
		let got = cached_matches_fresh(root, cache, &opts).await;
		if name == "add deep file" {
			assert!(got.contains(&"a/b/c/new.txt".to_owned()), "{name}: {got:?}");
		}
	}
}

/// A change in the same timestamp tick as a listing leaves the directory's
/// stamp unchanged, so a just-modified directory must not be served from
/// the cache.
#[tokio::test(flavor = "multi_thread")]
async fn cache_never_serves_fresh_listings() {
	let tmp = make_tree("cache-fresh", &["d/a"]);
	let cache = leaked_cache(1 << 20);
	let opts = Options::default();
	let filter = |_: &mut Worker<'_>, _: &mut Entry<'_>| Action::Continue;
	for i in 0..20 {
		collect_in(&Fs::native(), tmp.path(), &opts, true, filter, Some(cache))
			.await
			.expect("fill");
		let name = format!("d/f{i:02}");
		std::fs::write(tmp.path().join(&name), "").expect("write");
		let got = collect_in(&Fs::native(), tmp.path(), &opts, true, filter, Some(cache))
			.await
			.expect("cached");
		assert!(got.iter().any(|entry| entry.path == name.as_bytes()), "iteration {i}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn cache_eviction_keeps_results_correct() {
	let tmp = make_tree("cache-evict", &["a/1", "b/2", "c/3", "d/e/4"]);
	settle();
	// Every store overflows the budget and evicts.
	let cache = leaked_cache(1);
	for _ in 0..3 {
		cached_matches_fresh(tmp.path(), cache, &Options::default()).await;
	}
}

/// Paths (`""` for the root) and errors a tree traversal reports.
async fn tree_events(
	fs: &Fs,
	root: &Path,
	opts: &TreeOptions,
) -> (Vec<String>, Vec<(PathBuf, String)>) {
	let mut seen = Vec::new();
	let mut errors = Vec::new();
	let mut cursor = Tree::new(fs, root, opts).await.expect("tree");
	while let Some(event) = cursor.next().await {
		match event {
			Event::Entry(entry) => seen.push(String::from_utf8_lossy(entry.path).into_owned()),
			Event::Error(error) => errors.push((error.path.clone(), error.error.to_string())),
		}
	}
	(seen, errors)
}

async fn tree_paths(root: &Path, opts: &TreeOptions) -> Vec<String> {
	let (seen, errors) = tree_events(&Fs::native(), root, opts).await;
	assert!(errors.is_empty(), "{errors:?}");
	seen
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_visits_each_directory_in_name_order_pre_and_post() {
	let tmp = make_tree("tree-order", &["c", "B", "a/x", "a/y/z", "_", "é", "a-b"]);
	let pre = tree_paths(tmp.path(), &TreeOptions::default()).await;
	assert_eq!(pre, ["B", "_", "a", "a/x", "a/y", "a/y/z", "a-b", "c", "é"]);
	let opts =
		TreeOptions { contents_first: true, emit_root: true, min_depth: 0, ..Default::default() };
	let post = tree_paths(tmp.path(), &opts).await;
	assert_eq!(post, ["B", "_", "a/x", "a/y/z", "a/y", "a", "a-b", "c", "é", ""]);
}

/// `Order::Paths` visits files in the byte order of their full paths, which
/// differs from name order where a directory name prefixes a sibling's
/// (`a/x` sorts after `a-b` and `a.txt`); it matches a sorted collect.
#[tokio::test(flavor = "multi_thread")]
async fn tree_path_order_matches_sorted_collect_for_files() {
	let tmp = make_tree("tree-path-order", &["a/x", "a/y/z", "a-b", "a.txt", "ab/q", "b"]);
	let opts = TreeOptions { order: Order::Paths, ..Default::default() };
	let (seen, errors) = tree_events(&Fs::native(), tmp.path(), &opts).await;
	assert!(errors.is_empty(), "{errors:?}");
	let files: Vec<String> = seen
		.into_iter()
		.filter(|path| tmp.path().join(path).is_file())
		.collect();
	assert_eq!(files, ["a-b", "a.txt", "a/x", "a/y/z", "ab/q", "b"]);
	let collected = collect(&Fs::native(), tmp.path(), &Options::default(), true, |_, e| {
		if e.file_type == FileType::File {
			Action::Continue
		} else {
			Action::Skip
		}
	})
	.await
	.expect("collect");
	let sorted: Vec<String> = collected
		.iter()
		.map(|e| e.path_lossy().into_owned())
		.collect();
	assert_eq!(files, sorted);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_depth_bounds_and_root_emission() {
	let tmp = make_tree("tree-depth", &["a/b/c/d"]);
	let opts = TreeOptions { emit_root: true, min_depth: 0, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["", "a", "a/b", "a/b/c", "a/b/c/d"]);
	let opts =
		TreeOptions { emit_root: true, min_depth: 2, max_depth: Some(3), ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["a/b", "a/b/c"]);
	let opts = TreeOptions { min_depth: 3, max_depth: Some(2), ..Default::default() };
	assert!(tree_paths(tmp.path(), &opts).await.is_empty());
	let opts = TreeOptions { emit_root: true, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await[0], "a", "min_depth 1 never reports the root");
	let opts =
		TreeOptions { emit_root: true, min_depth: 0, max_depth: Some(0), ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, [""]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_skip_descends_and_skip_dir_prunes() {
	let tmp = make_tree("tree-skip", &["keep/file.txt", "skip/file.txt"]);
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		let Event::Entry(entry) = event else {
			continue;
		};
		seen.push(String::from_utf8_lossy(entry.path).into_owned());
		if entry.path == b"skip" {
			cursor.skip_dir();
		}
	}
	assert_eq!(seen, ["keep", "keep/file.txt", "skip"]);

	// Dropping the cursor stops the traversal; `skip_dir` on a file or under
	// `contents_first` has no effect.
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &TreeOptions::default())
		.await
		.expect("tree");
	assert!(cursor.next().await.is_some());
	drop(cursor);
	let opts = TreeOptions { contents_first: true, ..Default::default() };
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	let mut seen = Vec::new();
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push(String::from_utf8_lossy(entry.path).into_owned());
		}
		cursor.skip_dir();
	}
	assert_eq!(seen, ["keep/file.txt", "keep", "skip/file.txt", "skip"]);
}

/// Nesting depth must not consume the call stack, and deep trees must not
/// run out of directory handles.
#[tokio::test(flavor = "multi_thread")]
async fn tree_walks_trees_deeper_than_the_thread_stack() {
	const DEPTH: usize = 300;
	let tmp = TempDir::new("tree-deep");
	let mut deepest = tmp.path().to_path_buf();
	for _ in 0..DEPTH {
		deepest.push("d");
	}
	std::fs::create_dir_all(&deepest).expect("deep tree");
	std::fs::write(deepest.join("leaf.txt"), "ok").expect("leaf");
	let leaf = format!("{}leaf.txt", "d/".repeat(DEPTH));
	for contents_first in [false, true] {
		// Deep Windows paths exceed MAX_PATH without the verbatim prefix, which
		// the canonical temp dir already carries there.
		let root = tmp.path().to_path_buf();
		let seen = on_small_stack(async move {
			let opts = TreeOptions { contents_first, ..Default::default() };
			tree_paths(&root, &opts).await
		})
		.await;
		assert_eq!(seen.len(), DEPTH + 1);
		let (first, last) = if contents_first {
			(leaf.as_str(), "d")
		} else {
			("d", leaf.as_str())
		};
		assert_eq!(seen.first().map(String::as_str), Some(first));
		assert_eq!(seen.last().map(String::as_str), Some(last));
	}
}

/// Stopping at the leaf of an ignore chain as deep as path syscalls reach
/// must return rather than overflow the stack while each level's ignore
/// frame is released.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn stopping_at_the_leaf_of_a_deep_ignore_chain_returns() {
	let tmp = TempDir::new("deep-ignore");
	let path_max = usize::try_from(libc::PATH_MAX).expect("PATH_MAX is positive");
	let depth = (path_max - 96 - tmp.path().join("leaf").as_os_str().len()) / 2;
	let mut dir = tmp.path().to_path_buf();
	for _ in 0..depth {
		dir.push("d");
		std::fs::create_dir(&dir).expect("level");
		std::fs::write(dir.join(".ignore"), "*.log\n").expect("ignore file");
	}
	std::fs::write(dir.join("leaf"), "x").expect("leaf");
	let root = tmp.path().to_path_buf();
	let found = on_small_stack(async move {
		let opts = TreeOptions { gitignore: true, ..Default::default() };
		let mut found = false;
		let mut cursor = Tree::new(&Fs::native(), &root, &opts).await.expect("tree");
		while let Some(event) = cursor.next().await {
			if matches!(event, Event::Entry(entry) if entry.name() == b"leaf") {
				found = true;
				break;
			}
		}
		found
	})
	.await;
	assert!(found);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_honours_ignores_and_the_unignored_name() {
	let tmp = make_tree("tree-ignore", &[
		".gitignore=*.md\nbuild/\n",
		"AGENTS.md",
		"README.md",
		"build/AGENTS.md",
		"src/AGENTS.md",
		"src/x.rs",
		".git/HEAD",
	]);
	let opts = TreeOptions {
		gitignore: true,
		skip_git: true,
		unignored_name: Some("AGENTS.md"),
		..Default::default()
	};
	assert_eq!(tree_paths(tmp.path(), &opts).await, [
		".gitignore",
		"AGENTS.md",
		"src",
		"src/AGENTS.md",
		"src/x.rs"
	]);
	let opts = TreeOptions { gitignore: true, skip_git: true, hidden: false, ..Default::default() };
	assert_eq!(tree_paths(tmp.path(), &opts).await, ["src", "src/x.rs"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_missing_root_and_drop_cancellation() {
	let tmp = make_tree("tree-stop", &[]);
	let missing = tmp.path().join("nope");
	let err = Tree::new(&Fs::native(), &missing, &TreeOptions::default())
		.await
		.err()
		.expect("missing");
	assert!(matches!(err, WalkError::Root { ref path, .. } if *path == missing));
	for i in 0..300 {
		std::fs::write(tmp.path().join(format!("f{i:03}")), "").expect("write");
	}
	let mut seen = 0;
	let (fs, opts) = (Fs::native(), TreeOptions::default());
	let mut cursor = Tree::new(&fs, tmp.path(), &opts).await.expect("tree");
	let mut traversal = Box::pin(async {
		while cursor.next().await.is_some() {
			seen += 1;
		}
	});
	assert!(futures::poll!(traversal.as_mut()).is_pending(), "the traversal yields between entries");
	drop(traversal);
	assert!((1..300).contains(&seen), "{seen}");
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_a_file_root_is_reported_alone() {
	let tmp = make_tree("tree-file", &["f=abc"]);
	let opts =
		TreeOptions { emit_root: true, min_depth: 0, detail: Detail::Full, ..Default::default() };
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), &tmp.path().join("f"), &opts)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((entry.path.to_vec(), entry.file_type, entry.size, entry.depth));
		}
	}
	assert_eq!(seen, [(Vec::new(), FileType::File, Some(3), 0)]);
}

#[cfg(not(windows))]
#[tokio::test(flavor = "multi_thread")]
async fn tree_detail_max_depth_limits_full_listings() {
	let tmp = make_tree("tree-detail", &["top=12345", "d/deep=1234"]);
	let opts = TreeOptions { detail: Detail::Full, detail_max_depth: Some(1), ..Default::default() };
	let mut sizes = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), tmp.path(), &opts)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			sizes.push((String::from_utf8_lossy(entry.path).into_owned(), entry.size));
		}
	}
	assert_eq!(sizes, [
		("d".to_owned(), None),
		("d/deep".to_owned(), None),
		("top".to_owned(), Some(5))
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_reports_an_unreadable_root_as_an_error() {
	let tmp = make_tree("tree-unreadable", &["locked/x"]);
	let locked = tmp.path().join("locked");
	if !unreadable_dir(&locked) {
		return;
	}
	let opts = TreeOptions { emit_root: true, min_depth: 0, ..Default::default() };
	let (seen, errors) = tree_events(&Fs::native(), &locked, &opts).await;
	assert_eq!(seen, [""]);
	assert_eq!(errors.len(), 1);
	assert_eq!(errors[0].0, locked);
	let (seen, errors) = tree_events(&Fs::native(), tmp.path(), &TreeOptions::default()).await;
	assert_eq!(seen, ["locked"]);
	assert_eq!(
		errors
			.iter()
			.map(|(path, _)| path.clone())
			.collect::<Vec<_>>(),
		[locked]
	);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_follow_roots_traverses_a_root_link_only() {
	let target = make_tree("tree-roots-target", &["child.txt"]);
	let linked = make_tree("tree-roots-linked", &["linked-child.txt"]);
	symlink(linked.path().to_str().expect("utf-8"), &target.path().join("descendant-link"));
	let parent = TempDir::new("tree-roots-parent");
	let root_link = parent.path().join("root-link");
	symlink(target.path().to_str().expect("utf-8"), &root_link);

	let roots = TreeOptions { follow: Follow::Roots, ..Default::default() };
	assert_eq!(tree_paths(&root_link, &roots).await, ["child.txt", "descendant-link"]);

	let never =
		TreeOptions { follow: Follow::Never, emit_root: true, min_depth: 0, ..Default::default() };
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&Fs::native(), &root_link, &never)
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((entry.path.to_vec(), entry.file_type));
		}
	}
	assert_eq!(seen, [(Vec::new(), FileType::Symlink)]);

	let always = TreeOptions { follow: Follow::Always, ..Default::default() };
	assert_eq!(tree_paths(&root_link, &always).await, [
		"child.txt",
		"descendant-link",
		"descendant-link/linked-child.txt"
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_always_reports_symlink_cycles_to_ancestors() {
	let tmp = make_tree("tree-cycle", &["a/file.txt", "target/child.txt"]);
	let a = tmp.path().join("a");
	symlink("..", &a.join("to_root"));
	symlink(".", &a.join("to_parent"));
	symlink("target", &tmp.path().join("link"));
	let opts = TreeOptions { follow: Follow::Always, ..Default::default() };
	let (seen, mut errors) = tree_events(&Fs::native(), tmp.path(), &opts).await;
	assert_eq!(seen, ["a", "a/file.txt", "link", "link/child.txt", "target", "target/child.txt"]);
	errors.sort();
	assert_eq!(errors, [
		(a.join("to_parent"), "filesystem loop detected".to_owned()),
		(a.join("to_root"), "filesystem loop detected".to_owned()),
	]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn tree_unignored_name_does_not_exempt_followed_directory_links() {
	let tmp = make_tree("tree-unignored-link", &[
		".gitignore=AGENTS.md\n",
		"real/inner.txt",
		"sub/AGENTS.md=rules",
	]);
	symlink("real", &tmp.path().join("AGENTS.md"));
	let opts = TreeOptions {
		follow: Follow::Always,
		gitignore: true,
		unignored_name: Some("AGENTS.md"),
		..Default::default()
	};
	assert_eq!(tree_paths(tmp.path(), &opts).await, [
		".gitignore",
		"real",
		"real/inner.txt",
		"sub",
		"sub/AGENTS.md"
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tree_over_a_provider_spells_urls_and_raw_names() {
	let (_mem, blocking) = MemFs::with_files(&[
		("mem://root/dir/a%20b.rs", "alpha"),
		("mem://root/dir/sub/c.rs", "gamma"),
	]);
	let fs = Fs::Provider(blocking);
	let mut seen = Vec::new();
	let mut cursor = Tree::new(&fs, Path::new("mem://root/dir"), &TreeOptions::default())
		.await
		.expect("tree");
	while let Some(event) = cursor.next().await {
		if let Event::Entry(entry) = event {
			seen.push((String::from_utf8_lossy(entry.path).into_owned(), entry.abs.to_path_buf()));
		}
	}
	assert_eq!(seen, [
		("a b.rs".to_owned(), PathBuf::from("mem://root/dir/a%20b.rs")),
		("sub".to_owned(), PathBuf::from("mem://root/dir/sub")),
		("sub/c.rs".to_owned(), PathBuf::from("mem://root/dir/sub/c.rs")),
	]);
}
