use std::{
	collections::BTreeMap,
	convert::Infallible,
	fs,
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};
#[cfg(unix)]
use std::{
	ffi::OsString,
	os::unix::ffi::{OsStrExt, OsStringExt},
};

use pi_walker::{
	CompiledWalkGlob, Entry, EntryVisitor, FollowLinks, ParallelWalkControl, WalkControl, WalkError,
	WalkFilter, WalkOptions, WalkOrder, WalkRequest, WalkStatus, walk_entries,
};

struct TempTree {
	root: PathBuf,
}

impl TempTree {
	fn new(name: &str) -> Self {
		let unique = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system time should be after UNIX epoch")
			.as_nanos();
		let root = std::env::temp_dir().join(format!("pi-walker-parallel-{name}-{unique}"));
		fs::create_dir(&root).expect("temporary root should be created");
		Self { root }
	}

	fn path(&self) -> &Path {
		&self.root
	}
}

impl Drop for TempTree {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

fn write_file(path: impl AsRef<Path>) {
	let path = path.as_ref();
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).expect("parent directory should be created");
	}
	fs::write(path, b"x").expect("file should be written");
}

#[cfg(unix)]
fn write_file_if_supported(path: impl AsRef<Path>) -> std::io::Result<()> {
	let path = path.as_ref();
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, b"x")
}

fn sorted_serial_candidates(request: &WalkRequest) -> Vec<String> {
	let mut paths = request
		.collect_file_candidates()
		.expect("serial candidate collection should succeed")
		.into_iter()
		.map(|candidate| candidate.relative)
		.collect::<Vec<_>>();
	paths.sort_unstable();
	paths
}

fn sorted_parallel_candidates(request: &WalkRequest) -> Vec<String> {
	let paths = Arc::new(Mutex::new(Vec::new()));
	request
		.for_each_file_candidate_parallel(
			{
				let paths = Arc::clone(&paths);
				move |candidate| {
					paths
						.lock()
						.expect("candidate list mutex should not be poisoned")
						.push(candidate.relative.clone());
					Ok::<_, Infallible>(ParallelWalkControl::Continue)
				}
			},
			|| Ok::<(), Infallible>(()),
		)
		.expect("parallel candidate walk should succeed");
	let mut paths = Arc::into_inner(paths)
		.expect("candidate list should have no remaining owners")
		.into_inner()
		.expect("candidate list mutex should not be poisoned");
	paths.sort_unstable();
	paths
}

fn rs_request(root: &Path) -> WalkRequest {
	WalkRequest::new(root)
		.hidden(false)
		.gitignore(true)
		.skip_node_modules(true)
		.filter(
			WalkFilter::files_only()
				.glob(CompiledWalkGlob::new(["*.rs", "**/*.rs"]).expect("test glob should compile")),
		)
}

#[test]
fn parallel_candidates_match_serial_with_gitignore_hidden_node_modules_and_glob() {
	let tree = TempTree::new("candidate-equivalence");
	write_file(tree.path().join("root.rs"));
	write_file(tree.path().join("root.txt"));
	write_file(tree.path().join(".hidden.rs"));
	write_file(tree.path().join("node_modules/pkg/index.rs"));
	write_file(tree.path().join("src/visible.rs"));
	write_file(tree.path().join("src/note.txt"));
	write_file(tree.path().join("src/nested/keep.rs"));
	write_file(tree.path().join("src/nested/drop.rs"));
	write_file(tree.path().join("src/nested/deeper/other.rs"));
	fs::write(tree.path().join("src/nested/.gitignore"), "*.rs\n!keep.rs\n")
		.expect("nested .gitignore should be written");

	let request = rs_request(tree.path());

	assert_eq!(
		sorted_parallel_candidates(&request),
		sorted_serial_candidates(&request),
		"parallel traversal should return the same accepted candidate set as serial collection"
	);
	assert_eq!(
		sorted_serial_candidates(&request),
		vec!["root.rs", "src/nested/keep.rs", "src/visible.rs"],
		"fixture should exercise the ignore whitelist, hidden-file pruning, node_modules pruning, \
		 and glob filter"
	);
}

