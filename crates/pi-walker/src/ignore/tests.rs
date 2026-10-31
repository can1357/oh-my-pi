use std::path::Path;

use futures::future::BoxFuture;

use super::*;
use crate::{fs::Detail, testing::MemFs};

/// Expectations produced by the `ignore` crate through
/// `GitignoreBuilder::add_line` + `Gitignore::matched`, re-checked live below.
const RULE_CASES: &[(&str, &str, bool, Match)] = &[
	("*.log", "x.log", false, Match::Ignore),
	("*.log", "a/b/x.log", false, Match::Ignore),
	("*.log", "x.log.txt", false, Match::None),
	("*.log", "logs.log", true, Match::Ignore),
	("/build", "build", true, Match::Ignore),
	("/build", "a/build", true, Match::None),
	("/build", "build", false, Match::Ignore),
	("build/", "build", true, Match::Ignore),
	("build/", "build", false, Match::None),
	("build/", "a/build", true, Match::Ignore),
	("foo/**", "foo", true, Match::None),
	("foo/**", "foo/a", false, Match::Ignore),
	("foo/**", "foo/a/b", false, Match::Ignore),
	("**/foo", "foo", false, Match::Ignore),
	("**/foo", "a/b/foo", false, Match::Ignore),
	("**/foo", "foo/x", false, Match::None),
	("a/**/b", "a/b", false, Match::Ignore),
	("a/**/b", "a/x/b", false, Match::Ignore),
	("a/**/b", "a/x/y/b", false, Match::Ignore),
	("a/**/b", "b", false, Match::None),
	("*.log\n!keep.log", "keep.log", false, Match::Whitelist),
	("*.log\n!keep.log", "a/keep.log", false, Match::Whitelist),
	("*.log\n!keep.log", "drop.log", false, Match::Ignore),
	("!keep.log\n*.log", "keep.log", false, Match::Ignore),
	("\\#file\n\\!bang", "#file", false, Match::Ignore),
	("\\#file\n\\!bang", "!bang", false, Match::Ignore),
	("#comment", "#comment", false, Match::None),
	("trail   ", "trail", false, Match::Ignore),
	("esc\\ ", "esc ", false, Match::Ignore),
	("esc\\ ", "esc", false, Match::None),
	("[ab]c", "ac", false, Match::Ignore),
	("[ab]c", "cc", false, Match::None),
	("[ab]c", "x/bc", false, Match::Ignore),
	("[!a]x", "bx", false, Match::Ignore),
	("[!a]x", "ax", false, Match::None),
	("[abc", "[abc", false, Match::Ignore),
	("[abc", "a", false, Match::None),
	("{a,b}.txt", "a.txt", false, Match::Ignore),
	("{a,b}.txt", "b.txt", false, Match::Ignore),
	("{a,b}.txt", "c.txt", false, Match::None),
	("a**b", "axyb", false, Match::Ignore),
	("a**b", "a/b", false, Match::None),
	("doc/*.txt", "doc/x.txt", false, Match::Ignore),
	("doc/*.txt", "doc/sub/x.txt", false, Match::None),
	("doc/*.txt", "x/doc/y.txt", false, Match::None),
	("*", "anything", false, Match::Ignore),
	("*", "dir", true, Match::Ignore),
	("*", "a/b", false, Match::Ignore),
	("/", "x", false, Match::None),
	("dir/\n!dir/keep", "dir", true, Match::Ignore),
	("dir/\n!dir/keep", "dir/keep", false, Match::Whitelist),
	("a/b", "a/b", false, Match::Ignore),
	("a/b", "x/a/b", false, Match::None),
	("**", "x", false, Match::Ignore),
	("**", "a/b", true, Match::Ignore),
	("a/**", "a/x", false, Match::Ignore),
	("a/**", "a", true, Match::None),
	("a/**", "a/x/y", true, Match::Ignore),
	("*.min.*", "x.min.js", false, Match::Ignore),
	("*.min.*", "a/x.min.css", false, Match::Ignore),
	("foo?", "foo1", false, Match::Ignore),
	("foo?", "foo12", false, Match::None),
	("[a-c]*", "b-file", false, Match::Ignore),
	("[a-c]*", "d-file", false, Match::None),
	("a[/]b", "a/b", false, Match::Ignore),
	("{x,}y", "xy", false, Match::Ignore),
	("{x,}y", "y", false, Match::None),
	("\\", "x", false, Match::None),
	("**/a/**/*.rs", "a/x.rs", false, Match::Ignore),
	("**/a/**/*.rs", "q/a/b/c.rs", false, Match::Ignore),
	("**/a/**/*.rs", "a.rs", false, Match::None),
	("!", "anything", false, Match::Whitelist),
	("/*.txt", "a.txt", false, Match::Ignore),
	("/*.txt", "d/a.txt", false, Match::None),
	("é*", "éa", false, Match::Ignore),
	("?", "a", false, Match::Ignore),
	("?", "ab", false, Match::None),
	("?", "é", false, Match::None),
	("*.[oa]", "x.o", false, Match::Ignore),
	("*.[oa]", "x.a", false, Match::Ignore),
	("*.[oa]", "x.c", false, Match::None),
	("a/*/c", "a/b/c", false, Match::Ignore),
	("a/*/c", "a/b/x/c", false, Match::None),
	("**/", "x", true, Match::Ignore),
	("*/", "x", true, Match::Ignore),
	("x/**/", "x/y", true, Match::Ignore),
	("src/**/test", "src/test", true, Match::Ignore),
	("src/**/test", "src/a/b/test", false, Match::Ignore),
	("{a,b/c}", "b/c", false, Match::Ignore),
	("{a,b/c}", "x/a", false, Match::None),
	("*.{js,ts}", "a.ts", false, Match::Ignore),
	("*.{js,ts}", "d/a.js", false, Match::Ignore),
	("*.{js,ts}", "a.rs", false, Match::None),
	("a/**/**/b", "a/b", false, Match::Ignore),
	("a/**/**/b", "a/x/y/b", false, Match::Ignore),
	("**/**", "q", false, Match::Ignore),
	("**/*.go", "x/y.go", false, Match::Ignore),
	("***", "a/b", false, Match::Ignore),
	("***", "ab", false, Match::Ignore),
	("/a/", "a", true, Match::Ignore),
	("/a/", "x/a", true, Match::None),
	("a\\/", "a", true, Match::Ignore),
	("a\\/", "a", false, Match::None),
	("[]]", "]", false, Match::Ignore),
	("[-a]", "-", false, Match::Ignore),
	("[a-]", "-", false, Match::Ignore),
	("[z-a]", "z", false, Match::None),
	(
		"*a*a*a*a*a*b",
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		false,
		Match::None,
	),
	("*a*a*a*a*a*b", "aaaaaaaaaaaaaaab", false, Match::Ignore),
];

