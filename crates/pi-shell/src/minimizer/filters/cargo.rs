//! Cargo build/test output filters.

use std::{collections::BTreeMap, fmt::Write as _};

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"build"
				| "check"
				| "test" | "clippy"
				| "nextest"
				| "fmt" | "doc"
				| "bench"
				| "run" | "metadata"
				| "tree" | "update"
				| "install"
				| "publish"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("metadata") => input.to_string(),
		Some("test" | "bench") => failures_only(&cleaned, exit_code),
		Some("nextest") => filter_nextest(&cleaned),
		Some("clippy") => filter_clippy(&cleaned, exit_code),
		Some("build" | "check" | "doc" | "run") => condense_build(&cleaned),
		Some("fmt") => condense_fmt(&cleaned),
		Some("install") => filter_install(&cleaned, exit_code),
		Some("tree" | "update" | "publish") => compact_general(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn condense_build(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);
	let grouped = primitives::group_by_file(&stripped, 20);
	let deduped = primitives::dedup_consecutive_lines(&grouped);
	primitives::head_tail_lines(&deduped, 120, 60)
}

fn is_compiling_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
		|| trimmed.starts_with("Finished ")
		|| trimmed.starts_with("Documenting ")
		|| trimmed.starts_with("Running ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Locking ")
		|| trimmed.starts_with("Updating ")
		// `Blocking waiting for file lock on ...` is pure progress noise when a
		// concurrent cargo holds the lock (snip strips it in cargo-build/clippy).
		|| trimmed.starts_with("Blocking ")
		|| is_generated_warnings_rollup(trimmed)
}

/// The per-crate rollup line warning: `crate` (lib) generated N warnings.
/// The individual `warning: ...` diagnostic blocks are kept; this redundant
/// tally is dropped.  Clippy/install paths already skip it explicitly, so
/// stripping it here only affects build/check/doc/run condensing.
fn is_generated_warnings_rollup(trimmed: &str) -> bool {
	let Some(rest) = trimmed.strip_prefix("warning: ") else {
		return false;
	};
	rest.contains(" generated ") && (rest.ends_with(" warnings") || rest.ends_with(" warning"))
}

fn failures_only(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return summarize_successful_test_run(input);
	}
	let mut out = String::new();
	let mut keep = false;
	for line in input.lines() {
		let trimmed = line.trim_start();
		if trimmed.starts_with("failures:")
			|| trimmed.starts_with("---- ")
			|| trimmed.starts_with("error:")
			|| trimmed.starts_with("error[")
			|| trimmed.starts_with("thread '")
			|| trimmed.starts_with("test result: FAILED")
			|| trimmed.starts_with("test result: FAILED.")
		{
			keep = true;
		}
		// Passing test lines carry no failure signal — drop them unconditionally,
		// even after the keep flag latches, so a later passing suite in a
		// multi-suite run does not re-emit its `test <name> ... ok` lines.
		if is_passing_test_line(trimmed) {
			continue;
		}
		if keep || trimmed.starts_with("running ") {
			out.push_str(line);
			out.push('\n');
		}
	}
	if out.is_empty() {
		condense_build(input)
	} else {
		out
	}
}

#[derive(Default)]
struct CargoTestTotals {
	suites:   usize,
	passed:   u64,
	failed:   u64,
	ignored:  u64,
	measured: u64,
	filtered: u64,
	warnings: u64,
	duration: Option<String>,
}

