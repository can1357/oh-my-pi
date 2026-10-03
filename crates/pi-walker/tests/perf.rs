//! Ignored deterministic timing harness for pi-walker.
//!
//! Run with:
//! cargo nextest run --cargo-profile ci -p pi-walker --test perf \
//!     --run-ignored ignored-only --no-capture --test-threads=1

use std::{
	fmt::Write as _,
	fs,
	hint::black_box,
	path::{Path, PathBuf},
	sync::LazyLock,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use pi_walker::{WalkDetail, WalkOrder, WalkRequest};

const DIRECTORY_FANOUT: [usize; 5] = [5, 5, 5, 4, 2];
const CONTENT_FILE_COUNT: usize = 15_000;
const NODE_MODULES_PACKAGES: usize = 50;
const NODE_MODULES_FILES_PER_PACKAGE: usize = 10;
const MEASURED_ITERATIONS: usize = 5;

static SYNTHETIC_ROOT: LazyLock<PathBuf> = LazyLock::new(build_synthetic_tree);

#[test]
#[ignore = "run with: cargo nextest run --cargo-profile ci -p pi-walker --test perf --run-ignored \
            ignored-only --no-capture --test-threads=1"]
fn perf_walk_candidates_unordered_gitignore() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_candidates_unordered_gitignore", || {
		let candidates = WalkRequest::new(root)
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Unordered)
			.collect_file_candidates()
			.expect("collect unordered gitignore candidates");
		let count = candidates.len();
		assert!(count > 14_000, "expected a full candidate set, got {count}");
		count
	});
}

#[test]
#[ignore = "run with: cargo nextest run --cargo-profile ci -p pi-walker --test perf --run-ignored \
            ignored-only --no-capture --test-threads=1"]
fn perf_walk_candidates_path_order_no_gitignore() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_candidates_path_order_no_gitignore", || {
		let candidates = WalkRequest::new(root)
			.hidden(true)
			.gitignore(false)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Path)
			.collect_file_candidates()
			.expect("collect path-ordered candidates without gitignore");
		let count = candidates.len();
		assert!(count > 15_000, "expected unignored candidates, got {count}");
		count
	});
}

#[test]
#[ignore = "run with: cargo nextest run --cargo-profile ci -p pi-walker --test perf --run-ignored \
            ignored-only --no-capture --test-threads=1"]
fn perf_walk_collect_full_detail() {
	let root = SYNTHETIC_ROOT.as_path();
	run_bench("perf_walk_collect_full_detail", || {
		let outcome = WalkRequest::new(root)
			.hidden(true)
			.gitignore(true)
			.skip_git(true)
			.skip_node_modules(true)
			.order(WalkOrder::Unordered)
			.detail(WalkDetail::Full)
			.collect()
			.expect("collect full-detail entries");
		let count = outcome.entries.len();
		assert!(count > 15_000, "expected full-detail entries, got {count}");
		count
	});
}

fn run_bench(mut name: &str, mut run: impl FnMut() -> usize) {
	black_box(run());

	let mut timings = [Duration::ZERO; MEASURED_ITERATIONS];
	for timing in &mut timings {
		let started = Instant::now();
		let observed = run();
		let elapsed = started.elapsed();
		black_box(observed);
		*timing = elapsed;
	}

	timings.sort_unstable();
	let median_ms = timings[MEASURED_ITERATIONS / 2].as_secs_f64() * 1_000.0;
	name = black_box(name);
	println!("BENCH {name}: {median_ms:.3} ms");
}

fn build_synthetic_tree() -> PathBuf {
	let root = unique_temp_root("pi-walker-perf");
	fs::create_dir_all(&root).expect("create synthetic root");
	fs::create_dir_all(root.join(".git")).expect("create repo marker");

	let directories = create_directory_layout(&root);
	create_gitignores(&directories);
	create_content_files(&directories);
	create_node_modules(&root);

	root
}

fn unique_temp_root(prefix: &str) -> PathBuf {
	let timestamp = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.expect("system time is after UNIX_EPOCH")
		.as_nanos();
	let pid = std::process::id();
	std::env::temp_dir().join(format!("{prefix}-{pid}-{timestamp}"))
}

fn create_directory_layout(root: &Path) -> Vec<PathBuf> {
	let mut directories = Vec::with_capacity(1_700);
	directories.push(root.to_path_buf());

	let mut level = vec![root.to_path_buf()];
	for (depth, fanout) in DIRECTORY_FANOUT.into_iter().enumerate() {
		let mut next_level = Vec::with_capacity(level.len() * fanout);
		for (parent_index, parent) in level.iter().enumerate() {
			for child in 0..fanout {
				let directory = parent.join(format!("d{depth:02}-{parent_index:04}-{child:02}"));
				fs::create_dir_all(&directory).expect("create synthetic directory");
				directories.push(directory.clone());
				next_level.push(directory);
			}
		}
		level = next_level;
	}

	directories
}

fn create_gitignores(directories: &[PathBuf]) {
	for (directory_id, directory) in directories.iter().enumerate() {
		if directory_id.is_multiple_of(10) {
			let pattern = format!("/ignored-{directory_id:04}-*.txt\n");
			fs::write(directory.join(".gitignore"), pattern).expect("write synthetic gitignore");
		}
	}
}

fn create_content_files(directories: &[PathBuf]) {
	for file_index in 0..CONTENT_FILE_COUNT {
		let directory_id = file_index % directories.len();
		let local_index = file_index / directories.len();
		let file_name = if directory_id.is_multiple_of(10) && local_index == 0 {
			format!("ignored-{directory_id:04}-{local_index:03}.txt")
		} else {
			format!("file-{directory_id:04}-{local_index:03}.txt")
		};
		let path = directories[directory_id].join(file_name);
		fs::write(path, synthetic_content(file_index)).expect("write synthetic content file");
	}
}

fn create_node_modules(root: &Path) {
	let node_modules = root.join("node_modules");
	for package in 0..NODE_MODULES_PACKAGES {
		let package_dir = node_modules.join(format!("pkg-{package:02}"));
		fs::create_dir_all(&package_dir).expect("create synthetic node_modules package");
		for file in 0..NODE_MODULES_FILES_PER_PACKAGE {
			let content_index = CONTENT_FILE_COUNT + package * NODE_MODULES_FILES_PER_PACKAGE + file;
			let path = package_dir.join(format!("file-{file:02}.js"));
			fs::write(path, synthetic_content(content_index))
				.expect("write synthetic node_modules file");
		}
	}
}

fn synthetic_content(file_index: usize) -> String {
	let target_len = 512 + (file_index * 73) % 3_488;
	let has_common_token = (file_index * 37) % 100 < 60;
	let has_rare_token = file_index.is_multiple_of(100);
	let mut content = String::with_capacity(target_len + 96);

	if has_common_token {
		writeln!(content, "common token needle in file {file_index:05}").expect("write to String");
	} else {
		writeln!(content, "ordinary haystack line in file {file_index:05}").expect("write to String");
	}
	if has_rare_token {
		writeln!(content, "rare token NEEDLE_RARE in file {file_index:05}").expect("write to String");
	}

	let filler = format!("line {file_index:05} deterministic pi walker payload text\n");
	while content.len() < target_len {
		content.push_str(&filler);
	}

	content
}
