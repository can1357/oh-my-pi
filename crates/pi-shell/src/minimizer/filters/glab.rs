//! GitLab CLI (glab) output filters.

use std::{fmt::Write as _, sync::LazyLock};

use regex::Regex;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

/// Match GitLab CI section markers: `section_start/end:timestamp:name` followed
/// by bracket code.
static SECTION_MARKER_RE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"section_(?:start|end):\d+:[a-z0-9_]+\[[\d;]*[A-Za-z]").unwrap());

/// Match bare bracket ANSI-like codes without ESC prefix: `[0K`, `[0;m`,
/// `[36;1m`, etc.
static BARE_ANSI_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[[\d;]+[A-Za-z]").unwrap());

/// Multiple consecutive blank lines (3+ newlines) collapsed to double newline.
static MULTI_BLANK_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(subcommand, Some("mr" | "issue" | "ci" | "pipeline" | "release"))
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if preserves_raw_mode(ctx) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("ci") if primitives::command_has_ordered_tokens(ctx.command, "ci", "trace") => {
			filter_ci_trace(&cleaned)
		},
		Some("release") if primitives::command_has_ordered_tokens(ctx.command, "release", "list") => {
			match filter_release_list(&cleaned) {
				Some(summary) => summary,
				None => primitives::head_tail_dedup(&cleaned),
			}
		},
		Some("release") if primitives::command_has_ordered_tokens(ctx.command, "release", "view") => {
			filter_release_view(&cleaned)
		},
		Some("mr" | "issue")
			if primitives::command_has_ordered_tokens(ctx.command, "mr", "view")
				|| primitives::command_has_ordered_tokens(ctx.command, "issue", "view") =>
		{
			filter_mr_issue_view(&cleaned, exit_code)
		},
		_ => primitives::head_tail_dedup(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// Check whether the command should be passed through unmodified.
fn preserves_raw_mode(ctx: &MinimizerCtx<'_>) -> bool {
	// -F, --output, --json anywhere -> passthrough (user chose output format)
	if primitives::command_has_any_token(ctx.command, &["-F", "--output", "--json"]) {
		return true;
	}
	// --web anywhere -> passthrough (opens browser)
	if primitives::command_has_any_token(ctx.command, &["--web"]) {
		return true;
	}
	// api subcommand -> passthrough (advanced user)
	if ctx.subcommand == Some("api") {
		return true;
	}
	// --comments for mr view / issue view -> passthrough
	if primitives::command_has_any_token(ctx.command, &["--comments"])
		&& (primitives::command_has_ordered_tokens(ctx.command, "mr", "view")
			|| primitives::command_has_ordered_tokens(ctx.command, "issue", "view"))
	{
		return true;
	}
	// mr diff -> passthrough (raw unified diff must be un-modified)
	if primitives::command_has_ordered_tokens(ctx.command, "mr", "diff") {
		return true;
	}
	false
}

// ── CI trace filter ────────────────────────────────────────────────────

/// Filter `glab ci trace` output: strip section markers, bare ANSI codes,
/// and runner boilerplate. Keep warnings, errors, and build output.
fn filter_ci_trace(input: &str) -> String {
	// Strip section markers first (they contain bracket codes), then bare ANSI
	// codes
	let cleaned = SECTION_MARKER_RE.replace_all(input, "");
	let cleaned = BARE_ANSI_RE.replace_all(&cleaned, "");

	let mut filtered = String::new();
	let mut previous_blank = false;

	for line in cleaned.lines() {
		let trimmed = line.trim();

		if trimmed.is_empty() {
			if !previous_blank {
				filtered.push('\n');
			}
			previous_blank = true;
			continue;
		}
		previous_blank = false;

		// Skip runner boilerplate
		if trimmed.starts_with("Running with gitlab-runner")
			|| (trimmed.starts_with("on ") && trimmed.contains("system ID:"))
			|| trimmed.starts_with("Using Docker executor")
			|| trimmed.starts_with("Running on runner-")
			|| trimmed.starts_with("Preparing the")
			|| trimmed.starts_with("Preparing environment")
			|| trimmed.starts_with("Getting source from")
			|| trimmed.starts_with("Resolving secrets")
			|| trimmed.starts_with("Cleaning up")
			|| trimmed.starts_with("Uploading artifacts")
			|| trimmed.starts_with("Downloading artifacts")
			|| trimmed.starts_with("Runtime platform")
			|| trimmed.starts_with("Fetching changes with git")
			|| trimmed.starts_with("Initialized empty Git")
			|| trimmed.starts_with("Created fresh repository")
			|| trimmed.starts_with("Checking out ")
			|| trimmed.starts_with("Skipping Git submodules")
		{
			continue;
		}

		filtered.push_str(trimmed);
		filtered.push('\n');
	}

	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&filtered), 120, 80)
}