fn create_wide_tree(root: &Path, dirs: usize, files_per_dir: usize) {
	for dir_index in 0..dirs {
		let dir = root.join(format!("dir-{dir_index:03}"));
		fs::create_dir_all(&dir).expect("wide-tree directory should be created");
		for file_index in 0..files_per_dir {
			write_file(dir.join(format!("file-{file_index:03}.txt")));
		}
	}
}

#[test]
fn parallel_walk_stops_promptly_when_sink_requests_stop() {
	let tree = TempTree::new("early-stop");
	let full_file_count = 2_000;
	create_wide_tree(tree.path(), 100, full_file_count / 100);
	let request = WalkRequest::new(tree.path()).filter(WalkFilter::files_only());
	let invocations = AtomicUsize::new(0);

	let status = request
		.for_each_file_candidate_parallel(
			|_| {
				let seen = invocations.fetch_add(1, Ordering::SeqCst) + 1;
				if seen >= 5 {
					Ok::<_, Infallible>(ParallelWalkControl::Stop)
				} else {
					Ok(ParallelWalkControl::Continue)
				}
			},
			|| Ok::<(), Infallible>(()),
		)
		.expect("parallel walk should stop without an error");

	assert_eq!(status, WalkStatus::Stopped);
	assert!(
		invocations.load(Ordering::SeqCst) < full_file_count / 2,
		"stop should prevent most candidate callbacks after five files, saw {} of {full_file_count}",
		invocations.load(Ordering::SeqCst)
	);
}

#[test]
fn parallel_walk_returns_sink_error_and_terminates() {
	let tree = TempTree::new("sink-error");
	let full_file_count = 800;
	create_wide_tree(tree.path(), 80, full_file_count / 80);
	let request = WalkRequest::new(tree.path()).filter(WalkFilter::files_only());
	let invocations = AtomicUsize::new(0);

	let result = request.for_each_file_candidate_parallel(
		|_| {
			let seen = invocations.fetch_add(1, Ordering::SeqCst) + 1;
			if seen == 3 {
				Err("sink failed")
			} else {
				Ok(ParallelWalkControl::Continue)
			}
		},
		|| Ok(()),
	);

	match result {
		Err(WalkError::Interrupted("sink failed")) => {},
		other => panic!("sink error should be returned as WalkError::Interrupted, got {other:?}"),
	}
	assert!(
		invocations.load(Ordering::SeqCst) < full_file_count / 2,
		"sink error should terminate traversal instead of visiting most files, saw {} of \
		 {full_file_count}",
		invocations.load(Ordering::SeqCst)
	);
}

#[test]
fn parallel_walk_returns_heartbeat_error_before_visiting_candidates() {
	let tree = TempTree::new("heartbeat-error");
	create_wide_tree(tree.path(), 20, 10);
	let request = WalkRequest::new(tree.path()).filter(WalkFilter::files_only());
	let invocations = AtomicUsize::new(0);

	let result = request.for_each_file_candidate_parallel(
		|_| {
			invocations.fetch_add(1, Ordering::SeqCst);
			Ok(ParallelWalkControl::Continue)
		},
		|| Err("heartbeat failed"),
	);

	match result {
		Err(WalkError::Interrupted("heartbeat failed")) => {},
		other => {
			panic!("heartbeat error should be returned as WalkError::Interrupted, got {other:?}")
		},
	}
	assert!(
		invocations.load(Ordering::SeqCst) < 10,
		"pre-cancelled heartbeat should allow zero or only a few sink calls, saw {}",
		invocations.load(Ordering::SeqCst)
	);
}

#[cfg(unix)]
#[test]
fn parallel_follow_links_always_returns_same_candidates_as_serial_collection() {
	let tree = TempTree::new("follow-links");
	write_file(tree.path().join("target/child.txt"));
	write_file(tree.path().join("target/deeper/grandchild.txt"));
	std::os::unix::fs::symlink(tree.path().join("target"), tree.path().join("link"))
		.expect("directory symlink should be created");
	let request = WalkRequest::new(tree.path())
		.follow_links(FollowLinks::Always)
		.filter(WalkFilter::files_only());

	assert_eq!(
		sorted_parallel_candidates(&request),
		sorted_serial_candidates(&request),
		"follow-links traversal should expose the same candidate set through parallel API and \
		 serial collection"
	);
}

