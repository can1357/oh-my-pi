//! GitHub CLI output filters.

use std::fmt::Write as _;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"pr"
				| "issue"
				| "run" | "workflow"
				| "repo" | "api"
				| "search"
				| "release"
				| "codespace"
				| "gist"
		)
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_raw_mode(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "checks") => {
			match filter_pr_checks(&cleaned) {
				Some(summary) => summary,
				None => filter_pr_issue(&cleaned, exit_code),
			}
		},
		Some("pr" | "issue") => filter_pr_issue(&cleaned, exit_code),
		Some("run" | "workflow") => filter_run(&cleaned, exit_code),
		_ => primitives::head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn preserves_raw_mode(ctx: &MinimizerCtx<'_>) -> bool {
	match ctx.subcommand {
		Some("api") => true,
		Some("run") => {
			primitives::command_has_ordered_tokens(ctx.command, "run", "view")
				&& primitives::command_has_any_token(ctx.command, &["--log", "--log-failed", "--json"])
		},
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "checks") => {
			// `--watch` re-renders the whole check table each `--interval`/-i
			// (default 10s) until checks finish; the captured buffer is then
			// dozens of concatenated frames. `filter_pr_checks` counts one glyph
			// per row per frame, so it would report counts x frames and let
			// duplicate failed rows exhaust FAILED_ROW_CAP, hiding distinct later
			// failures. A watch is an explicit live view -- pass it through raw
			// instead of summarizing a multi-frame buffer. (--json/-w break the
			// table shape outright.)
			primitives::command_has_any_token(ctx.command, &[
				"--json",
				"--web",
				"-w",
				"--jq",
				"--template",
				"--watch",
				"--interval",
				"-i",
			])
		},
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "diff") => true,
		Some("pr") if primitives::command_has_ordered_tokens(ctx.command, "pr", "status") => {
			primitives::command_has_any_token(ctx.command, &["--web", "--jq", "--template"])
		},
		Some(subcommand @ ("pr" | "issue")) => {
			primitives::command_has_ordered_tokens(ctx.command, subcommand, "view")
				&& primitives::command_has_any_token(ctx.command, &["--json", "--jq", "--comments"])
		},
		_ => false,
	}
}

fn filter_pr_issue(input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return primitives::head_tail_dedup(input);
	}
	let markdown_filtered = filter_markdown_noise(input);
	primitives::head_tail_dedup(&markdown_filtered)
}

/// Summarize the DEFAULT (non-JSON) `gh pr checks` table.
///
/// Default human output is a tab-separated table:
/// `<symbol>\t<name>\t<duration>\t<url>` where the leading status glyph is
/// `✓`/`X`/`*`/`-` (pass/fail/pending/skipping). We re-derive against this real
/// layout — NOT rtk's `[ok]`/`[x]` strings, which only appear on the injected
/// `-F json` path. Failed rows stay verbatim (they carry the actionable URL);
/// passed/pending/skipping collapse to counts. Returns `None` when no
/// recognizable check rows are found so the caller can fall back to the generic
/// path.
fn filter_pr_checks(input: &str) -> Option<String> {
	let mut passed = 0usize;
	let mut pending = 0usize;
	let mut skipping = 0usize;
	let mut failed_rows = Vec::new();
	let mut saw_row = false;

	for line in input.lines() {
		let trimmed = line.trim_start();
		// A real check row is `<symbol>\t<name>\t<duration>\t<url>`: a status glyph
		// followed by at least one TAB-delimited field. Requiring the tab shape
		// keyed off the row's first glyph — NOT the leading char alone — rejects
		// separators (`---`), blank-glyph lines, and bulleted annotation detail
		// (`- ...`, `* ...`) that gh/CI tools emit, any of which would otherwise be
		// miscounted as a phantom skipping/pending check and inflate the summary.
		if !trimmed.contains('\t') {
			continue;
		}
		let Some(symbol) = trimmed.chars().next() else {
			continue;
		};
		match symbol {
			'✓' => {
				saw_row = true;
				passed += 1;
			},
			'X' | '✗' | '×' => {
				saw_row = true;
				failed_rows.push(line.trim_end().to_string());
			},
			'*' => {
				saw_row = true;
				pending += 1;
			},
			'-' => {
				saw_row = true;
				skipping += 1;
			},
			_ => {},
		}
	}

	if !saw_row {
		return None;
	}

	let mut out = String::new();
	let failed = failed_rows.len();
	let _ = write!(out, "checks: {passed} passed, {failed} failed");
	if pending > 0 {
		let _ = write!(out, ", {pending} pending");
	}
	if skipping > 0 {
		let _ = write!(out, ", {skipping} skipping");
	}
	out.push('\n');
	// Cap the verbatim failed rows: a PR with hundreds of failing checks would
	// otherwise emit one line each, uncapped (this path bypasses head_tail_dedup
	// that every sibling arm ends in). Keep the first FAILED_ROW_CAP failures —
	// they carry the actionable URLs — and append an omission marker.
	const FAILED_ROW_CAP: usize = 40;
	out.push_str(&primitives::head_lines_only(&failed_rows.join("\n"), FAILED_ROW_CAP));
	Some(out)
}