// ── Release list filter ───────────────────────────────────────────────

/// Parse `glab release list` tab-separated output into compact form.
/// Returns `None` if no TAB-separated rows are found (caller falls through
/// to `head_tail_dedup`).
fn filter_release_list(input: &str) -> Option<String> {
	let mut lines = input.lines().peekable();
	let mut filtered = String::new();

	// Skip "Showing N releases..." preamble and blank lines until header.
	// Parse the total count from the preamble line if present.
	let mut total: Option<usize> = None;
	while let Some(line) = lines.peek() {
		let trimmed = line.trim();
		if trimmed.starts_with("Name\t") || trimmed.starts_with("NAME\t") {
			lines.next(); // consume header
			break;
		}
		// Parse "Showing N releases on owner/repo." or similar
		if total.is_none()
			&& let Some(rest) = trimmed.strip_prefix("Showing ")
			&& let Some(n_str) = rest.split_whitespace().next()
			&& let Ok(n) = n_str.parse::<usize>()
		{
			total = Some(n);
		}
		lines.next();
	}

	filtered.push_str("Releases\n");

	let mut count = 0;
	let mut has_more = false;
	for line in &mut lines {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}

		let parts: Vec<&str> = trimmed.split('\t').collect();
		if parts.len() < 3 {
			continue;
		}

		if count >= 20 {
			// We've already emitted 20 rows and found a 21st valid row.
			has_more = true;
			break;
		}

		let name = parts[0].trim();
		let tag = parts[1].trim();
		let created = parts[2].trim();

		if name == tag {
			let _ = writeln!(filtered, "  {name} ({created})");
		} else {
			let _ = writeln!(filtered, "  {name} [{tag}] ({created})");
		}

		count += 1;
	}

	if count == 0 {
		return None;
	}

	// Append omission marker when there are more releases than shown.
	let omitted = total.map_or(0, |t| t.saturating_sub(count));
	if omitted > 0 {
		let _ = writeln!(filtered, "[…{omitted} releases elided…]");
	} else if has_more {
		// Total not parsed from preamble but a 21st row was observed; signal
		// truncation.
		filtered.push_str("[…releases elided…]\n");
	}

	Some(filtered)
}

// ── Release view filter ───────────────────────────────────────────────

/// Filter `glab release view` output: strip SOURCES block, image-only lines,
/// `Image: name -> url` lines, HTML comments, horizontal rules, and collapse
/// multiple blank lines.
fn filter_release_view(input: &str) -> String {
	let mut filtered = String::new();
	let mut in_sources = false;

	for line in input.lines() {
		let trimmed = line.trim();

		// Strip trailing "View this release on GitLab" link
		if trimmed.starts_with("View this release on GitLab") {
			continue;
		}

		// Strip "ASSETS" / "There are no assets..." section
		if trimmed == "ASSETS" {
			in_sources = true; // reuse state machine; next non-empty line is "There are no assets..."
			continue;
		}

		// Strip SOURCES section (archive download URLs)
		if trimmed == "SOURCES" {
			in_sources = true;
			continue;
		}
		if in_sources {
			if trimmed.starts_with("http://") || trimmed.starts_with("https://") || trimmed.is_empty()
			{
				continue;
			}
			in_sources = false;
		}

		// Strip image-only lines: ![alt](url)
		if trimmed.starts_with("![") && trimmed.ends_with(')') && trimmed.contains("](") {
			continue;
		}
		// Strip glab's "Image: name -> url" rendering (Unicode or ASCII arrow)
		if trimmed.starts_with("Image:") && (trimmed.contains('\u{2192}') || trimmed.contains(" -> "))
		{
			continue;
		}

		// Strip single-line HTML comments
		if trimmed.starts_with("<!--") && trimmed.ends_with("-->") {
			continue;
		}

		// Strip horizontal rules (--- or --------)
		if trimmed.len() >= 3 && trimmed.chars().all(|c| c == '-') {
			continue;
		}

		filtered.push_str(line);
		filtered.push('\n');
	}

	// Collapse multiple blank lines
	MULTI_BLANK_RE.replace_all(&filtered, "\n\n").to_string()
}

// ── MR/issue view filter ─────────────────────────────────────────────

/// On error (non-zero exit), skip markdown filtering to preserve error context.
/// On success, apply markdown body noise filtering.
fn filter_mr_issue_view(input: &str, exit_code: i32) -> String {
	if exit_code != 0 {
		return primitives::head_tail_dedup(input);
	}
	filter_markdown_body_view(input)
}

