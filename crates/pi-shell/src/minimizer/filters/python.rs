//! Python test, type-check, and lint output filters.
//!
//! Ported from rtk-ai/rtk@878af7de99e0ba71da2e8fd996f6b52a1836e06c
//! Path: `src/cmds/python/pytest_cmd.rs`
//! License: MIT (compatible with workspace MIT). See `NOTICE` at
//! the `pi-shell` crate root.
//!
//! The pytest state machine (`filter_pytest`, `pytest_success`,
//! `is_pytest_*`, `looks_like_pytest_summary_part`) adapts the
//! `build_pytest_summary` algorithm from RTK at the pinned SHA above:
//! preserve failures, errors, and the final summary line; strip header
//! framing, progress dots, and verbose PASSED rows. Unknown-state lines
//! fall through unchanged (RTK's defensive default), so xdist `[gwN]`
//! prefixes and custom reporters never cause data loss.

use super::lint;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

/// Cap on rendered verbose failure blocks (the `___ test ___` traceback
/// sections). Mirrors RTK's `MAX_PYTEST_FAILURES` (== `CAP_WARNINGS` == 10),
/// re-derived for the minimizer's streaming, line-based renderer: once this
/// many traceback blocks have been emitted, further blocks are suppressed and
/// a single `[…N failures elided…]` overflow marker stands in for the
/// remainder. The compact `FAILED …` short-summary one-liners are NOT capped
/// here — they name every failed test cheaply and stay intact.
///
/// The `=== ERRORS ===` section (collection / fixture-setup errors) is capped
/// by a SEPARATE counter (see `filter_pytest`): pytest renders ERRORS *before*
/// FAILURES, and those banners (`___ ERROR collecting … ___`) contain the
/// substring `test` via their path, so a single shared counter would let a
/// burst of low-value collection banners exhaust the budget and evict the
/// real assertion tracebacks that follow. Two counters keep each section's
/// overflow independent.
const MAX_PYTEST_FAILURES: usize = 10;

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	matches!(program, "pytest" | "ruff" | "mypy")
		|| matches!(
			(program, subcommand),
			("python" | "python3" | "py", Some("pytest" | "ruff" | "mypy"))
		)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	// Kill-switch parity (M2): when `legacy_filters_active`, fall back to
	// the pre-PR passthrough so callers can rollback an RTK-port regression
	// without recompile.
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}
	let tool = python_tool(ctx.program, ctx.subcommand);
	let cleaned = primitives::strip_ansi(input);
	let text = match tool {
		Some("pytest") => filter_pytest(&cleaned, exit_code),
		Some("ruff") if is_ruff_format(ctx) => filter_ruff_format(&cleaned),
		Some("ruff") => lint::condense_lint_output("ruff", &cleaned, exit_code),
		Some("mypy") => lint::condense_lint_output("mypy", &cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn python_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match program {
		"pytest" | "ruff" | "mypy" => Some(program),
		"python" | "python3" | "py" => match subcommand {
			Some("pytest" | "ruff" | "mypy") => subcommand,
			_ => None,
		},
		_ => None,
	}
}

fn filter_pytest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return pytest_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;
	// Verbose traceback blocks seen so far, counted SEPARATELY per pytest
	// section. `=== ERRORS ===` (collection / fixture-setup) banners render
	// before `=== FAILURES ===`, so a shared counter would let collection
	// noise exhaust the budget and evict real assertion tracebacks; two
	// counters give each section an independent cap + overflow marker.
	let mut failure_blocks = 0usize;
	let mut error_blocks = 0usize;
	let mut suppressing = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) {
			in_failure = false;
			suppressing = false;
			push_line(&mut out, line);
			continue;
		}
		if is_pytest_summary_line(trimmed) {
			in_failure = false;
			suppressing = false;
			push_pytest_summary_line(&mut out, trimmed);
			continue;
		}
		// XFAIL/XPASS short-summary report lines (emitted under `-r` flags)
		// must survive verbatim: XPASS in particular signals a behavior change
		// (something expected-to-fail now passes). Handled before the
		// in_failure block so the verbose-pass-noise filter can't eat them.
		if trimmed.starts_with("XFAIL ") || trimmed.starts_with("XPASS ") {
			in_failure = false;
			suppressing = false;
			push_line(&mut out, line);
			continue;
		}

		// `=== ERRORS ===` banners (`___ ERROR collecting … ___`,
		// `___ ERROR at setup of … ___`) are checked FIRST and counted under
		// their own cap. They precede the FAILURES section, so counting them
		// here keeps the failure budget reserved for real assertion blocks.
		let is_error_banner = is_pytest_error_banner(trimmed);
		if is_error_banner || is_pytest_failure_header(trimmed) {
			in_failure = true;
			// The overflow count for each kind is rendered once after the loop.
			if is_error_banner {
				error_blocks += 1;
				suppressing = error_blocks > MAX_PYTEST_FAILURES;
			} else {
				failure_blocks += 1;
				suppressing = failure_blocks > MAX_PYTEST_FAILURES;
			}
			if !suppressing {
				push_line(&mut out, line);
			}
			continue;
		}

		if starts_pytest_failure(trimmed) {
			in_failure = true;
			// While a capped traceback block is being suppressed, its `E   ` /
			// `ERROR at ` continuation lines belong to that block and are
			// dropped too. (`FAILED ` short-summary lines only appear after the
			// summary header has cleared `suppressing`, so they stay.)
			if !suppressing {
				push_line(&mut out, line);
			}
			continue;
		}

		if in_failure {
			if is_pytest_section_delimiter(trimmed) && !starts_pytest_failure(trimmed) {
				in_failure = false;
				continue;
			}
			if !suppressing && !is_pytest_pass_noise(trimmed) {
				push_line(&mut out, line);
			}
			continue;
		}

		if trimmed.starts_with("FAILED ") || trimmed.starts_with("ERROR ") {
			push_line(&mut out, line);
		}
	}

	// Errors render before failures in pytest; mirror that order for the
	// overflow markers so the compact output reads top-to-bottom.
	let error_overflow = error_blocks.saturating_sub(MAX_PYTEST_FAILURES);
	if error_overflow > 0 {
		out.push_str("[…");
		out.push_str(&error_overflow.to_string());
		out.push_str(" errors elided…]\n");
	}
	let overflow = failure_blocks.saturating_sub(MAX_PYTEST_FAILURES);
	if overflow > 0 {
		out.push_str("[…");
		out.push_str(&overflow.to_string());
		out.push_str(" failures elided…]\n");
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn pytest_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_pytest_summary_header(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_pytest_summary_line(trimmed) {
			push_pytest_summary_line(&mut summary, trimmed);
			push_pytest_summary_line(&mut out, trimmed);
			continue;
		}
		if is_pytest_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) {
		out
	} else if has_content(&summary) {
		summary
	} else {
		primitives::head_tail_lines(input, 0, 20)
	}
}

