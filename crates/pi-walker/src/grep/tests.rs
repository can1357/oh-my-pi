use std::{
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::sync::mpsc;

use super::{
	ContextLine, Engine, GrepError, GrepOptions, GrepResult, MAX_FILE_BYTES, Match, Mode,
	SearchOptions, grep, scan, search,
};
use crate::{fs::Fs, walk};

struct TempDir(PathBuf);

impl TempDir {
	fn new() -> Self {
		static COUNTER: AtomicU64 = AtomicU64::new(0);
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |d| d.as_nanos());
		let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
		let path =
			std::env::temp_dir().join(format!("pi-walker-grep-{}-{nanos}-{seq}", std::process::id()));
		fs::create_dir_all(&path).expect("create temp dir");
		Self(path.canonicalize().expect("canonical temp dir"))
	}

	fn path(&self) -> &Path {
		&self.0
	}

	fn write(&self, rel: &str, content: impl AsRef<[u8]>) -> PathBuf {
		let path = self.0.join(rel);
		fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
		fs::write(&path, content).expect("write file");
		path
	}
}

impl Drop for TempDir {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.0);
	}
}

fn needle() -> Arc<Engine> {
	Arc::new(compile("needle"))
}

fn compile(pattern: &str) -> Engine {
	Engine::compile(pattern, false, false).expect("compile")
}

/// pi's natives defaults with ignore files off.
fn options(engine: &Arc<Engine>) -> GrepOptions {
	GrepOptions {
		walk: walk::Options { hidden: true, gitignore: false, ..walk::Options::default() },
		..GrepOptions::new(engine.clone())
	}
}

async fn run(root: &Path, opts: &GrepOptions) -> GrepResult {
	grep(&Fs::native(), root, opts.clone())
		.await
		.expect("grep succeeds")
}

/// Runs a streamed search, draining the sink concurrently.
async fn run_sunk(
	root: &Path,
	mut opts: GrepOptions,
) -> (Result<GrepResult, GrepError>, Vec<Vec<Match>>) {
	let (tx, mut rx) = mpsc::channel(4);
	opts.sink = Some(tx);
	let drain = async {
		let mut batches = Vec::new();
		while let Some(batch) = rx.recv().await {
			batches.push(batch);
		}
		batches
	};
	let fs = Fs::native();
	tokio::join!(grep(&fs, root, opts), drain)
}

fn paths(result: &GrepResult) -> Vec<&str> {
	result.matches.iter().map(|m| m.path.as_str()).collect()
}

fn sorted_paths(result: &GrepResult) -> Vec<&str> {
	let mut paths = paths(result);
	paths.sort_unstable();
	paths
}

/// An oversized file whose first bytes are `prefix`.
fn write_oversized(dir: &TempDir, rel: &str, prefix: &str) {
	let mut content = String::with_capacity(5 << 20);
	content.push_str(prefix);
	while content.len() as u64 <= MAX_FILE_BYTES + 256 * 1024 {
		content.push_str("filler line of haystack text\n");
	}
	dir.write(rel, content);
}

#[cfg(unix)]
fn make_fifo(path: &Path) {
	use std::os::unix::ffi::OsStrExt;
	let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("no NUL");
	// SAFETY: `c_path` is a valid NUL-terminated string alive for the call.
	let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
	assert_eq!(rc, 0, "mkfifo: {}", std::io::Error::last_os_error());
}

// ----- in-memory search: rendering, context, limits ------------------------

/// `search` results as `N:text` (match) and `N-text` (context) lines.
fn lines(content: &str, pattern: &str, multiline: bool, opts: SearchOptions) -> Vec<String> {
	let engine = Engine::compile(pattern, false, multiline).expect("compile");
	let res =
		search(&engine, content.as_bytes(), &SearchOptions { multiline, ..opts }).expect("search");
	let mut out = Vec::new();
	for m in res.matches {
		out.extend(m.before.iter().map(|c| format!("{}-{}", c.line, c.text)));
		out.push(format!("{}:{}", m.line, m.text));
		out.extend(m.after.iter().map(|c| format!("{}-{}", c.line, c.text)));
	}
	out
}

fn long_line(pattern: &str, content: impl AsRef<[u8]>, multiline: bool) -> Match {
	let engine = Engine::compile(pattern, false, multiline).expect("compile");
	let opts = SearchOptions { multiline, max_columns: Some(512), ..SearchOptions::default() };
	let res = search(&engine, content.as_ref(), &opts).expect("search");
	res.matches.into_iter().next().expect("one match")
}

#[test]
fn context_lines_are_reported_once_and_stop_at_the_next_match() {
	let doc = "1\n2\nm\n3\nm\n4\n5\n6\nm\n";
	let ctx = |before, after| SearchOptions { before, after, ..SearchOptions::default() };
	assert_eq!(lines(doc, "m", false, ctx(1, 1)), ["2-2", "3:m", "4-3", "5:m", "6-4", "8-6", "9:m"]);
	assert_eq!(lines(doc, "m", false, ctx(3, 0)), [
		"1-1", "2-2", "3:m", "4-3", "5:m", "6-4", "7-5", "8-6", "9:m"
	]);
	let paged = SearchOptions { offset: 1, max_count: Some(1), ..ctx(2, 2) };
	assert_eq!(lines(doc, "m", false, paged), ["5:m", "6-4", "7-5"]);
	let capped = SearchOptions { max_count: Some(1), ..ctx(0, 5) };
	assert_eq!(lines("m\nx\nm\n", "m", false, capped), ["1:m", "2-x"]);
}

#[test]
fn lines_are_trimmed_and_decoded_lossily() {
	assert_eq!(lines("ab\u{a0} \t\n", "ab", false, SearchOptions::default()), ["1:ab"]);
	assert_eq!(lines("\u{2028}x ab \u{3000}\n", "ab", false, SearchOptions::default()), [
		"1:\u{2028}x ab"
	]);
	let engine = compile("ab");
	let res = search(&engine, b"\xff\xff ab\xe2\x82\n", &SearchOptions::default()).expect("search");
	assert_eq!(res.matches[0].text, "\u{fffd}\u{fffd} ab\u{fffd}");
}

