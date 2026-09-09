//! Ruby test and lint output filters.

use super::lint;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"rspec" | "rubocop" => true,
		"rake" | "rails" => !is_def_scoped_subcommand(subcommand),
		_ => false,
	}
}

/// Subcommands that have dedicated TOML defs and must run standalone instead
/// of being claimed by the generic ruby filter (which would overlay them).
fn is_def_scoped_subcommand(subcommand: Option<&str>) -> bool {
	matches!(subcommand, Some("db:migrate" | "db:rollback" | "routes"))
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ruby_tool(ctx.program, ctx.subcommand) {
		Some("rspec") => filter_rspec(&cleaned, exit_code),
		Some("minitest") => filter_minitest(&cleaned, exit_code),
		Some("rubocop") => filter_rubocop(&cleaned, exit_code),
		Some("rake") => filter_rake(&cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn ruby_tool<'a>(program: &'a str, subcommand: Option<&'a str>) -> Option<&'a str> {
	match (program, subcommand) {
		("rspec", _) => Some("rspec"),
		("rubocop", _) => Some("rubocop"),
		("rake" | "rails", Some(sub)) if is_minitest_subcommand(sub) => Some("minitest"),
		("rake" | "rails", Some(sub)) if is_def_scoped_subcommand(Some(sub)) => None,
		("rake" | "rails", _) => Some("rake"),
		_ => None,
	}
}

/// A rake/rails subcommand that runs minitest: the bare `test` task, a scoped
/// `test:<scope>` task (`test:models`, `test:system`, `test:all`), or a
/// namespaced `<ns>:test` task (`app:test`).
fn is_minitest_subcommand(sub: &str) -> bool {
	sub == "test" || sub.starts_with("test:") || sub.ends_with(":test")
}

fn filter_rspec(input: &str, exit_code: i32) -> String {
	if let Some(text) = compact_rspec_json(input) {
		return text;
	}

	// Strip rtk noise (Spring preloader, SimpleCov coverage block, DEPRECATION
	// warnings, `Finished in …` timing, Capybara screenshot detail) before both
	// the success and failure text paths. Ported from
	// rtk/src/cmds/ruby/rspec_cmd.rs::strip_noise, re-derived against the
	// minimizer's DEFAULT (non-JSON) output.
	let stripped = strip_rspec_noise(input);

	if exit_code == 0 {
		// snip behavior: on success collapse the doc-format tree to the
		// `N examples, 0 failures` summary (plus any pending lines), discarding
		// the per-example descriptions.
		return rspec_success_summary(&stripped);
	}

	let mut out = String::new();
	// Each rendered failure block is buffered separately so the total can be
	// capped at MAX_RENDERED_FAILURES with a `[…N failures elided…]` marker. The
	// buffered blocks are rendered into `out` the moment the `Failures:` section
	// ends — at the summary line or the `Failed examples:` boundary — so real
	// rspec ordering (`Failures:` details, then summary, then `Failed examples:`)
	// keeps each detail block under its own `Failures:` header instead of being
	// appended after the `Failed examples:` list.
	let mut blocks: Vec<String> = Vec::new();
	let mut current = String::new();
	let mut rendered_blocks = false;
	let mut in_failure = false;
	let mut in_failed_examples = false;

	for line in stripped.lines() {
		let trimmed = line.trim();
		if trimmed == "Failures:" {
			in_failure = true;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if trimmed == "Failed examples:" {
			flush_rspec_block(&mut blocks, &mut current);
			render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);
			in_failure = false;
			in_failed_examples = true;
			push_line(&mut out, line);
			continue;
		}
		if is_rspec_summary_line(trimmed) {
			flush_rspec_block(&mut blocks, &mut current);
			render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);
			in_failure = false;
			in_failed_examples = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if is_gem_backtrace(trimmed) || is_rspec_noise(trimmed) {
				continue;
			}
			if is_numbered_failure(trimmed) {
				flush_rspec_block(&mut blocks, &mut current);
			}
			current.push_str(line);
			current.push('\n');
			continue;
		}
		if in_failed_examples && !trimmed.is_empty() {
			push_line(&mut out, line);
		}
	}
	// Any failure blocks not yet rendered (no summary / `Failed examples:`
	// boundary was seen) are flushed at the end.
	flush_rspec_block(&mut blocks, &mut current);
	render_rspec_blocks(&mut out, &mut blocks, &mut rendered_blocks);

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// Render the buffered `Failures:` detail blocks into `out`, capped at
/// `MAX_RENDERED_FAILURES` with a `[…N failures elided…]` marker. Runs at most
/// once — guarded by `rendered` — so the section is emitted exactly where the
/// `Failures:` block ends (the summary line or `Failed examples:` boundary),
/// preserving real rspec section ordering.
fn render_rspec_blocks(out: &mut String, blocks: &mut Vec<String>, rendered: &mut bool) {
	if *rendered {
		blocks.clear();
		return;
	}
	let total = blocks.len();
	if total == 0 {
		return;
	}
	*rendered = true;
	for block in blocks.iter().take(MAX_RENDERED_FAILURES) {
		out.push_str(block);
	}
	if total > MAX_RENDERED_FAILURES {
		push_line(out, &format!("[…{} failures elided…]", total - MAX_RENDERED_FAILURES));
	}
	blocks.clear();
}

/// Cap on rendered failure blocks in non-JSON rspec output. rtk uses the same
/// limit (`MAX_RSPEC_FAILURES = 5`) — failure blocks carry full context, so a
/// handful is enough before collapsing to a `[…N failures elided…]` marker.
const MAX_RENDERED_FAILURES: usize = 5;

fn flush_rspec_block(blocks: &mut Vec<String>, current: &mut String) {
	if has_content(current) {
		blocks.push(std::mem::take(current));
	} else {
		current.clear();
	}
}

/// A numbered failure header like `1) User validates name`.
fn is_numbered_failure(trimmed: &str) -> bool {
	let Some(pos) = trimmed.find(')') else {
		return false;
	};
	let prefix = &trimmed[..pos];
	!prefix.is_empty() && prefix.chars().all(|ch| ch.is_ascii_digit())
}

/// Drop rtk-style rspec noise before the text paths. Mirrors
/// `rtk/src/cmds/ruby/rspec_cmd.rs::strip_noise`: Spring preloader, `SimpleCov`
/// coverage block (until the next blank line), `DEPRECATION WARNING:` lines,
/// the `Finished in …` timing line, and Capybara screenshot detail (kept as a
/// compact `[screenshot: path]`).
fn strip_rspec_noise(input: &str) -> String {
	let mut out = String::new();
	let mut in_simplecov = false;
	// The SimpleCov / coverage block only ever appears in the TRAILING region
	// (after the run completes), never inside a numbered `Failures:` block. The
	// donor's patterns (`simplecov`, `coverage/`, `.simplecov`) are unscoped
	// substring/prefix tests, so a failure whose description or assertion path
	// mentions SimpleCov coverage (e.g. `1) SimpleCov configuration loads`, or an
	// assertion about a `coverage/index.html` artifact) would falsely enter the
	// strip and swallow the entire failure block up to the next blank line. Gate
	// the strip to OUTSIDE the `Failures:` section so failure diagnostics survive.
	let mut in_failures = false;

	for line in input.lines() {
		let trimmed = line.trim();
		let lower = trimmed.to_ascii_lowercase();

		if trimmed == "Failures:" {
			in_failures = true;
		} else if trimmed == "Failed examples:"
			|| is_rspec_summary_line(trimmed)
			|| trimmed.starts_with("Finished in ")
		{
			// rspec always prints the `Finished in …` timing line AFTER the failure
			// details and BEFORE the trailing coverage block, so it reliably closes
			// the `Failures:` region even when the summary line trails the coverage
			// block (SimpleCov prints between timing and summary).
			in_failures = false;
		}

		if lower.contains("running via spring preloader") {
			continue;
		}
		if trimmed.starts_with("DEPRECATION WARNING:") {
			continue;
		}
		if trimmed.starts_with("Finished in ") {
			continue;
		}
		// Only strip the SimpleCov/coverage block when NOT inside a `Failures:`
		// section. The `coverage report` banner is anchored to its actual shape
		// (`Coverage report generated …`) rather than a bare `coverage/` prefix, so
		// a failure-detail line asserting on a `coverage/`-prefixed artifact path is
		// not mistaken for the banner.
		if !in_failures
			&& (is_coverage_banner(&lower)
				|| lower.contains("simplecov")
				|| lower.contains(".simplecov"))
		{
			in_simplecov = true;
			continue;
		}
		if in_simplecov {
			if trimmed.is_empty() {
				in_simplecov = false;
			}
			continue;
		}
		if let Some(rest) = trimmed.strip_prefix("saved screenshot to ") {
			push_line(&mut out, &format!("[screenshot: {}]", rest.trim()));
			continue;
		}

		push_line(&mut out, line);
	}

	out
}

/// The `SimpleCov` coverage-report banner that opens the trailing coverage
/// block, e.g. `Coverage report generated for RSpec to /app/coverage`. Anchored
/// to the banner shape so a failure-detail line merely mentioning a `coverage/`
/// path is not misread as the banner.
fn is_coverage_banner(lower: &str) -> bool {
	lower.starts_with("coverage report")
}

/// On a passing rspec run, keep only the `N examples, …` summary line plus any
/// pending lines; discard the doc-format example tree (snip behavior).
fn rspec_success_summary(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if is_rspec_summary_line(trimmed) || trimmed.starts_with("Pending") {
			push_line(&mut out, line);
		}
	}
	if has_content(&out) {
		out
	} else {
		ruby_test_success(input)
	}
}

fn compact_rspec_json(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let map = value.as_object()?;
	let mut out = String::new();

	if let Some(summary_line) = first_json_string(map, &["summary_line"]) {
		push_line(&mut out, summary_line);
	} else if let Some(summary) = map.get("summary").and_then(|value| value.as_object()) {
		push_line(&mut out, &rspec_summary_from_json(summary));
	}

	if let Some(examples) = map.get("examples").and_then(|value| value.as_array()) {
		for example in examples {
			let Some(example_map) = example.as_object() else {
				continue;
			};
			let status = first_json_string(example_map, &["status"]);
			if status == Some("failed") {
				push_rspec_json_example(&mut out, "FAILED", example_map);
			} else if status == Some("pending") {
				push_rspec_json_example(&mut out, "PENDING", example_map);
			}
		}
	}

	if let Some(errors) = map
		.get("errors_outside_of_examples")
		.and_then(|value| value.as_array())
	{
		for error in errors {
			if let Some(error_map) = error.as_object() {
				push_rspec_json_error(&mut out, error_map);
			}
		}
	}

	if has_content(&out) { Some(out) } else { None }
}

fn rspec_summary_from_json(map: &serde_json::Map<String, serde_json::Value>) -> String {
	let examples = first_json_u64(map, &["example_count"]);
	let failures = first_json_u64(map, &["failure_count"]);
	let pending = first_json_u64(map, &["pending_count"]);
	let errors = first_json_u64(map, &["errors_outside_of_examples_count"]);

	let mut parts = Vec::new();
	if let Some(examples) = examples {
		parts.push(format!("{examples} examples"));
	}
	if let Some(failures) = failures {
		parts.push(format!("{failures} failures"));
	}
	if let Some(pending) = pending {
		parts.push(format!("{pending} pending"));
	}
	if let Some(errors) = errors {
		parts.push(format!("{errors} errors outside examples"));
	}

	if parts.is_empty() {
		"RSpec JSON summary".to_string()
	} else {
		parts.join(", ")
	}
}

fn push_rspec_json_example(
	out: &mut String,
	label: &str,
	map: &serde_json::Map<String, serde_json::Value>,
) {
	let description = first_json_string(map, &["full_description", "description", "id"])
		.unwrap_or("<unknown example>");
	push_line(out, &format!("{label}: {description}"));
	push_json_location(out, map);

	if let Some(exception) = map.get("exception").and_then(|value| value.as_object()) {
		push_json_exception(out, exception);
	}
	if let Some(message) = first_json_string(map, &["pending_message", "message"]) {
		push_line(out, message);
	}
}

fn push_rspec_json_error(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	push_line(out, "ERROR outside examples");
	push_json_exception(out, map);
}

fn push_json_location(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(path) = first_json_string(map, &["file_path", "file", "path"]) {
		let mut location = path.to_string();
		if let Some(line) = first_json_u64(map, &["line_number", "line"]) {
			location.push(':');
			location.push_str(&line.to_string());
		}
		push_line(out, &location);
	}
}

fn push_json_exception(out: &mut String, map: &serde_json::Map<String, serde_json::Value>) {
	if let Some(class_name) = first_json_string(map, &["class", "class_name", "type"]) {
		push_line(out, class_name);
	}
	if let Some(message) = first_json_string(map, &["message", "description"]) {
		push_line(out, message);
	}
	if let Some(backtrace) = map.get("backtrace").and_then(|value| value.as_array()) {
		for frame in backtrace {
			if let Some(frame) = frame.as_str()
				&& !is_gem_backtrace(frame)
			{
				push_line(out, frame);
				break;
			}
		}
	}
}

fn first_json_string<'a>(
	map: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(|value| value.as_str()))
}

