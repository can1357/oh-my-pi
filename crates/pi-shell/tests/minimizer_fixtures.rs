//! End-to-end fixture harness for the output minimizer with a token-savings
//! gate.
//!
//! Each fixture is a `<family>/<case>` pair on disk under
//! `tests/fixtures/minimizer/`:
//!
//! - `<case>.cmd`  — the full command line (one line; required).
//! - `<case>.raw`  — the raw captured output fed to the minimizer (required).
//! - `<case>.exit` — integer exit code (optional; defaults to 0).
//! - `<case>.min`  — expected minimized snapshot (optional, see gate below).
//!
//! Gate per fixture:
//!
//! - `raw.chars().count() < MIN_MINIMIZE_CHARS`: the minimizer must return the
//!   raw output unchanged; short output is never filtered.
//! - `raw.chars().count() >= MIN_MINIMIZE_CHARS`: assert `minimized.len() <=
//!   0.40 * raw.len()` — the savings gate, measured in bytes because the
//!   output-size budget is byte-based.
//! - `.min` present alongside an eligible raw buffer: assert BOTH the savings
//!   gate and the exact snapshot.
//!
//! All fixture failures are collected before the harness panics so a single run
//! reports every regression, not just the first.

use std::{fmt::Write as _, fs, path::Path};

use pi_shell::minimizer::{self, MinimizerConfig, engine::MIN_MINIMIZE_CHARS};

/// Byte-savings gate: minimized output must be at most this fraction of the raw
/// input for buffers large enough to be worth filtering.
const SAVINGS_RATIO: f64 = 0.40;

/// A single discovered fixture: the `.cmd`/`.raw` pair plus its optional
/// `.exit` and `.min` companions.
struct Fixture {
	/// `<family>/<case>` — used only for human-readable failure reports.
	name:     String,
	command:  String,
	raw:      String,
	exit:     i32,
	expected: Option<String>,
}

#[test]
fn minimizer_fixtures_clear_savings_gate() {
	let root = fixtures_root();
	let fixtures = discover_fixtures(&root);

	// A silently-empty harness is worse than none: if the fixtures tree is
	// missing or holds no `.cmd` cases, fail loudly rather than passing on zero
	// assertions.
	assert!(
		!fixtures.is_empty(),
		"no minimizer fixtures discovered under {}: the harness must run against at least one \
		 fixture (a silently-empty gate is worse than none)",
		root.display()
	);

	let cfg = MinimizerConfig { enabled: true, max_capture_bytes: u32::MAX, ..Default::default() };
	let mut failures: Vec<String> = Vec::new();

	for fixture in &fixtures {
		if let Err(report) = check_fixture(fixture, &cfg) {
			failures.push(report);
		}
	}

	assert!(
		failures.is_empty(),
		"{} of {} minimizer fixture(s) failed:\n\n{}",
		failures.len(),
		fixtures.len(),
		failures.join("\n\n")
	);
}

/// Run the minimizer on one fixture and apply the gate. Returns `Err(report)`
/// with a human-readable failure description (fixture name, ratio, diff
/// excerpt) on any violation so the caller can collect every failure.
fn check_fixture(fixture: &Fixture, cfg: &MinimizerConfig) -> Result<(), String> {
	let out = minimizer::apply(&fixture.command, &fixture.raw, fixture.exit, cfg);
	let minimized = out.text.as_str();
	let raw_chars = fixture.raw.chars().count();
	let raw_len = fixture.raw.len();
	let min_len = minimized.len();

	if raw_chars < MIN_MINIMIZE_CHARS {
		if minimized == fixture.raw {
			return Ok(());
		}
		return Err(format!(
			"[{}] cmd={:?} exit={} raw={} chars: short output was modified",
			fixture.name, fixture.command, fixture.exit, raw_chars,
		));
	}

	let ratio = if raw_len == 0 {
		0.0
	} else {
		min_len as f64 / raw_len as f64
	};

	let mut problems: Vec<String> = Vec::new();
	let budget = (SAVINGS_RATIO * raw_len as f64).floor() as usize;
	if min_len > budget {
		problems.push(format!(
			"savings gate: minimized {min_len} B > {budget} B budget ({:.1}% of {raw_len} B raw, \
			 limit {:.0}%)",
			ratio * 100.0,
			SAVINGS_RATIO * 100.0
		));
	}
	// A `.min` alongside an eligible raw buffer pins the exact shape too.
	if let Some(expected) = &fixture.expected
		&& expected != minimized
	{
		problems.push(format!("snapshot mismatch:\n{}", diff_excerpt(expected, minimized)));
	}

	if problems.is_empty() {
		Ok(())
	} else {
		Err(format!(
			"[{}] cmd={:?} exit={} raw={} B min={} B ratio={:.1}%\n  - {}",
			fixture.name,
			fixture.command,
			fixture.exit,
			raw_len,
			min_len,
			ratio * 100.0,
			problems.join("\n  - ")
		))
	}
}