fn filter_run(input: &str, exit_code: i32) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	if exit_code != 0 || contains_failure_signal(input) {
		return primitives::head_tail_lines(&deduped, 160, 120);
	}
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn filter_markdown_noise(input: &str) -> String {
	let mut out = String::new();
	let mut in_html_comment = false;
	let mut previous_blank = false;
	let mut comment_lines = 0usize;

	for line in input.lines() {
		let trimmed = line.trim();
		if in_html_comment {
			if trimmed.contains("-->") {
				in_html_comment = false;
				comment_lines = 0;
			} else {
				comment_lines += 1;
				if comment_lines > 50 {
					in_html_comment = false;
					comment_lines = 0;
				}
			}
			continue;
		}
		if trimmed.starts_with("<!--") {
			if !trimmed.contains("-->") {
				in_html_comment = true;
				comment_lines = 0;
			}
			continue;
		}
		if primitives::is_markdown_badge_or_image(trimmed) || primitives::is_horizontal_rule(trimmed)
		{
			continue;
		}
		if trimmed.is_empty() {
			if !previous_blank {
				out.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;
		out.push_str(line.trim_end());
		out.push('\n');
	}
	out
}

fn contains_failure_signal(input: &str) -> bool {
	input.lines().any(|line| {
		let lower = line.to_ascii_lowercase();
		lower.contains("error")
			|| lower.contains("failed")
			|| lower.contains("failure")
			|| lower.contains("cancelled")
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn test_ctx<'a>(
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "gh", subcommand, command, config }
	}

	#[test]
	fn pr_issue_filter_removes_markdown_template_noise() {
		let input =
			"<!-- template -->\n# Title\n[![CI](https://img.shields.io/badge.svg)](url)\nBody\n---\n";
		let out = filter_pr_issue(input, 0);
		assert!(!out.contains("template"));
		assert!(!out.contains("shields.io"));
		assert!(out.contains("# Title"));
		assert!(out.contains("Body"));
	}

	#[test]
	fn run_filter_preserves_failure_tail_and_dedups() {
		let input = "step ok\nstep ok\nError: failed job\n";
		let out = filter_run(input, 1);
		assert!(out.contains("step ok (×2)"));
		assert!(out.contains("Error: failed job"));
	}

	#[test]
	fn api_json_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("api"), "gh api repos/owner/repo", &cfg);
		let input = "{\n  \"full_name\": \"owner/repo\",\n  \"private\": false\n}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn pr_checks_summarizes_default_table_and_keeps_failures() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123", &cfg);
		// DEFAULT `gh pr checks` table: <symbol>\t<name>\t<duration>\t<url>.
		let input = "✓\tbuild\t1m2s\thttps://ci.test/build\n\
		             X\ttest\t3m4s\thttps://ci.test/test\n\
		             *\tlint\t0s\thttps://ci.test/lint\n\
		             -\tdocs\t0s\thttps://ci.test/docs\n";

		let out = filter(&ctx, input, 1);

		assert!(out.changed);
		assert!(out.text.contains("checks: 1 passed, 1 failed"));
		assert!(out.text.contains("1 pending"));
		assert!(out.text.contains("1 skipping"));
		// Failed row stays verbatim with its actionable URL.
		assert!(out.text.contains("X\ttest\t3m4s\thttps://ci.test/test"));
		// Passed/pending/skipping rows collapse to counts only.
		assert!(!out.text.contains("https://ci.test/build"));
		assert!(!out.text.contains("https://ci.test/lint"));
	}

	#[test]
	fn pr_checks_caps_unbounded_failed_rows() {
		// A PR with hundreds of failing checks must not emit one verbatim line
		// each: the failed rows are capped (with an omission marker) like every
		// sibling path, not passed through unbounded.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123", &cfg);
		let mut input = String::new();
		for idx in 0..500 {
			let _ = writeln!(input, "X\tcheck{idx}\t1s\thttps://ci.test/{idx}");
		}

		let out = filter(&ctx, &input, 1);

		assert!(out.changed);
		assert!(out.text.contains("checks: 0 passed, 500 failed"));
		// First failures stay verbatim with their actionable URLs.
		assert!(out.text.contains("X\tcheck0\t1s\thttps://ci.test/0"));
		// The output is capped, not 501 lines of raw rows.
		assert!(out.text.contains("ln elided…]"));
		assert!(out.text.lines().count() < 60);
		assert!(!out.text.contains("https://ci.test/499"));
	}

	#[test]
	fn pr_checks_web_flag_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123 --web", &cfg);
		let input = "Opening https://github.com/owner/repo/pull/123/checks in your browser.\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn pr_checks_watch_session_is_passthrough() {
		// `--watch` re-renders the whole table each interval; the captured buffer
		// is many concatenated frames. Summarizing it would count every row once
		// per frame (counts x frames) and let duplicate failed rows exhaust the
		// FAILED_ROW_CAP, hiding distinct later failures. A watch must pass through
		// raw so the live frames survive intact.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123 --watch", &cfg);
		// Three frames of the same 1-pass/1-fail PR (what a watch concatenates).
		let frame =
			"\u{2713}\tbuild\t1m2s\thttps://ci.test/build\nX\ttest\t3m4s\thttps://ci.test/test\n";
		let input = format!("{frame}{frame}{frame}");

		let out = filter(&ctx, &input, 1);

		// Raw passthrough: no summary line, no inflated counts.
		assert!(!out.changed);
		assert_eq!(out.text, input);
		assert!(!out.text.contains("checks:"));
	}

	#[test]
	fn pr_checks_watch_interval_flags_are_passthrough() {
		// `-i`/`--interval` only take effect alongside `--watch`; recognizing
		// them (long and short forms, attached or spaced) keeps any watch variant
		// on the raw path.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = "\u{2713}\tbuild\t1m2s\thttps://ci.test/build\n";
		for command in ["gh pr checks 123 --watch -i 5", "gh pr checks 123 --watch --interval=5"] {
			let ctx = test_ctx(Some("pr"), command, &cfg);
			let out = filter(&ctx, input, 0);
			assert!(!out.changed, "expected passthrough for {command}");
			assert_eq!(out.text, input);
		}
	}

	#[test]
	fn pr_checks_ignores_non_tab_glyph_lines() {
		// Only `<symbol>\t...` rows count. A separator (`---`) and bulleted CI
		// annotation detail (`- ...`, `* ...`) whose first char matches a status
		// glyph must NOT be miscounted as phantom skipping/pending checks.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123", &cfg);
		let input = "✓\tbuild\t1m\thttps://ci.test/build\nX\ttest\t2m\thttps://ci.test/test\n---\n- \
		             annotation detail one\n- annotation detail two\n* note about the failure\n";

		let out = filter(&ctx, input, 1);

		assert!(out.changed);
		// Exactly 1 passed + 1 failed; no phantom pending/skipping from the
		// separator or the bulleted detail lines.
		assert!(out.text.contains("checks: 1 passed, 1 failed"));
		assert!(!out.text.contains("pending"));
		assert!(!out.text.contains("skipping"));
		// The failing row (with its actionable URL) is still kept verbatim.
		assert!(out.text.contains("X\ttest\t2m\thttps://ci.test/test"));
	}

	#[test]
	fn pr_checks_falls_back_when_no_rows() {
		// No recognizable glyph rows -> generic pr/issue path, not a bogus summary.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr checks 123", &cfg);
		let input = "no checks reported on this pull request\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.text.contains("checks: 0 passed"));
		assert!(out.text.contains("no checks reported"));
	}

	#[test]
	fn pr_diff_preserves_diff() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pr"), "gh pr diff 123", &cfg);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}
}