fn first_json_u64(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(serde_json::Value::as_u64))
}

fn filter_minitest(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		return ruby_test_success(input);
	}

	let mut out = String::new();
	let mut in_failure = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if starts_minitest_failure(trimmed) {
			in_failure = true;
			push_line(&mut out, line);
			continue;
		}
		if is_minitest_summary_line(trimmed) {
			in_failure = false;
			push_line(&mut out, line);
			continue;
		}
		if in_failure {
			if trimmed.starts_with("Finished in ") {
				in_failure = false;
				continue;
			}
			if !trimmed.is_empty() {
				push_line(&mut out, line);
			}
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// `RuboCop` output: keep lint's grouped offense rendering as primary, but
/// compact the `-a`/`-A` autocorrect run-summary line
/// (`N files inspected, M offenses detected, K offenses autocorrected`) — which
/// the grouped output otherwise keeps verbatim and buried — to a single `ok`
/// line. Ported from `rtk/src/cmds/ruby/rubocop_cmd.rs` autocorrect handling,
/// re-derived against the minimizer's DEFAULT text output.
fn filter_rubocop(input: &str, exit_code: i32) -> String {
	let condensed = lint::condense_lint_output("rubocop", input, exit_code);

	let mut out = String::new();
	let mut replaced = false;
	for line in condensed.lines() {
		let trimmed = line.trim();
		if !replaced
			&& trimmed.contains("inspected")
			&& trimmed.contains("autocorrected")
			&& let Some(compact) = compact_rubocop_autocorrect(trimmed)
		{
			push_line(&mut out, &compact);
			replaced = true;
			continue;
		}
		push_line(&mut out, line);
	}

	if replaced { out } else { condensed }
}

/// Build `ok rubocop -A (N files, K autocorrected)` from an autocorrect summary
/// line. Returns `None` when the counts cannot be parsed (keep the line as-is).
fn compact_rubocop_autocorrect(line: &str) -> Option<String> {
	let files = leading_number(line)?;
	let corrected = line
		.split(',')
		.rev()
		.find(|part| part.contains("autocorrected"))
		.and_then(leading_number)?;
	Some(format!("ok rubocop -A ({files} files, {corrected} autocorrected)"))
}

/// First whitespace-delimited token of `s` parsed as a count.
fn leading_number(s: &str) -> Option<usize> {
	s.split_whitespace().next()?.parse().ok()
}

/// Generic rake/rails task condenser for NON-test tasks. Keeps result/status
/// lines (mirrors snip's rake keep-lines pattern) plus the HEAD of a
/// `rake aborted!` traceback (the first few frames, which carry the real
/// cause). `rake test` / `rails test` never reach here — they route to
/// `filter_minitest`.
fn filter_rake(input: &str, exit_code: i32) -> String {
	// On a FAILING non-test task that prints no `rake aborted!` header, the
	// keep-lines pass below would retain only individually keyword-matching lines
	// and silently drop the keyword-less diagnostic body (offending records,
	// `Expected positive integer, got -3`-style value detail) — exactly the
	// failure-detail the task warns must survive. The head/tail safety net only
	// fires when `out` is empty, which a single keyword line defeats. So when the
	// task failed and produced no `rake aborted!` traceback, preserve the full
	// diagnostic via head/tail rather than the lossy keep-lines pass.
	if exit_code != 0 && !input.lines().any(|line| line.trim() == "rake aborted!") {
		return primitives::head_tail_lines(input, 80, 80);
	}

	let mut out = String::new();
	let mut aborted_frames = 0usize;
	let mut in_aborted = false;

	for line in input.lines() {
		let trimmed = line.trim();

		if trimmed == "rake aborted!" {
			in_aborted = true;
			aborted_frames = 0;
			push_line(&mut out, line);
			continue;
		}
		if in_aborted {
			// Keep the head of the traceback — the first few frames pinpoint the
			// cause — then drop the long tail.
			if aborted_frames < MAX_ABORTED_FRAMES {
				push_line(&mut out, line);
				aborted_frames += 1;
				continue;
			}
			// A blank line ends the traceback block; resume normal keep-lines.
			if trimmed.is_empty() {
				in_aborted = false;
			}
			continue;
		}

		if is_rake_keep_line(trimmed) {
			push_line(&mut out, line);
		}
	}

	if has_content(&out) {
		out
	} else {
		primitives::head_tail_lines(input, 80, 80)
	}
}

/// Number of `rake aborted!` traceback frames kept (HEAD): enough to localize
/// the failure without dumping the full Rake/Ruby internal stack.
const MAX_ABORTED_FRAMES: usize = 5;

/// snip rake.yaml keep-lines pattern, re-derived: task result / status / error
/// keywords worth surfacing from a non-test rake task.
fn is_rake_keep_line(trimmed: &str) -> bool {
	if trimmed.is_empty() {
		return false;
	}
	// rake aborted! always surfaces
	if trimmed.contains("rake aborted") {
		return true;
	}
	// warning: lines from asset compilation, migrations, etc. are signal
	if trimmed.to_ascii_lowercase().starts_with("warning:") {
		return true;
	}
	let lower = trimmed.to_ascii_lowercase();
	let words: Vec<&str> = lower.split_whitespace().collect();
	words.iter().any(|w| {
		matches!(
			*w,
			"passed"
				| "failed"
				| "error"
				| "fail" | "ok"
				| "finished"
				| "assertion"
				| "test" | "failure"
		)
	})
}

fn ruby_test_success(input: &str) -> String {
	let mut out = String::new();
	let mut summary = String::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if is_rspec_summary_line(trimmed) || is_minitest_summary_line(trimmed) {
			push_line(&mut summary, line);
			push_line(&mut out, line);
			continue;
		}
		if is_ruby_pass_noise(trimmed) {
			continue;
		}
		push_line(&mut out, line);
	}

	if has_content(&out) { out } else { summary }
}