#[test]
fn max_columns_cuts_matches_and_context() {
	for (content, max, want) in [
		("abcdefghij", 5, "ab..."),
		("abcdefghij", 2, "..."),
		("ééééé", 6, "é..."),
		("abc", 3, "abc"),
	] {
		let engine = compile("a|é");
		let opts = SearchOptions { max_columns: Some(max), ..SearchOptions::default() };
		let res = search(&engine, format!("{content}\n").as_bytes(), &opts).expect("search");
		assert_eq!(res.matches[0].text, want, "{content} max {max}");
		assert_eq!(res.matches[0].truncated, want != content, "{content} max {max}");
	}
	let engine = compile("match");
	let opts = SearchOptions { before: 1, max_columns: Some(6), ..SearchOptions::default() };
	let res = search(&engine, b"context line\nmatch\n", &opts).expect("search");
	assert_eq!(res.matches[0].before, [ContextLine { line: 1, text: "con...".to_owned() }]);
}

#[test]
fn search_limits_count_one_match_past_the_cap() {
	let doc = b"ab\nab\nab\n";
	let engine = compile("ab");
	for (opts, lines, count, limit) in [
		(SearchOptions::default(), 3, 3, false),
		(SearchOptions { max_count: Some(2), ..SearchOptions::default() }, 2, 3, true),
		(SearchOptions { max_count: Some(3), ..SearchOptions::default() }, 3, 3, true),
		(SearchOptions { max_count: Some(5), ..SearchOptions::default() }, 3, 3, false),
		(SearchOptions { offset: 2, ..SearchOptions::default() }, 1, 3, false),
		(SearchOptions { mode: Mode::Count, ..SearchOptions::default() }, 0, 3, false),
		(SearchOptions { max_count: Some(0), ..SearchOptions::default() }, 1, 2, true),
	] {
		let res = search(&engine, doc, &opts).expect("search");
		assert_eq!(
			(res.matches.len(), res.match_count, res.limit_reached),
			(lines, count, limit),
			"{opts:?}"
		);
	}
}

#[test]
fn line_mode_never_reports_a_cross_line_match() {
	for pattern in [r"a\nb", r"a\sb", r"a(?=\nb)"] {
		let engine = compile(pattern);
		let res = search(&engine, b"xa\nb\na b\n", &SearchOptions::default()).expect("search");
		let found: Vec<_> = res
			.matches
			.iter()
			.map(|m| (m.line, m.text.as_str()))
			.collect();
		let want: &[(u64, &str)] = if pattern == r"a\sb" {
			&[(3, "a b")]
		} else {
			&[]
		};
		assert_eq!(found, want, "{pattern}");
	}
}

#[test]
fn line_anchors_match_at_every_line() {
	for pattern in ["^fn", r"^fn\b", "(?<=^)fn", "fn$"] {
		let engine = compile(pattern);
		let res = search(&engine, b"x\nfn\nfn\n", &SearchOptions::default()).expect("search");
		assert_eq!(res.match_count, 2, "{pattern}");
	}
}

#[test]
fn multiline_matches_merge_adjacent_lines_into_blocks() {
	let ml = SearchOptions::default();
	assert_eq!(lines("foo\nbar\n", r"foo\nbar", true, ml.clone()), ["1:foo\nbar"]);
	assert_eq!(lines("x\nfoo\nbar\n", "^bar", true, ml.clone()), ["3:bar"]);
	assert!(lines("a\nb\n", "a.b", true, ml.clone()).is_empty());
	assert_eq!(lines("a\nb\n", "a[^x]b", true, ml.clone()), ["1:a\nb"]);
	assert_eq!(lines("a\nb\nc\nd\nb\nc\n", r"b\nc|d", true, ml), ["2:b\nc\nd\nb\nc"]);
	let ctx = SearchOptions { before: 1, after: 1, ..SearchOptions::default() };
	assert_eq!(lines("a\nb\nc\nd\n", r"b\nc", true, ctx), ["1-a", "2:b\nc", "4-d"]);
	// A pattern that cannot match `\n` is searched line by line.
	let engine = Engine::compile("ab", false, true).expect("compile");
	let opts = SearchOptions { multiline: true, ..SearchOptions::default() };
	assert_eq!(
		search(&engine, b"ab\nab\nx\nab\n", &opts)
			.expect("search")
			.match_count,
		3
	);
	let engine = Engine::compile(r"ab\n?", false, true).expect("compile");
	assert_eq!(
		search(&engine, b"ab\nab\nx\nab\n", &opts)
			.expect("search")
			.match_count,
		2
	);
}

#[test]
fn binary_buffers_have_no_matches_and_late_nul_lines_end_the_scan() {
	let engine = compile("match");
	let res = search(&engine, b"match\x00\nmatch\n", &SearchOptions::default()).expect("search");
	assert_eq!(res.match_count, 0);
	let pad_lines = (70 << 10) / 13;
	let pad = "padding line\n".repeat(pad_lines);
	let doc = format!("{pad}match 1\nnul \x00 here\nmatch 2\nmatch \x00 3\nmatch 4\n");
	assert_eq!(lines(&doc, "match", false, SearchOptions::default()), [
		format!("{}:match 1", pad_lines + 1),
		format!("{}:match 2", pad_lines + 3)
	]);
	// A NUL in a context line about to be reported ends the scan too.
	let ctx = SearchOptions { before: 1, ..SearchOptions::default() };
	assert_eq!(lines(&doc, "match 2", false, ctx), Vec::<String>::new());
}