/// Render a short, line-oriented diff excerpt (first divergence plus a little
/// context) so a snapshot failure is legible without dumping both buffers.
fn diff_excerpt(expected: &str, actual: &str) -> String {
	let expected_lines: Vec<&str> = expected.lines().collect();
	let actual_lines: Vec<&str> = actual.lines().collect();
	let max = expected_lines.len().max(actual_lines.len());

	let first_diff = (0..max).find(|&i| expected_lines.get(i) != actual_lines.get(i));
	let Some(start) = first_diff else {
		// Lines all match: the difference is a trailing newline / final fragment.
		return format!("    expected {expected:?}\n    actual   {actual:?}");
	};

	let mut excerpt = String::new();
	for i in start..(start + 3).min(max) {
		let _ = write!(
			excerpt,
			"    line {}:\n      expected {:?}\n      actual   {:?}\n",
			i + 1,
			expected_lines.get(i).copied().unwrap_or("<missing>"),
			actual_lines.get(i).copied().unwrap_or("<missing>")
		);
	}
	excerpt.trim_end().to_string()
}

/// Absolute path to the fixtures tree. Under cargo the compile-time manifest
/// dir exists at runtime; under Bazel the compile-time sandbox path is gone,
/// so fall back to the runfiles-relative layout (test cwd is the workspace
/// runfiles root and the fixtures ride along as `data`).
fn fixtures_root() -> std::path::PathBuf {
	let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/minimizer");
	if manifest.is_dir() {
		return manifest;
	}
	Path::new("crates/pi-shell/tests/fixtures/minimizer").to_path_buf()
}

/// Walk `<root>/<family>/<case>.cmd` and assemble each fixture with its
/// `.raw`/`.exit`/`.min` companions. A missing `.raw` for a discovered `.cmd`
/// is a hard error: the fixture is malformed, not absent.
fn discover_fixtures(root: &Path) -> Vec<Fixture> {
	let mut fixtures = Vec::new();

	let Ok(families) = fs::read_dir(root) else {
		// Missing tree → return empty; the test body turns this into a loud
		// failure with the full path.
		return fixtures;
	};

	let mut family_dirs: Vec<_> = families
		.filter_map(Result::ok)
		.map(|entry| entry.path())
		.filter(|path| path.is_dir())
		.collect();
	family_dirs.sort();

	for family_dir in family_dirs {
		let family = family_dir
			.file_name()
			.and_then(|name| name.to_str())
			.unwrap_or("?")
			.to_string();

		let Ok(entries) = fs::read_dir(&family_dir) else {
			continue;
		};
		let mut cmd_paths: Vec<_> = entries
			.filter_map(Result::ok)
			.map(|entry| entry.path())
			.filter(|path| path.extension().is_some_and(|ext| ext == "cmd"))
			.collect();
		cmd_paths.sort();

		for cmd_path in cmd_paths {
			let case = cmd_path
				.file_stem()
				.and_then(|name| name.to_str())
				.unwrap_or("?")
				.to_string();
			let raw_path = cmd_path.with_extension("raw");
			let raw = fs::read_to_string(&raw_path).unwrap_or_else(|err| {
				panic!(
					"fixture {family}/{case}: missing or unreadable .raw ({}): {err}",
					raw_path.display()
				)
			});

			let command = fs::read_to_string(&cmd_path)
				.unwrap_or_else(|err| panic!("fixture {family}/{case}: unreadable .cmd: {err}"))
				.trim_end_matches(['\n', '\r'])
				.to_string();

			let exit = fs::read_to_string(cmd_path.with_extension("exit"))
				.ok()
				.map_or(0, |text| {
					text.trim().parse::<i32>().unwrap_or_else(|err| {
						panic!("fixture {family}/{case}: invalid .exit ({:?}): {err}", text.trim())
					})
				});

			let expected = fs::read_to_string(cmd_path.with_extension("min")).ok();

			fixtures.push(Fixture { name: format!("{family}/{case}"), command, raw, exit, expected });
		}
	}

	fixtures
}
