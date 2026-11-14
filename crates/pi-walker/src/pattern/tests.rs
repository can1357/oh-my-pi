use super::*;

fn glob(pattern: &str) -> Glob {
	Glob::new(pattern).unwrap_or_else(|err| panic!("{pattern}: {err}"))
}

/// Patterns covering every construct, for the differential and pruning tests.
const PATTERNS: &[&str] = &[
	"*.rs",
	"**/*.rs",
	"src/*.rs",
	"src/**/*.rs",
	"src/**",
	"**/src/**",
	"**",
	"**/",
	"***",
	"a**b",
	"a/**/b",
	"a/**/**/b",
	"**/a/**/*.rs",
	"a/b/c.rs",
	"a/*/c.rs",
	"s?c/*",
	"?",
	"[ab]/x.rs",
	"[!a]*",
	"[^a]/*",
	"a[/]b",
	"[a-c]*",
	"[]]",
	"[-a]",
	"[a-]",
	"[é]",
	"[a-é]",
	"{a,b/c}",
	"{a,b}/*.rs",
	"*.{rs,md}",
	"{x,}y",
	"{,}",
	"{**/a,b}",
	"{a/**,b}",
	"x/{**/a,b}",
	"\\*.rs",
	"a\\/b",
	"*a*a*a*b",
	"a/**/",
	"**/x.rs/**",
	"é*",
	"",
	"a,b",
];

/// Paths for the differential and pruning tests.
const PATHS: &[&str] = &[
	"",
	"a",
	"b",
	"y",
	"xy",
	"ab",
	"axb",
	"a/b",
	"a/x/b",
	"a/x/y/b",
	"a/b/c.rs",
	"a/x/c.rs",
	"a/x/y/c.rs",
	"b/c",
	"b/x.rs",
	"x.rs",
	"x.md",
	"src/x.rs",
	"src/a/b/x.rs",
	"src",
	"src/",
	"q/src/x",
	"sxc/1",
	"é",
	"éa",
	"]",
	"-",
	"*.rs",
	"a/x.rs/z",
	"q/a/b/c.rs",
	"a.rs",
	"c/d",
	"x/a",
	"x/b",
	"x/q/a",
	"aaaaab",
	"aXaYaZb",
	"a,b",
	"/a",
];

#[test]
fn matches_globset_literal_separator() {
	for pattern in PATTERNS {
		let ours = Glob::new(pattern);
		let theirs = globset::GlobBuilder::new(pattern)
			.literal_separator(true)
			.backslash_escape(true)
			.build()
			.map(|g| g.compile_matcher());
		let (ours, theirs) = match (ours, theirs) {
			(Ok(a), Ok(b)) => (a, b),
			(Err(_), Err(_)) => continue,
			(a, b) => panic!("{pattern}: compile mismatch: ours {a:?}, globset {:?}", b.err()),
		};
		for path in PATHS {
			assert_eq!(
				ours.is_match(path.as_bytes()),
				theirs.is_match(path),
				"pattern {pattern:?} path {path:?}"
			);
		}
	}
}

#[test]
fn rejects_what_globset_rejects() {
	for pattern in ["[abc", "a\\", "{a,b", "a}", "[z-a]", "{a,{b}"] {
		assert!(Glob::new(pattern).is_err(), "{pattern} compiled");
		assert!(
			globset::GlobBuilder::new(pattern)
				.literal_separator(true)
				.backslash_escape(true)
				.build()
				.is_err(),
			"oracle accepted {pattern}"
		);
	}
	let err = Glob::new("[abc").unwrap_err();
	assert_eq!(err.pattern(), "[abc");
	assert_eq!(err.to_string(), "[abc: unclosed character class");
}

#[test]
fn alternative_limit() {
	let ok = "{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}"; // 256
	assert!(Glob::new(ok).is_ok());
	assert!(Glob::new(&format!("{ok}{{a,b}}")).is_err());
}

#[test]
fn unclosed_class() {
	assert!(Glob::new("[abc").is_err());
	let g = Glob::with_dialect("[abc", Dialect { allow_unclosed_class: true }).unwrap();
	assert!(g.is_match(b"[abc"));
	assert!(!g.is_match(b"a"));
	// After rollback later '[' stay literal too.
	let g = Glob::with_dialect("[a[b", Dialect { allow_unclosed_class: true }).unwrap();
	assert!(g.is_match(b"[a[b"));
}