#[test]
fn long_line_match_past_the_budget_shows_a_window_around_it() {
	let line = format!("{}deadline [s120]{}", "a".repeat(12_000), "b".repeat(2_400));
	let found = long_line(r"deadline \[s120\]", &line, false);
	assert!(found.truncated);
	assert_eq!(found.column, Some(12_001));
	assert!(found.text.len() <= 512, "window is {} bytes", found.text.len());
	assert!(found.text.starts_with("...a"), "{}", found.text);
	assert!(found.text.ends_with("b..."), "{}", found.text);
	assert!(found.text.contains("deadline [s120]"), "{}", found.text);
}

#[test]
fn long_line_match_near_the_end_cuts_only_the_start() {
	let found = long_line("needle", format!("{}needle", "a".repeat(2_000)), false);
	assert_eq!(found.column, Some(2_001));
	assert!(found.text.len() <= 512);
	assert!(found.text.starts_with("...a"), "{}", found.text);
	assert!(found.text.ends_with("aneedle"), "{}", found.text);
}

#[test]
fn long_line_match_inside_the_head_keeps_the_head() {
	let found = long_line("needle", format!("xx needle {}", "a".repeat(2_000)), false);
	assert_eq!(found.column, Some(4));
	assert_eq!(found.text, format!("xx needle {}...", "a".repeat(499)));
}

#[test]
fn long_line_window_counts_columns_in_characters_and_cuts_on_boundaries() {
	let found =
		long_line("needle", format!("{}needle{}", "é".repeat(3_000), "é".repeat(3_000)), false);
	assert_eq!(found.column, Some(3_001));
	assert!(found.text.len() <= 512);
	assert!(found.text.starts_with("...é") && found.text.ends_with("é..."), "{}", found.text);
	assert!(found.text.contains("needle"));
}

#[test]
fn long_line_window_follows_the_scanners_match() {
	let pad = "a".repeat(12_000);
	let cases = [
		("trailing spaces", "needle +$", format!("{pad}needle   \n"), false),
		("line terminator", r"needle\n", format!("{pad}needle\nnext\n"), true),
		("look-ahead", r"needle(?=\nend)", format!("{pad}needle\nend\n"), true),
		(
			"look-ahead past 128 bytes",
			r"needle(?=\nb{150}END)",
			format!("{pad}needle\n{}END\n", "b".repeat(150)),
			true,
		),
		(
			"look-behind",
			r"(?<=foo\na{12000})needle",
			format!("foo\n{pad}needle{}\n", "b".repeat(100)),
			true,
		),
	];
	for (name, pattern, content, multiline) in cases {
		let found = long_line(pattern, &content, multiline);
		assert!(found.text.contains("needle"), "{name}: {}", found.text);
		assert_eq!(found.column, Some(12_001), "{name}");
	}
}

#[test]
fn long_line_window_maps_the_match_past_invalid_utf8() {
	let mut content = "a".repeat(12_000).into_bytes();
	content.push(0xff);
	content.extend(format!("{}needle{}", "c".repeat(2_000), "b".repeat(2_400)).into_bytes());
	let found = long_line("\u{FFFD}|needle", &content, false);
	assert!(found.text.contains("needle"), "{}", found.text);
	assert_eq!(found.column, Some(14_002));
}

#[test]
fn long_line_window_shows_an_empty_match_at_the_end_of_input() {
	let line = "a".repeat(5_000);
	for (pattern, multiline) in
		[("$", false), (r"\z", false), ("x|$", false), ("$", true), (r"\z", true)]
	{
		let found = long_line(pattern, &line, multiline);
		assert_eq!(found.column, Some(5_001), "{pattern} multiline={multiline}");
		assert!(found.text.starts_with("...a"), "{pattern}: {}", found.text);
		assert!(found.text.ends_with('a'), "{pattern}: {}", found.text);
	}
}

/// Line-mode outcome and matches of the scanner and of the chunked stream.
fn scan_both<M: grep_matcher::Matcher>(
	matcher: &M,
	doc: &[u8],
	params: &scan::ScanParams,
) -> [(scan::ScanOutcome, Vec<Match>); 2] {
	let (mut ours, mut theirs) = (Vec::new(), Vec::new());
	let a = scan::Scanner::default()
		.scan(matcher, false, false, doc, params, &mut ours)
		.unwrap_or_else(|err| panic!("scan: {err}"));
	let b = scan::scan_reader(matcher, doc, params, &mut theirs).expect("stream");
	[(a, ours), (b, theirs)]
}

/// The in-memory scanner and grep-searcher (which streams oversized file
/// roots) agree on every line-mode report: context, offsets, caps, probes.
#[test]
fn scanner_matches_grep_searcher_in_line_mode() {
	let words = ["ab", "x", "abc ab", "y", "", "zab", "a b", "  ab  ", "ccc", "é ab"];
	let mut seed = 0x2545_f491_u64;
	let mut next = move |n: usize| {
		seed = seed
			.wrapping_mul(6_364_136_223_846_793_005)
			.wrapping_add(1_442_695_040_888_963_407);
		((seed >> 33) as usize) % n
	};
	for round in 0..60 {
		let mut doc = String::new();
		for _ in 0..next(40) {
			doc.push_str(words[next(words.len())]);
			doc.push('\n');
		}
		if round % 3 == 0 {
			doc.push_str("ab tail");
		}
		for pattern in ["ab", "^ab", "b$", "a.c", r"ab(?=\s)", "x*", r"\bab\b"] {
			let engine = compile(pattern);
			let params = scan::ScanParams {
				content:     next(4) != 0,
				before:      next(3),
				after:       next(3),
				max_columns: [None, Some(4)][next(2)],
				offset:      [0, 0, 1, 3][next(4)],
				cap:         [None, Some(0), Some(1), Some(2), Some(5)][next(5)],
				probe:       true,
			};
			let [ours, theirs] = match &engine {
				Engine::Rust(m) => scan_both(m, doc.as_bytes(), &params),
				Engine::Pcre(m) => scan_both(m, doc.as_bytes(), &params),
			};
			assert_eq!(ours, theirs, "{pattern} {params:?}\n{doc}");
		}
	}
}

