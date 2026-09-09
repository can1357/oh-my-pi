//! Graphite (`gt`) output filters.

use std::fmt::Write as _;

use super::git;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const GT_SUBCOMMANDS: &[&str] = &[
	"log", "submit", "sync", "restack", "create", "branch", "diff", "show", "add", "push", "pull",
	"fetch", "stash", "worktree",
];

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	program == "gt" && subcommand.is_some_and(|subcommand| GT_SUBCOMMANDS.contains(&subcommand))
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if ctx.subcommand == Some("log") && is_log_short(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("log") => compact_log(&cleaned),
		Some("branch") => primitives::compact_listing(&cleaned, 40),
		Some("sync") => dense_sync_summary(&cleaned, exit_code)
			.unwrap_or_else(|| compact_noisy_command(&cleaned, exit_code)),
		Some("restack") => dense_restack_summary(&cleaned, exit_code)
			.unwrap_or_else(|| compact_noisy_command(&cleaned, exit_code)),
		Some("submit" | "create") => compact_noisy_command(&cleaned, exit_code),
		Some("diff" | "show" | "add" | "push" | "pull" | "fetch" | "stash" | "worktree") => {
			let git_ctx = MinimizerCtx {
				program:    "git",
				subcommand: ctx.subcommand,
				command:    ctx.command,
				config:     ctx.config,
			};
			return git::filter(&git_ctx, input, exit_code);
		},
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_log_short(command: &str) -> bool {
	has_ordered_tokens(command, "log", "short")
}

fn has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
	let mut saw_first = false;
	for part in command.split_whitespace() {
		if saw_first && part == second {
			return true;
		}
		if part == first {
			saw_first = true;
		}
	}
	false
}

fn compact_log(input: &str) -> String {
	let mut out = String::new();
	let mut entries = 0usize;
	let mut omitted_entries = 0usize;
	let max_entries = 24usize;

	for line in input.lines() {
		if is_graph_node(line) {
			entries += 1;
			if entries > max_entries {
				omitted_entries += 1;
				continue;
			}
		} else if entries > max_entries {
			continue;
		}

		let trimmed = remove_email_fragments(line.trim_end());
		if !trimmed.trim().is_empty() || !out.ends_with("\n\n") {
			out.push_str(&trim_line(&trimmed, 140));
			out.push('\n');
		}
	}

	if omitted_entries > 0 {
		let _ = writeln!(out, "[…{omitted_entries} entries elided…]");
	}

	primitives::head_tail_lines(&out, 80, 24)
}

fn compact_noisy_command(input: &str, exit_code: i32) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	let mut kept = String::new();

	for line in deduped.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_progress_noise(trimmed) {
			continue;
		}
		if exit_code == 0 && is_low_value_status(trimmed) {
			continue;
		}
		kept.push_str(trimmed);
		kept.push('\n');
	}

	let candidate = if kept.trim().is_empty() {
		deduped
	} else {
		kept
	};

	primitives::head_tail_lines(&candidate, 80, 40)
}

/// FAST PATH: collapse a clean `gt sync` to one dense line.
///
/// Re-derived against DEFAULT `gt sync` output (no injection): `Synced ...
/// branch` lines and `Deleted branch <name>` lines. Returns `None` (so the
/// caller falls back to `compact_noisy_command`) on a non-zero exit, on any
/// error line, or when nothing recognizable was synced/deleted — error
/// visibility is preserved.
fn dense_sync_summary(input: &str, exit_code: i32) -> Option<String> {
	if exit_code != 0 {
		return None;
	}

	let mut synced = 0usize;
	let mut deleted = 0usize;
	let mut deleted_names = Vec::new();

	for raw in input.lines() {
		let line = raw.trim();
		if line.is_empty() {
			continue;
		}
		if is_error_line(line) {
			return None;
		}
		// Real `gt sync` emits the top-level confirmation `Synced with remote`
		// (no "branch" token); per-branch forms read `Synced ... branch`. Count
		// both so a successful sync never reports `0 synced`.
		if line.starts_with("Synced with remote")
			|| (line.contains("Synced") && line.contains("branch"))
		{
			synced += 1;
		} else if let Some(name) = deleted_branch_name(line) {
			deleted += 1;
			deleted_names.push(name);
		}
	}

	if synced == 0 && deleted == 0 {
		return None;
	}

	let mut summary = format!("ok sync: {synced} synced, {deleted} deleted");
	if !deleted_names.is_empty() {
		// Cap the inline name list: a long-lived stack cleanup can delete hundreds
		// of merged branches at once, and this fast path bypasses the
		// head_tail_lines bound that compact_noisy_command (the fallback) applies.
		// Without a cap every name lands on one unbounded line, defeating the
		// minimizer's bounding guarantee. Show the first DELETED_NAME_CAP names and
		// summarize the rest as `[…N names elided…]` (the count above stays exact).
		const DELETED_NAME_CAP: usize = 20;
		let shown = deleted_names.len().min(DELETED_NAME_CAP);
		let names = deleted_names[..shown].join(", ");
		let _ = write!(summary, " ({names}");
		if deleted_names.len() > DELETED_NAME_CAP {
			let _ = write!(summary, " […{} names elided…]", deleted_names.len() - DELETED_NAME_CAP);
		}
		summary.push(')');
	}
	summary.push('\n');
	Some(summary)
}