fn oracle(rules: &str, path: &str, is_dir: bool) -> Match {
	let mut builder = ignore::gitignore::GitignoreBuilder::new("/r");
	for line in rules.lines() {
		let _ = builder.add_line(None, line);
	}
	let gi = builder.build().expect("oracle builds");
	match gi.matched(Path::new("/r").join(path), is_dir) {
		ignore::Match::None => Match::None,
		ignore::Match::Ignore(_) => Match::Ignore,
		ignore::Match::Whitelist(_) => Match::Whitelist,
	}
}

#[test]
fn rules_match_ignore_crate() {
	for &(rules, path, is_dir, want) in RULE_CASES {
		let got = Rules::parse(rules.as_bytes()).matched(path.as_bytes(), is_dir);
		assert_eq!(got, want, "rules {rules:?} path {path:?} dir={is_dir}");
		assert_eq!(
			oracle(rules, path, is_dir),
			want,
			"oracle: rules {rules:?} path {path:?} dir={is_dir}"
		);
	}
}

#[test]
fn parse_framing() {
	// BOM stripped from the first line, CRLF endings, and parsing stops at
	// the first line that is not UTF-8.
	let rules = Rules::parse(b"\xEF\xBB\xBF*.log\r\n!keep.log\r\n\xff\n*.txt\n");
	assert_eq!(rules.matched(b"x.log", false), Match::Ignore);
	assert_eq!(rules.matched(b"keep.log", false), Match::Whitelist);
	assert_eq!(rules.matched(b"x.txt", false), Match::None);
	assert!(Rules::parse(b"# only a comment\n\n   \n").is_empty());
}

#[test]
fn matched_path_or_parents_checks_ancestors_as_dirs() {
	let rules = Rules::parse(b"build/\n!keep\n");
	assert_eq!(rules.matched_path_or_parents(b"a/build/x/y.rs", false), Match::Ignore);
	assert_eq!(rules.matched_path_or_parents(b"build", false), Match::None);
	assert_eq!(rules.matched_path_or_parents(b"build/keep", false), Match::Whitelist);
	assert_eq!(rules.matched_path_or_parents(b"src/x.rs", false), Match::None);
}