fn summarize_successful_test_run(input: &str) -> String {
	let mut totals = CargoTestTotals::default();

	for line in input.lines() {
		let trimmed = line.trim();
		if let Some(summary) = trimmed.strip_prefix("test result: ok.") {
			totals.suites += 1;
			collect_cargo_test_summary(summary, &mut totals);
			continue;
		}
		if let Some(warnings) = parse_generated_warning_count(trimmed) {
			totals.warnings += warnings;
		}
	}

	if totals.suites == 0 {
		return strip_passing_tests(input);
	}

	let mut out = String::from("cargo test:");
	if totals.passed > 0 {
		out.push(' ');
		out.push_str(&totals.passed.to_string());
		out.push_str(" passed");
	} else {
		out.push_str(" ok");
	}

	let mut details = Vec::new();
	details.push(format_suite_count(totals.suites));
	if totals.failed > 0 {
		details.push(format!("{} failed", totals.failed));
	}
	if totals.ignored > 0 {
		details.push(format!("{} ignored", totals.ignored));
	}
	if totals.measured > 0 {
		details.push(format!("{} measured", totals.measured));
	}
	if totals.filtered > 0 {
		details.push(format!("{} filtered", totals.filtered));
	}
	if totals.warnings > 0 {
		details.push(format!("{} warnings", totals.warnings));
	}
	if let Some(duration) = totals.duration {
		details.push(duration);
	}
	if !details.is_empty() {
		out.push_str(" (");
		out.push_str(&details.join(", "));
		out.push(')');
	}
	out.push('\n');
	out
}

fn collect_cargo_test_summary(summary: &str, totals: &mut CargoTestTotals) {
	for part in summary.split(';') {
		let trimmed = part.trim().trim_end_matches('.');
		if let Some(value) = parse_count_prefix(trimmed, "passed") {
			totals.passed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "failed") {
			totals.failed += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "ignored") {
			totals.ignored += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "measured") {
			totals.measured += value;
		} else if let Some(value) = parse_count_prefix(trimmed, "filtered out") {
			totals.filtered += value;
		} else if let Some(duration) = trimmed.strip_prefix("finished in ") {
			totals.duration = Some(duration.to_string());
		}
	}
}

fn parse_generated_warning_count(line: &str) -> Option<u64> {
	if !line.contains(" generated ") || !line.ends_with(" warnings") {
		return None;
	}
	let before = line.rsplit_once(" warnings")?.0;
	let count_text = before.rsplit_once(' ')?.1;
	count_text.parse().ok()
}

fn parse_count_prefix(text: &str, label: &str) -> Option<u64> {
	let (count, rest) = text.split_once(' ')?;
	if rest != label {
		return None;
	}
	count.parse().ok()
}

fn format_suite_count(suites: usize) -> String {
	if suites == 1 {
		"1 suite".to_string()
	} else {
		format!("{suites} suites")
	}
}

fn strip_passing_tests(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim_start();
		if is_passing_test_line(trimmed) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

fn is_passing_test_line(trimmed: &str) -> bool {
	trimmed.starts_with("test ") && (trimmed.ends_with(" ... ok") || trimmed.ends_with("... ok"))
}

fn filter_nextest(input: &str) -> String {
	let mut out = String::new();
	let mut in_failure = false;
	let mut summary = None;
	let mut canceled = false;
	let mut past_summary = false;

	for line in input.lines() {
		let trimmed = line.trim();
		// Once the Summary line is seen, nextest re-lists the failing tests as a
		// recap (duplicate `FAIL [...]` rows + trailing noise).  Drop everything
		// after it; the captured Summary line is re-emitted verbatim at the end.
		if past_summary {
			continue;
		}
		if is_compiling_noise(trimmed)
			|| trimmed.starts_with("PASS ")
			|| trimmed.starts_with("────")
			|| trimmed.starts_with("Starting ")
		{
			continue;
		}
		if trimmed.starts_with("Summary [") {
			summary = Some(trimmed.to_string());
			in_failure = false;
			past_summary = true;
			continue;
		}
		if trimmed.starts_with("Cancelling") {
			canceled = true;
			continue;
		}
		if trimmed.starts_with("FAIL ") {
			in_failure = true;
			out.push_str(trimmed);
			out.push('\n');
			continue;
		}
		if in_failure && !trimmed.starts_with("error: test run failed") {
			out.push_str(line);
			out.push('\n');
		}
	}

	if canceled {
		out.push_str("Cancelling due to test failure\n");
	}
	if let Some(line) = summary {
		out.push_str(&line);
		out.push('\n');
	}
	if out.is_empty() {
		compact_general(input)
	} else {
		out
	}
}

fn condense_fmt(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let grouped = primitives::group_by_file(&deduped, 20);
	primitives::head_tail_lines(&grouped, 80, 40)
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_general_cargo_noise]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 80, 40)
}