// ----- file roots -----------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn single_file_count_mode_reports_every_match() {
	let dir = TempDir::new();
	let file = dir.write("only.txt", "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n");
	let engine = needle();
	let res =
		run(&file, &GrepOptions { mode: Mode::Count, max_count: Some(2), ..options(&engine) }).await;
	assert_eq!(res.matches.len(), 1);
	assert_eq!(res.matches[0].count, Some(5));
	assert_eq!(res.matches[0].path, file.to_string_lossy());
}

#[tokio::test(flavor = "multi_thread")]
async fn single_file_honours_max_count_per_file_and_keeps_offset() {
	let dir = TempDir::new();
	let hot = dir.write("hot.txt", "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n");
	let engine = needle();
	let res = run(&hot, &GrepOptions {
		max_count: Some(4),
		max_count_per_file: Some(2),
		..options(&engine)
	})
	.await;
	assert_eq!(res.matches.len(), 2);
	assert_eq!(res.files_with_matches, 1);
	assert!(res.limit_reached);
	assert_eq!(res.total_matches, 3, "the scan stops at the match after the cap");

	let res = run(&hot, &GrepOptions {
		max_count: Some(10),
		max_count_per_file: Some(2),
		offset: 2,
		..options(&engine)
	})
	.await;
	assert_eq!(res.matches.iter().map(|m| m.line).collect::<Vec<_>>(), [3, 4]);
}

