use std::{
	fs,
	sync::atomic::{self, AtomicUsize},
};

use super::*;
use crate::testing::MemFs;

struct TempTree {
	root: PathBuf,
}

impl Drop for TempTree {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

/// A fresh temp directory holding `files` (relative path, contents).
fn temp_tree(files: &[(&str, &str)]) -> TempTree {
	static COUNTER: AtomicUsize = AtomicUsize::new(0);
	let seq = COUNTER.fetch_add(1, atomic::Ordering::Relaxed);
	let root = std::env::temp_dir().join(format!("pi-ast-search-{}-{seq}", std::process::id()));
	let _ = fs::remove_dir_all(&root);
	fs::create_dir_all(&root).expect("temp root should be created");
	for &(path, contents) in files {
		let path = root.join(path);
		fs::create_dir_all(path.parent().expect("fixture has a parent"))
			.expect("fixture dir should be created");
		fs::write(path, contents).expect("fixture should be written");
	}
	TempTree { root }
}

/// Candidates as the `astGrep`/`astEdit` natives discover them.
async fn candidates(
	fs: &Fs,
	root: &Path,
	glob: Option<&str>,
	lang: Option<&str>,
) -> Vec<Candidate> {
	let include = glob.map(|glob| Selector::scope(glob, false).expect("glob compiles"));
	let node_modules = include
		.as_ref()
		.is_some_and(Selector::mentions_node_modules);
	let opts = Discover {
		include,
		hidden: true,
		gitignore: true,
		node_modules,
		any_file: lang.is_some(),
		..Default::default()
	};
	discover(fs, root, &opts).await.expect("discovery succeeds")
}

fn displays(candidates: &[Candidate]) -> Vec<&str> {
	candidates
		.iter()
		.map(|candidate| candidate.display.as_str())
		.collect()
}

fn rewrite_spec<'a>(
	rules: &'a [(String, String)],
	lang: Option<&'a str>,
	mode: Mode,
) -> Rewrite<'a> {
	Rewrite {
		rules,
		lang,
		selector: None,
		strictness: MatchStrictness::Smart,
		max_replacements: usize::MAX,
		max_files: usize::MAX,
		fail_on_parse_error: false,
		skip_overlaps: false,
		mode,
	}
}

fn rules(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
	pairs
		.iter()
		.map(|&(pattern, template)| (pattern.to_string(), template.to_string()))
		.collect()
}

async fn rewrite_tree(
	tree: &TempTree,
	spec: &Rewrite<'_>,
	glob: Option<&str>,
) -> Result<Edited, Error> {
	let fs = Fs::native();
	let candidates = candidates(&fs, &tree.root, glob, spec.lang).await;
	rewrite(&fs, candidates, spec).await
}

fn mode(dry_run: bool) -> Mode {
	if dry_run { Mode::Preview } else { Mode::Write }
}

const BROKEN_PYTHON: &str = "def broken(:\n    print(\"BADPY_MARKER\")\n";
const VALID_PYTHON: &str = "def working():\n    print(\"BADPY_MARKER\")\n";
const REWRITTEN_PYTHON: &str = "def working():\n    repr(\"BADPY_MARKER\")\n";

async fn edit_python_tree(
	tree: &TempTree,
	dry_run: bool,
	fail_on_parse_error: bool,
) -> Result<Edited, Error> {
	let rules = rules(&[("print($A)", "repr($A)")]);
	let spec =
		Rewrite { fail_on_parse_error, ..rewrite_spec(&rules, Some("python"), mode(dry_run)) };
	rewrite_tree(tree, &spec, Some("*.py")).await
}

fn compile(pattern: &str, language: SupportLang) -> Pattern {
	ops::compile_pattern(pattern, None, &MatchStrictness::Smart, language).expect("pattern compiles")
}

#[test]
fn detects_missing_python_token_and_preserves_recovered_matches() {
	let ast = SupportLang::Python.ast_grep(BROKEN_PYTHON);
	assert!(!ast.root().dfs().any(|node| node.is_error()));
	assert!(
		ast.root()
			.dfs()
			.any(|node| node.is_missing() && !node.is_named())
	);
	assert!(has_parse_error(&ast));
	let matches: Vec<_> = ast
		.root()
		.find_all(compile("print($A)", SupportLang::Python))
		.collect();
	assert_eq!(matches.len(), 1);
	assert_eq!(matches[0].text(), "print(\"BADPY_MARKER\")");
}