fn is_general_cargo_noise(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("Downloaded ")
		|| trimmed.starts_with("Downloading ")
		|| trimmed.starts_with("Compiling ")
		|| trimmed.starts_with("Checking ")
		|| trimmed.starts_with("Fresh ")
}
/// Filter `cargo install` output: strip compilation/download noise, keep
/// install/error summaries.
fn filter_install(input: &str, exit_code: i32) -> String {
	let stripped = primitives::strip_lines(input, &[is_compiling_noise]);

	if exit_code != 0 {
		return primitives::head_tail_lines(&stripped, 100, 40);
	}

	let mut summaries = String::new();
	for line in stripped.lines() {
		let trimmed = line.trim_start();
		if is_install_summary(trimmed) || trimmed.starts_with("WARNING:") {
			summaries.push_str(line);
			summaries.push('\n');
		}
	}

	if summaries.is_empty() {
		let deduped = primitives::dedup_consecutive_lines(&stripped);
		primitives::head_tail_lines(&deduped, 60, 20)
	} else {
		primitives::dedup_consecutive_lines(&summaries)
	}
}

fn is_install_summary(line: &str) -> bool {
	line.starts_with("Installed ")
		|| line.starts_with("Replaced ")
		|| line.starts_with("Replacing ")
		|| line.starts_with("Ignored ")
}

#[derive(Debug)]
struct ClippyWarning {
	location:  String,
	message:   String,
	lint_rule: Option<String>,
}

/// Filter `cargo clippy`: group warnings by lint rule; keep errors verbatim.
fn filter_clippy(input: &str, exit_code: i32) -> String {
	let no_noise = primitives::strip_lines(input, &[is_compiling_noise]);

	let has_compile_error = no_noise.lines().any(|l| {
		let t = l.trim_start();
		(t.starts_with("error:")
			&& !t.starts_with("error: could not compile")
			&& !t.starts_with("error: aborting"))
			|| t.starts_with("error[")
	});

	if has_compile_error {
		let grouped = primitives::group_by_file(&no_noise, 20);
		return primitives::head_tail_lines(&grouped, 120, 60);
	}

	let warnings = parse_clippy_warnings(&no_noise);
	if warnings.is_empty() {
		let deduped = primitives::dedup_consecutive_lines(&no_noise);
		return primitives::head_tail_lines(&deduped, 80, 40);
	}

	format_clippy_grouped(&warnings, exit_code)
}

fn parse_clippy_warnings(input: &str) -> Vec<ClippyWarning> {
	let mut warnings = Vec::new();
	let lines: Vec<&str> = input.lines().collect();
	let mut i = 0;

	while i < lines.len() {
		let trimmed = lines[i].trim();
		if !trimmed.starts_with("warning: ") {
			i += 1;
			continue;
		}

		let msg = trimmed.strip_prefix("warning: ").unwrap_or("");
		// Skip summary lines like "warning: `crate` (lib) generated N warning(s)"
		if msg.contains(" generated ") && (msg.ends_with(" warnings") || msg.ends_with(" warning")) {
			i += 1;
			continue;
		}

		let message = msg.to_string();
		let mut location = String::new();
		let mut lint_rule = None;

		i += 1;
		while i < lines.len() {
			let t = lines[i].trim();
			if t.starts_with("--> ") {
				location = t.strip_prefix("--> ").unwrap_or("").to_string();
			}
			if let Some(rule) = extract_lint_rule(t) {
				lint_rule = Some(rule);
			}
			i += 1;
			if i >= lines.len() {
				break;
			}
			let next = lines[i].trim();
			if next.starts_with("warning: ")
				|| next.starts_with("error:")
				|| next.starts_with("error[")
			{
				break;
			}
		}

		if !message.is_empty() {
			warnings.push(ClippyWarning { location, message, lint_rule });
		}
	}

	warnings
}