#[test]
fn unordered_and_path_collection_return_equal_sets_and_path_walk_sorts_each_directory() {
	let tree = TempTree::new("serial-order");
	write_file(tree.path().join("βeta.txt"));
	write_file(tree.path().join("alpha.txt"));
	write_file(tree.path().join("space name.txt"));
	write_file(tree.path().join("dir/猫.txt"));
	write_file(tree.path().join("dir/a.txt"));
	write_file(tree.path().join("dir/sub/éclair.txt"));
	write_file(tree.path().join("dir/sub/plain.txt"));
	#[cfg(unix)]
	{
		let _ = write_file_if_supported(
			tree
				.path()
				.join(OsString::from_vec(b"dir/sub/raw-\xFF.txt".to_vec())),
		);
	}

	let unordered = collected_path_set(tree.path(), WalkOrder::Unordered);
	let ordered = collected_path_set(tree.path(), WalkOrder::Path);
	assert_eq!(
		unordered, ordered,
		"serial unordered and path-ordered collection should return the same entry set"
	);

	let mut visitor = DirectoryOrderVisitor::default();
	let status = walk_entries(
		tree.path(),
		WalkOptions { order: WalkOrder::Path, ..WalkOptions::default() },
		&mut visitor,
		|| Ok::<(), Infallible>(()),
	)
	.expect("path-ordered walk should succeed");
	assert_eq!(status, WalkStatus::Complete);
	visitor.assert_each_directory_sorted();
}

fn collected_path_set(root: &Path, order: WalkOrder) -> Vec<String> {
	let mut paths = WalkRequest::new(root)
		.order(order)
		.collect()
		.expect("collection should succeed")
		.entries
		.into_iter()
		.map(|entry| entry.path)
		.collect::<Vec<_>>();
	paths.sort_unstable();
	paths
}

#[derive(Default)]
struct DirectoryOrderVisitor {
	children_by_parent: BTreeMap<String, Vec<Vec<u8>>>,
}

impl DirectoryOrderVisitor {
	fn assert_each_directory_sorted(&self) {
		for (parent, children) in &self.children_by_parent {
			let mut sorted = children.clone();
			sorted.sort_unstable();
			assert_eq!(
				children, &sorted,
				"children of {parent:?} should be visited in lexicographic path order"
			);
		}
	}
}

impl EntryVisitor for DirectoryOrderVisitor {
	type Error = Infallible;

	fn visit(&mut self, entry: Entry<'_>) -> Result<WalkControl, Self::Error> {
		let parent = entry
			.relative
			.rsplit_once('/')
			.map_or_else(String::new, |(parent, _)| parent.to_owned());
		self
			.children_by_parent
			.entry(parent)
			.or_default()
			.push(sort_key(entry.name));
		Ok(WalkControl::Continue)
	}
}

#[cfg(unix)]
fn sort_key(name: &std::ffi::OsStr) -> Vec<u8> {
	name.as_bytes().to_vec()
}

#[cfg(not(unix))]
fn sort_key(name: &std::ffi::OsStr) -> Vec<u8> {
	name.to_string_lossy().into_owned().into_bytes()
}

#[test]
fn parallel_deep_tree_relative_path_preserves_full_component_chain() {
	let tree = TempTree::new("deep-tree");
	let mut dir = tree.path().to_path_buf();
	let mut components = Vec::new();
	for depth in 0..40 {
		let component = format!("a{depth:02}");
		dir.push(&component);
		components.push(component);
	}
	fs::create_dir_all(&dir).expect("deep directory chain should be created");
	write_file(dir.join("leaf.txt"));
	components.push("leaf.txt".to_owned());
	let expected = components.join("/");
	let request = WalkRequest::new(tree.path()).filter(WalkFilter::files_only());

	assert_eq!(
		sorted_parallel_candidates(&request),
		vec![expected],
		"parallel path builder should preserve every nested component in the relative file path"
	);
}