fn starts_minitest_failure(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(number) = parts.next() else {
		return false;
	};
	let Some(kind) = parts.next() else {
		return false;
	};
	number.ends_with(')') && matches!(kind, "Failure:" | "Error:")
}

fn is_rspec_summary_line(trimmed: &str) -> bool {
	trimmed.contains(" examples, ") && (trimmed.contains(" failure") || trimmed.contains(" pending"))
}

fn is_minitest_summary_line(trimmed: &str) -> bool {
	// Minitest prints `N runs, …`; minitest-reporters prints `N tests, …`.
	// Accept either head form.
	(trimmed.contains(" runs, ") || trimmed.contains(" tests, "))
		&& trimmed.contains(" assertions, ")
		&& trimmed.contains(" failures, ")
		&& trimmed.contains(" errors")
}

fn is_ruby_pass_noise(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed == "."
		|| trimmed
			.chars()
			.all(|ch| matches!(ch, '.' | 'S' | 'F' | 'E'))
		|| trimmed.starts_with("Run options:")
		|| trimmed.starts_with("Running:")
		|| trimmed.starts_with("Randomized with seed")
		|| trimmed.starts_with("Finished in ")
		// minitest-reporters banner / progress lines.
		|| trimmed.starts_with("Started with run options")
		|| trimmed.starts_with("Progress:")
}