fn starts_pytest_failure(trimmed: &str) -> bool {
	is_pytest_failure_header(trimmed)
		|| trimmed.starts_with("E   ")
		|| trimmed.starts_with("ERROR at ")
		|| trimmed.starts_with("FAILED ")
}

/// A `___ test ___`-style banner that opens one verbose traceback block in the
/// `=== FAILURES ===` section. These are the units capped by
/// `MAX_PYTEST_FAILURES`; the `E   `/`FAILED `/`ERROR at ` forms are
/// continuation or short-summary lines, not block boundaries.
fn is_pytest_failure_header(trimmed: &str) -> bool {
	trimmed.starts_with('_') && trimmed.ends_with('_') && trimmed.contains("test")
}

/// A `___ ERROR … ___` banner that opens an `=== ERRORS ===`-section block:
/// `___ ERROR collecting <path> ___` (import/collection failure) and
/// `___ ERROR at setup of <test> ___` / `___ ERROR at teardown of <test> ___`
/// (fixture errors). These render BEFORE the FAILURES section and their inner
/// text contains the substring `test` via the path/test name, so without this
/// distinction they would count against `MAX_PYTEST_FAILURES` and crowd out
/// the real assertion tracebacks. They are capped by their own counter
/// instead.
fn is_pytest_error_banner(trimmed: &str) -> bool {
	if !(trimmed.starts_with('_') && trimmed.ends_with('_')) {
		return false;
	}
	trimmed.trim_matches('_').trim().starts_with("ERROR ")
}