fn extract_lint_rule(line: &str) -> Option<String> {
	let line = line.trim();
	if !line.starts_with("= note:") {
		return None;
	}
	let after_note = line.strip_prefix("= note:")?.trim();
	// Attribute form: `#[warn(rule)]` / `#[deny(rule)]` / `#[allow(rule)]`.
	if let Some(rest) = after_note
		.strip_prefix("`#[warn(")
		.or_else(|| after_note.strip_prefix("`#[deny("))
		.or_else(|| after_note.strip_prefix("`#[allow("))
	{
		return Some(rest.split(")]`").next()?.to_string());
	}
	// CLI form: `requested on the command line with `-W <rule>`` (also -D).
	// Lints enabled this way carry no `#[warn(...)]` note, so without this
	// branch they fall into the ungrouped bucket instead of grouping by rule.
	let cli = after_note.strip_prefix("requested on the command line with ")?;
	let flag = cli.strip_prefix('`')?.split('`').next()?.trim();
	let rule = flag
		.strip_prefix("-W ")
		.or_else(|| flag.strip_prefix("-D "))
		.or_else(|| flag.strip_prefix("-A "))?
		.trim();
	if rule.is_empty() {
		return None;
	}
	Some(rule.to_string())
}

fn format_clippy_grouped(warnings: &[ClippyWarning], exit_code: i32) -> String {
	let mut groups: BTreeMap<String, Vec<&ClippyWarning>> = BTreeMap::new();
	let mut ungrouped = Vec::new();

	for w in warnings {
		if let Some(ref rule) = w.lint_rule {
			groups.entry(rule.clone()).or_default().push(w);
		} else {
			ungrouped.push(w);
		}
	}

	let mut out = String::new();

	for (rule, warns) in &groups {
		if warns.len() == 1 {
			let loc = if warns[0].location.is_empty() {
				String::new()
			} else {
				format!("{}  ", warns[0].location)
			};
			let _ = writeln!(out, "clippy: {} — {}{}", rule, loc, warns[0].message);
		} else {
			let _ = writeln!(out, "clippy: {} ({} warnings)", rule, warns.len());
			for w in warns {
				let _ = writeln!(out, "  {}  {}", w.location, w.message);
			}
		}
	}

	for w in &ungrouped {
		let _ = writeln!(out, "clippy warning: {}  {}", w.location, w.message);
	}

	if exit_code != 0 {
		out.push_str("(clippy found issues)\n");
	}

	if out.is_empty() {
		"cargo clippy: ok\n".to_string()
	} else {
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn strips_compiling_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("build"),
			command:    "cargo build",
			config:     &cfg,
		};
		let out = filter(&ctx, "   Compiling foo v0.1.0\nerror: nope\nsrc/lib.rs:1:1 bad\n", 1);
		assert!(!out.text.contains("Compiling"));
		assert!(out.text.contains("error: nope"));
	}

	#[test]
	fn build_strips_blocking_lock_and_warning_rollup() {
		// `Blocking waiting for file lock` is concurrent-cargo progress noise;
		// the `warning: \`crate\` (lib) generated N warnings` rollup is a
		// redundant tally of the per-warning blocks, which are kept.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("build"),
			command:    "cargo build",
			config:     &cfg,
		};
		let input = concat!(
			"    Blocking waiting for file lock on build directory\n",
			"   Compiling foo v0.1.0\n",
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"warning: `foo` (lib) generated 1 warning\n",
			"    Finished dev [unoptimized + debuginfo] target(s) in 1.2s\n",
		);
		let out = filter(&ctx, input, 0);
		assert!(
			!out.text.contains("Blocking"),
			"blocking lock noise must be stripped: {:?}",
			out.text
		);
		assert!(
			!out.text.contains("generated 1 warning"),
			"warning rollup must be stripped: {:?}",
			out.text
		);
		// Per-warning diagnostic block is kept.
		assert!(
			out.text.contains("unused variable: `x`"),
			"warning block must survive: {:?}",
			out.text
		);
		assert!(out.text.contains("src/lib.rs:2:9"), "warning location must survive: {:?}", out.text);
	}

	#[test]
	fn drops_passing_test_lines_on_success() {
		let out =
			strip_passing_tests("running 2 tests\ntest a ... ok\ntest b ... ok\ntest result: ok\n");
		assert_eq!(out, "running 2 tests\ntest result: ok\n");
	}

	#[test]
	fn summarizes_successful_cargo_test_run() {
		let input = "warning: unused variable: `start`\nwarning: `rtk` (bin \"rtk\" test) generated \
		             17 warnings\nrunning 262 tests\ntest a ... ok\ntest b ... ok\ntest result: ok. \
		             262 passed; 0 failed; 0 ignored; 0 measured\n";
		let out = summarize_successful_test_run(input);
		assert_eq!(out, "cargo test: 262 passed (1 suite, 17 warnings)\n");
	}

	#[test]
	fn supports_nextest_and_keeps_failures_with_summary() {
		assert!(supports(Some("nextest")));
		// nextest re-lists failing tests as a recap AFTER the Summary line.  The
		// recap `FAIL [...]` row and `error: test run failed` trailer must be
		// dropped (past_summary), while the in-run FAIL block + verbatim Summary
		// line survive.
		let out = filter_nextest(
			"Starting 3 tests across 1 binary\nPASS crate::ok\nFAIL crate::bad\nstdout text\nSummary \
			 [0.2s] 2 tests run: 1 passed, 1 failed\nFAIL [   0.011s] crate::bad\nerror: test run \
			 failed\n",
		);
		assert!(!out.contains("PASS crate::ok"));
		assert!(out.contains("FAIL crate::bad"));
		assert!(out.contains("stdout text"));
		assert!(out.contains("Summary [0.2s] 2 tests run: 1 passed, 1 failed"));
		// Post-Summary recap row and trailing noise are dropped.
		assert!(!out.contains("FAIL [   0.011s]"), "post-Summary recap must be dropped: {out:?}");
		assert!(
			!out.contains("error: test run failed"),
			"post-Summary trailer must be dropped: {out:?}"
		);
	}
	#[test]
	fn install_strips_noise_keeps_summary() {
		assert!(supports(Some("install")));
		let input = concat!(
			"    Updating crates.io index\n",
			"  Downloaded foo v1.0.0\n",
			"   Compiling bar v0.1.0\n",
			"   Compiling tool v3.0.0\n",
			"    Finished release [optimized] target(s) in 45.2s\n",
			"  Installing /home/user/.cargo/bin/tool\n",
			"   Installed package `tool v3.0.0` (executable `tool`)\n",
		);
		let out = filter_install(input, 0);
		assert!(!out.contains("Compiling"));
		assert!(!out.contains("Downloaded"));
		assert!(!out.contains("Updating"));
		assert!(!out.contains("Finished"));
		assert!(out.contains("Installed package `tool v3.0.0`"));
	}

	#[test]
	fn install_already_installed() {
		let input = concat!(
			"    Updating crates.io index\n",
			"     Ignored package `tool v1.0.0` is already installed, use --force to override\n",
		);
		let out = filter_install(input, 0);
		assert!(!out.contains("Updating"));
		assert!(out.contains("Ignored package `tool v1.0.0`"));
	}

	#[test]
	fn install_error_preserves_context() {
		let input = concat!(
			"    Updating crates.io index\n",
			"   Compiling foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/main.rs:5:9\n",
			"  |\n",
			"5 |     let y = x;\n",
			"  |             ^ not found in this scope\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_install(input, 1);
		assert!(!out.contains("Compiling"));
		assert!(!out.contains("Updating"));
		assert!(out.contains("error[E0425]"));
		assert!(out.contains("cannot find value `x`"));
	}

	#[test]
	fn clippy_groups_warnings_by_lint_rule() {
		assert!(supports(Some("clippy")));
		let input = concat!(
			"    Checking foo v0.1.0\n",
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^ help: if this is intentional, prefix with an underscore: `_x`\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: unused variable: `y`\n",
			" --> src/lib.rs:5:9\n",
			"  |\n",
			"5 |     let y = 2;\n",
			"  |         ^ help: if this is intentional, prefix with an underscore: `_y`\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: `foo` (lib) generated 2 warnings\n",
		);
		let out = filter_clippy(input, 0);
		assert!(!out.contains("Checking"));
		assert!(!out.contains("generated"));
		assert!(out.contains("unused_variables"));
		assert!(out.contains("2 warnings"));
		assert!(out.contains("src/lib.rs:2:9"));
		assert!(out.contains("src/lib.rs:5:9"));
	}

	#[test]
	fn clippy_single_warning_compact() {
		let input = concat!(
			"warning: redundant clone\n",
			" --> src/main.rs:10:3\n",
			"  |\n",
			"10|     foo.clone()\n",
			"  |     ^^^^^^^^^^^^ help: remove this\n",
			"  |\n",
			"  = note: `#[warn(clippy::redundant_clone)]` on by default\n",
			"\n",
			"warning: `foo` (bin \"foo\") generated 1 warning\n",
		);
		let out = filter_clippy(input, 0);
		assert!(!out.contains("generated"));
		assert!(out.contains("clippy::redundant_clone"));
		assert!(out.contains("src/main.rs:10:3"));
		assert!(out.contains("redundant clone"));
	}

	#[test]
	fn clippy_multiple_rules_grouped_separately() {
		let input = concat!(
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^\n",
			"  |\n",
			"  = note: `#[warn(unused_variables)]` on by default\n",
			"\n",
			"warning: redundant clone\n",
			" --> src/main.rs:10:3\n",
			"  |\n",
			"10|     foo.clone()\n",
			"  |     ^^^^^^^^^^^^ help: remove this\n",
			"  |\n",
			"  = note: `#[warn(clippy::redundant_clone)]` on by default\n",
			"\n",
			"warning: `foo` (lib) generated 2 warnings\n",
		);
		let out = filter_clippy(input, 0);
		assert!(out.contains("unused_variables"));
		assert!(out.contains("clippy::redundant_clone"));
		// Two separate groups, not merged
		let unused_pos = out.find("unused_variables").unwrap();
		let clone_pos = out.find("clippy::redundant_clone").unwrap();
		assert_ne!(unused_pos, clone_pos);
	}

	#[test]
	fn clippy_groups_cli_enabled_lint_via_command_line_note() {
		// A lint enabled on the command line (`-W clippy::needless_return`) emits
		// a `requested on the command line with` note instead of `#[warn(...)]`.
		// It must still GROUP under its rule, not fall into the ungrouped bucket.
		let input = concat!(
			"warning: unneeded `return` statement\n",
			" --> src/lib.rs:3:5\n",
			"  |\n",
			"3 |     return x;\n",
			"  |     ^^^^^^^^^\n",
			"  |\n",
			"  = note: requested on the command line with `-W clippy::needless_return`\n",
			"\n",
			"warning: `foo` (lib) generated 1 warning\n",
		);
		let out = filter_clippy(input, 0);
		// Grouped renderer prefixes rule-grouped lines with `clippy: <rule>`.
		assert!(
			out.contains("clippy: clippy::needless_return"),
			"CLI-enabled lint must group by rule: {out:?}"
		);
		// Not emitted via the ungrouped `clippy warning:` path.
		assert!(!out.contains("clippy warning:"), "CLI-enabled lint must not be ungrouped: {out:?}");
		assert!(out.contains("src/lib.rs:3:5"), "location must survive: {out:?}");
	}

	#[test]
	fn extract_lint_rule_parses_note_forms() {
		assert_eq!(
			extract_lint_rule("  = note: `#[warn(unused_variables)]` on by default"),
			Some("unused_variables".to_string())
		);
		assert_eq!(
			extract_lint_rule(
				"= note: requested on the command line with `-W clippy::needless_return`"
			),
			Some("clippy::needless_return".to_string())
		);
		assert_eq!(
			extract_lint_rule("= note: requested on the command line with `-D warnings`"),
			Some("warnings".to_string())
		);
		assert_eq!(
			extract_lint_rule("= note: requested on the command line with `-W dead_code`"),
			Some("dead_code".to_string())
		);
		assert_eq!(extract_lint_rule("= note: some other note"), None);
	}

	#[test]
	fn clippy_compile_error_falls_back_to_build_style() {
		let input = concat!(
			"   Compiling foo v0.1.0\n",
			"error[E0425]: cannot find value `x` in this scope\n",
			" --> src/lib.rs:5:9\n",
			"  |\n",
			"5 |     let y = x;\n",
			"  |             ^ not found in this scope\n",
			"error: could not compile `foo` due to 1 previous error\n",
		);
		let out = filter_clippy(input, 1);
		assert!(!out.contains("Compiling"));
		assert!(out.contains("error[E0425]"));
		assert!(out.contains("cannot find value `x`"));
		// Should NOT have clippy: prefix since it fell back to build style
		assert!(!out.contains("clippy:"));
	}

	#[test]
	fn clippy_exit_code_signals_issues() {
		let input = concat!(
			"warning: unused variable: `x`\n",
			" --> src/lib.rs:2:9\n",
			"  |\n",
			"2 |     let x = 1;\n",
			"  |         ^\n",
			"  |\n",
			"  = note: `#[deny(unused_variables)]` on by default\n",
		);
		let out = filter_clippy(input, 1);
		assert!(out.contains("(clippy found issues)"));
	}

	#[test]
	fn metadata_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("metadata"),
			command:    "cargo metadata --format-version 1",
			config:     &cfg,
		};
		let input = r#"{"packages":[{"name":"app","targets":[{"kind":["bin"]}]}],"resolve":null}"#;
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	// --- cargo test failure — failure block and panic line survive ---

	#[test]
	fn cargo_test_failure_keeps_thread_panic_and_failures_block() {
		// `cargo test` with exit 101 must surface the thread panic message,
		// the `failures:` block listing the failing test names, and the
		// `test result: FAILED` summary line.  Passing test lines and
		// `Compiling` noise must not appear.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test",
			config:     &cfg,
		};
		let input = concat!(
			"   Compiling pi-shell v0.1.0\n",
			"running 3 tests\n",
			"test ok_one ... ok\n",
			"test ok_two ... ok\n",
			"test bad_parse ... FAILED\n",
			"\n",
			"---- bad_parse stdout ----\n",
			"thread 'bad_parse' panicked at 'assertion failed: result.is_ok()', src/lib.rs:42:5\n",
			"note: run with RUST_BACKTRACE=1 for a backtrace.\n",
			"\n",
			"failures:\n",
			"    bad_parse\n",
			"\n",
			"test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured\n",
		);

		let out = filter(&ctx, input, 101);

		// Failure evidence must survive.
		assert!(
			out.text.contains("thread 'bad_parse' panicked"),
			"panic line must survive: {:?}",
			out.text
		);
		assert!(out.text.contains("failures:\n"), "failures block must survive: {:?}", out.text);
		assert!(out.text.contains("bad_parse"), "failing test name must survive: {:?}", out.text);
		assert!(out.text.contains("test result: FAILED"), "result line must survive: {:?}", out.text);
		// Noise must be stripped.
		assert!(!out.text.contains("Compiling"), "Compiling noise must be stripped");
		assert!(!out.text.contains("test ok_one"), "passing test lines must be stripped");
		assert!(!out.text.contains("test ok_two"), "passing test lines must be stripped");
	}

	#[test]
	fn cargo_test_multi_suite_drops_passing_lines_after_keep_latches() {
		// Suite 1 fails, latching the keep flag.  Suite 2 passes — its
		// `test <name> ... ok` lines must NOT leak through just because keep
		// is set.  Only failure evidence survives.
		let input = concat!(
			"running 1 tests\n",
			"test suite1_bad ... FAILED\n",
			"\n",
			"failures:\n",
			"    suite1_bad\n",
			"\n",
			"test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured\n",
			"running 2 tests\n",
			"test suite2_ok_a ... ok\n",
			"test suite2_ok_b ... ok\n",
			"test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured\n",
		);

		let out = failures_only(input, 101);

		// Failure evidence from suite 1 survives.
		assert!(out.contains("suite1_bad"), "failing test name must survive: {out:?}");
		assert!(out.contains("test result: FAILED"), "failed summary must survive: {out:?}");
		// Suite 2's passing lines must be dropped even though keep is latched.
		assert!(
			!out.contains("test suite2_ok_a"),
			"passing line after keep latch must be dropped: {out:?}"
		);
		assert!(
			!out.contains("test suite2_ok_b"),
			"passing line after keep latch must be dropped: {out:?}"
		);
	}

	#[test]
	fn cargo_test_success_via_filter_produces_one_line_summary() {
		// The token-savings contract: a full passing run must collapse to a
		// single `cargo test: N passed (M suite[s])` line through filter(),
		// not through the helper directly.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test --workspace",
			config:     &cfg,
		};
		let input = concat!(
			"   Compiling pi-shell v0.1.0\n",
			"running 42 tests\n",
			"test a ... ok\n",
			"test b ... ok\n",
			"test result: ok. 42 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
			"running 18 tests\n",
			"test c ... ok\n",
			"test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n",
			"warning: `pi-shell` (test \"integration\") generated 2 warnings\n",
		);

		let out = filter(&ctx, input, 0);

		assert!(out.changed, "successful run must be compacted");
		// One-line summary: total passed, suite count, warnings.
		assert!(out.text.contains("60 passed"), "total across suites must be summed: {:?}", out.text);
		assert!(out.text.contains("2 suites"), "suite count must appear: {:?}", out.text);
		assert!(out.text.contains("2 warnings"), "warning count must appear: {:?}", out.text);
		// No per-test lines.
		assert!(!out.text.contains("test a"), "individual test lines must be stripped");
		assert!(!out.text.contains("Compiling"), "Compiling noise must be stripped");
	}

	#[test]
	fn cargo_test_failure_exit_code_non_zero_is_not_summarized() {
		// A run that reports `test result: ok` but then exits non-zero
		// (e.g. a post-test hook failing) must not be falsely summarized
		// as a clean pass — failures_only should fall through to condense_build
		// rather than fabricating a `cargo test: N passed` line.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "cargo",
			subcommand: Some("test"),
			command:    "cargo test",
			config:     &cfg,
		};
		// The test suite itself says ok, but a subsequent build step failed.
		let input = concat!(
			"running 1 tests\n",
			"test it_works ... ok\n",
			"test result: ok. 1 passed; 0 failed\n",
			"error: could not compile `pi-shell` due to 1 previous error\n",
		);

		let out = filter(&ctx, input, 1);

		// Must not emit a clean "cargo test: N passed" summary because exit was
		// non-zero.
		assert!(
			!out.text.starts_with("cargo test:"),
			"must not fabricate a pass summary on non-zero exit: {:?}",
			out.text
		);
	}
}