/// FAST PATH: collapse a clean `gt restack` to one dense line.
///
/// Re-derived against DEFAULT `gt restack` output: lines reporting a restacked
/// branch. Returns `None` (caller falls back to `compact_noisy_command`) on a
/// non-zero exit, on any error line, or when no branch was restacked.
fn dense_restack_summary(input: &str, exit_code: i32) -> Option<String> {
	if exit_code != 0 {
		return None;
	}

	let mut restacked = 0usize;
	for raw in input.lines() {
		let line = raw.trim();
		if line.is_empty() {
			continue;
		}
		if is_error_line(line) {
			return None;
		}
		if (line.contains("Restacked") || line.contains("Rebased")) && line.contains("branch") {
			restacked += 1;
		}
	}

	if restacked == 0 {
		return None;
	}
	Some(format!("ok restacked {restacked} branches\n"))
}

/// Extract the branch name from a `Deleted branch <name>` / `deleted branch
/// <name>` line.
fn deleted_branch_name(line: &str) -> Option<String> {
	let lower = line.to_ascii_lowercase();
	let marker = "deleted branch ";
	let pos = lower.find(marker)?;
	let rest = line[pos + marker.len()..].trim_start();
	let name = rest
		.split_whitespace()
		.next()?
		.trim_matches(|ch: char| matches!(ch, '`' | '"' | '\'' | ','));
	if name.is_empty() {
		None
	} else {
		Some(name.to_string())
	}
}

fn is_error_line(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("error")
		|| lower.starts_with("fatal")
		|| lower.starts_with("conflict")
		|| lower.contains("failed to")
		|| lower.contains("merge conflict")
}

fn is_graph_node(line: &str) -> bool {
	let stripped = line
		.trim_start_matches('│')
		.trim_start_matches('|')
		.trim_start();
	matches!(stripped.chars().next(), Some('◉' | '○' | '◯' | '◆' | '●' | '@' | '*'))
}

fn remove_email_fragments(line: &str) -> String {
	let mut words = Vec::new();
	for word in line.split_whitespace() {
		let stripped = word.trim_matches(|ch: char| matches!(ch, '<' | '>' | '(' | ')' | ','));
		if stripped.contains('@') && stripped.contains('.') {
			continue;
		}
		words.push(word);
	}
	words.join(" ")
}

fn trim_line(line: &str, max_chars: usize) -> String {
	let mut out = String::new();
	for (idx, ch) in line.chars().enumerate() {
		if idx >= max_chars {
			out.push('…');
			return out;
		}
		out.push(ch);
	}
	out
}

fn is_progress_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("enumerating objects:")
		|| lower.starts_with("counting objects:")
		|| lower.starts_with("compressing objects:")
		|| lower.starts_with("writing objects:")
		|| lower.starts_with("remote: counting objects:")
		|| lower.starts_with("remote: compressing objects:")
		|| lower.starts_with("remote: total")
		|| lower.starts_with("resolving deltas:")
		|| lower.starts_with("delta compression")
		|| lower.starts_with("total ")
}