#[tokio::test(flavor = "multi_thread")]
async fn single_file_root_ignores_glob_but_honours_type() {
	let dir = TempDir::new();
	let file = dir.write("a.rs", "needle\n");
	let engine = needle();
	let glob = GrepOptions { glob: Some("*.md".to_owned()), ..options(&engine) };
	assert_eq!(run(&file, &glob).await.matches.len(), 1);
	let typed = GrepOptions { file_type: Some("ts".to_owned()), ..options(&engine) };
	assert_eq!(run(&file, &typed).await, GrepResult::default());
	let bad_glob = GrepOptions { glob: Some("[".to_owned()), ..options(&engine) };
	assert!(matches!(grep(&Fs::native(), &file, bad_glob).await, Err(GrepError::Glob(_))));
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_file_roots_are_streamed_in_full_or_cut_in_multiline_mode() {
	let dir = TempDir::new();
	let mut content = String::from("needle head\n");
	while content.len() as u64 <= MAX_FILE_BYTES + 1024 {
		content.push_str("filler line of haystack text\n");
	}
	content.push_str("needle tail\n");
	let big = dir.write("big.txt", &content);
	let engine = needle();
	let res = run(&big, &options(&engine)).await;
	assert_eq!(res.total_matches, 2, "a named file is searched in full");
	assert_eq!(res.files_searched, 1);
	assert_eq!(res.skipped_oversized, 0);

	let files = run(&big, &GrepOptions { mode: Mode::FilesWithMatches, ..options(&engine) }).await;
	assert_eq!((files.matches.len(), files.total_matches, files.limit_reached), (1, 1, false));

	let multi = Arc::new(Engine::compile("needle", false, true).expect("compile"));
	let res = run(&big, &GrepOptions { multiline: true, ..options(&multi) }).await;
	assert_eq!(res.total_matches, 1, "multiline mode searches the leading window");
}

#[tokio::test(flavor = "multi_thread")]
async fn streamed_file_root_fails_on_a_line_over_the_limit() {
	let dir = TempDir::new();
	let mut content = vec![b'a'; scan::STREAM_LINE_LIMIT + 1024];
	content.extend_from_slice(b"\nneedle\n");
	let big = dir.write("long.txt", &content);
	let engine = needle();
	let Err(GrepError::Search(reason)) = grep(&Fs::native(), &big, options(&engine)).await else {
		panic!("a line over the limit must fail the search");
	};
	assert!(reason.contains("a line longer than 64 MiB cannot be searched"), "{reason}");
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_and_special_roots() {
	let dir = TempDir::new();
	let engine = needle();
	let missing = grep(&Fs::native(), &dir.path().join("missing"), options(&engine)).await;
	assert!(matches!(missing, Err(GrepError::NotFound(_))));
	#[cfg(unix)]
	{
		let fifo = dir.path().join("direct.fifo");
		make_fifo(&fifo);
		assert_eq!(run(&fifo, &options(&engine)).await, GrepResult::default());
	}
}

// ----- directory roots ------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn directory_counts_searched_files_and_skips_fifos() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle\n");
	dir.write("b.txt", "haystack\n");
	#[cfg(unix)]
	make_fifo(&dir.path().join("skip-me.fifo"));
	let engine = needle();
	let res = run(dir.path(), &options(&engine)).await;
	assert_eq!((res.total_matches, res.files_with_matches, res.files_searched), (1, 1, 2));
	assert_eq!(paths(&res), ["a.txt"]);

	let files = run(dir.path(), &GrepOptions {
		mode: Mode::FilesWithMatches,
		..options(&Arc::new(compile("nothing")))
	})
	.await;
	assert_eq!((files.total_matches, files.files_with_matches, files.files_searched), (0, 0, 2));
}

#[tokio::test(flavor = "multi_thread")]
async fn pcre2_lookaround_and_backreferences_search_directories() {
	let dir = TempDir::new();
	dir.write("lookahead.txt", "foobar\nfoobaz\n");
	dir.write("backreference.txt", "same same\nsame other\n");
	dir.write("models.txt", "dim_customers_status_accepted_values\n");
	for (pattern, path, line) in [
		(r"foo(?=bar)", "lookahead.txt", "foobar"),
		(r"\b(\w+)\s+\1\b", "backreference.txt", "same same"),
		(
			r"(final_incremental_account_id_relationships|dim_customers_status_accepted_values|stg_orders_customer_id_relationships)(?!_[0-9a-f]{32})",
			"models.txt",
			"dim_customers_status_accepted_values",
		),
	] {
		let engine = Arc::new(compile(pattern));
		let res = run(dir.path(), &options(&engine)).await;
		assert_eq!(res.total_matches, 1, "{pattern}");
		assert_eq!((res.matches[0].path.as_str(), res.matches[0].line), (path, 1), "{pattern}");
		assert_eq!(res.matches[0].text, line);
	}

	dir.write("schema.yml", "  - not_null:\n      severity: warn\n");
	let pattern = r"^(\s+)- (not_null|unique|accepted_values|relationships|expression_is_true|[a-z_]+):\s*$\n(?!\1    (arguments|config|description|name):)";
	let engine = Arc::new(Engine::compile(pattern, false, true).expect("compile"));
	let res = run(dir.path(), &GrepOptions { multiline: true, ..options(&engine) }).await;
	assert_eq!(paths(&res), ["schema.yml"]);
	assert_eq!(res.matches[0].line, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn multiline_directory_search_matches_across_lines() {
	let dir = TempDir::new();
	dir.write("code.txt", "fn foo() {\n  return 1;\n}\n");
	let engine = Arc::new(Engine::compile(r"foo\(\) \{\n  return", false, true).expect("compile"));
	let res = run(dir.path(), &GrepOptions { multiline: true, ..options(&engine) }).await;
	assert_eq!(res.total_matches, 1);
	assert_eq!((res.matches[0].path.as_str(), res.matches[0].line), ("code.txt", 1));
	assert_eq!(res.matches[0].text, "fn foo() {\n  return 1;");
}

#[tokio::test(flavor = "multi_thread")]
async fn gitignore_skips_ignored_files_and_directories() {
	let dir = TempDir::new();
	fs::create_dir_all(dir.path().join(".git")).expect("repo marker");
	dir.write(".gitignore", "ignored.rs\nignored-dir/\n");
	dir.write("kept.rs", "needle kept\n");
	dir.write("ignored.rs", "needle ignored\n");
	dir.write("ignored-dir/nested.rs", "needle nested\n");
	dir.write(".git/config.rs", "needle in git\n");
	let engine = needle();
	let mut opts = GrepOptions { glob: Some("*.rs".to_owned()), ..options(&engine) };
	opts.walk.gitignore = true;
	let res = run(dir.path(), &opts).await;
	assert_eq!(paths(&res), ["kept.rs"]);
	assert_eq!(res.files_searched, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn non_recursive_glob_matches_only_direct_children() {
	let dir = TempDir::new();
	dir.write("x.go", "needle root\n");
	dir.write("svc/y.go", "needle nested\n");
	let engine = needle();
	let flat = GrepOptions { glob: Some("*.go".to_owned()), recursive: false, ..options(&engine) };
	assert_eq!(paths(&run(dir.path(), &flat).await), ["x.go"]);
	let deep = GrepOptions { glob: Some("*.go".to_owned()), ..options(&engine) };
	assert_eq!(paths(&run(dir.path(), &deep).await), ["svc/y.go", "x.go"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_naming_directories_searches_their_files() {
	let dir = TempDir::new();
	dir.write("backend/auth/a.ts", "needle auth\n");
	dir.write("frontend/src/main.tsx", "needle main\n");
	dir.write("frontend/src/deep/x.tsx", "needle deep\n");
	dir.write("other/z.ts", "needle other\n");
	let engine = needle();
	for (glob, expected) in [
		(
			"{backend/auth,frontend/src}",
			&["backend/auth/a.ts", "frontend/src/deep/x.tsx", "frontend/src/main.tsx"][..],
		),
		("frontend/sr?", &["frontend/src/deep/x.tsx", "frontend/src/main.tsx"][..]),
		("frontend/sr**", &["frontend/src/deep/x.tsx", "frontend/src/main.tsx"][..]),
		("frontend/src/{main.tsx,App.tsx}", &["frontend/src/main.tsx"][..]),
	] {
		let opts = GrepOptions { glob: Some(glob.to_owned()), recursive: false, ..options(&engine) };
		assert_eq!(paths(&run(dir.path(), &opts).await), expected, "glob {glob}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exclude_drops_matching_files_and_directories() {
	let dir = TempDir::new();
	dir.write("src/app.ts", "needle app\n");
	dir.write("src/app.test.ts", "needle test\n");
	dir.write("src/vendor/lib.ts", "needle vendored\n");
	dir.write("vendor/pkg/index.ts", "needle vendor\n");
	dir.write("gen/schema.ts", "needle gen\n");
	let engine = needle();
	for (exclude, glob, expected) in [
		(&["*.test.ts", "vendor"][..], None, &["gen/schema.ts", "src/app.ts"][..]),
		(
			&["gen/"][..],
			None,
			&["src/app.test.ts", "src/app.ts", "src/vendor/lib.ts", "vendor/pkg/index.ts"][..],
		),
		(&["src/vendor/**"][..], Some("src"), &["src/app.test.ts", "src/app.ts"][..]),
		(
			&["/vendor"][..],
			None,
			&["gen/schema.ts", "src/app.test.ts", "src/app.ts", "src/vendor/lib.ts"][..],
		),
		(&["{vendor,gen}"][..], None, &["src/app.test.ts", "src/app.ts"][..]),
		(
			&[" ", "\\gen\\"][..],
			None,
			&["src/app.test.ts", "src/app.ts", "src/vendor/lib.ts", "vendor/pkg/index.ts"][..],
		),
	] {
		for max_count in [None, Some(10)] {
			let opts = GrepOptions {
				exclude: exclude.iter().map(|p| (*p).to_owned()).collect(),
				glob: glob.map(str::to_owned),
				max_count,
				..options(&engine)
			};
			assert_eq!(
				sorted_paths(&run(dir.path(), &opts).await),
				expected,
				"{exclude:?} {max_count:?}"
			);
		}
	}
	let bad = GrepOptions { exclude: vec!["[".to_owned()], ..options(&engine) };
	let err = grep(&Fs::native(), dir.path(), bad)
		.await
		.expect_err("bad exclude");
	assert!(err.to_string().contains("Invalid exclude pattern"), "{err}");
}

#[tokio::test(flavor = "multi_thread")]
async fn type_filter_limits_search_to_matching_extensions() {
	let dir = TempDir::new();
	let mut expected = Vec::new();
	for index in 0..150 {
		let source = format!("dir_{:02}/source_{index:03}.rs", index % 6);
		dir.write(&source, "needle\n");
		dir.write(&format!("dir_{:02}/note_{index:03}.txt", index % 6), "needle\n");
		expected.push(source);
	}
	expected.sort_unstable();
	let engine = needle();
	let res =
		run(dir.path(), &GrepOptions { file_type: Some("rust".to_owned()), ..options(&engine) })
			.await;
	assert_eq!(paths(&res), expected);
	assert_eq!((res.files_searched, res.files_with_matches), (150, 150));
}

#[tokio::test(flavor = "multi_thread")]
async fn offset_and_limit_apply_in_path_order() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle a1\nneedle a2\n");
	dir.write("b.txt", "needle b1\n");
	dir.write("c.txt", "haystack\n");
	let engine = needle();
	let res =
		run(dir.path(), &GrepOptions { max_count: Some(2), offset: 1, ..options(&engine) }).await;
	assert_eq!((res.total_matches, res.files_with_matches, res.limit_reached), (3, 2, true));
	let found: Vec<_> = res
		.matches
		.iter()
		.map(|m| (m.path.as_str(), m.text.as_str()))
		.collect();
	assert_eq!(found, [("a.txt", "needle a2"), ("b.txt", "needle b1")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn content_pages_preserve_context_and_totals_across_files() {
	let dir = TempDir::new();
	dir.write("a.txt", "before a\nneedle a\nafter a\n");
	dir.write("b.txt", "before b\nneedle b\nafter b\n");
	let engine = needle();
	for (offset, max_count, expected, limited) in [
		(1, Some(0), None, true),
		(1, Some(1), Some("b.txt"), true),
		(1, Some(2), Some("b.txt"), false),
		(2, Some(1), None, false),
		(3, None, None, false),
	] {
		let res = run(dir.path(), &GrepOptions {
			offset,
			max_count,
			before: 1,
			after: 1,
			..options(&engine)
		})
		.await;
		assert_eq!((res.total_matches, res.files_with_matches, res.files_searched), (2, 2, 2));
		assert_eq!(res.limit_reached, limited, "{offset} {max_count:?}");
		assert_eq!(res.matches.len(), usize::from(expected.is_some()));
		if let Some(path) = expected {
			let m = &res.matches[0];
			assert_eq!((m.path.as_str(), m.line, m.text.as_str()), (path, 2, "needle b"));
			assert_eq!(m.before, [ContextLine { line: 1, text: "before b".to_owned() }]);
			assert_eq!(m.after, [ContextLine { line: 3, text: "after b".to_owned() }]);
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn count_mode_limit_applies_to_matches_not_files() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle a1\nneedle a2\n");
	dir.write("b.txt", "needle b1\n");
	let engine = needle();
	let res =
		run(dir.path(), &GrepOptions { mode: Mode::Count, max_count: Some(2), ..options(&engine) })
			.await;
	assert!(res.limit_reached);
	assert_eq!(paths(&res), ["a.txt"]);
	assert_eq!(res.matches[0].count, Some(2));
	// The budget settles after `a.txt`; totals cover the searched prefix.
	assert_eq!((res.total_matches, res.files_searched), (2, 1));

	let res =
		run(dir.path(), &GrepOptions { mode: Mode::Count, max_count: Some(3), ..options(&engine) })
			.await;
	assert_eq!(res.matches.iter().map(|m| m.count).collect::<Vec<_>>(), [Some(2), Some(1)]);
	assert!(res.limit_reached);
}

#[tokio::test(flavor = "multi_thread")]
async fn per_file_cap_preserves_file_diversity() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle 1\nneedle 2\nneedle 3\nneedle 4\nneedle 5\n");
	dir.write("z.txt", "needle z\n");
	let engine = needle();
	for max_count in [Some(4), None] {
		let res = run(dir.path(), &GrepOptions {
			max_count,
			max_count_per_file: Some(2),
			..options(&engine)
		})
		.await;
		assert_eq!(paths(&res), ["a.txt", "a.txt", "z.txt"], "{max_count:?}");
		assert_eq!(res.files_with_matches, 2);
		assert!(res.limit_reached);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn budget_stops_after_the_first_page() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle a1\nneedle a2\n");
	dir.write("z.txt", "needle z\n");
	let engine = needle();
	let res = run(dir.path(), &GrepOptions { max_count: Some(1), ..options(&engine) }).await;
	assert_eq!(paths(&res), ["a.txt"]);
	assert_eq!((res.files_searched, res.total_matches), (1, 2));
	assert!(res.limit_reached);

	dir.write("b.txt", "needle b1\nneedle b2\n");
	dir.write("c.txt", "needle c1\nneedle c2\n");
	let res = run(dir.path(), &GrepOptions {
		max_count: Some(3),
		max_count_per_file: Some(1),
		..options(&engine)
	})
	.await;
	assert_eq!(paths(&res), ["a.txt", "b.txt", "c.txt"]);
	assert_eq!(res.files_searched, 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn large_budget_stops_before_scanning_the_tree() {
	let dir = TempDir::new();
	let file_count = 3_000;
	for index in 0..file_count {
		dir.write(&format!("{index:04}.txt"), "needle\n");
	}
	let engine = needle();
	let res = run(dir.path(), &GrepOptions { max_count: Some(100), ..options(&engine) }).await;
	assert!(res.limit_reached);
	let expected: Vec<String> = (0..100).map(|i| format!("{i:04}.txt")).collect();
	assert_eq!(paths(&res), expected);
	assert!(res.files_searched < file_count / 2, "searched {} files", res.files_searched);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_files_are_searched_over_their_prefix_after_all_others() {
	let dir = TempDir::new();
	write_oversized(&dir, "000_big.txt", "needle big 0\n");
	write_oversized(&dir, "001_big.txt", "needle big 1\n");
	for index in 0..300 {
		dir.write(&format!("normal/file_{index:03}.txt"), "needle normal\n");
	}
	let engine = needle();
	for max_count in [None, Some(1_000)] {
		let res = run(dir.path(), &GrepOptions { max_count, ..options(&engine) }).await;
		let found = paths(&res);
		assert_eq!(found.len(), 302);
		assert!(found[..300].iter().all(|p| p.starts_with("normal/")), "{max_count:?}");
		assert_eq!(found[300..], ["000_big.txt", "001_big.txt"]);
		assert_eq!((res.files_searched, res.skipped_oversized), (302, 0));
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_pass_runs_only_while_the_budget_is_open() {
	let dir = TempDir::new();
	write_oversized(&dir, "00_big.txt", "needle\n");
	let normals: Vec<String> = (0..70).map(|i| format!("01_normal_{i:02}.txt")).collect();
	for path in &normals {
		dir.write(path, "needle\n");
	}
	let engine = needle();
	let res = run(dir.path(), &GrepOptions { max_count: Some(65), ..options(&engine) }).await;
	assert_eq!(paths(&res), normals[..65].iter().map(String::as_str).collect::<Vec<_>>());
	assert_eq!(res.files_searched, 65, "the oversized file stays unsearched");

	let res = run(dir.path(), &GrepOptions { max_count: Some(100), ..options(&engine) }).await;
	let found = paths(&res);
	assert_eq!(found[..70], normals.iter().map(String::as_str).collect::<Vec<_>>());
	assert_eq!(found.last().copied(), Some("00_big.txt"));
	assert_eq!(res.files_searched, 71);
}

#[tokio::test(flavor = "multi_thread")]
async fn oversized_file_matches_follow_normal_ones_regardless_of_path_order() {
	let dir = TempDir::new();
	write_oversized(&dir, "a_big.txt", "needle\n");
	dir.write("z_small.txt", "needle\n");
	let engine = needle();
	let res = run(dir.path(), &options(&engine)).await;
	assert_eq!(paths(&res), ["z_small.txt", "a_big.txt"]);
	assert_eq!((res.files_searched, res.skipped_oversized), (2, 0));
}

fn populate_parity_tree(dir: &TempDir) {
	fs::create_dir_all(dir.path().join(".git")).expect("repo marker");
	dir.write("dir_00/.gitignore", "ignored_match.txt\n");
	dir.write("dir_00/ignored_match.txt", "before ignored\nneedle ignored\nafter ignored\n");
	for index in 0..300 {
		let body = if index % 3 == 0 { "needle" } else { "haystack" };
		dir.write(
			&format!("dir_{:02}/nested_{:02}/file_{index:03}.txt", index % 12, index % 5),
			format!("before {index}\n{body} {index}\nafter {index}\n"),
		);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn budgeted_and_unbounded_searches_agree() {
	let dir = TempDir::new();
	populate_parity_tree(&dir);
	let engine = needle();
	for mode in [Mode::Content, Mode::Count, Mode::FilesWithMatches] {
		let mut opts = GrepOptions { mode, before: 1, after: 1, ..options(&engine) };
		opts.walk.gitignore = true;
		let unbounded = run(dir.path(), &opts).await;
		let budgeted =
			run(dir.path(), &GrepOptions { max_count: Some(10_000), ..opts.clone() }).await;
		assert_eq!(unbounded, budgeted, "{mode:?}");
		assert_eq!(unbounded.files_with_matches, 100);
		assert!(!paths(&unbounded).contains(&"dir_00/ignored_match.txt"));
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn results_do_not_depend_on_worker_count() {
	let dir = TempDir::new();
	populate_parity_tree(&dir);
	write_oversized(&dir, "dir_03/big.txt", "needle big\n");
	let engine = needle();
	for max_count in [None, Some(40)] {
		let with = async |workers| {
			let mut opts = GrepOptions { max_count, before: 1, after: 1, ..options(&engine) };
			opts.walk.workers = Some(workers);
			run(dir.path(), &opts).await
		};
		assert_eq!(with(1).await, with(4).await, "{max_count:?}");
	}
}

/// Files of listings served from the listing cache open by path, not
/// relative to a directory handle; the results do not change.
#[tokio::test(flavor = "multi_thread")]
async fn cached_listings_search_the_same_files_as_fresh_ones() {
	let dir = TempDir::new();
	populate_parity_tree(&dir);
	let engine = needle();
	let mut opts = GrepOptions { before: 1, after: 1, ..options(&engine) };
	let plain = run(dir.path(), &opts).await;
	opts.walk.cache = true;
	let filling = run(dir.path(), &opts).await;
	let cached = run(dir.path(), &opts).await;
	assert_eq!(plain, filling);
	assert_eq!(plain, cached);
}

#[tokio::test(flavor = "multi_thread")]
async fn dropping_a_blocked_search_stops_the_walk() {
	let dir = TempDir::new();
	for index in 0..1_000 {
		dir.write(&format!("{index:04}.txt"), "needle\n");
	}
	let engine = needle();
	let (tx, mut rx) = mpsc::channel(1);
	let opts = GrepOptions { sink: Some(tx), ..options(&engine) };
	let blocked =
		tokio::time::timeout(Duration::from_millis(200), grep(&Fs::native(), dir.path(), opts)).await;
	assert!(blocked.is_err(), "nothing drains the sink");
	let mut received = 0;
	while let Some(batch) = rx.recv().await {
		received += batch.len();
	}
	assert!(received < 1_000, "{received}");
}

#[tokio::test(flavor = "multi_thread")]
async fn sink_receives_bounded_batches_and_the_result_only_counts() {
	let dense = 1024 * 2 + 5;
	let dir = TempDir::new();
	let body = (0..dense).fold(String::new(), |mut body, i| {
		let _ = write!(body, "needle {i}\nctx {i}\n");
		body
	});
	dir.write("dense.txt", body);
	dir.write("small.txt", "needle x\nhay\n");
	dir.write("none.txt", "hay\n");
	let engine = needle();
	for (target, files, searched) in
		[(dir.path().to_path_buf(), 2, 3), (dir.path().join("dense.txt"), 1, 1)]
	{
		let (res, batches) = run_sunk(&target, GrepOptions { after: 1, ..options(&engine) }).await;
		let res = res.expect("grep succeeds");
		assert!(res.matches.is_empty());
		assert_eq!((res.files_with_matches, res.files_searched), (files, searched));
		assert_eq!(res.total_matches, dense as u64 + files - 1);
		assert!(
			batches
				.iter()
				.all(|batch| !batch.is_empty() && batch.len() <= 1024)
		);
		assert!(
			batches
				.iter()
				.all(|batch| batch.iter().all(|m| m.path == batch[0].path))
		);
		let dense_hits: Vec<&Match> = batches
			.iter()
			.flatten()
			.filter(|m| m.path.ends_with("dense.txt"))
			.collect();
		assert_eq!(dense_hits.len(), dense);
		for (i, m) in dense_hits.iter().enumerate() {
			assert_eq!(m.text, format!("needle {i}"));
			assert_eq!(m.after, [ContextLine { line: 2 * i as u64 + 2, text: format!("ctx {i}") }]);
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn sink_count_mode_streams_one_entry_per_matching_file() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle\nneedle\n");
	dir.write("b.txt", "needle\n");
	let engine = needle();
	let (res, batches) =
		run_sunk(dir.path(), GrepOptions { mode: Mode::Count, ..options(&engine) }).await;
	let res = res.expect("grep succeeds");
	assert!(res.matches.is_empty());
	assert_eq!(res.total_matches, 3);
	let mut counts: Vec<(String, Option<u64>)> = batches
		.iter()
		.flatten()
		.map(|m| (m.path.clone(), m.count))
		.collect();
	counts.sort();
	assert_eq!(counts, [("a.txt".to_owned(), Some(2)), ("b.txt".to_owned(), Some(1))]);
}

#[tokio::test(flavor = "multi_thread")]
async fn sink_errors_and_global_limits_fail_the_search() {
	let dir = TempDir::new();
	dir.write("a.txt", "needle\n");
	let engine = needle();
	let (tx, rx) = mpsc::channel(1);
	drop(rx);
	let err = grep(&Fs::native(), dir.path(), GrepOptions { sink: Some(tx), ..options(&engine) })
		.await
		.expect_err("a closed receiver fails the search");
	assert!(matches!(&err, GrepError::Sink(reason) if reason == "grep sink closed"), "{err}");

	let (tx, _rx) = mpsc::channel(1);
	for (max_count, offset) in [(Some(1), 0), (None, 1)] {
		let opts = GrepOptions { max_count, offset, sink: Some(tx.clone()), ..options(&engine) };
		let err = grep(&Fs::native(), dir.path(), opts)
			.await
			.expect_err("limits with a sink");
		assert!(matches!(err, GrepError::StreamLimits));
		assert!(err.to_string().contains("maxCount"));
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn provider_url_trees_report_raw_relative_paths() {
	let (_mem, vfs) = crate::testing::MemFs::with_files(&[
		("mem://root/dir/a.txt", "before\nneedle one\n"),
		("mem://root/dir/sub/b%20c.txt", "needle two\n"),
		("mem://root/dir/skip.txt", "haystack\n"),
		("mem://root/outside.txt", "needle outside\n"),
	]);
	let fs = Fs::Provider(vfs);
	let engine = needle();
	for max_count in [None, Some(10)] {
		let res =
			grep(&fs, Path::new("mem://root/dir"), GrepOptions { max_count, ..options(&engine) })
				.await
				.expect("grep over a URL directory");
		let hits: Vec<_> = res
			.matches
			.iter()
			.map(|m| (m.path.as_str(), m.text.as_str()))
			.collect();
		assert_eq!(hits, [("a.txt", "needle one"), ("sub/b c.txt", "needle two")]);
		assert_eq!(res.files_searched, 3);
	}
	let file = Path::new("mem://root/dir/sub/b%20c.txt");
	let res = grep(&fs, file, GrepOptions { file_type: Some("txt".to_owned()), ..options(&engine) })
		.await
		.expect("grep over a URL file");
	assert_eq!(res.files_searched, 1);
	assert_eq!(paths(&res), ["mem://root/dir/sub/b%20c.txt"]);
	assert_eq!(res.matches[0].text, "needle two");
}

/// A provider whose directories cannot be listed.
#[derive(Debug)]
struct Unlistable(Arc<crate::testing::MemFs>);

#[async_trait::async_trait]
impl pi_vfs::FileSystem for Unlistable {
	async fn open(
		&self,
		path: &Path,
		options: &pi_vfs::OpenOptions,
	) -> std::io::Result<pi_vfs::File> {
		self.0.open(path, options).await
	}

	async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
		self.0.metadata(path).await
	}

	async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
		Err(std::io::ErrorKind::Unsupported.into())
	}
}

/// A root that cannot be listed fails the search with or without a match
/// budget, instead of reporting an empty tree.
#[tokio::test(flavor = "multi_thread")]
async fn unlistable_root_fails_the_search() {
	let (mem, _) = crate::testing::MemFs::with_files(&[("mem://h/dir/a.txt", "needle\n")]);
	let vfs = pi_vfs::Fs::new(Arc::new(Unlistable(mem)));
	let root = Path::new("mem://h/dir");
	let fs = Fs::new(&vfs, root);
	let engine = needle();
	for max_count in [None, Some(10)] {
		let result = grep(&fs, root, GrepOptions { max_count, ..options(&engine) }).await;
		assert!(
			matches!(result, Err(GrepError::Walk(walk::WalkError::Root { ref path, .. })) if path == root),
			"max_count {max_count:?}: {:?}",
			result.map(|r| r.files_searched)
		);
	}
}