fn is_rspec_noise(trimmed: &str) -> bool {
	trimmed.starts_with("# ") && is_gem_backtrace(trimmed)
}

fn is_gem_backtrace(trimmed: &str) -> bool {
	trimmed.contains("/gems/")
		|| trimmed.contains("lib/rspec")
		|| trimmed.contains("lib/ruby/")
		|| trimmed.contains("vendor/bundle")
}

fn push_line(out: &mut String, line: &str) {
	out.push_str(line);
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
	fn supports_rspec_minitest_and_rubocop() {
		assert!(supports("rspec", None));
		assert!(supports("rake", Some("test")));
		assert!(supports("rails", Some("test")));
		assert!(supports("rubocop", None));
		// rake/rails are claimed GENERICALLY except for def-scoped subcommands
		// (db:migrate, db:rollback, routes) which run standalone via TOML defs.
		assert!(!supports("rake", Some("db:migrate")));
		assert!(!supports("rails", Some("db:migrate")));
		assert!(!supports("rails", Some("db:rollback")));
		assert!(!supports("rails", Some("routes")));
		assert!(supports("rake", Some("db:seed")));
		// test subcommand still routes to the minitest filter.
		assert_eq!(ruby_tool("rake", Some("test")), Some("minitest"));
		assert_eq!(ruby_tool("rails", Some("test")), Some("minitest"));
		assert_eq!(ruby_tool("rake", Some("db:seed")), Some("rake"));
		// Scoped (`test:<scope>`) and namespaced (`<ns>:test`) minitest tasks
		// must ALSO route to the minitest filter — the generic condenser would
		// strip 'Expected:'/'Actual:' failure-detail lines.
		assert_eq!(ruby_tool("rake", Some("test:models")), Some("minitest"));
		assert_eq!(ruby_tool("rails", Some("test:system")), Some("minitest"));
		assert_eq!(ruby_tool("rake", Some("test:all")), Some("minitest"));
		assert_eq!(ruby_tool("rake", Some("app:test")), Some("minitest"));
		// Def-scoped subcommands return None so the engine runs the TOML def
		// standalone instead of overlaying the generic rake condenser.
		assert_eq!(ruby_tool("rake", Some("db:migrate")), None);
		assert_eq!(ruby_tool("rails", Some("db:migrate")), None);
		assert_eq!(ruby_tool("rails", Some("routes")), None);
	}

	#[test]
	fn scoped_minitest_task_keeps_failure_detail() {
		// `rake test:models` yields subcommand="test:models" (detect.rs default
		// arm lowercases the first positional). It must route to filter_minitest
		// and KEEP the Expected/Actual assertion payload — the generic rake
		// condenser would drop those keyword-less lines.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rake",
			subcommand: Some("test:models"),
			command:    "rake test:models",
			config:     &cfg,
		};
		let input = "Run options: --seed 1\n\n# Running:\n\n.F\n\n  1) Failure:\nUserTest#test_name \
		             [test/models/user_test.rb:8]:\nExpected: true\n  Actual: false\n\n2 runs, 2 \
		             assertions, 1 failures, 0 errors, 0 skips\n";
		let out = filter(&context, input, 1);

		assert!(out.text.contains("1) Failure"));
		assert!(out.text.contains("test/models/user_test.rb:8"));
		// The diagnostic payload survives (the generic condenser would drop it).
		assert!(out.text.contains("Expected: true"));
		assert!(out.text.contains("Actual: false"));
		assert!(out.text.contains("2 runs, 2 assertions, 1 failures"));
	}

	#[test]
	fn rspec_failure_keeps_failure_context_and_summary() {
		let input = "..F\n\nFailures:\n\n  1) User validates name\n     Failure/Error: \
		             expect(user).to be_valid\n       expected valid? to return true, got false\n     \
		             # ./spec/models/user_spec.rb:12:in `block'\n     # \
		             ./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1\n\nFailed \
		             examples:\n\nrspec ./spec/models/user_spec.rb:12 # User validates name\n\n3 \
		             examples, 1 failure\n";
		let out = filter_rspec(input, 1);

		assert!(!out.contains("..F"));
		assert!(out.contains("User validates name"));
		assert!(out.contains("expected valid?"));
		assert!(out.contains("spec/models/user_spec.rb:12"));
		assert!(!out.contains("vendor/bundle"));
		assert!(out.contains("3 examples, 1 failure"));
	}

	#[test]
	fn minitest_failure_keeps_failure_and_summary() {
		let input = "Run options: --seed 1\n\n# Running:\n\n.F\n\nFinished in 0.001s, 2000 \
		             runs/s\n\n  1) Failure:\nUserTest#test_name \
		             [test/models/user_test.rb:8]:\nExpected false to be truthy.\n\n2 runs, 2 \
		             assertions, 1 failures, 0 errors, 0 skips\n";
		let out = filter_minitest(input, 1);

		assert!(!out.contains("Run options"));
		assert!(out.contains("1) Failure"));
		assert!(out.contains("test/models/user_test.rb:8"));
		assert!(out.contains("2 runs, 2 assertions, 1 failures"));
	}

	#[test]
	fn rspec_json_all_pass_preserves_summary() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:1]","full_description":"User is valid","status":"passed","file_path":"./spec/user_spec.rb","line_number":3}
	  ],
	  "summary": {"example_count":1,"failure_count":0,"pending_count":0,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 0 failures"
	}"#;
		let out = filter_rspec(input, 0);

		assert!(out.contains("1 example, 0 failures"));
		assert!(!out.contains("User is valid"));
	}

	#[test]
	fn rspec_json_failure_preserves_example_context() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:1]","full_description":"User validates name","status":"failed","file_path":"./spec/user_spec.rb","line_number":12,"exception":{"class":"RSpec::Expectations::ExpectationNotMetError","message":"expected valid? to return true, got false","backtrace":["./spec/user_spec.rb:12:in `block'","./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1"]}}
	  ],
	  "summary": {"example_count":1,"failure_count":1,"pending_count":0,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 1 failure"
	}"#;
		let out = filter_rspec(input, 1);

		assert!(out.contains("1 example, 1 failure"));
		assert!(out.contains("FAILED: User validates name"));
		assert!(out.contains("./spec/user_spec.rb:12"));
		assert!(out.contains("expected valid? to return true"));
		assert!(!out.contains("vendor/bundle"));
	}

	#[test]
	fn rspec_json_pending_preserves_pending_context() {
		let input = r#"{
	  "examples": [
		{"id":"./spec/user_spec.rb[1:2]","full_description":"User syncs later","status":"pending","file_path":"./spec/user_spec.rb","line_number":20,"pending_message":"Temporarily skipped"}
	  ],
	  "summary": {"example_count":1,"failure_count":0,"pending_count":1,"errors_outside_of_examples_count":0},
	  "summary_line":"1 example, 0 failures, 1 pending"
	}"#;
		let out = filter_rspec(input, 0);

		assert!(out.contains("1 example, 0 failures, 1 pending"));
		assert!(out.contains("PENDING: User syncs later"));
		assert!(out.contains("./spec/user_spec.rb:20"));
		assert!(out.contains("Temporarily skipped"));
	}

	#[test]
	fn rspec_json_errors_outside_examples_preserves_error_context() {
		let input = r#"{
	  "examples": [],
	  "errors_outside_of_examples": [
		{"class":"LoadError","message":"cannot load such file -- missing_helper","backtrace":["./spec/spec_helper.rb:4:in `require'","./vendor/bundle/ruby/3.3.0/gems/rspec-core/lib/rspec/core.rb:1"]}
	  ],
	  "summary": {"example_count":0,"failure_count":0,"pending_count":0,"errors_outside_of_examples_count":1},
	  "summary_line":"0 examples, 0 failures, 1 error occurred outside of examples"
	}"#;
		let out = filter_rspec(input, 1);

		assert!(out.contains("0 examples, 0 failures, 1 error occurred outside of examples"));
		assert!(out.contains("ERROR outside examples"));
		assert!(out.contains("LoadError"));
		assert!(out.contains("cannot load such file"));
		assert!(out.contains("./spec/spec_helper.rb:4"));
		assert!(!out.contains("vendor/bundle"));
	}

	#[test]
	fn rubocop_routes_to_lint_grouping() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rubocop",
			subcommand: None,
			command:    "rubocop",
			config:     &cfg,
		};
		let out = filter(
			&context,
			"app/models/user.rb:1:1: C: Style/FrozenStringLiteralComment: Missing frozen string \
			 literal comment.\napp/models/user.rb:2:7: W: Lint/UselessAssignment: Useless \
			 assignment.\n",
			1,
		);

		assert!(out.text.contains("2 diagnostics in 1 files"));
		assert!(out.text.contains("app/models/user.rb (2 diagnostics)"));
	}

	// ── CONCERN 1: rspec noise strip + failure cap + success collapse ──────

	#[test]
	fn rspec_strips_spring_simplecov_deprecation_and_timing_noise() {
		let input = "Running via Spring preloader in process 12345\n\nFailures:\n\n  1) User \
		             validates name\n     Failure/Error: expect(user).to be_valid\n       expected \
		             true got false\n     # ./spec/models/user_spec.rb:12\n\nFinished in 0.45 \
		             seconds (files took 1.2 seconds to load)\nDEPRECATION WARNING: thing is \
		             deprecated.\nCoverage report generated for RSpec to /app/coverage.\n142 / 200 \
		             LOC (71.0%) covered.\n\n3 examples, 1 failure\n";
		let out = filter_rspec(input, 1);

		assert!(!out.contains("Spring preloader"));
		assert!(!out.contains("Finished in"));
		assert!(!out.contains("DEPRECATION"));
		assert!(!out.contains("Coverage report"));
		assert!(!out.contains("LOC"));
		assert!(out.contains("User validates name"));
		assert!(out.contains("expected true got false"));
		assert!(out.contains("3 examples, 1 failure"));
	}

	#[test]
	fn rspec_caps_failure_blocks_at_five() {
		let mut input = String::from("Failures:\n\n");
		for i in 1..=7 {
			let _ = write!(
				input,
				"  {i}) Example number {i} fails\n     Failure/Error: expect(true).to eq(false)\n     \
				 # ./spec/a_spec.rb:{i}\n\n"
			);
		}
		input.push_str("7 examples, 7 failures\n");
		let out = filter_rspec(&input, 1);

		assert!(out.contains("Example number 1 fails"));
		assert!(out.contains("Example number 5 fails"));
		assert!(!out.contains("Example number 6 fails"));
		assert!(out.contains("[…2 failures elided…]"));
		assert!(out.contains("7 examples, 7 failures"));
	}

	#[test]
	fn rspec_exit_zero_collapses_doc_tree_to_summary() {
		// snip rspec_raw.txt-style doc-format run, but all passing: the doc tree
		// must collapse to the summary line only.
		let input = "Randomized with seed 12345\n\nUserController\n  GET /users\n    returns a list \
		             of users\n  POST /users\n    creates a new user\n\nOrderService\n  #process\n    \
		             processes payment\n\nFinished in 0.45 seconds\n5 examples, 0 failures\n";
		let out = filter_rspec(input, 0);

		assert!(out.contains("5 examples, 0 failures"));
		assert!(!out.contains("UserController"));
		assert!(!out.contains("processes payment"));
		assert!(!out.contains("Finished in"));
	}

	#[test]
	fn rspec_failure_real_order_keeps_detail_under_failures_header() {
		// Real rspec text emits sections in this order: `Failures:` numbered
		// detail blocks, then the summary line, then `Failed examples:` list (see
		// snip/tests/fixtures/rspec_raw.txt). The detail block must render under
		// the `Failures:` header (before the summary), not be appended after the
		// `Failed examples:` list.
		let input = "Failures:\n\n  1) User validates name\n     Failure/Error: expect(user).to \
		             be_valid\n       expected valid? to return true, got false\n     # \
		             ./spec/models/user_spec.rb:12\n\n1 example, 1 failure\n\nFailed \
		             examples:\n\nrspec ./spec/models/user_spec.rb:12 # User validates name\n";
		let out = filter_rspec(input, 1);

		let failures_at = out.find("Failures:").expect("Failures header present");
		let detail_at = out.find("expected valid?").expect("detail present");
		let summary_at = out.find("1 example, 1 failure").expect("summary present");
		let failed_examples_at = out
			.find("Failed examples:")
			.expect("failed-examples header");

		// Detail block sits under `Failures:` and before the summary; the
		// `Failed examples:` header comes after the summary — not collided with
		// the `Failures:` header.
		assert!(failures_at < detail_at, "detail must follow Failures header: {out}");
		assert!(detail_at < summary_at, "detail must precede summary: {out}");
		assert!(summary_at < failed_examples_at, "summary must precede Failed examples list: {out}");
		// The two section headers must not be adjacent (the collision symptom).
		assert!(detail_at < failed_examples_at, "detail must not land under Failed examples: {out}");
	}

	#[test]
	fn rspec_failure_doc_run_keeps_failed_examples_and_summary() {
		// The donor snip/tests/fixtures/rspec_raw.txt: a 3-failure doc run with no
		// `Failures:` detail block, only the doc tree + `Failed examples:` list.
		let input = "Randomized with seed 12345\n\nUserController\n  GET /users\n    returns a list \
		             of users\n\nFinished in 0.45623 seconds (files took 1.23 seconds to load)\n42 \
		             examples, 3 failures, 2 pending\n\nFailed examples:\n\nrspec \
		             ./spec/controllers/users_controller_spec.rb:25 # UserController POST /users \
		             with invalid params returns errors\nrspec \
		             ./spec/services/order_service_spec.rb:45 # OrderService #process with invalid \
		             order raises error\n";
		let out = filter_rspec(input, 1);

		assert!(out.contains("Failed examples:"));
		assert!(out.contains("users_controller_spec.rb:25"));
		assert!(out.contains("42 examples, 3 failures, 2 pending"));
		assert!(!out.contains("returns a list of users"));
		assert!(!out.contains("Finished in"));
	}

	// ── CONCERN 2: rubocop autocorrect summary compaction ──────────────────

	#[test]
	fn rubocop_autocorrect_summary_compacts_to_ok_line() {
		// A default `rubocop -A` run: grouped offenses stay primary, the
		// `N files inspected, M offenses detected, K offenses autocorrected`
		// run-summary line collapses to one ok line.
		let input = "app/models/user.rb:1:1: C: [Corrected] Style/FrozenStringLiteralComment: \
		             Missing frozen string literal comment.\napp/models/user.rb:10:5: C: \
		             [Corrected] Layout/TrailingWhitespace: Trailing whitespace detected.\n\n15 \
		             files inspected, 3 offenses detected, 3 offenses autocorrected\n";
		let out = filter_rubocop(input, 1);

		assert!(out.contains("ok rubocop -A (15 files, 3 autocorrected)"));
		assert!(!out.contains("offenses detected, 3 offenses autocorrected"));
		// Grouped offense output stays primary.
		assert!(out.contains("app/models/user.rb"));
	}

	// ── CONCERN 3: minitest `tests,` summary + reporter noise ──────────────

	#[test]
	fn minitest_accepts_tests_summary_and_strips_reporter_noise() {
		let input = "Started with run options --seed 37764\n\nProgress: \
		             |====================|\n\n.F\n\nFinished in 5.79938s\n\n  1) \
		             Failure:\nUserTest#test_name [test/models/user_test.rb:8]:\nExpected: true\n  \
		             Actual: false\n\n57 tests, 378 assertions, 1 failures, 0 errors, 0 skips\n";
		let out = filter_minitest(input, 1);

		assert!(!out.contains("Started with run options"));
		assert!(!out.contains("Progress:"));
		assert!(out.contains("1) Failure"));
		assert!(out.contains("test/models/user_test.rb:8"));
		assert!(out.contains("Expected: true"));
		assert!(out.contains("57 tests, 378 assertions, 1 failures"));
	}

	#[test]
	fn minitest_tests_summary_passes_through_success() {
		let input = "Started with run options --seed 1\n\nProgress: |==========|\n\nFinished in \
		             5.7s\n57 tests, 378 assertions, 0 failures, 0 errors, 0 skips\n";
		let out = filter_minitest(input, 0);

		assert!(out.contains("57 tests, 378 assertions, 0 failures"));
		assert!(!out.contains("Started with run options"));
		assert!(!out.contains("Progress:"));
	}

	// ── CONCERN 4: generic rake/rails condensation ─────────────────────────

	#[test]
	fn rake_generic_task_condensed_keeps_status_drops_chatter() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rake",
			subcommand: Some("db:seed"),
			command:    "rake db:seed",
			config:     &cfg,
		};
		let input = "Seeding users...\nLoading fixtures from db/seeds.rb\ncreating record \
		             1\ncreating record 2\nSeed finished successfully\nDone in 1.2s\n";
		let out = filter(&context, input, 0);

		assert!(out.text.contains("Seed finished successfully"));
		// Pure progress chatter without a status keyword is dropped.
		assert!(!out.text.contains("creating record 1"));
	}

	#[test]
	fn rspec_simplecov_named_failure_block_is_not_swallowed() {
		// A failure whose header/detail mentions SimpleCov (or a `coverage/`
		// artifact path) must NOT trigger the trailing-coverage strip: the whole
		// numbered block (header, Failure/Error, diff, file:line) must survive.
		let input = "Failures:\n\n  1) SimpleCov configuration loads correctly\n     Failure/Error: \
		             expect(config).to be_present\n       expected present\n     # \
		             ./spec/simplecov_spec.rb:5\n\n3 examples, 1 failure\n";
		let out = filter_rspec(input, 1);

		assert!(out.contains("SimpleCov configuration loads correctly"));
		assert!(out.contains("expected present"));
		assert!(out.contains("spec/simplecov_spec.rb:5"));
		assert!(out.contains("3 examples, 1 failure"));
	}

	#[test]
	fn rspec_coverage_path_assertion_in_failure_survives() {
		// A failure-detail line asserting on a `coverage/`-prefixed path must not be
		// mistaken for the SimpleCov coverage banner and swallowed.
		let input = "Failures:\n\n  1) Report generates coverage artifact\n     Failure/Error: \
		             expect(File).to exist\n       coverage/index.html should exist\n     # \
		             ./spec/report_spec.rb:9\n\n1 example, 1 failure\n";
		let out = filter_rspec(input, 1);

		assert!(out.contains("Report generates coverage artifact"));
		assert!(out.contains("coverage/index.html should exist"));
		assert!(out.contains("spec/report_spec.rb:9"));
		assert!(out.contains("1 example, 1 failure"));
	}

	#[test]
	fn rspec_trailing_simplecov_block_still_stripped() {
		// The trailing SimpleCov/coverage block (outside any `Failures:` section)
		// must STILL be stripped — the failure-block gate must not disable it.
		let input = "Failures:\n\n  1) User validates name\n     Failure/Error: expect(user).to \
		             be_valid\n       expected true got false\n     # ./spec/user_spec.rb:5\n\n3 \
		             examples, 1 failure\n\nCoverage report generated for RSpec to \
		             /app/coverage.\n142 / 200 LOC (71.0%) covered.\n";
		let out = filter_rspec(input, 1);

		assert!(out.contains("User validates name"));
		assert!(!out.contains("Coverage report"));
		assert!(!out.contains("LOC"));
		assert!(out.contains("3 examples, 1 failure"));
	}

	#[test]
	fn rake_failing_task_without_aborted_keeps_diagnostic_body() {
		// A FAILING non-test rake task that prints no `rake aborted!` header but
		// emits one keyword line plus keyword-less diagnostic body: the body lines
		// (offending records + `Expected positive integer, got -3` value detail)
		// must survive — the keep-lines pass alone would drop them.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rake",
			subcommand: Some("import:run"),
			command:    "rake import:run",
			config:     &cfg,
		};
		let input = "Starting import...\nImportError occurred during processing\nRecord 4821: \
		             invalid value '<<>>' in column total\nRecord 4822: foreign key 9912 \
		             missing\nExpected positive integer, got -3\n";
		let out = filter(&context, input, 1);

		assert!(out.text.contains("ImportError occurred during processing"));
		assert!(out.text.contains("Record 4821"));
		assert!(out.text.contains("Record 4822"));
		assert!(out.text.contains("Expected positive integer, got -3"));
	}

	#[test]
	fn rake_keep_warning_lines() {
		assert!(is_rake_keep_line("warning: constant Foo::Bar is deprecated"));
		assert!(is_rake_keep_line("Warning: could not find JAVA_HOME"));
		// non-warning task chatter still dropped
		assert!(!is_rake_keep_line("Compiling assets..."));
	}

	#[test]
	fn rake_aborted_keeps_traceback_head() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = MinimizerCtx {
			program:    "rake",
			subcommand: Some("db:seed"),
			command:    "rake db:seed",
			config:     &cfg,
		};
		let mut input = String::from("rake aborted!\nNameError: undefined local variable\n");
		for i in 0..20 {
			let _ = writeln!(input, "/app/lib/task_{i}.rb:{i}:in `block'");
		}
		input.push_str("\nTasks: TOP => db:seed\n");
		let out = filter(&context, &input, 1);

		assert!(out.text.contains("rake aborted!"));
		assert!(out.text.contains("NameError: undefined local variable"));
		// HEAD frames kept, deep tail dropped.
		assert!(out.text.contains("task_0.rb"));
		assert!(!out.text.contains("task_15.rb"));
	}
}