#[tokio::test(flavor = "multi_thread")]
async fn read_through_provider() {
	let (_mem, fs) = MemFs::with_files(&[("mem://r/.gitignore", "*.log\n")]);
	let rules = Rules::read(&fs, Path::new("mem://r/.gitignore"))
		.await
		.unwrap();
	assert_eq!(rules.matched(b"a.log", false), Match::Ignore);
	assert!(
		Rules::read(&fs, Path::new("mem://r/missing"))
			.await
			.is_err()
	);
}

#[test]
fn parse_excludes_file_matches_ignore_crate_regex() {
	let cases: &[(&str, Option<&str>)] = &[
		("[core]\n\texcludesfile = ~/.gitignore_global\n", Some("/home/u/.gitignore_global")),
		("  ExcludesFile=\"/x/y\"  \n", Some("/x/y")),
		("excludesfile\n= spaced\n", Some("spaced")),
		("excludesfile = first\nexcludesfile = second\n", Some("first")),
		("excludesfile = \"a b\"\n", None),
		("excludesfiles = x\n", None),
		("[core]\n\teditor = vim\n", None),
	];
	for &(config, want) in cases {
		let got = parse_excludes_file(config.as_bytes(), Some(Path::new("/home/u")));
		assert_eq!(got.as_deref(), want.map(Path::new), "{config:?}");
	}
	assert_eq!(parse_excludes_file(b"excludesfile=~/g", None).as_deref(), Some(Path::new("~/g")));
}

/// Walks `root` on `fs` the way the walker drives the chain and returns the
/// non-ignored files, sorted; `.git` directories are not descended.
async fn walk(fs: &Fs, root: &str) -> Vec<String> {
	fn visit<'a>(
		s: &'a mut Session,
		ig: &'a Ignorer,
		dir: &'a Dir,
		rel: &'a [u8],
		parent: Option<&'a Arc<Frame>>,
		out: &'a mut Vec<String>,
	) -> BoxFuture<'a, ()> {
		Box::pin(async move {
			let listing = s.list(dir, Detail::Minimal, 0).await.unwrap().clone();
			let mut names = Names::default();
			for r in listing.records() {
				names.record(listing.name(r), r.file_type);
			}
			let frame = DirIgnores::load(s, dir, names, false)
				.await
				.frame(parent, names, rel);
			let mut scratch = Vec::new();
			for r in listing.records() {
				let name = listing.name(r);
				if name == b".git" {
					continue;
				}
				let mut child = rel.to_vec();
				if !child.is_empty() {
					child.push(b'/');
				}
				child.extend_from_slice(name);
				let is_dir = r.file_type == FileType::Dir;
				if ig.ignored(frame.as_deref(), &child, is_dir, &mut scratch) {
					continue;
				}
				if is_dir {
					let sub = s.open_child(dir, name).await.unwrap();
					visit(s, ig, &sub, &child, frame.as_ref(), out).await;
				} else {
					out.push(String::from_utf8(child).unwrap());
				}
			}
		})
	}
	let mut s = fs.session();
	let (ig, frame) = Ignorer::new(&mut s, fs, Path::new(root)).await;
	let dir = s.open_dir(Path::new(root)).await.unwrap();
	let mut out = Vec::new();
	visit(&mut s, &ig, &dir, b"", frame.as_ref(), &mut out).await;
	out.sort();
	out
}

fn tree(files: &[(&str, &str)], dirs: &[&str]) -> Fs {
	let (mem, fs) = MemFs::with_files(files);
	for dir in dirs {
		mem.add_dir(dir);
	}
	Fs::Provider(fs)
}