fn is_low_value_status(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("pushing to remote")
		|| lower.starts_with("syncing with remote")
		|| lower.starts_with("creating new branch")
		|| lower.starts_with("restacking branches")
		|| lower.starts_with("checking out from ")
		|| lower.starts_with("tracking branch set up")
		|| lower.starts_with("creating pull request for ")
		|| lower.starts_with("updating pull request for ")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn test_ctx<'a>(subcommand: Option<&'a str>, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		test_ctx_with_command(subcommand, "gt", config)
	}

	fn test_ctx_with_command<'a>(
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program: "gt", subcommand, command, config }
	}

	#[test]
	fn supports_known_gt_and_git_passthrough_subcommands() {
		assert!(supports("gt", Some("log")));
		assert!(supports("gt", Some("submit")));
		assert!(!supports("gt", Some("status")));
		assert!(supports("gt", Some("diff")));
		assert!(!supports("git", Some("log")));
	}

	#[test]
	fn log_listing_is_compacted_and_sanitized() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), &cfg);
		let mut input = String::new();
		for idx in 0..30 {
			input.push_str("◉  abc123");
			input.push_str(&idx.to_string());
			input.push_str(" feat/branch ");
			input.push_str(&idx.to_string());
			input.push_str("d ago user@example.com\n│  commit message\n│\n");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.contains("abc1230"));
		assert!(out.text.contains("entries elided"));
		assert!(!out.text.contains("user@example.com"));
	}

	#[test]
	fn log_short_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx_with_command(Some("log"), "gt log short", &cfg);
		let input = "abc123 main user@example.com\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn status_is_not_supported() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx_with_command(Some("status"), "gt status", &cfg);
		let input = "## main\n M a.rs\n?? b.rs\n";
		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn branch_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), &cfg);
		let mut input = String::new();
		for idx in 0..60 {
			input.push_str("  feat/");
			input.push_str(&idx.to_string());
			input.push('\n');
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.text.starts_with("60 entries\n"));
		assert!(out.text.contains("feat/0"));
		assert!(out.text.contains("feat/59"));
		assert!(out.text.contains("…"));
	}

	#[test]
	fn submit_noise_is_stripped_and_summaries_remain() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("submit"), &cfg);
		let input = "\x1b[32mCounting objects: 100% (2/2), done.\x1b[0m\rCounting objects: 100% (2/2), done.\nPushed branch feat/a to origin\nCreated pull request #42 for feat/a: https://example.test/pr/42\nAll branches submitted successfully!\n";

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(!out.text.contains("Counting objects"));
		assert!(out.text.contains("Pushed branch feat/a to origin"));
		assert!(out.text.contains("Created pull request #42"));
		assert!(out.text.contains("All branches submitted successfully!"));
		assert!(!out.text.contains('\x1b'));
	}

	#[test]
	fn sync_dense_summary_counts_synced_and_deleted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let input = "Synced branch feat/a with remote\nSynced branch feat/b with remote\nDeleted \
		             branch feat/merged-feature\nDeleted branch fix/old-hotfix\n";

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "ok sync: 2 synced, 2 deleted (feat/merged-feature, fix/old-hotfix)\n");
	}

	#[test]
	fn sync_dense_summary_counts_synced_with_remote_form() {
		// Donor real-output fixture (gt_cmd.rs): the top-level confirmation is
		// `Synced with remote` (no "branch" token), followed by deletions. The
		// synced tally must reflect this real form, not report `0 synced`.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let input =
			"Synced with remote\nDeleted branch feat/merged-feature\nDeleted branch fix/old-hotfix\n";

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "ok sync: 1 synced, 2 deleted (feat/merged-feature, fix/old-hotfix)\n");
	}

	#[test]
	fn sync_dense_summary_caps_deleted_name_list() {
		// A long-lived stack cleanup can delete hundreds of merged branches at
		// once. The dense summary must stay bounded: cap the inline name list and
		// summarize the remainder as `[…N names elided…]`, never emit one unbounded
		// line.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let mut input = String::from("Synced with remote\n");
		for idx in 0..500 {
			let _ = writeln!(input, "Deleted branch feat/merged-{idx}");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		// Exact deleted count is preserved.
		assert!(out.text.contains("ok sync: 1 synced, 500 deleted"));
		// First names stay visible; the rest collapse to a `[…N names elided…]` marker.
		assert!(out.text.contains("feat/merged-0"));
		assert!(out.text.contains("[…480 names elided…]"));
		// Bounded: a single short line, not 500 names concatenated.
		assert!(!out.text.contains("feat/merged-499"));
		let longest = out.text.lines().map(str::len).max().unwrap_or(0);
		assert!(longest < 600, "summary line not bounded: {longest} bytes");
	}

	#[test]
	fn restack_dense_summary_counts_branches() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("restack"), &cfg);
		let input = "Restacked branch feat/add-auth on main\nRestacked branch feat/add-db on \
		             feat/add-auth\nRestacked branch fix/parsing on feat/add-db\n";

		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "ok restacked 3 branches\n");
	}

	#[test]
	fn sync_with_error_falls_back_to_compact() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let input = "Synced branch feat/a with remote\nerror: failed to rebase feat/b\n";

		// Error line present -> fast path declines, compact_noisy_command keeps the
		// error.
		let out = filter(&ctx, input, 0);

		assert!(!out.text.starts_with("ok sync:"));
		assert!(out.text.contains("error: failed to rebase feat/b"));
		assert!(out.text.contains("Synced branch feat/a with remote"));
	}

	#[test]
	fn sync_noise_is_stripped_and_errors_remain() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("sync"), &cfg);
		let input = "remote: Counting objects: 1\nremote: Counting objects: 1\nSynced branch feat/a \
		             with remote\nerror: failed to rebase feat/b\n";

		let out = filter(&ctx, input, 1);

		assert!(!out.text.contains("Counting objects"));
		assert!(out.text.contains("Synced branch feat/a with remote"));
		assert!(out.text.contains("error: failed to rebase feat/b"));
	}
}