// ── Markdown body filter (mr view / issue view) ──────────────────────

/// Filter markdown body noise: HTML comments, badges, image-only lines,
/// horizontal rules. Collapse multiple blank lines. Apply `head_tail_dedup`.
fn filter_markdown_body_view(input: &str) -> String {
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
				// Safety: cap unclosed comment consumption at 50 lines to
				// prevent data loss from malformed/truncated markdown.
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
	primitives::head_tail_dedup(&out)
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
		MinimizerCtx { program: "glab", subcommand, command, config }
	}

	// ── CI trace tests ──────────────────────────────────────────────────

	#[test]
	fn ci_trace_strips_section_markers_and_runner_boilerplate() {
		let input = include_str!("fixtures/glab/ci-trace.txt");
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("ci"), "glab ci trace 123", &cfg);

		let out = filter(&ctx, input, 1);

		assert!(out.changed);
		// Section markers stripped
		assert!(!out.text.contains("section_start:"));
		assert!(!out.text.contains("section_end:"));
		// Runner boilerplate stripped
		assert!(!out.text.contains("Running with gitlab-runner"));
		assert!(!out.text.contains("Using Docker executor"));
		assert!(!out.text.contains("Fetching changes with git"));
		assert!(!out.text.contains("Checking out"));
		assert!(!out.text.contains("Uploading artifacts"));
		assert!(!out.text.contains("Downloading artifacts"));
		assert!(!out.text.contains("Cleaning up"));
		assert!(!out.text.contains("Runtime platform"));
		assert!(!out.text.contains("Preparing the"));
		assert!(!out.text.contains("Getting source from"));
		assert!(!out.text.contains("Resolving secrets"));
		// Bare ANSI codes stripped
		assert!(!out.text.contains("[0K"));
		assert!(!out.text.contains("[36;1m"));
		assert!(!out.text.contains("[32m"));
		assert!(!out.text.contains("[31m"));
		assert!(!out.text.contains("[33m"));
		assert!(!out.text.contains("[0m"));
		// Build output preserved
		assert!(out.text.contains("npm ci"));
		assert!(out.text.contains("npm run build"));
		assert!(out.text.contains("npm test"));
		// Test results preserved
		assert!(out.text.contains("FAIL"));
		assert!(out.text.contains("AssertionError"));
		// Final error line preserved
		assert!(out.text.contains("Job failed"));
	}

	#[test]
	fn ci_trace_preserves_build_errors() {
		let input = "\
section_start:1711234578:build_script[0K
$ npm test
[31mFAIL[0m src/auth.test.ts
  Error: expected true to be false
section_end:1711234600:build_script[0K
[31;1mERROR: Job failed: exit code 1[0K
";
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("ci"), "glab ci trace 456", &cfg);

		let out = filter(&ctx, input, 1);

		assert!(out.changed);
		assert!(out.text.contains("$ npm test"));
		assert!(out.text.contains("FAIL"));
		assert!(out.text.contains("Error: expected true to be false"));
		assert!(out.text.contains("ERROR: Job failed: exit code 1"));
		// Boilerplate gone
		assert!(!out.text.contains("section_start"));
		assert!(!out.text.contains("section_end"));
	}

	#[test]
	fn ci_trace_passthrough_on_web_flag() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("ci"), "glab ci trace 123 --web", &cfg);
		let input = "Opening in browser...\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	// ── Release list tests ──────────────────────────────────────────────

	#[test]
	fn release_list_compacts_tab_separated() {
		let input = include_str!("fixtures/glab/release-list.txt");
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release list", &cfg);

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(out.text.contains("Releases"));
		assert!(out.text.contains("v3.2.1"));
		assert!(out.text.contains("about 2 days ago"));
		// Preamble stripped
		assert!(!out.text.contains("Showing 10 releases"));
		// Header stripped
		assert!(!out.text.contains("Name\tTag\tCreated"));
	}

	#[test]
	fn release_list_falls_through_on_no_tabs() {
		let input = "No releases available on owner/repo.\n";
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release list", &cfg);

		let out = filter(&ctx, input, 0);

		// Falls through to head_tail_dedup; output should still contain the text
		assert!(out.text.contains("No releases available"));
	}

	// ── Release view tests ──────────────────────────────────────────────

	#[test]
	fn release_view_strips_sources_and_noise() {
		let input = include_str!("fixtures/glab/release-view.txt");
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release view v2.0.0", &cfg);

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		// SOURCES section stripped
		assert!(!out.text.contains("SOURCES"));
		assert!(!out.text.contains("toolkit-v2.0.0.zip"));
		assert!(!out.text.contains("toolkit-v2.0.0.tar.gz"));
		// Horizontal rules stripped
		assert!(!out.text.contains("--------"));
		// Image lines stripped
		assert!(!out.text.contains("Image:"));
		// HTML comments stripped
		assert!(!out.text.contains("<!-- internal"));
		// Footer stripped (noise)
		assert!(!out.text.contains("View this release"));
		// ASSETS/SOURCES sections stripped
		assert!(!out.text.contains("ASSETS"));
		assert!(!out.text.contains("SOURCES"));
		assert!(!out.text.contains("archive/v2.0.0"));
	}

	#[test]
	fn release_view_preserves_description() {
		let input = include_str!("fixtures/glab/release-view.txt");
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release view v2.0.0", &cfg);

		let out = filter(&ctx, input, 0);

		// Description preserved
		assert!(out.text.contains("Test Release v2.0"));
		assert!(out.text.contains("Added widget support"));
		assert!(out.text.contains("Fixed authentication bug"));
		assert!(out.text.contains("@alice_dev @bob_dev"));
		// Footer stripped (noise)
		assert!(!out.text.contains("View this release"));
		// ASSETS/SOURCES sections stripped
		assert!(!out.text.contains("ASSETS"));
		assert!(!out.text.contains("SOURCES"));
		assert!(!out.text.contains("archive/v2.0.0"));
	}

	// ── MR/issue view tests ─────────────────────────────────────────────

	#[test]
	fn mr_view_strips_markdown_noise() {
		let input = [
			"<!-- template comment -->",
			"# MR Title",
			"[![CI](https://img.shields.io/badge-passing-green)](url)",
			"## Description",
			"Some description here.",
			"---",
			"More content.",
			"![badge](https://img.shields.io/build/passing)",
			"",
		]
		.join("\n");
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("mr"), "glab mr view 42", &cfg);

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		// HTML comments stripped
		assert!(!out.text.contains("template comment"));
		// Badges stripped
		assert!(!out.text.contains("img.shields.io"));
		// Horizontal rules stripped
		assert!(!out.text.contains("---"));
		// Content preserved
		assert!(out.text.contains("# MR Title"));
		assert!(out.text.contains("## Description"));
		assert!(out.text.contains("Some description here."));
		assert!(out.text.contains("More content."));
	}

	// ── Passthrough tests ───────────────────────────────────────────────

	#[test]
	fn mr_list_passthrough_on_json_flag() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("mr"), "glab mr list --json", &cfg);
		let input = "[{\"iid\": 1, \"title\": \"test\"}]\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn api_subcommand_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("api"), "glab api projects/1", &cfg);
		let input = "{\"id\": 1, \"name\": \"test\"}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	// ── Passthrough flag variations ─────────────────────────────────────

	#[test]
	fn passthrough_on_output_flag() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("mr"), "glab mr list -F json", &cfg);
		let input = "[]\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn passthrough_on_web_flag_anywhere() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release view --web v1.0", &cfg);
		let input = "Opening...\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn passthrough_on_comments_for_mr_view() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("mr"), "glab mr view 42 --comments", &cfg);
		let input = "comments...\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	// ── Edge cases ──────────────────────────────────────────────────────

	#[test]
	fn release_list_name_differs_from_tag() {
		let input = "Showing 1 releases\n\nName\tTag\tCreated\nMy Release\tv1.0.0\t2 days ago\n";
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release list", &cfg);

		let out = filter(&ctx, input, 0);

		assert!(out.text.contains("My Release [v1.0.0]"));
	}

	#[test]
	fn ci_trace_empty_input() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("ci"), "glab ci trace 123", &cfg);
		let input = "";

		let out = filter(&ctx, input, 0);

		// Empty input passes through (no change)
		assert!(!out.changed);
	}

	#[test]
	fn release_list_marks_omitted_when_over_cap() {
		// Build input with 25 releases so the cap of 20 is exceeded.
		let mut input = String::from("Showing 25 releases on owner/repo.\n\nName\tTag\tCreated\n");
		for i in 1..=25 {
			let _ = writeln!(input, "Release {i}\tv{i}.0.0\t{i} days ago");
		}
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("release"), "glab release list", &cfg);

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		// Output must signal that releases were elided.
		assert!(out.text.contains("elided"), "expected omission marker, got: {}", out.text);
		// First release present, 21st not shown verbatim in the list.
		assert!(out.text.contains("Release 1"));
		assert!(!out.text.contains("Release 21 ["));
	}

	#[test]
	fn mr_diff_passes_through_unmodified() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("mr"), "glab mr diff 42", &cfg);
		let input =
			"diff --git a/foo.rs b/foo.rs\n--- a/foo.rs\n+++ b/foo.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}
}