#[test]
fn valid_python_matches_without_parse_errors() {
	let ast = SupportLang::Python.ast_grep(VALID_PYTHON);
	assert!(!has_parse_error(&ast));
	let matches: Vec<_> = ast
		.root()
		.find_all(compile("print($A)", SupportLang::Python))
		.collect();
	assert_eq!(matches.len(), 1);
	assert_eq!(matches[0].text(), "print(\"BADPY_MARKER\")");
}

#[test]
fn detects_existing_typescript_error_nodes() {
	let ast = SupportLang::TypeScript.ast_grep("export function broken( { return 1; }");
	assert!(ast.root().dfs().any(|node| node.is_error()));
	assert!(has_parse_error(&ast));
}

/// Regression for #15950: a pattern that only parses as an ERROR node
/// compiles, so it must surface a warning instead of a silent zero-match.
#[test]
fn error_node_patterns_are_reported_valid_ones_are_not() {
	let patterns = ["123+".to_string(), "foo($A)".to_string()];
	let query = Query {
		patterns:   &patterns,
		lang:       None,
		selector:   None,
		strictness: MatchStrictness::Smart,
		captures:   false,
	};
	let page = Page { offset: 0, limit: usize::MAX };
	let cancel = CancellationToken::new();
	let found = find_source("foo(1);\n", SupportLang::TypeScript, &query, page, &cancel)
		.expect("both patterns compile");
	assert_eq!(found.total_matches, 1);
	assert_eq!(found.warnings.len(), 1, "{:?}", found.warnings);
	assert!(found.warnings[0].starts_with("123+: "), "{:?}", found.warnings);
	assert!(found.warnings[0].contains("ERROR node"), "{:?}", found.warnings);
}