fn is_pytest_summary_header(trimmed: &str) -> bool {
	trimmed.contains("short test summary info") || trimmed.contains("warnings summary")
}

fn is_pytest_summary_line(trimmed: &str) -> bool {
	let has_status = trimmed.contains("passed")
		|| trimmed.contains("failed")
		|| trimmed.contains("error")
		|| trimmed.contains("skipped")
		|| trimmed.contains("warnings")
		|| trimmed.contains("no tests ran");

	if trimmed.starts_with('=') {
		return has_status;
	}

	has_status
		&& trimmed.contains(" in ")
		&& trimmed
			.split(',')
			.all(|part| looks_like_pytest_summary_part(part.trim()))
}

fn looks_like_pytest_summary_part(part: &str) -> bool {
	if part == "no tests ran" {
		return true;
	}

	if let Some((count, rest)) = part.split_once(' ') {
		return count.parse::<u64>().is_ok()
			&& (rest.starts_with("passed")
				|| rest.starts_with("failed")
				|| rest.starts_with("errors")
				|| rest.starts_with("error")
				|| rest.starts_with("skipped")
				|| rest.starts_with("warnings")
				|| rest.starts_with("warning")
				|| rest.starts_with("xfailed")
				|| rest.starts_with("xpassed"));
	}

	false
}

fn compact_pytest_summary_line(trimmed: &str) -> &str {
	if trimmed.starts_with('=') {
		trimmed.trim_matches('=').trim()
	} else {
		trimmed
	}
}

fn is_pytest_section_delimiter(trimmed: &str) -> bool {
	trimmed.len() >= 6
		&& trimmed
			.chars()
			.all(|ch| ch == '_' || ch == '=' || ch == '-')
}

fn is_pytest_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.contains("test session starts")
		|| trimmed.starts_with("collecting ")
		|| trimmed.starts_with("collected ")
		|| trimmed.starts_with("rootdir:")
		|| trimmed.starts_with("configfile:")
		|| trimmed.starts_with("plugins:")
		|| trimmed.starts_with("platform ")
		|| trimmed.starts_with("cachedir:")
		|| is_pytest_verbose_pass_line(trimmed)
		|| is_pytest_progress_line(trimmed)
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
}

fn is_pytest_verbose_pass_line(trimmed: &str) -> bool {
	if !trimmed.contains("::") {
		return false;
	}
	// `XFAIL …`/`XPASS …` short-summary report lines lead with the status
	// token (e.g. `XFAIL test.py::case - reason`) and must NOT be treated as
	// pass-noise — XPASS signals a behavior change. Verbose per-test rows carry
	// the status token in a trailing column (`test.py::case XFAIL [100%]`), so
	// keying on the leading token cleanly separates the two.
	if trimmed.starts_with("XFAIL ") || trimmed.starts_with("XPASS ") {
		return false;
	}
	let mut parts = trimmed.split_whitespace();
	parts.any(|part| matches!(part, "PASSED" | "SKIPPED" | "XPASS" | "XFAIL"))
}

fn is_pytest_progress_line(trimmed: &str) -> bool {
	let Some((path, statuses)) = trimmed.split_once(char::is_whitespace) else {
		return false;
	};
	std::path::Path::new(path)
		.extension()
		.is_some_and(|ext| ext.eq_ignore_ascii_case("py"))
		&& statuses
			.trim()
			.chars()
			.all(|ch| matches!(ch, '.' | 's' | 'S' | 'x' | 'X' | 'f' | 'F' | 'E'))
}

fn is_ruff_format(ctx: &MinimizerCtx<'_>) -> bool {
	ctx.subcommand == Some("format") || ctx.command.split_whitespace().any(|part| part == "format")
}