#[tokio::test(flavor = "multi_thread")]
async fn parent_ignore_outside_repo_does_not_filter_root() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "*.nix\n"),
			("mem://t/projects/hm/flake.nix", "x"),
			("mem://t/projects/hm/modules/common/zsh.nix", "x"),
		],
		&[],
	);
	assert_eq!(walk(&fs, "mem://t/projects/hm").await, ["flake.nix", "modules/common/zsh.nix"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn repo_parent_ignore_filters_subdirectory_root() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "*.nix\n"),
			("mem://t/projects/hm/flake.nix", "x"),
			("mem://t/projects/hm/kept.txt", "x"),
			("mem://t/projects/hm/modules/common/zsh.nix", "x"),
		],
		&["mem://t/.git"],
	);
	assert_eq!(walk(&fs, "mem://t/projects/hm").await, ["kept.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ancestor_rules_covering_root_are_dropped_but_others_kept() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "*.log\nignored/**\n"),
			("mem://t/ignored/package/keep.ts", "x"),
			("mem://t/ignored/package/trace.log", "x"),
			("mem://t/ignored/package/nested/.gitignore", "generated.ts\n"),
			("mem://t/ignored/package/nested/generated.ts", "x"),
			("mem://t/ignored/package/nested/keep.ts", "x"),
		],
		&["mem://t/.git"],
	);
	assert_eq!(walk(&fs, "mem://t/ignored/package").await, [
		"keep.ts",
		"nested/.gitignore",
		"nested/keep.ts"
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn gitignore_applies_without_repo_but_exclude_needs_one() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "ignored.txt\n"),
			("mem://t/ignored.txt", "x"),
			("mem://t/kept.txt", "x"),
		],
		&[],
	);
	assert_eq!(walk(&fs, "mem://t").await, [".gitignore", "kept.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn precedence_dot_over_git_over_exclude() {
	let fs = tree(
		&[
			("mem://t/.git/info/exclude", "*.a\n*.b\n*.c\n"),
			("mem://t/.gitignore", "!*.a\n*.d\n"),
			("mem://t/.ignore", "!*.b\n!*.d\n"),
			("mem://t/x.a", ""),
			("mem://t/x.b", ""),
			("mem://t/x.c", ""),
			("mem://t/x.d", ""),
		],
		&[],
	);
	assert_eq!(walk(&fs, "mem://t").await, [".gitignore", ".ignore", "x.a", "x.b", "x.d"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn nearest_file_of_each_kind_decides() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "*.log\n/top.txt\n"),
			("mem://t/sub/.gitignore", "!keep.log\n"),
			("mem://t/sub/keep.log", ""),
			("mem://t/sub/drop.log", ""),
			("mem://t/sub/top.txt", ""),
			("mem://t/top.txt", ""),
			("mem://t/sub/deep/x.log", ""),
		],
		&[],
	);
	assert_eq!(walk(&fs, "mem://t").await, [
		".gitignore",
		"sub/.gitignore",
		"sub/keep.log",
		"sub/top.txt"
	]);
}

#[tokio::test(flavor = "multi_thread")]
async fn exclude_above_nested_repo_is_not_consulted() {
	let fs = tree(
		&[
			("mem://t/.git/info/exclude", "*.tmp\n"),
			("mem://t/a.tmp", ""),
			("mem://t/inner/b.tmp", ""),
		],
		&["mem://t/inner/.git"],
	);
	assert_eq!(walk(&fs, "mem://t").await, ["inner/b.tmp"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ancestor_anchored_rules_use_root_offset() {
	let fs = tree(
		&[
			("mem://t/.gitignore", "/src/gen/\nsrc/*.tmp\n"),
			("mem://t/src/gen/x.rs", ""),
			("mem://t/src/a.tmp", ""),
			("mem://t/src/a%20b.rs", ""),
			("mem://t/src/sub/a.tmp", ""),
		],
		&["mem://t/.git"],
	);
	assert_eq!(walk(&fs, "mem://t/src").await, ["a b.rs", "sub/a.tmp"]);
}

#[test]
fn global_rules_apply_only_inside_repo_and_last() {
	let global = Rules::parse(b"*.g\nsub/*.h\n");
	let ig = Ignorer { global: Some(global), cwd: b"/w".to_vec(), root: b"/w/repo".to_vec() };
	let repo = Frame::new(
		None,
		[None, Some(Arc::new(Rules::parse(b"!keep.g\n"))), None],
		true,
		Box::default(),
		Box::default(),
	);
	let plain = Frame::new(None, [None, None, None], false, Box::default(), Box::default());
	let mut scratch = Vec::new();
	assert!(ig.ignored(Some(&repo), b"x.g", false, &mut scratch));
	assert!(!ig.ignored(Some(&repo), b"keep.g", false, &mut scratch));
	// Anchored global rules see the path relative to the cwd: repo/sub/x.h.
	assert!(!ig.ignored(Some(&repo), b"sub/x.h", false, &mut scratch));
	assert!(!ig.ignored(Some(&plain), b"x.g", false, &mut scratch));
	assert!(!ig.ignored(None, b"x.g", false, &mut scratch));
	let ig = Ignorer { root: b"/w".to_vec(), ..ig };
	assert!(ig.ignored(Some(&repo), b"sub/x.h", false, &mut scratch));
}

#[test]
fn names_record_only_relevant_entries() {
	let mut names = Names::default();
	names.record(b".gitignore", FileType::Dir);
	names.record(b".ignorex", FileType::File);
	assert!(names.is_empty());
	names.record(b".jj", FileType::Dir);
	assert!(!names.is_empty());
	assert_eq!(DirIgnores::source_names(names).count(), 0);
	names.record(b".git", FileType::File);
	names.record(b".ignore", FileType::Symlink);
	assert_eq!(DirIgnores::source_names(names).collect::<Vec<_>>(), [
		(0, ".ignore"),
		(2, ".git/info/exclude")
	]);
}