#[test]
fn error_node_warning_bounds_and_escapes_untrusted_pattern() {
	let language = SupportLang::TypeScript;
	let compiled = compile("123+", language);
	let warning = error_node_warning(&format!("123+\t\n{}", "x".repeat(100)), &compiled, language)
		.expect("ERROR-rooted pattern warns");
	assert!(warning.starts_with("123+\\u{9}\\u{a}"));
	assert!(warning.contains("…: pattern is not valid typescript"));
	assert!(!warning.contains('\t'));
	assert!(!warning.contains('\n'));
	assert!(!warning.contains(&"x".repeat(100)));
	let combining = error_node_warning(&"\u{0301}".repeat(100), &compiled, language)
		.expect("ERROR-rooted pattern warns");
	assert!(combining.starts_with(&format!("{}…: ", "\u{0301}".repeat(48))));
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_skips_missing_python_token_in_preview_and_apply() {
	let tree = temp_tree(&[("broken.py", BROKEN_PYTHON)]);
	for dry_run in [true, false] {
		let edited = edit_python_tree(&tree, dry_run, false)
			.await
			.expect("invalid file should be skipped");
		assert_eq!(edited.report.files_searched, 1);
		assert!(edited.files.is_empty());
		assert_eq!(edited.report.warnings, [
			"broken.py: parse error (syntax tree contains error nodes)"
		]);
		assert_eq!(fs::read_to_string(tree.root.join("broken.py")).unwrap(), BROKEN_PYTHON);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_previews_and_applies_valid_python() {
	let tree = temp_tree(&[("valid.py", VALID_PYTHON)]);
	for dry_run in [true, false] {
		let edited = edit_python_tree(&tree, dry_run, false)
			.await
			.expect("valid Python should rewrite");
		assert!(edited.report.warnings.is_empty());
		assert_eq!(edited.files.len(), 1);
		let changes = &edited.files[0].changes;
		assert_eq!(changes.len(), 1);
		assert_eq!(changes[0].before, "print(\"BADPY_MARKER\")");
		assert_eq!(changes[0].after, "repr(\"BADPY_MARKER\")");
		let expected = if dry_run {
			VALID_PYTHON
		} else {
			REWRITTEN_PYTHON
		};
		assert_eq!(fs::read_to_string(tree.root.join("valid.py")).unwrap(), expected);
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn tolerant_rewrite_only_applies_valid_python_files() {
	let tree = temp_tree(&[("a_valid.py", VALID_PYTHON), ("b_broken.py", BROKEN_PYTHON)]);
	let edited = edit_python_tree(&tree, false, false)
		.await
		.expect("tolerant edit should succeed");
	assert_eq!(edited.report.files_searched, 2);
	assert_eq!(edited.files.len(), 1);
	assert_eq!(edited.files[0].changes.len(), 1);
	assert_eq!(edited.report.warnings.len(), 1);
	assert_eq!(fs::read_to_string(tree.root.join("a_valid.py")).unwrap(), REWRITTEN_PYTHON);
	assert_eq!(fs::read_to_string(tree.root.join("b_broken.py")).unwrap(), BROKEN_PYTHON);
}

#[tokio::test(flavor = "multi_thread")]
async fn strict_parse_failure_does_not_partially_write() {
	let tree = temp_tree(&[("a_valid.py", VALID_PYTHON), ("b_broken.py", BROKEN_PYTHON)]);
	for dry_run in [true, false] {
		let Err(Error::Invalid(reason)) = edit_python_tree(&tree, dry_run, true).await else {
			panic!("strict mode should reject the missing token");
		};
		assert!(reason.contains("b_broken.py: parse error"), "{reason}");
		assert_eq!(fs::read_to_string(tree.root.join("a_valid.py")).unwrap(), VALID_PYTHON);
		assert_eq!(fs::read_to_string(tree.root.join("b_broken.py")).unwrap(), BROKEN_PYTHON);
	}
}

fn dummy_match() -> Match {
	let pos = Pos { line: 0, column: 0 };
	Match {
		span:     Span { start: 0, end: 0, start_pos: pos, end_pos: pos },
		text:     String::new(),
		captures: None,
	}
}

#[test]
fn window_materializes_only_the_page() {
	let mut window = Window::new(Page { offset: 1, limit: 2 });
	let mut materialized = 0;
	for start in 1..=100 {
		let key = Key { file: 0, start, end: start + 1, sequence: start as u64 };
		if window.admits(&key) {
			materialized += 1;
			window.retain(Retained { key, matched: dummy_match() });
		}
	}
	assert_eq!(materialized, 4);
	let (page, limit_reached) = window.into_page();
	assert!(limit_reached);
	let starts: Vec<_> = page.iter().map(|retained| retained.key.start).collect();
	assert_eq!(starts, [2, 3]);
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_star_selects_only_direct_children() {
	let tree = temp_tree(&[("a.ts", "const a = 1;\n"), ("nested/b.ts", "const b = 2;\n")]);
	let found = candidates(&Fs::native(), &tree.root, Some("*.ts"), None).await;
	assert_eq!(displays(&found), ["a.ts"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn glob_double_star_selects_recursively() {
	let tree = temp_tree(&[("a.ts", "const a = 1;\n"), ("nested/b.ts", "const b = 2;\n")]);
	let found = candidates(&Fs::native(), &tree.root, Some("**/*.ts"), None).await;
	assert_eq!(displays(&found), ["a.ts", "nested/b.ts"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn discovery_keeps_only_known_languages_unless_one_is_explicit() {
	let tree = temp_tree(&[("a.ts", "const a = 1;\n"), ("notes.unknownext", "x\n")]);
	let fs = Fs::native();
	let known = candidates(&fs, &tree.root, None, None).await;
	assert_eq!(displays(&known), ["a.ts"]);
	let explicit = candidates(&fs, &tree.root, None, Some("ts")).await;
	assert_eq!(displays(&explicit), ["a.ts", "notes.unknownext"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_handles_mixed_language_tree_per_file() {
	let tree = temp_tree(&[("a.ts", "const f = (x) => x;\n"), ("b.rs", "fn main() {}\n")]);
	// The arrow pattern only matches TypeScript; the Rust file is searched in
	// its own language and left untouched instead of failing the whole run.
	let rules = rules(&[("($X) => $X", "identity")]);
	let edited = rewrite_tree(&tree, &rewrite_spec(&rules, None, Mode::Write), None)
		.await
		.expect("mixed-language tree should rewrite per file");
	assert_eq!(edited.files.len(), 1, "only the TypeScript file matches");
	assert_eq!(edited.report.files_searched, 2);
	assert_eq!(fs::read_to_string(tree.root.join("a.ts")).unwrap(), "const f = identity;\n");
	assert_eq!(fs::read_to_string(tree.root.join("b.rs")).unwrap(), "fn main() {}\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_orders_mixed_language_pattern_warnings() {
	let tree = temp_tree(&[("a.js", "const x = 1;\n"), ("b.ts", "const y = 2;\n")]);
	let rules = rules(&[("123+", "ignored")]);
	let edited = rewrite_tree(&tree, &rewrite_spec(&rules, None, Mode::Preview), None)
		.await
		.expect("mixed-language tree should report parse issues");
	let warnings = &edited.report.warnings;
	assert_eq!(warnings.len(), 2, "expected both languages to warn: {warnings:?}");
	assert!(warnings[0].contains("javascript"), "{warnings:?}");
	assert!(warnings[1].contains("typescript"), "{warnings:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_dedupes_identical_matches_across_rules() {
	let tree = temp_tree(&[("a.ts", "const b = foo(bar);\n")]);
	// Both rules rewrite the same call node identically; the deterministic
	// edit applies once instead of failing as an ambiguous overlap.
	let rules = rules(&[("foo($X)", "qux($X)"), ("foo(bar)", "qux(bar)")]);
	let edited = rewrite_tree(&tree, &rewrite_spec(&rules, Some("ts"), Mode::Write), None)
		.await
		.expect("identical duplicate matches should apply cleanly");
	assert_eq!(edited.files[0].changes.len(), 1, "duplicate match must be counted once");
	assert_eq!(fs::read_to_string(tree.root.join("a.ts")).unwrap(), "const b = qux(bar);\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_does_not_partially_write_when_render_fails() {
	// `a.ts` rewrites cleanly; `b.ts` matches both rules with nested ranges, so
	// rendering it fails on the overlap after `a.ts` was already rendered.
	let tree = temp_tree(&[("a.ts", "const a = bar;\n"), ("b.ts", "const b = foo(bar);\n")]);
	let rules = rules(&[("bar", "baz"), ("foo($X)", "qux($X)")]);
	let result = rewrite_tree(&tree, &rewrite_spec(&rules, Some("ts"), Mode::Write), None).await;
	assert!(matches!(result, Err(Error::Invalid(_))), "overlapping edits must fail");
	assert_eq!(fs::read_to_string(tree.root.join("a.ts")).unwrap(), "const a = bar;\n");
	assert_eq!(fs::read_to_string(tree.root.join("b.ts")).unwrap(), "const b = foo(bar);\n");
}

#[test]
fn rewrite_skip_overlaps_keeps_the_outer_match() {
	let rules = rules(&[("foo($X)", "bar($X)")]);
	let spec = Rewrite { skip_overlaps: true, ..rewrite_spec(&rules, None, Mode::Render) };
	let cancel = CancellationToken::new();
	let edit = rewrite_source("foo(foo(1));\n", SupportLang::TypeScript, &spec, &cancel)
		.expect("overlaps are skipped");
	assert_eq!(edit.changes.len(), 1);
	assert_eq!(edit.content, "bar(foo(1));\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn find_streams_files_with_single_and_multi_captures() {
	let tree = temp_tree(&[
		("a.ts", "const a = foo(1, 2);\n"),
		("b.ts", "const b = 1;\n"),
		("c.ts", "foo(x, y, z);\n"),
	]);
	let fs = Fs::native();
	let patterns = ["foo($A, $$$REST)".to_string()];
	let query = Query {
		patterns:   &patterns,
		lang:       None,
		selector:   None,
		strictness: MatchStrictness::Smart,
		captures:   true,
	};
	let found = candidates(&fs, &tree.root, None, None).await;
	let mut finder = find(&fs, found, &query);
	let mut files = Vec::new();
	while let Some(file) = finder.next().await {
		files.push(file.expect("search succeeds"));
	}
	let report = finder.report();
	assert_eq!(report.files_searched, 3);
	let shown: Vec<_> = files.iter().map(|file| file.display.as_str()).collect();
	assert_eq!(shown, ["a.ts", "c.ts"]);

	let matched = &files[0].matches[0];
	assert_eq!(matched.text, "foo(1, 2)");
	assert_eq!((matched.span.start, matched.span.end), (10, 19));
	assert_eq!(matched.span.start_pos, Pos { line: 0, column: 10 });
	let captures = matched.captures.as_ref().expect("captures requested");
	let a = &captures.single["A"];
	assert_eq!((a.text.as_str(), a.span.start), ("1", 14));
	let rest: Vec<_> = captures.multi["REST"]
		.iter()
		.map(|capture| capture.text.as_str())
		.collect();
	assert_eq!(rest, ["2"]);
	let captures = files[1].matches[0]
		.captures
		.as_ref()
		.expect("captures requested");
	let rest: Vec<_> = captures.multi["REST"]
		.iter()
		.map(|capture| capture.text.as_str())
		.collect();
	assert_eq!(rest, ["y", ",", "z"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn find_page_orders_and_pages_across_files() {
	let tree = temp_tree(&[("a.ts", "foo(1);\nfoo(2);\n"), ("b.ts", "foo(3);\n")]);
	let fs = Fs::native();
	let patterns = ["foo($A)".to_string()];
	let query = Query {
		patterns:   &patterns,
		lang:       None,
		selector:   None,
		strictness: MatchStrictness::Smart,
		captures:   false,
	};
	let page = Page { offset: 1, limit: 1 };
	let candidates = candidates(&fs, &tree.root, None, None).await;
	let found = find_page(&fs, candidates, &query, page)
		.await
		.expect("search succeeds");
	assert_eq!(found.total_matches, 3);
	assert_eq!(found.files_with_matches, 2);
	assert!(found.limit_reached);
	assert_eq!(found.hits.len(), 1);
	assert_eq!(
		(found.hits[0].display.as_str(), found.hits[0].matched.text.as_str()),
		("a.ts", "foo(2)")
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn rewrite_goes_through_the_provider_for_url_trees() {
	let (mem, fs) = MemFs::with_files(&[
		("mem://root/src/a.ts", "const f = (x) => x;\n"),
		("mem://root/src/nested/b.ts", "const g = (y) => y;\n"),
		("mem://root/other.ts", "const h = (z) => z;\n"),
	]);
	let rules = rules(&[("($X) => $X", "identity")]);
	let found = candidates(&fs, Path::new("mem://root/src"), None, None).await;
	let edited = rewrite(&fs, found, &rewrite_spec(&rules, None, Mode::Write))
		.await
		.expect("URL tree should rewrite through the provider");
	let shown: Vec<_> = edited
		.files
		.iter()
		.map(|file| file.display.as_str())
		.collect();
	assert_eq!(shown, ["a.ts", "nested/b.ts"]);
	assert_eq!(mem.contents("mem://root/src/a.ts").as_deref(), Some("const f = identity;\n"));
	assert_eq!(mem.contents("mem://root/src/nested/b.ts").as_deref(), Some("const g = identity;\n"));
	assert_eq!(
		mem.contents("mem://root/other.ts").as_deref(),
		Some("const h = (z) => z;\n"),
		"files outside the URL root stay untouched",
	);
}

#[tokio::test(flavor = "multi_thread")]
async fn single_file_url_root_displays_its_decoded_name() {
	let (_mem, fs) = MemFs::with_files(&[("mem://root/a%20b.ts", "const a = 1;\n")]);
	let found = candidates(&fs, Path::new("mem://root/a%20b.ts"), None, None).await;
	assert_eq!(found, [Candidate {
		path:    PathBuf::from("mem://root/a%20b.ts"),
		display: "a b.ts".to_string(),
	}]);
}