fn filter_ruff_format(input: &str) -> String {
	let mut out = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if is_ruff_format_line(trimmed) {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn is_ruff_format_line(trimmed: &str) -> bool {
	trimmed.starts_with("Would reformat:")
		|| trimmed.starts_with("Would format:")
		|| trimmed.starts_with("Reformatted:")
		|| trimmed.contains(" file would be reformatted")
		|| trimmed.contains(" files would be reformatted")
		|| trimmed.contains(" file reformatted")
		|| trimmed.contains(" files reformatted")
		|| trimmed.contains(" file left unchanged")
		|| trimmed.contains(" files left unchanged")
		|| trimmed.contains(" file already formatted")
		|| trimmed.contains(" files already formatted")
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn push_pytest_summary_line(out: &mut String, trimmed: &str) {
	out.push_str("pytest: ");
	out.push_str(compact_pytest_summary_line(trimmed));
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn supports_direct_and_python_module_tools() {
		assert!(supports("pytest", None));
		assert!(supports("python3", Some("mypy")));
		assert!(!supports("python3", Some("pip")));
	}

	#[test]
	fn pytest_failure_keeps_failure_and_summary() {
		let input = "============================= test session starts \
		             =============================\ncollected 2 items\ntests/test_math.py \
		             .F\n\n______________________________ test_adds_badly \
		             ______________________________\n\ndef test_adds_badly():\n>       assert 1 + 1 \
		             == 3\nE       assert (1 + 1) == 3\n\ntests/test_math.py:4: \
		             AssertionError\n=========================== short test summary info \
		             ===========================\nFAILED tests/test_math.py::test_adds_badly - \
		             assert (1 + 1) == 3\n========================= 1 failed, 1 passed in 0.02s \
		             =========================\n";

		let out = filter_pytest(input, 1);

		assert!(!out.contains("test session starts"));
		assert!(out.contains("test_adds_badly"));
		assert!(out.contains("AssertionError"));
		assert!(out.contains("pytest: 1 failed, 1 passed"));
	}

	#[test]
	fn ruff_check_routes_to_lint_grouping() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("check"),
			command:    "ruff check",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"src/a.py:1:1: F401 unused import\nsrc/a.py:2:1: E501 line too long\n",
			1,
		);

		assert!(out.text.contains("2 diagnostics in 1 files"));
		assert!(out.text.contains("src/a.py (2 diagnostics)"));
	}

	#[test]
	fn pytest_quiet_summary_survives_without_framing() {
		let input = "................................................................\n5 failed, \
		             1698 passed, 2 skipped in 108.89s\n";
		let out = filter_pytest(input, 1);

		assert!(!out.contains("................................................................"));
		assert!(out.contains("pytest: 5 failed, 1698 passed, 2 skipped in 108.89s"));
	}

	#[test]
	fn pytest_verbose_success_collapses_to_summary() {
		let input = "===== test session starts ======\nplatform darwin -- Python 3.14.3, \
		             pytest-9.0.2\ncachedir: .pytest_cache\nrootdir: /app\nplugins: \
		             anyio-4.12.1\ncollected 33 items\n\ntest_utils.py::TestStringUtils::test_strip \
		             PASSED    [  3%]\ntest_utils.py::TestListOps::test_flatten PASSED      \
		             [100%]\n\n====== 33 passed in 0.05s ======\n";
		let out = filter_pytest(input, 0);
		assert_eq!(out, "pytest: 33 passed in 0.05s\n");
	}

	#[test]
	fn direct_pytest_success_routes_to_compact_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "pytest",
			subcommand: None,
			command:    "pytest",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"===== test session starts =====\ncollected 2 items\n\ntests/test_a.py ..\n===== 2 \
			 passed in 0.01s =====\n",
			0,
		);

		assert_eq!(out.text, "pytest: 2 passed in 0.01s\n");
	}

	#[test]
	fn ruff_format_preserves_changed_files_and_summaries() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("format"),
			command:    "ruff format --check .",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"Would reformat: src/a.py\nWould reformat: tests/test_a.py\n2 files would be \
			 reformatted, 5 files left unchanged\n",
			1,
		);

		assert!(out.text.contains("Would reformat: src/a.py"));
		assert!(out.text.contains("Would reformat: tests/test_a.py"));
		assert!(
			out.text
				.contains("2 files would be reformatted, 5 files left unchanged")
		);
		assert!(!out.text.contains("diagnostics"));
	}

	#[test]
	fn ruff_format_preserves_all_formatted_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "ruff",
			subcommand: Some("format"),
			command:    "ruff format .",
			config:     &cfg,
		};
		let out = filter(&context, "3 files left unchanged\n", 0);

		assert!(out.text.contains("3 files left unchanged"));
		assert!(!out.text.contains("diagnostics"));
	}

	#[test]
	fn pytest_caps_failure_blocks_with_overflow_marker() {
		// Default (non -q) failing output with 12 verbose traceback blocks.
		let mut input = String::from(
			"============================= test session starts \
			 =============================\ncollected 12 items\n\ntests/test_many.py \
			 FFFFFFFFFFFF                                              [100%]\n\n\
			 =================================== FAILURES \
			 ===================================\n",
		);
		for i in 0..12 {
			let _ = write!(
				input,
				"____________________________ test_case_{i} ____________________________\n\n    def \
				 test_case_{i}():\n>       assert False\nE       assert \
				 False\n\ntests/test_many.py:{}: AssertionError\n",
				i + 1
			);
		}
		input.push_str(
			"=========================== short test summary info ===========================\n",
		);
		for i in 0..12 {
			let _ = writeln!(input, "FAILED tests/test_many.py::test_case_{i} - assert False");
		}
		input.push_str("========================= 12 failed in 0.30s =========================\n");

		let out = filter_pytest(&input, 1);

		// First 10 traceback blocks render; blocks 11 and 12 are suppressed.
		assert!(out.contains("test_case_0"), "got: {out}");
		assert!(out.contains("test_case_9"), "got: {out}");
		// The overflow marker accounts for the remaining 2 verbose blocks.
		assert!(out.contains("[…2 failures elided…]"), "got: {out}");
		// The traceback bodies for the capped blocks are gone, but the compact
		// short-summary one-liners for every test survive uncapped.
		let assert_false_lines = out.matches("E       assert False").count();
		assert_eq!(assert_false_lines, 10, "capped traceback bodies: {out}");
		assert!(
			out.contains("FAILED tests/test_many.py::test_case_11"),
			"short-summary one-liners must stay uncapped: {out}"
		);
		assert!(out.contains("pytest: 12 failed in 0.30s"), "got: {out}");
	}

	#[test]
	fn pytest_xfail_xpass_summary_lines_survive() {
		// `-rxX` surfaces XFAIL/XPASS entries in the short summary; XPASS is a
		// behavior-change signal and must never be stripped as pass-noise.
		let input = "============================= test session starts \
		             =============================\ncollected 3 items\n\ntests/test_x.py \
		             .xX                                              [100%]\n\n\
		             =========================== short test summary info \
		             ===========================\nXFAIL tests/test_x.py::test_known_bug - \
		             known issue #42\nXPASS tests/test_x.py::test_unexpected_pass - should \
		             fail but passes\n========================= 1 passed, 1 xfailed, 1 xpassed \
		             in 0.04s =========================\n";

		let out = filter_pytest(input, 1);

		assert!(out.contains("XFAIL tests/test_x.py::test_known_bug"), "got: {out}");
		assert!(out.contains("XPASS tests/test_x.py::test_unexpected_pass"), "got: {out}");
		assert!(out.contains("pytest: 1 passed, 1 xfailed, 1 xpassed"), "got: {out}");
	}

	#[test]
	fn pytest_collection_errors_do_not_evict_real_failure_tracebacks() {
		// Constructed from real default pytest output (`--tb=short -q`,
		// collection errors coexisting with failures): the `=== ERRORS ===`
		// section renders 9 `___ ERROR collecting … ___` banners BEFORE the
		// `=== FAILURES ===` section's 5 real assertion blocks. Those banners
		// contain the substring `test` via their path, so a single shared cap
		// would let them consume 9 of 10 slots and suppress 4 of the 5 real
		// payment-bug tracebacks. The separate error cap must keep every real
		// assertion traceback intact.
		let mut input = String::from(
			"============================= test session starts \
			 =============================\ncollected 5 items / 9 \
			 errors\n\n==================================== ERRORS \
			 ====================================\n",
		);
		for i in 0..9 {
			let _ = write!(
				input,
				"_____________________ ERROR collecting tests/test_imp_{i}.py \
				 _____________________\nImportError while importing test module \
				 'tests/test_imp_{i}.py'.\nE   ImportError: boom\n"
			);
		}
		input.push_str(
			"=================================== FAILURES ===================================\n",
		);
		for i in 0..5 {
			let _ = write!(
				input,
				"_______________________________ test_critical_{i} \
				 ________________________________\ntests/pay.py:{}: in test_critical_{i}\n    assert \
				 0 == 100\nE   assert 0 == 100\ntests/pay.py:{}: AssertionError\n",
				i + 1,
				i + 1
			);
		}
		input.push_str(
			"=========================== short test summary info ===========================\n",
		);
		for i in 0..5 {
			let _ = writeln!(input, "FAILED tests/pay.py::test_critical_{i} - assert 0 == 100");
		}
		input.push_str(
			"========================= 5 failed, 9 errors in 0.30s =========================\n",
		);

		let out = filter_pytest(&input, 1);

		// Every real assertion traceback survives — none evicted by the
		// collection-error banners that precede them.
		for i in 0..5 {
			assert!(out.contains(&format!("test_critical_{i}")), "lost failure {i}: {out}");
		}
		let assert_lines = out.matches("E   assert 0 == 100").count();
		assert_eq!(assert_lines, 5, "all 5 assertion bodies must survive: {out}");
		// 5 < cap, so there is NO failure overflow stealing real tracebacks.
		assert!(!out.contains("failures elided"), "no failures should be capped: {out}");
		// Collection errors are still surfaced (under their own cap of 10).
		assert!(out.contains("ERROR collecting tests/test_imp_0.py"), "got: {out}");
		assert!(!out.contains("errors elided"), "9 errors < cap, no error overflow: {out}");
		assert!(out.contains("pytest: 5 failed, 9 errors"), "got: {out}");
	}

	#[test]
	fn pytest_caps_error_blocks_independently_of_failures() {
		// 12 collection-error banners (ERRORS section) exceed the cap and yield
		// their OWN `[…N errors elided…]` marker, while the 2 real failure tracebacks
		// in the FAILURES section are untouched (their counter is separate).
		let mut input = String::from(
			"============================= test session starts \
			 =============================\ncollected 2 items / 12 \
			 errors\n\n==================================== ERRORS \
			 ====================================\n",
		);
		for i in 0..12 {
			let _ = write!(
				input,
				"_____________________ ERROR collecting tests/test_imp_{i}.py \
				 _____________________\nE   ImportError: boom\n"
			);
		}
		input.push_str(
			"=================================== FAILURES ===================================\n",
		);
		for i in 0..2 {
			let _ = write!(
				input,
				"_______________________________ test_real_{i} ________________________________\n    \
				 assert False\nE   assert False\n"
			);
		}
		input.push_str(
			"========================= 2 failed, 12 errors in 0.10s =========================\n",
		);

		let out = filter_pytest(&input, 1);

		// Error overflow marker fires for the 2 capped collection banners…
		assert!(out.contains("[…2 errors elided…]"), "got: {out}");
		// …but NOT a failure overflow — both real tracebacks render in full.
		assert!(!out.contains("failures elided"), "failures must be uncapped here: {out}");
		assert!(out.contains("test_real_0"), "got: {out}");
		assert!(out.contains("test_real_1"), "got: {out}");
		let assert_false = out.matches("E   assert False").count();
		assert_eq!(assert_false, 2, "both failure bodies survive: {out}");
	}
}
