//! Jest, Vitest, and Playwright output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if exit_code == 0 {
		drop_passed_lines(&cleaned)
	} else {
		failures_only(&cleaned)
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn drop_passed_lines(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		// snip jest.yaml strips: console.log noise and the zero-information
		// "Ran all test suites" line carry no signal even on success.
		if is_noise_line(trimmed) {
			continue;
		}
		if is_pass_noise(trimmed) {
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

fn failures_only(input: &str) -> String {
	let mut out = String::new();
	let mut keeping_block = false;
	let mut kept_failure = false;
	let mut trailing_context = 0usize;

	for line in input.lines() {
		let trimmed = line.trim_start();

		// snip jest.yaml strips: drop console.log noise and the zero-information
		// "Ran all test suites" line transparently, without breaking the kept
		// failure block around them.
		if is_noise_line(trimmed) {
			continue;
		}

		if is_summary_line(trimmed) {
			keeping_block = false;
			trailing_context = 0;
			push_line(&mut out, line);
			continue;
		}

		if starts_failure_block(trimmed) {
			keeping_block = true;
			kept_failure = true;
			trailing_context = 10;
			push_line(&mut out, line);
			continue;
		}

		if keeping_block {
			if is_pass_noise(trimmed) {
				keeping_block = false;
				trailing_context = 0;
				continue;
			}
			push_line(&mut out, line);
			if trimmed.is_empty() {
				continue;
			}
			if is_error_context_line(trimmed) {
				trailing_context = 10;
			} else if trailing_context > 0 {
				trailing_context -= 1;
			} else {
				keeping_block = false;
			}
		}
	}

	// A failing run where no failure block was recognized means the format is
	// unknown; summary counts alone lose the actual error (issue: bun's non-TTY
	// `(fail)` output). Fall back to head/tail rather than drop the failure.
	if kept_failure && has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
	out.push('\n');
}

fn has_content(text: &str) -> bool {
	text.lines().any(|line| !line.trim().is_empty())
}

fn is_summary_line(trimmed: &str) -> bool {
	trimmed.starts_with("Test Suites:")
		|| trimmed.starts_with("Tests:")
		|| trimmed.starts_with("Snapshots:")
		|| trimmed.starts_with("Time:")
		|| trimmed.starts_with("Test Files")
		|| trimmed.starts_with("Duration")
		|| trimmed.starts_with("Start at")
		|| trimmed.starts_with("% ")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("Playwright Test Report")
		|| (trimmed.starts_with("Ran ") && trimmed.contains("tests across"))
		|| starts_count_summary(trimmed)
}

fn starts_count_summary(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(count) = parts.next() else {
		return false;
	};
	if !count.chars().all(|ch| ch.is_ascii_digit()) {
		return false;
	}
	matches!(parts.next(), Some("failed" | "passed" | "skipped" | "flaky" | "pass" | "fail"))
}

/// Zero-information lines worth dropping regardless of pass/fail context.
/// Ported from snip/filters/jest.yaml's `remove_lines` strips: jest console.log
/// echoes (`^\s+console\.`) and the trailing `Ran all test suites.` banner.
fn is_noise_line(trimmed: &str) -> bool {
	trimmed.starts_with("console.") || trimmed.starts_with("Ran all test suites")
}

fn is_pass_noise(trimmed: &str) -> bool {
	trimmed.starts_with("(pass)")
		|| trimmed.starts_with("PASS ")
		|| trimmed.starts_with("✓")
		|| trimmed.starts_with("✔")
		|| trimmed.starts_with("√")
		|| trimmed.starts_with("○")
		|| trimmed.starts_with(" RUN ")
		|| trimmed.starts_with("DEV ")
		|| trimmed.starts_with("bun test ")
		|| trimmed.ends_with(".test.ts:")
		|| trimmed.ends_with(".test.js:")
		|| trimmed.ends_with(".test.tsx:")
		|| trimmed.ends_with(".test.jsx:")
		|| trimmed.ends_with(".spec.ts:")
		|| trimmed.ends_with(".spec.js:")
}

fn starts_failure_block(trimmed: &str) -> bool {
	trimmed.starts_with("(fail)")
		|| trimmed.starts_with("FAIL ")
		|| trimmed.starts_with("FAILURES")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("● ")
		|| trimmed.starts_with("✕")
		|| trimmed.starts_with("×")
		|| trimmed.starts_with("✗")
		|| trimmed.starts_with("❯")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("error:")
		|| is_code_frame_line(trimmed)
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| is_playwright_numbered_failure(trimmed)
}

fn is_error_context_line(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("at ")
		|| trimmed.starts_with("→")
		|| trimmed.starts_with('>')
		|| trimmed.starts_with('|')
		|| trimmed.starts_with("Expected")
		|| trimmed.starts_with("Received")
		|| trimmed.starts_with("Error:")
		|| trimmed.starts_with("error:")
		|| trimmed.starts_with("AssertionError")
		|| trimmed.starts_with("TimeoutError")
		|| trimmed.contains(" › ")
		|| trimmed.contains(".spec.")
		|| trimmed.contains(".test.")
}

/// Source excerpt rows in bun/jest failure output: `12 | expect(x).toBe(y)`
/// (optionally behind jest's `> ` pointer). Bun prints the code frame *before*
/// its `error:` line, so these must open the failure block.
fn is_code_frame_line(trimmed: &str) -> bool {
	let rest = trimmed.strip_prefix("> ").unwrap_or(trimmed);
	let after_digits = rest.trim_start_matches(|ch: char| ch.is_ascii_digit());
	after_digits.len() < rest.len() && after_digits.starts_with(" |")
}

fn is_playwright_numbered_failure(trimmed: &str) -> bool {
	let mut chars = trimmed.chars();
	let mut saw_digit = false;
	while let Some(ch) = chars.next() {
		if ch.is_ascii_digit() {
			saw_digit = true;
			continue;
		}
		return saw_digit && ch == ')' && chars.next().is_some_and(char::is_whitespace);
	}
	false
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn drops_passed_lines() {
		assert_eq!(drop_passed_lines("PASS a.test.ts\n✓ ok\nTests 1 passed\n"), "Tests 1 passed\n");
	}

	#[test]
	fn keeps_jest_failure_context_and_summary() {
		let input = "PASS src/ok.test.ts\nFAIL src/bad.test.ts\n  suite\n    ✕ breaks (5 ms)\n\n  ● \
		             suite › breaks\n\n    Expected: 1\n    Received: 2\n\nTest Suites: 1 failed, 1 \
		             passed, 2 total\nTests:       1 failed, 1 passed, 2 total\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("PASS src/ok.test.ts"));
		assert!(filtered.contains("FAIL src/bad.test.ts"));
		assert!(filtered.contains("● suite › breaks"));
		assert!(filtered.contains("Expected: 1"));
		assert!(filtered.contains("Test Suites: 1 failed"));
	}

	#[test]
	fn keeps_vitest_failure_and_drops_success_checks() {
		let input = "✓ src/passing.test.ts (1)\n× src/failing.test.ts > thing > fails\n  → expected \
		             true to be false\n ❯ src/failing.test.ts:4:10\n\nTest Files  1 failed | 1 \
		             passed (2)\nTests  1 failed | 1 passed (2)\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("src/passing.test.ts"));
		assert!(filtered.contains("× src/failing.test.ts"));
		assert!(filtered.contains("expected true to be false"));
		assert!(filtered.contains("Test Files  1 failed"));
	}

	#[test]
	fn keeps_playwright_numbered_failure_and_summary() {
		let input = "  ✓ 1 [chromium] › tests/ok.spec.ts:3:1 › ok (120ms)\n  1) [chromium] › \
		             tests/login.spec.ts:7:1 › login\n\n    Error: expect(locator).toBeVisible() \
		             failed\n      at tests/login.spec.ts:9:11\n\n  1 failed\n    [chromium] › \
		             tests/login.spec.ts:7:1 › login\n  1 passed (2.3s)\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("tests/ok.spec.ts"));
		assert!(filtered.contains("1) [chromium]"));
		assert!(filtered.contains("toBeVisible"));
		assert!(filtered.contains("1 failed"));
	}

	#[test]
	fn success_keeps_summary_when_everything_else_is_pass_noise() {
		let filtered = drop_passed_lines("✓ one passed\n✓ two passed\n3 passed (1.2s)\n");
		assert_eq!(filtered, "3 passed (1.2s)\n");
	}
	#[test]
	fn bun_pass_only_collapses_to_counts() {
		let input = "\
✓ a.test.ts > add works [0.50ms]
✓ a.test.ts > subtract works [0.30ms]
✓ b.test.ts > multiply works [0.40ms]
✓ b.test.ts > divide works [0.60ms]
✓ c.test.ts > negate works [0.20ms]

 5 pass
 0 fail
 7 expect() calls
Ran 5 tests across 3 files. [102.00ms]
";
		let filtered = drop_passed_lines(input);

		assert!(!filtered.contains("add works"));
		assert!(!filtered.contains("subtract works"));
		assert!(!filtered.contains("multiply works"));
		assert!(filtered.contains("5 pass"));
		assert!(filtered.contains("0 fail"));
		assert!(filtered.contains("7 expect() calls"));
		assert!(filtered.contains("Ran 5 tests across 3 files"));
	}

	#[test]
	fn bun_failure_keeps_error_and_counts() {
		let input = "\
✗ a.test.ts > bad test [0.40ms]
error: expect(received).toBe(expected)
Expected: 2
Received: 3
      at a.test.ts:5:7

✓ b.test.ts > another good [0.60ms]

 2 pass
 1 fail
Ran 3 tests across 2 files. [150.00ms]
";
		let filtered = failures_only(input);

		assert!(!filtered.contains("another good"));
		assert!(filtered.contains("✗ a.test.ts > bad test"));
		assert!(filtered.contains("error: expect(received).toBe(expected)"));
		assert!(filtered.contains("Expected: 2"));
		assert!(filtered.contains("Received: 3"));
		assert!(filtered.contains("at a.test.ts:5:7"));
		assert!(filtered.contains("2 pass"));
		assert!(filtered.contains("1 fail"));
	}

	// Regression: bun's non-TTY reporter marks results as `(pass)`/`(fail)` and
	// prints the code frame + `error:` block *before* the `(fail)` line. The
	// old filter recognized none of these markers and reduced a failing run to
	// bare counts, dropping the failed test name and assertion entirely.
	#[test]
	fn bun_non_tty_failure_keeps_error_block_fail_line_and_counts() {
		let input = "\
bun test v1.2.19 (aad3abea)

test/ok.test.ts:
(pass) suite > works [0.12ms]

test/bundled-reference-laziness.test.ts:
14 | \tconst result = runFixture();
15 | \texpect(result.exitCode).toBe(0);
              ^
error: expect(received).toBe(expected)

Expected: 0
Received: 1

      at runFixture (/work/pi/packages/catalog/test/bundled-reference-laziness.test.ts:14:52)
      at <anonymous> (/work/pi/packages/catalog/test/bundled-reference-laziness.test.ts:20:43)
(fail) bundled model laziness > provider options and the bundled registry stay lazy [124.31ms]

 625 pass
 1 fail
 3042 expect() calls
Ran 626 tests across 84 files. [8.37s]
";
		let filtered = failures_only(input);

		assert!(!filtered.contains("(pass) suite > works"));
		assert!(filtered.contains("error: expect(received).toBe(expected)"));
		assert!(filtered.contains("15 | \texpect(result.exitCode).toBe(0);"));
		assert!(filtered.contains("Expected: 0"));
		assert!(filtered.contains("Received: 1"));
		assert!(filtered.contains("at runFixture"));
		assert!(filtered.contains(
			"(fail) bundled model laziness > provider options and the bundled registry stay lazy"
		));
		assert!(filtered.contains("625 pass"));
		assert!(filtered.contains("1 fail"));
		assert!(filtered.contains("Ran 626 tests across 84 files."));
	}

	#[test]
	fn bun_non_tty_pass_lines_collapse_on_success() {
		let input = "\
bun test v1.2.19 (aad3abea)

test/ok.test.ts:
(pass) suite > works [0.12ms]
(pass) suite > also works [0.10ms]

 2 pass
 0 fail
Ran 2 tests across 1 file. [50.00ms]
";
		let filtered = drop_passed_lines(input);

		assert!(!filtered.contains("(pass)"));
		assert!(filtered.contains("2 pass"));
		assert!(filtered.contains("0 fail"));
		assert!(filtered.contains("Ran 2 tests across 1 file."));
	}

	// A failing run in an unrecognized format must never collapse to bare
	// summary counts: the actual failure text is the whole point of the output.
	#[test]
	fn unrecognized_failure_format_falls_back_to_head_tail() {
		let input = "something exploded in a novel way\nTests: 1 failed, 1 total\n";
		let filtered = failures_only(input);

		assert!(filtered.contains("something exploded in a novel way"));
		assert!(filtered.contains("Tests: 1 failed, 1 total"));
	}

	#[test]
	fn vitest_many_passes_collapses_to_summary() {
		let input = "\
 ✓ src/a.test.ts > suite > test1 (2ms)
 ✓ src/a.test.ts > suite > test2 (1ms)
 ✓ src/a.test.ts > other > test3 (3ms)
 ✓ src/b.test.ts > feature > test4 (1ms)
 ✓ src/b.test.ts > feature > test5 (2ms)
 ✓ src/b.test.ts > edge > test6 (5ms)

 Test Files  2 passed (2)
      Tests  6 passed (6)
   Start at  12:00:00
   Duration  1.23s
";
		let filtered = drop_passed_lines(input);

		assert!(!filtered.contains("test1"));
		assert!(!filtered.contains("test6"));
		assert!(filtered.contains("Test Files  2 passed (2)"));
		assert!(filtered.contains("Tests  6 passed (6)"));
		assert!(filtered.contains("Duration  1.23s"));
	}

	#[test]
	fn jest_many_passes_collapses_to_summary() {
		let input = "\
 PASS  src/a.test.ts
 PASS  src/b.test.ts
 PASS  src/c.test.ts
 PASS  src/d.test.ts
 PASS  src/e.test.ts

Test Suites: 5 passed, 5 total
Tests:       32 passed, 32 total
Snapshots:   0 total
Time:        2.345s
";
		let filtered = drop_passed_lines(input);

		assert!(!filtered.contains("src/a.test.ts"));
		assert!(!filtered.contains("src/e.test.ts"));
		assert!(filtered.contains("Test Suites: 5 passed, 5 total"));
		assert!(filtered.contains("Tests:       32 passed, 32 total"));
		assert!(filtered.contains("Time:        2.345s"));
	}

	// Ported from snip/filters/jest.yaml's "all passing" inline test. snip keeps
	// PASS lines; the minimizer collapses pass runs to the count summary, which is
	// strictly less noisy, so the expectation is adjusted to drop the PASS lines.
	#[test]
	fn jest_all_passing_collapses_to_summary() {
		let input = "PASS  src/__tests__/utils.test.js\nPASS  src/__tests__/main.test.js\n\nTest \
		             Suites: 2 passed, 2 total\nTests:       5 passed, 5 total\nSnapshots:   0 \
		             total\nTime:        1.234 s\n";
		let filtered = drop_passed_lines(input);

		assert!(!filtered.contains("utils.test.js"));
		assert!(!filtered.contains("main.test.js"));
		assert!(filtered.contains("Test Suites: 2 passed, 2 total"));
		assert!(filtered.contains("Tests:       5 passed, 5 total"));
		assert!(filtered.contains("Time:        1.234 s"));
	}

	// Ported from snip/filters/jest.yaml's "with failures and stack traces" inline
	// test. snip strips the code frame and `at` stack lines; the minimizer keeps
	// that richer failure context. The new strips fold in here: the trailing "Ran
	// all test suites." banner is dropped and the PASS line collapses.
	#[test]
	fn jest_failures_drop_ran_banner_and_keep_rich_context() {
		let input =
			"PASS  src/__tests__/utils.test.js\nFAIL  src/__tests__/main.test.js\n  ● Main > should \
			 return correct value\n\n    expect(received).toBe(expected)\n\n    Expected: 4\n    \
			 Received: 3\n\n      5 |   test('should return correct value', () => {\n      6 |     \
			 expect(calculate(2, 2)).toBe(4);\n        |             ^\n      7 |   });\n\n    at \
			 Object.<anonymous> (src/__tests__/main.test.js:6:29)\n\nTest Suites: 1 failed, 1 \
			 passed, 2 total\nTests:       1 failed, 3 passed, 4 total\nSnapshots:   0 total\nTime:    \
			 1.234 s\nRan all test suites.\n";
		let filtered = failures_only(input);

		// PASS line collapses; failure context survives.
		assert!(!filtered.contains("PASS  src/__tests__/utils.test.js"));
		assert!(filtered.contains("FAIL  src/__tests__/main.test.js"));
		assert!(filtered.contains("● Main > should return correct value"));
		assert!(filtered.contains("Expected: 4"));
		assert!(filtered.contains("Received: 3"));
		assert!(filtered.contains("Test Suites: 1 failed, 1 passed, 2 total"));
		// New snip strip: the zero-information banner is gone.
		assert!(!filtered.contains("Ran all test suites"));
	}

	// New jest console.log strip (snip jest.yaml `^\s+console\.`): echoed
	// console output is dropped on both the pass and fail paths.
	#[test]
	fn jest_console_log_noise_is_dropped() {
		let pass_input = "PASS  src/a.test.ts\n  console.log\n    debugging value 42\n      at \
		                  log.ts:3:9\n\nTests:       1 passed, 1 total\n";
		let pass_filtered = drop_passed_lines(pass_input);
		assert!(!pass_filtered.contains("console.log"));
		assert!(pass_filtered.contains("Tests:       1 passed, 1 total"));

		let fail_input = "FAIL  src/a.test.ts\n  ● breaks\n    console.error\n      noisy log \
		                  line\n    Expected: 1\n    Received: 2\n\nTests:       1 failed, 1 total\n";
		let fail_filtered = failures_only(fail_input);
		assert!(!fail_filtered.contains("console.error"));
		assert!(fail_filtered.contains("Expected: 1"));
		assert!(fail_filtered.contains("Received: 2"));
		assert!(fail_filtered.contains("Tests:       1 failed, 1 total"));
	}

	// Vitest default-reporter regression (keep-minimizer; pure lock). A failing
	// file's multi-line `AssertionError: expected X to be Y` block plus the
	// `❯ file:line` pointer must survive failures_only.
	#[test]
	fn vitest_assertion_error_block_and_pointer_survive() {
		let input = " ✓ src/passing.test.ts (3)\n ❯ src/math.test.ts (1)\n   × adds numbers\n\n  \
		             AssertionError: expected 3 to be 4 // Object.is equality\n\n  - Expected\n  + \
		             Received\n\n  - 4\n  + 3\n\n ❯ src/math.test.ts:7:23\n\n Test Files  1 failed \
		             | 1 passed (2)\n      Tests  1 failed | 1 passed (2)\n";
		let filtered = failures_only(input);

		assert!(!filtered.contains("src/passing.test.ts"));
		assert!(filtered.contains("× adds numbers"));
		assert!(filtered.contains("AssertionError: expected 3 to be 4"));
		assert!(filtered.contains("❯ src/math.test.ts:7:23"));
		assert!(filtered.contains("Test Files  1 failed | 1 passed (2)"));
	}
}