#[test]
fn may_match_under() {
	let cases = [
		("src/*.go", "src", true),
		("src/*.go", "src/sub", false),
		("src/*.go", "lib", false),
		("src/**/*.go", "src/a/b", true),
		("src/**/*.go", "lib", false),
		("src/**", "src/a/b", true),
		("src/**", "srcx", false),
		("**/*.go", "anything/deep", true),
		("*.go", "any", false),
		("a/b/c.txt", "a", true),
		("a/b/c.txt", "a/b", true),
		("a/b/c.txt", "a/b/c.txt", false),
		("a/b/c.txt", "a/x", false),
		("{src,lib}/*.go", "lib", true),
		("{src,lib}/*.go", "test", false),
		("s?c/*.go", "src", true),
		("[st]rc/*.go", "trc", true),
		("[st]rc/*.go", "arc", false),
		("**", "x/y", true),
		("anything", "", true),
	];
	for (pattern, dir, want) in cases {
		assert_eq!(glob(pattern).may_match_under(dir.as_bytes()), want, "{pattern} under {dir}");
	}
}

#[test]
fn max_depth() {
	let cases = [
		("*.go", Some(1)),
		("src/*.go", Some(2)),
		("a/b/c", Some(3)),
		("{a,b/c}", Some(2)),
		("**/*.go", None),
		("src/**", None),
		("a/[!x]", None),
		("**", None),
	];
	for (pattern, want) in cases {
		assert_eq!(glob(pattern).max_depth(), want, "{pattern}");
	}
}

#[test]
fn basename_only_and_union() {
	assert!(glob("**/*.rs").basename_only());
	assert!(glob("**/foo*").basename_only());
	// Anchored: `*.rs` matches root files only, so the whole path matters.
	assert!(!glob("*.rs").basename_only());
	assert!(!glob("src/*.rs").basename_only());
	let u = Glob::union([glob("**/*.rs"), glob("src/*.md")]);
	assert!(u.is_match(b"x.rs") && u.is_match(b"src/a.md") && !u.is_match(b"a.md"));
	assert!(!u.basename_only());
	assert!(u.is_match_base(b"q/x.rs", b"x.rs"));
	assert!(Glob::union([glob("x"), glob("**")]).is_match(b"any/thing"));
}

#[test]
fn memoized_backtracking_stays_linear() {
	let g = glob("*a*a*a*a*a*a*a*b");
	let long = "a".repeat(4000);
	assert!(!g.is_match(long.as_bytes()));
	assert!(g.is_match(format!("{long}b").as_bytes()));
}

/// Pruning must never hide a match: for every corpus path a glob matches,
/// each ancestor directory reports `may_match_under` and the path is within
/// `max_depth`.
#[test]
fn pruning_never_hides_matches() {
	let segs = ["a", "b", "c.rs", "src", "x.rs", "é", "sxc", "q", "1"];
	let mut corpus: Vec<String> = segs.iter().map(|s| (*s).to_owned()).collect();
	let mut frontier = corpus.clone();
	for _ in 0..3 {
		let mut next = Vec::new();
		for p in &frontier {
			for s in segs {
				next.push(format!("{p}/{s}"));
			}
		}
		corpus.extend(next.iter().cloned());
		frontier = next;
	}
	let extra = ["[ab]/[!z]/q", "{a,b/c}/*.rs", "s?c/**", "**/x.rs", "a/*/q/**"];
	for pattern in PATTERNS.iter().chain(&extra) {
		let Ok(g) = Glob::new(pattern) else { continue };
		for path in &corpus {
			let bytes = path.as_bytes();
			if !g.is_match(bytes) {
				continue;
			}
			for (i, _) in bytes.iter().enumerate().filter(|(_, b)| **b == b'/') {
				assert!(
					g.may_match_under(&bytes[..i]),
					"{pattern} matches {path} but pruned at {}",
					&path[..i]
				);
			}
			if let Some(depth) = g.max_depth() {
				assert!(
					path.split('/').count() <= depth,
					"{pattern} matches {path} beyond depth {depth}"
				);
			}
		}
	}
}
