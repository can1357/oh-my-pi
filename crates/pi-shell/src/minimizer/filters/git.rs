//! Git output filters.

use std::fmt::Write as _;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(subcommand: Option<&str>) -> bool {
	matches!(
		subcommand,
		Some(
			"status"
				| "diff" | "show"
				| "log" | "add"
				| "commit"
				| "push" | "pull"
				| "branch"
				| "fetch"
				| "stash"
				| "worktree"
				| "merge"
				| "rebase"
				| "checkout"
				| "switch"
				| "restore"
				| "clean"
				| "reset"
				| "tag",
		),
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	if is_show_path_content(ctx.command) || is_stash_patch(ctx.command) {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("status") if is_status_machine_format(ctx.command) => cleaned,
		Some("status") => condense_status(&cleaned),
		Some("diff") if has_token(ctx.command, "--summary") => cleaned,
		Some("diff") if is_stat_format(ctx.command) => condense_diff_stat(&cleaned),
		Some("diff") => {
			if exit_code == 0 {
				if let Some(mode) = diff_listing_mode(ctx.command) {
					compact_diff_listing(&cleaned, mode)
				} else {
					compact_diff_output(&cleaned)
				}
			} else {
				compact_diff_output(&cleaned)
			}
		},
		Some("show") if is_show_custom_format(ctx.command) => cleaned,
		Some("show") => condense_show(&cleaned),
		Some("log") if is_log_custom_format(ctx.command) => cleaned,
		Some("log") => condense_log(&cleaned, 32, 16),
		// Non-listing branch formats produce single values or one-liner
		// confirmations (e.g. `--show-current` → `main`, `--delete` →
		// `Deleted branch feature (was abc123).`).  `condense_branch`
		// would rewrite those as `local: main\n` / `local: Deleted
		// branch…`, changing the meaning of the requested output, so
		// skip it and passthrough the cleaned buffer.
		Some("branch") if is_branch_non_listing(ctx.command) => cleaned,
		Some("branch") => condense_branch(&cleaned),
		Some("tag") if is_tag_non_listing(ctx.command) => cleaned,
		Some("tag") => primitives::compact_listing(&cleaned, 40),
		Some("stash") => condense_stash(ctx.command, &cleaned, exit_code),
		Some("worktree") => {
			if has_token(ctx.command, "--porcelain")
				|| has_token(ctx.command, "-z")
				|| has_token(ctx.command, "--null")
			{
				cleaned
			} else {
				condense_worktree(&cleaned)
			}
		},
		Some("push") if has_token(ctx.command, "--porcelain") => cleaned,
		Some("push") => condense_push(&cleaned, exit_code),
		Some("pull") => condense_pull(&cleaned, exit_code),
		Some("fetch") if has_token(ctx.command, "--porcelain") => cleaned,
		Some("fetch") => condense_fetch(&cleaned, exit_code),
		Some("commit") => condense_commit(&cleaned, exit_code),
		Some("merge" | "rebase" | "checkout" | "switch" | "restore" | "clean" | "reset" | "add") => {
			condense_noisy_output(&cleaned)
		},
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_show_path_content(command: &str) -> bool {
	let mut saw_show = false;
	for part in command.split_whitespace() {
		if saw_show && !part.starts_with('-') && part.contains(':') {
			return true;
		}
		if part == "show" {
			saw_show = true;
		}
	}
	false
}

fn is_stash_patch(command: &str) -> bool {
	has_ordered_tokens(command, "stash", "show")
		&& (has_token(command, "-p") || has_token(command, "--patch"))
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

fn has_token(command: &str, token: &str) -> bool {
	command.split_whitespace().any(|part| part == token)
}

/// Whether `command` carries `--flag` in either the space-separated
/// (`--flag value`) or the inline (`--flag=value`) form. `has_token` only
/// matches the bare token, so inline `=`-joined flags (e.g. `--format=%H`)
/// would otherwise slip through guards that key off the flag name alone.
fn has_flag(command: &str, flag: &str) -> bool {
	let inline_prefix = format!("{flag}=");
	command
		.split_whitespace()
		.any(|part| part == flag || part.starts_with(&inline_prefix))
}

fn is_status_machine_format(command: &str) -> bool {
	command.split_whitespace().any(|part| {
		matches!(part, "--porcelain" | "--porcelain=v1" | "--porcelain=v2" | "--null")
			|| part == "-z"
			|| part.starts_with('-') && !part.starts_with("--") && part.contains('z')
	})
}

fn is_stat_format(command: &str) -> bool {
	command
		.split_whitespace()
		.any(|part| part == "--stat" || part.starts_with("--stat="))
}

#[derive(Clone, Copy)]
enum DiffListingMode {
	NameOnly,
	NameStatus,
	Numstat,
}

const DIFF_LISTING_LIMIT: usize = 20;

impl DiffListingMode {
	const fn label(self) -> &'static str {
		match self {
			Self::NameOnly => "--name-only",
			Self::NameStatus => "--name-status",
			Self::Numstat => "--numstat",
		}
	}
}

fn diff_listing_mode(command: &str) -> Option<DiffListingMode> {
	if has_token(command, "--name-only") {
		Some(DiffListingMode::NameOnly)
	} else if has_token(command, "--name-status") {
		Some(DiffListingMode::NameStatus)
	} else if has_token(command, "--numstat") {
		Some(DiffListingMode::Numstat)
	} else {
		None
	}
}

fn compact_diff_listing(input: &str, mode: DiffListingMode) -> String {
	let mut entries = Vec::new();
	for line in input.lines() {
		if line.is_empty() {
			continue;
		}
		if !is_diff_listing_line(mode, line) {
			return input.to_string();
		}
		entries.push(line.to_string());
	}

	if entries.len() <= DIFF_LISTING_LIMIT {
		return input.to_string();
	}

	let mut out = String::new();
	let _ = writeln!(out, "git diff {}: {}", mode.label(), format_file_count(entries.len()));
	for entry in entries.iter().take(DIFF_LISTING_LIMIT) {
		out.push_str(entry);
		out.push('\n');
	}
	let _ = writeln!(out, "[…{} files elided…]", entries.len() - DIFF_LISTING_LIMIT);
	out
}

fn is_diff_listing_line(mode: DiffListingMode, line: &str) -> bool {
	match mode {
		DiffListingMode::NameOnly => true,
		DiffListingMode::NameStatus => line.split('\t').count() >= 2,
		DiffListingMode::Numstat => line.split('\t').count() >= 3,
	}
}

#[derive(Default)]
struct StatusSummary {
	branch:     Option<String>,
	stash:      Option<String>,
	divergence: Option<String>,
	clean:      bool,
	staged:     usize,
	unstaged:   usize,
	untracked:  usize,
	conflicts:  usize,
	paths:      Vec<String>,
}

fn condense_status(input: &str) -> String {
	let mut summary = StatusSummary::default();
	let mut in_untracked = false;
	// Long-format `git status` groups entries under section headers. `modified:`
	// and `deleted:` appear in both the staged ("Changes to be committed:") and
	// unstaged ("Changes not staged for commit:") sections, so we must track the
	// active section to count them correctly.
	let mut in_staged = false;
	let mut state: Option<&str> = None;

	for line in input.lines() {
		let line = line.trim_end();
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if let Some(branch) = line.strip_prefix("## ") {
			summary.branch = Some(branch.to_string());
			continue;
		}
		if parse_short_status_line(line, &mut summary) {
			continue;
		}
		if let Some(branch) = trimmed.strip_prefix("On branch ") {
			summary.branch = Some(branch.to_string());
			continue;
		}
		if trimmed.starts_with("Your branch is ahead")
			|| trimmed.starts_with("Your branch is behind")
			|| trimmed.starts_with("Your branch and")
			|| trimmed.starts_with("HEAD detached")
		{
			summary.divergence = Some(trimmed.to_string());
			continue;
		}
		if trimmed.starts_with("Your stash currently has ") {
			summary.stash = Some(trimmed.to_string());
			continue;
		}
		if trimmed.starts_with("nothing to commit") || trimmed == "working tree clean" {
			summary.clean = true;
			continue;
		}
		// Only detect in-progress state headers OUTSIDE the "Untracked files:"
		// section. Real `git status` prints these blocks before/after the file
		// listings, never as untracked entries; but several progress phrases
		// ("Last command done", "Next command to do", "No commands remaining")
		// are plausible filenames, so an untracked file so named would otherwise
		// be mis-read as `state: rebasing` and swallowed via the `continue`
		// below, losing the real untracked count. Gating on `!in_untracked`
		// lets such filenames fall through to the untracked path handling.
		if !in_untracked && let Some(detected) = detect_status_state(trimmed) {
			if state.is_none() {
				state = Some(detected);
			}
			continue;
		}
		if trimmed.starts_with("Changes to be committed:") {
			in_staged = true;
			in_untracked = false;
			continue;
		}
		if trimmed.starts_with("Changes not staged for commit:")
			|| trimmed.starts_with("Unmerged paths:")
		{
			in_staged = false;
			in_untracked = false;
			continue;
		}
		if trimmed.starts_with("Untracked files:") {
			in_untracked = true;
			in_staged = false;
			continue;
		}
		if parse_long_status_line(trimmed, in_staged, in_untracked, &mut summary) {
			continue;
		}
		if !trimmed.starts_with('(')
			&& !trimmed.ends_with(':')
			&& !trimmed.starts_with("use ")
			&& !trimmed.starts_with("no changes added")
			&& in_untracked
		{
			summary.untracked += 1;
			push_status_path(&mut summary, "??", trimmed);
		}
	}

	if status_has_no_signal(&summary) && state.is_none() {
		return input.to_string();
	}
	let body = format_status_summary(&summary);
	match state {
		Some(s) => {
			let mut out = String::with_capacity(7 + s.len() + 1 + body.len());
			out.push_str("state: ");
			out.push_str(s);
			out.push('\n');
			out.push_str(&body);
			out
		},
		None => body,
	}
}
fn detect_status_state(line: &str) -> Option<&str> {
	if line.starts_with("You are currently rebasing")
		// Interactive-rebase sub-states all print under the same in-progress
		// rebase header in default long-format `git status`; collapse them to
		// the single `rebasing` label so an interactive-rebase edit/split is not
		// mistaken for a clean tree. "You are currently editing a commit"/"…
		// splitting the commit" are the rebase-edit/-split phase lines, and the
		// "Last command done"/"Next command to do"/"No commands remaining"
		// progress lines accompany them.
		|| line.starts_with("You are currently editing")
		|| line.starts_with("You are currently splitting")
		|| line.starts_with("Last command done")
		|| line.starts_with("Next command to do")
		|| line.starts_with("No commands remaining")
	{
		Some("rebasing")
	} else if line.starts_with("You are currently cherry-picking") {
		Some("cherry-pick")
	} else if line.starts_with("You are currently reverting") {
		Some("revert")
	} else if line.starts_with("You are currently bisecting") {
		Some("bisect")
	} else if line.starts_with("You are in the middle of an am session") {
		Some("am")
	} else if line.starts_with("You are in a sparse checkout") {
		Some("sparse-checkout")
	} else if line.starts_with("All conflicts fixed but you are still merging") {
		// Distinct from `merge-conflict`: the merge is staged and ready to
		// conclude with `git commit`, so surface a separate "ready to commit"
		// label rather than implying unresolved conflicts.
		Some("merge (ready to commit)")
	} else if line == "You have unmerged paths." {
		Some("merge-conflict")
	} else {
		None
	}
}

fn parse_short_status_line(line: &str, summary: &mut StatusSummary) -> bool {
	let Some(status) = line.get(..2) else {
		return false;
	};
	let Some(path) = line.get(3..) else {
		return false;
	};
	if !is_short_status(status) {
		return false;
	}
	if status == "  " {
		return false;
	}
	if status == "!!" {
		return true;
	}
	if status == "??" {
		summary.untracked += 1;
	} else if status.contains('U') {
		summary.conflicts += 1;
	} else {
		let bytes = status.as_bytes();
		if bytes[0] != b' ' {
			summary.staged += 1;
		}
		if bytes[1] != b' ' {
			summary.unstaged += 1;
		}
	}
	push_status_path(summary, status.trim(), path.trim());
	true
}

fn is_short_status(status: &str) -> bool {
	status
		.bytes()
		.all(|byte| matches!(byte, b' ' | b'M' | b'A' | b'D' | b'R' | b'C' | b'U' | b'?' | b'!'))
}

fn parse_long_status_line(
	line: &str,
	in_staged: bool,
	in_untracked: bool,
	summary: &mut StatusSummary,
) -> bool {
	// `modified:`/`deleted:` are staged or unstaged depending on the active
	// section; `new file:`/`renamed:` only appear staged. The unmerged-path
	// forms are always conflicts regardless of section.
	for (prefix, label, staged) in [
		("modified:", "M", in_staged),
		("deleted:", "D", in_staged),
		("new file:", "A", true),
		("renamed:", "R", true),
		("both modified:", "UU", false),
		("both added:", "AA", false),
		("both deleted:", "DD", false),
		("added by us:", "AU", false),
		("added by them:", "UA", false),
		("deleted by us:", "DU", false),
		("deleted by them:", "UD", false),
	] {
		if let Some(path) = line.strip_prefix(prefix) {
			if matches!(label, "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD") {
				summary.conflicts += 1;
			} else if staged {
				summary.staged += 1;
			} else {
				summary.unstaged += 1;
			}
			push_status_path(summary, label, path.trim());
			return true;
		}
	}
	if in_untracked && !line.starts_with('(') && !line.ends_with(':') {
		summary.untracked += 1;
		push_status_path(summary, "??", line);
		return true;
	}
	false
}

fn push_status_path(summary: &mut StatusSummary, label: &str, path: &str) {
	if path.is_empty() {
		return;
	}
	summary
		.paths
		.push(format!("{label} {}", primitives::truncate_line(path, 160)));
}

const fn status_has_no_signal(summary: &StatusSummary) -> bool {
	summary.branch.is_none()
		&& summary.stash.is_none()
		&& summary.divergence.is_none()
		&& !summary.clean
		&& summary.staged == 0
		&& summary.unstaged == 0
		&& summary.untracked == 0
		&& summary.conflicts == 0
}

fn format_status_summary(summary: &StatusSummary) -> String {
	let mut out = String::new();
	if let Some(branch) = &summary.branch {
		out.push_str("branch ");
		out.push_str(branch);
		out.push('\n');
	}
	if let Some(div) = &summary.divergence {
		out.push_str(div);
		out.push('\n');
	}
	if let Some(stash) = &summary.stash {
		out.push_str(stash);
		out.push('\n');
	}
	if summary.clean && summary.paths.is_empty() {
		out.push_str("clean\n");
		return out;
	}
	out.push_str("staged ");
	out.push_str(&summary.staged.to_string());
	out.push_str(", unstaged ");
	out.push_str(&summary.unstaged.to_string());
	out.push_str(", untracked ");
	out.push_str(&summary.untracked.to_string());
	if summary.conflicts > 0 {
		out.push_str(", conflicts ");
		out.push_str(&summary.conflicts.to_string());
	}
	out.push('\n');
	for path in summary.paths.iter().take(40) {
		out.push_str(path);
		out.push('\n');
	}
	if summary.paths.len() > 40 {
		let _ = writeln!(out, "[…{} paths elided…]", summary.paths.len() - 40);
	}
	out
}

fn condense_log(input: &str, head: usize, tail: usize) -> String {
	let entries = parse_log_entries(input);
	if !entries.is_empty() {
		let mut out = String::new();
		if entries.len() <= head + tail {
			for entry in &entries {
				push_log_entry(&mut out, entry);
			}
		} else {
			for entry in entries.iter().take(head) {
				push_log_entry(&mut out, entry);
			}
			let _ = writeln!(out, "[…{} commits elided…]", entries.len() - head - tail);
			for entry in entries.iter().skip(entries.len() - tail) {
				push_log_entry(&mut out, entry);
			}
		}
		return out;
	}

	let mut out = String::new();
	for line in input.lines() {
		if let Some(commit) = line.strip_prefix("commit ") {
			out.push_str("commit ");
			if let Some(short) = commit.get(..12) {
				out.push_str(short);
			} else {
				out.push_str(commit);
			}
			out.push('\n');
		} else if !(line.trim_start().starts_with("Author:")
			|| line.trim_start().starts_with("Date:"))
		{
			out.push_str(line.trim_end());
			out.push('\n');
		}
	}
	primitives::head_tail_lines(&out, head, tail)
}

struct LogEntry {
	hash:    String,
	subject: String,
	body:    Vec<String>,
	/// Body lines dropped past the per-commit body cap, surfaced as an explicit
	/// `[…Nln elided…]` marker instead of being silently lost.
	elided:  usize,
}

/// Soft cap on rendered subject/body line width. Long commit subjects and body
/// lines are truncated through `truncate_line`, which appends a `…[+N]`
/// dropped-char marker so the elision is visible rather than silent.
const LOG_LINE_WIDTH: usize = 160;

fn push_log_entry(out: &mut String, entry: &LogEntry) {
	out.push_str(&entry.hash);
	if !entry.subject.is_empty() {
		out.push(' ');
		out.push_str(&primitives::truncate_line(&entry.subject, LOG_LINE_WIDTH));
	}
	out.push('\n');
	for line in &entry.body {
		out.push_str("  ");
		out.push_str(&primitives::truncate_line(line, LOG_LINE_WIDTH));
		out.push('\n');
	}
	if entry.elided > 0 {
		let _ = writeln!(out, "  […{}ln elided…]", entry.elided);
	}
}

fn parse_log_entries(input: &str) -> Vec<LogEntry> {
	let mut entries = Vec::new();
	let mut current: Option<LogEntry> = None;

	for line in input.lines() {
		if let Some(rest) = line.strip_prefix("commit ") {
			if let Some(entry) = current.take() {
				entries.push(entry);
			}
			let trimmed = rest.trim();
			let (hash, subject) = trimmed
				.split_once(' ')
				.map_or((trimmed, ""), |(hash, subject)| (hash, subject.trim()));
			current = Some(LogEntry {
				hash:    short_hash(hash),
				subject: subject.to_string(),
				body:    Vec::new(),
				elided:  0,
			});
			continue;
		}

		let Some(entry) = current.as_mut() else {
			continue;
		};
		let trimmed = line.trim();
		if skip_log_line(trimmed) {
			continue;
		}
		if entry.subject.is_empty() {
			entry.subject = trimmed.to_string();
		} else if !is_git_trailer(trimmed) {
			// Real (non-trailer) body lines past the 3-line cap are tallied so
			// `push_log_entry` can emit an explicit `[…Nln elided…]` marker
			// rather than dropping them silently.
			if entry.body.len() < 3 {
				entry.body.push(trimmed.to_string());
			} else {
				entry.elided += 1;
			}
		}
	}

	if let Some(entry) = current {
		entries.push(entry);
	}
	entries
}

fn short_hash(hash: &str) -> String {
	hash.chars().take(7).collect()
}

fn skip_log_line(trimmed: &str) -> bool {
	trimmed.is_empty()
		|| trimmed.starts_with("Author:")
		|| trimmed.starts_with("Date:")
		|| trimmed.starts_with("Merge:")
		|| is_log_stat_line(trimmed)
		|| trimmed.contains("files changed")
		|| trimmed.contains("file changed")
}

fn is_log_stat_line(trimmed: &str) -> bool {
	let Some((_path, stat)) = trimmed.split_once(" | ") else {
		return false;
	};
	stat
		.trim_start()
		.bytes()
		.next()
		.is_some_and(|byte| byte.is_ascii_digit())
}

fn is_git_trailer(trimmed: &str) -> bool {
	const TRAILERS: &[&str] = &[
		"Signed-off-by:",
		"Co-authored-by:",
		"Acked-by:",
		"Reviewed-by:",
		"Tested-by:",
		"Reported-by:",
		"Helped-by:",
		"Suggested-by:",
		"Change-Id:",
		"Refs:",
	];
	TRAILERS.iter().any(|prefix| trimmed.starts_with(prefix))
}

fn condense_show(input: &str) -> String {
	let Some(diff_start) = input.find("\ndiff --git ") else {
		return primitives::head_tail_lines(input, 80, 40);
	};
	let prelude = &input[..diff_start];
	let diff = &input[diff_start + 1..];
	let diff_summary = compact_diff_output(diff);
	if diff_summary == diff {
		return primitives::head_tail_lines(input, 80, 40);
	}

	let mut out = String::new();
	push_show_commit_summary(&mut out, prelude);
	if !out.is_empty() {
		out.push('\n');
	}
	out.push_str(&diff_summary);
	out
}

fn push_show_commit_summary(out: &mut String, prelude: &str) {
	let mut body_lines = 0usize;
	for line in prelude.lines() {
		let trimmed = line.trim();
		if let Some(rest) = trimmed.strip_prefix("commit ") {
			out.push_str("commit ");
			out.push_str(&short_hash(rest));
			out.push('\n');
			continue;
		}
		if skip_log_line(trimmed) || is_git_trailer(trimmed) {
			continue;
		}
		if trimmed.starts_with("diff --git") {
			break;
		}
		if body_lines >= 4 {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
		body_lines += 1;
	}
}
/// Whether `git branch` was invoked with non-listing flags (mutations, value
/// retrieval, or config) whose output `condense_branch` would corrupt by
/// treating the output as a listing.
fn is_branch_non_listing(command: &str) -> bool {
	let tokens: Vec<&str> = command.split_whitespace().collect();
	// Find the "branch" token and scan flags after it
	let idx = tokens.iter().position(|&t| t == "branch");
	let Some(idx) = idx else { return false };
	tokens[idx + 1..].iter().any(|&tok| {
		if !tok.starts_with('-') {
			return false; // non-flag args after the command (branch names) are fine
		}
		!matches!(
			tok,
			// Listing flags — skip to allow `condense_branch` to handle them
			"--list"
				| "-l" | "--merged"
				| "--no-merged"
				| "--contains"
				| "--no-contains"
				| "--points-at"
				| "--verbose"
				| "-v" | "--all"
				| "-a" | "--remotes"
				| "-r" | "--sort"
				| "--column"
				| "--no-column"
				| "--ignore-case"
				| "--abbrev"
		)
	})
}
/// Whether `git tag` was invoked with non-listing flags (verification,
/// deletion, creation, or custom formatting) whose output `compact_listing`
/// would corrupt by treating it as a plain tag-name listing.
fn is_tag_non_listing(command: &str) -> bool {
	if !has_token(command, "tag") {
		return false;
	}

	let tokens: Vec<&str> = command.split_whitespace().collect();
	let idx = tokens.iter().position(|&t| t == "tag");
	let Some(idx) = idx else { return false };
	tokens[idx + 1..].iter().any(|&tok| {
		if !tok.starts_with('-') {
			return false;
		}
		!matches!(
			tok,
			"--list"
				| "-l" | "--contains"
				| "--no-contains"
				| "--merged"
				| "--no-merged"
				| "--points-at"
				| "--sort"
				| "--column"
				| "--no-column"
				| "--ignore-case"
		)
	})
}

/// Whether `git show` was invoked with custom output format flags that
/// `condense_show` would corrupt (pre-diff content would be truncated/
/// rewritten as commit summary).
fn is_show_custom_format(command: &str) -> bool {
	// `--format`/`--pretty` accept both space-separated (`--format fuller`) and
	// inline (`--format=%H`, `--pretty=fuller`) forms; both rewrite the commit
	// prelude that `condense_show` would otherwise truncate, so treat either
	// form as a custom format. `--diff-filter` likewise takes an inline value.
	has_flag(command, "--format")
		|| has_flag(command, "--pretty")
		|| has_flag(command, "--diff-filter")
		|| has_token(command, "--name-only")
		|| has_token(command, "--name-status")
		|| has_token(command, "--stat")
		|| has_token(command, "--numstat")
		|| has_token(command, "--shortstat")
		|| has_token(command, "--summary")
		|| has_token(command, "--check")
		|| has_token(command, "--dirstat")
}

fn is_log_custom_format(command: &str) -> bool {
	has_flag(command, "--format") || has_flag(command, "--pretty") || has_token(command, "--oneline")
}

fn condense_branch(input: &str) -> String {
	let mut current: Option<String> = None;
	let mut local = Vec::new();
	let mut remote_only = Vec::new();

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.contains(" -> ") {
			continue;
		}
		let (is_current, name) = trimmed
			.strip_prefix('*')
			.map_or((false, trimmed), |rest| (true, rest.trim()));
		if name.is_empty() {
			continue;
		}
		if is_current {
			current = Some(name.to_string());
		} else if name.starts_with("remotes/") {
			remote_only.push(name.trim_start_matches("remotes/").to_string());
		} else {
			local.push(name.to_string());
		}
	}

	if current.is_none() && local.is_empty() && remote_only.is_empty() {
		return input.to_string();
	}

	let mut out = String::new();
	if let Some(current) = current.as_deref() {
		out.push_str("* ");
		out.push_str(current);
		out.push('\n');
	}
	if !local.is_empty() {
		out.push_str("local:");
		for branch in local.iter().take(24) {
			out.push(' ');
			out.push_str(branch);
		}
		if local.len() > 24 {
			out.push_str(" … +");
			out.push_str(&(local.len() - 24).to_string());
		}
		out.push('\n');
	}
	let remote_only = remote_only
		.into_iter()
		.filter(|branch| !has_local_tracking_branch(branch, current.as_deref(), &local))
		.collect::<Vec<_>>();
	if !remote_only.is_empty() {
		out.push_str("remote-only (");
		out.push_str(&remote_only.len().to_string());
		out.push_str("):");
		for branch in remote_only.iter().take(24) {
			out.push(' ');
			out.push_str(branch);
		}
		if remote_only.len() > 24 {
			out.push_str(" … +");
			out.push_str(&(remote_only.len() - 24).to_string());
		}
		out.push('\n');
	}
	out
}

fn has_local_tracking_branch(remote: &str, current: Option<&str>, local: &[String]) -> bool {
	// Only the conventional `origin/<branch>` mirror is treated as redundant with
	// a local branch of the same name. Same-named branches on other remotes
	// (e.g. `upstream/main` alongside `origin/main`) are distinct refs and must
	// be preserved in the summary.
	let Some(branch) = remote.strip_prefix("origin/") else {
		return false;
	};
	current == Some(branch) || local.iter().any(|local| local == branch)
}

struct DiffFile {
	path:    String,
	added:   usize,
	removed: usize,
	hunks:   Vec<DiffHunk>,
}

struct DiffHunk {
	header: String,
	lines:  Vec<String>,
}

pub(crate) fn compact_diff_output(input: &str) -> String {
	let files = parse_unified_diff(input);
	if files.is_empty() {
		return input.to_string();
	}

	let total_added: usize = files.iter().map(|file| file.added).sum();
	let total_removed: usize = files.iter().map(|file| file.removed).sum();
	if total_added == 0 && total_removed == 0 {
		return input.to_string();
	}

	let mut out = String::new();
	for file in files.iter().take(20) {
		let changed = file.added + file.removed;
		out.push_str(&file.path);
		out.push_str(" | ");
		out.push_str(&changed.to_string());
		out.push(' ');
		out.push_str(&diff_bar(file.added, file.removed));
		out.push('\n');
	}
	if files.len() > 20 {
		let _ = writeln!(out, "[…{} files from stat elided…]", files.len() - 20);
	}
	out.push_str(&format_file_count(files.len()));
	out.push_str(" changed, ");
	out.push_str(&total_added.to_string());
	out.push_str(" insertions(+), ");
	out.push_str(&total_removed.to_string());
	out.push_str(" deletions(-)\n\n--- Changes ---\n");

	for file in files.iter().take(12) {
		out.push('\n');
		out.push_str("File: ");
		out.push_str(&file.path);
		out.push('\n');
		for hunk in file.hunks.iter().take(8) {
			out.push_str("  ");
			out.push_str(&hunk.header);
			out.push('\n');
			for line in hunk.lines.iter().take(6) {
				out.push_str("  ");
				out.push_str(line);
				out.push('\n');
			}
			if hunk.lines.len() > 6 {
				let _ = writeln!(out, "  […{} changed lines elided…]", hunk.lines.len() - 6);
			}
		}
		if file.hunks.len() > 8 {
			let _ = writeln!(out, "  […{} hunks elided…]", file.hunks.len() - 8);
		}
	}
	if files.len() > 12 {
		let _ = writeln!(out, "\n[…{} files from changes elided…]", files.len() - 12);
	}
	out
}

fn parse_unified_diff(input: &str) -> Vec<DiffFile> {
	let mut files = Vec::new();
	let mut current: Option<DiffFile> = None;
	let mut current_hunk: Option<DiffHunk> = None;
	let mut pending_old_path: Option<String> = None;

	for line in input.lines() {
		if let Some(path) = parse_diff_git_path(line) {
			flush_hunk(&mut current, &mut current_hunk);
			if let Some(file) = current.take() {
				files.push(file);
			}
			current = Some(DiffFile { path, added: 0, removed: 0, hunks: Vec::new() });
			pending_old_path = None;
			continue;
		}
		if let Some(path) = line.strip_prefix("--- ") {
			pending_old_path = Some(path.strip_prefix("a/").unwrap_or(path).to_string());
			continue;
		}
		if let Some(path) = line.strip_prefix("+++ ") {
			let path = path.strip_prefix("b/").unwrap_or(path);
			let path = if path == "/dev/null" {
				pending_old_path.as_deref().unwrap_or(path)
			} else {
				path
			};
			flush_hunk(&mut current, &mut current_hunk);
			let update_current_path = current
				.as_ref()
				.is_some_and(|file| file.added == 0 && file.removed == 0 && file.hunks.is_empty());
			if update_current_path {
				if let Some(file) = current.as_mut() {
					file.path = path.to_string();
				}
			} else if let Some(file) = current.take() {
				files.push(file);
				current = Some(DiffFile {
					path:    path.to_string(),
					added:   0,
					removed: 0,
					hunks:   Vec::new(),
				});
			} else {
				current = Some(DiffFile {
					path:    path.to_string(),
					added:   0,
					removed: 0,
					hunks:   Vec::new(),
				});
			}
			pending_old_path = None;
			continue;
		}
		if line.starts_with("@@") {
			flush_hunk(&mut current, &mut current_hunk);
			current_hunk = Some(DiffHunk { header: line.to_string(), lines: Vec::new() });
			continue;
		}
		if line.starts_with("+++") || line.starts_with("---") {
			continue;
		}
		let Some(file) = current.as_mut() else {
			continue;
		};
		if line.starts_with('+') {
			file.added += 1;
			push_diff_line(&mut current_hunk, line);
		} else if line.starts_with('-') {
			file.removed += 1;
			push_diff_line(&mut current_hunk, line);
		}
	}

	flush_hunk(&mut current, &mut current_hunk);
	if let Some(file) = current {
		files.push(file);
	}
	files
		.into_iter()
		.filter(|file| file.added > 0 || file.removed > 0)
		.collect()
}

fn parse_diff_git_path(line: &str) -> Option<String> {
	let rest = line.strip_prefix("diff --git ")?;
	let mut parts = rest.split_whitespace();
	let _old = parts.next()?;
	let new = parts.next()?;
	Some(new.strip_prefix("b/").map_or(new, |path| path).to_string())
}

fn flush_hunk(file: &mut Option<DiffFile>, hunk: &mut Option<DiffHunk>) {
	let Some(hunk) = hunk.take() else {
		return;
	};
	if let Some(file) = file.as_mut() {
		file.hunks.push(hunk);
	}
}

fn push_diff_line(hunk: &mut Option<DiffHunk>, line: &str) {
	let Some(hunk) = hunk.as_mut() else {
		return;
	};
	hunk.lines.push(primitives::truncate_line(line, 160));
}

fn diff_bar(added: usize, removed: usize) -> String {
	let total = added + removed;
	if total == 0 {
		return String::new();
	}
	let width = total.clamp(1, 24);
	let plus = (added * width).div_ceil(total);
	let minus = width.saturating_sub(plus);
	format!("{}{}", "+".repeat(plus), "-".repeat(minus))
}

fn format_file_count(files: usize) -> String {
	if files == 1 {
		"1 file".to_string()
	} else {
		format!("{files} files")
	}
}

fn condense_noisy_output(input: &str) -> String {
	let deduped = primitives::dedup_consecutive_lines(input);
	primitives::head_tail_cap(&deduped, primitives::CapClass::Errors)
}

fn condense_commit(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		let mut hash = None;
		let mut stat = None;
		for line in input.lines() {
			let trimmed = line.trim();
			if hash.is_none()
				&& let Some(found) = parse_commit_hash(trimmed)
			{
				hash = Some(found);
				continue;
			}
			// Default `git commit` success prints a "N files changed, …" stat line
			// below the "[branch hash] msg" line; fold it back into the summary so
			// the files/insertions signal survives the condense.
			if stat.is_none() {
				stat = parse_stat_summary(trimmed);
			}
		}
		if let Some(hash) = hash {
			return match stat {
				Some((files, added, deleted)) => {
					format!("ok {hash} ({files} files +{added} -{deleted})\n")
				},
				// `--quiet` (or otherwise stat-less) success keeps the bare hash.
				None => format!("ok {hash}\n"),
			};
		}
		// No commit hash found — likely a `--dry-run` invocation that exits 0
		// but prints a status-style listing instead of a "[branch hash]" line.
		// Preserve/condense the output rather than replacing it with bare "ok".
		return condense_noisy_output(input);
	}

	if input.contains("nothing to commit") {
		return format!("nothing to commit (exit {exit_code})\n");
	}

	condense_noisy_output(input)
}

fn parse_commit_hash(line: &str) -> Option<&str> {
	let rest = line.strip_prefix('[')?;
	let (prefix, _message) = rest.split_once(']')?;
	prefix.split_whitespace().last()
}

fn is_push_progress(line: &str) -> bool {
	let t = line.trim_start();
	t.starts_with("Enumerating objects:")
		|| t.starts_with("Counting objects:")
		|| t.starts_with("Delta compression")
		|| t.starts_with("Compressing objects:")
		|| t.starts_with("Writing objects:")
		|| t.starts_with("Total ")
}

fn is_remote_progress(line: &str) -> bool {
	let Some(rest) = line
		.trim()
		.strip_prefix("remote:")
		.or_else(|| line.trim().strip_prefix("remote: "))
	else {
		return false;
	};
	let rest = rest.trim();
	rest.starts_with("Resolving deltas:")
		|| rest.starts_with("Enumerating objects:")
		|| rest.starts_with("Counting objects:")
		|| rest.starts_with("Compressing objects:")
		|| rest.starts_with("Writing objects:")
		|| rest.starts_with("Total ")
}

fn extract_pushed_ref(line: &str) -> Option<&str> {
	if let Some((_before, after_arrow)) = line.split_once(" -> ") {
		return after_arrow.split_whitespace().next();
	}
	let deleted = line.split_once("[deleted]")?.1.trim();
	deleted.split_whitespace().next()
}

fn is_fetch_ref_update(line: &str) -> bool {
	let Some((_before, after_arrow)) = line.split_once(" -> ") else {
		return false;
	};
	after_arrow
		.split_whitespace()
		.next()
		.is_some_and(|dest| dest != "FETCH_HEAD")
}

fn condense_push(input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = primitives::strip_lines(&cleaned, &[is_push_progress]);

	let mut out = String::new();
	if exit_code == 0 {
		let mut pushed_ref = None;

		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			// Keep remote warnings / notes (non-progress remote lines)
			if trimmed.starts_with("remote:") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep destination lines
			if trimmed.starts_with("To ") {
				out.push_str(line);
				out.push('\n');
				continue;
			}
			// Keep ref update lines: "* [new ...]", "- [deleted] ...", branch setup,
			// or "hash..hash ref -> ref"
			if trimmed.starts_with("* [new")
				|| trimmed.starts_with("- [deleted]")
				|| trimmed.starts_with("Branch ")
				|| trimmed.contains(" -> ")
			{
				if pushed_ref.is_none() {
					pushed_ref = extract_pushed_ref(trimmed);
				}
				out.push_str(line);
				out.push('\n');
			}
		}

		if out.is_empty() {
			out.push_str("ok (up-to-date)\n");
		} else if let Some(dest) = pushed_ref {
			out.push_str("ok ");
			out.push_str(dest);
			out.push('\n');
		} else {
			out.push_str("ok\n");
		}
	} else {
		// Failure: keep diagnostics, strip only progress noise
		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if is_remote_progress(trimmed) {
				continue;
			}
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}
fn condense_pull(input: &str, exit_code: i32) -> String {
	if exit_code == 0 {
		if input.contains("Already up to date.") || input.contains("Already up-to-date.") {
			return "ok (up-to-date)\n".to_string();
		}
		for line in input.lines() {
			let trimmed = line.trim();
			if let Some((files, added, deleted)) = parse_stat_summary(trimmed) {
				return format!("ok {files} files +{added} -{deleted}\n");
			}
		}
		return "ok\n".to_string();
	}
	condense_noisy_output(input)
}

fn condense_diff_stat(input: &str) -> String {
	let mut entries = Vec::new();
	let mut summary = None;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		if let Some((files, added, deleted)) = parse_stat_summary(trimmed) {
			summary = Some((files, added, deleted));
			continue;
		}
		if trimmed.contains('|') {
			entries.push(primitives::truncate_line(trimmed, 140));
		}
	}

	let Some((files, added, deleted)) = summary else {
		return primitives::head_tail_cap(input, primitives::CapClass::List);
	};

	let mut out = String::new();
	let _ = writeln!(out, "git diff --stat: {files} files +{added} -{deleted}");
	for entry in entries.iter().take(20) {
		out.push_str(entry);
		out.push('\n');
	}
	if entries.len() > 20 {
		let _ = writeln!(out, "[…{} files elided…]", entries.len() - 20);
	}
	out
}

fn parse_stat_summary(line: &str) -> Option<(&str, &str, &str)> {
	// Parse "N file(s) changed, I insertion(s)(+), D deletion(s)(-)"
	// or variants with only insertions or only deletions.
	if !line.contains("file") || !line.contains("changed") {
		return None;
	}
	let mut files = "";
	let mut inserted = "0";
	let mut deleted = "0";

	for segment in line.split(", ") {
		if segment.contains("file") && segment.contains("changed") {
			files = segment.split_whitespace().next().unwrap_or("");
		} else if segment.contains("insertion") {
			inserted = segment.split_whitespace().next().unwrap_or("0");
		} else if segment.contains("deletion") {
			deleted = segment.split_whitespace().next().unwrap_or("0");
		}
	}

	if files.is_empty() {
		return None;
	}
	Some((files, inserted, deleted))
}

fn condense_fetch(input: &str, exit_code: i32) -> String {
	let cleaned = primitives::strip_ansi(input);
	let stripped = primitives::strip_lines(&cleaned, &[is_remote_progress]);

	if exit_code == 0 {
		let mut updates: usize = 0;
		let mut kept = Vec::new();

		for line in stripped.lines() {
			let trimmed = line.trim();
			if trimmed.is_empty() {
				continue;
			}
			if trimmed.starts_with("From ") || trimmed.starts_with("To ") {
				kept.push(trimmed.to_string());
				continue;
			}
			// remote: warnings/errors
			if trimmed.starts_with("remote:") && !is_remote_progress(trimmed) {
				kept.push(trimmed.to_string());
				continue;
			}
			// Branch fetch lines: " * branch       name -> FETCH_HEAD", " * [new branch]
			// name -> origin/name", or "   hash..hash name -> name"
			if trimmed.starts_with('*') || trimmed.starts_with(" *") {
				if is_fetch_ref_update(trimmed) {
					updates += 1;
				}
				kept.push(trimmed.to_string());
				continue;
			}
			if trimmed.contains(" -> ") && (trimmed.starts_with('-') || trimmed.contains("..")) {
				if is_fetch_ref_update(trimmed) {
					updates += 1;
				}
				kept.push(trimmed.to_string());
			}
			// Keep error/warning lines
			if trimmed.starts_with("error:")
				|| trimmed.starts_with("fatal:")
				|| trimmed.starts_with("warning:")
			{
				kept.push(trimmed.to_string());
			}
		}

		let mut out = String::new();
		for line in kept {
			out.push_str(&line);
			out.push('\n');
		}
		if updates == 0 {
			out.push_str("ok fetched (up-to-date)\n");
		} else {
			out.push_str("ok fetched, ");
			out.push_str(&updates.to_string());
			out.push_str(" update");
			if updates != 1 {
				out.push('s');
			}
			out.push('\n');
		}
		return out;
	}

	// Failure: keep diagnostics, dedup like old condense_noisy_output
	// Don't strip progress on failure; keep verbatim for debugging.
	let deduped = primitives::dedup_consecutive_lines(input);
	let mut out = String::new();
	for line in deduped.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}
	primitives::head_tail_lines(&out, 80, 40)
}

fn condense_stash(command: &str, input: &str, exit_code: i32) -> String {
	if has_token(command, "list") {
		return condense_stash_list(input);
	}
	if input.contains("No local changes to save") {
		return "No local changes to save\n".to_string();
	}
	if exit_code == 0 {
		let sub = stash_subcommand(command);
		// Bare "stash" defaults to push
		let sub = if sub.is_empty() { "push" } else { sub };
		if sub == "push" || sub == "save" {
			return "ok stashed\n".to_string();
		}
		if sub == "apply" || sub == "pop" || sub == "branch" {
			let compacted = condense_status(input);
			return if compacted == input {
				input.to_string()
			} else {
				compacted
			};
		}
		if sub == "create" {
			return input.to_string();
		}
		if sub == "drop" || sub == "clear" {
			return format!("ok stash {sub}\n");
		}
		// Default: compact listing fallback
		return primitives::compact_listing(input, 40);
	}

	condense_noisy_output(input)
}

fn condense_stash_list(input: &str) -> String {
	let mut out = String::new();
	let mut count = 0usize;
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}
		count += 1;
		// Format: "stash@{N}: WIP on <branch>: <hash> <message>"
		// or    : "stash@{N}: On <branch>: <hash> <message>"
		let (stash_ref, after_stash) = if let Some((stash_ref, rest)) = trimmed.split_once(": ") {
			(stash_ref, rest)
		} else {
			("", trimmed)
		};
		// Strip the "WIP on "/"On " prefix but KEEP <branch> — it's the primary
		// thing users scan a stash list for ("which branch is this stash from?").
		// Re-emit it compactly as `[branch] <message>` instead of dropping it.
		let compact = match after_stash
			.strip_prefix("WIP on ")
			.or_else(|| after_stash.strip_prefix("On "))
		{
			Some(rest) => rest.split_once(": ").map_or_else(
				|| after_stash.to_string(),
				|(branch, msg)| format!("[{}] {}", branch.trim(), msg.trim()),
			),
			None => after_stash.to_string(),
		};
		if !stash_ref.is_empty() {
			out.push_str(stash_ref);
			out.push_str(": ");
		}
		out.push_str(&compact);
		out.push('\n');
	}
	if count == 0 {
		return input.to_string();
	}
	// Remove trailing newline then add exactly one
	out.pop();
	out.push('\n');
	out
}

fn stash_subcommand(command: &str) -> &str {
	for part in command.split_whitespace() {
		match part {
			"push" | "save" | "apply" | "pop" | "drop" | "branch" | "clear" | "create" | "show"
			| "list" => return part,
			_ => {},
		}
	}
	""
}

const WORKTREE_LIMIT: usize = 20;

fn condense_worktree(input: &str) -> String {
	// Home is re-derived from the environment (never shelled out) so a leading
	// `$HOME` in worktree paths can be abbreviated to `~`. Falls back to no
	// abbreviation when `HOME` is unset.
	let home = std::env::var("HOME").unwrap_or_default();
	condense_worktree_with_home(input, &home)
}

/// Condense `git worktree` output, shape-detected from the OUTPUT rather than
/// the args so it covers both `worktree list` and bare confirmations.
///
/// Listing-shaped lines (`<abs-path> <hash> [<branch>]`, plus the `(bare)` and
/// `(detached HEAD)` variants) get a leading `$HOME` abbreviated to `~` and are
/// capped with an elided-count marker. Any non-listing output (`add`'s
/// "Preparing worktree…"/"HEAD is now at …" confirmations, errors) is left to
/// `condense_noisy_output`/passthrough so its meaning is preserved.
fn condense_worktree_with_home(input: &str, home: &str) -> String {
	let mut entries = Vec::new();
	for line in input.lines() {
		if line.trim().is_empty() {
			continue;
		}
		if !is_worktree_listing_line(line) {
			// Not a listing: confirmation / error / progress — hand off untouched.
			return condense_noisy_output(input);
		}
		entries.push(abbreviate_worktree_home(line, home));
	}

	if entries.is_empty() {
		return input.to_string();
	}

	let mut out = String::new();
	for entry in entries.iter().take(WORKTREE_LIMIT) {
		out.push_str(entry);
		out.push('\n');
	}
	if entries.len() > WORKTREE_LIMIT {
		let _ = writeln!(out, "[…{} worktrees elided…]", entries.len() - WORKTREE_LIMIT);
	}
	out
}

/// A `git worktree list` row is `<abs-path>  <hash> [<branch>]`, with the
/// trailing column being `(bare)` for a bare repo or `(detached HEAD)` for a
/// detached worktree. The discriminator: an absolute first token followed by a
/// hex hash or the literal `(bare)`.
fn is_worktree_listing_line(line: &str) -> bool {
	let mut parts = line.split_whitespace();
	let Some(path) = parts.next() else {
		return false;
	};
	if !path.starts_with('/') {
		return false;
	}
	let Some(second) = parts.next() else {
		return false;
	};
	second == "(bare)" || is_short_hex(second)
}

fn is_short_hex(token: &str) -> bool {
	token.len() >= 7 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn abbreviate_worktree_home(line: &str, home: &str) -> String {
	if home.is_empty() {
		return line.to_string();
	}
	// Only abbreviate a leading `$HOME` path prefix; a bare `$HOME` exactly is
	// rendered as `~`. Mid-line occurrences are left untouched.
	if let Some(rest) = line.strip_prefix(home)
		&& (rest.is_empty() || rest.starts_with(['/', ' ', '\t']))
	{
		return format!("~{rest}");
	}
	line.to_string()
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
		MinimizerCtx { program: "git", subcommand, command, config }
	}

	#[test]
	fn status_is_supported() {
		assert!(supports(Some("status")));
	}

	#[test]
	fn short_status_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --short", &cfg);
		let input = " M src/main.rs\nM  Cargo.toml\n?? scratch.txt\nUU conflicted.rs\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(
			out.text,
			"staged 1, unstaged 1, untracked 1, conflicts 1\nM src/main.rs\nM Cargo.toml\n?? \
			 scratch.txt\nUU conflicted.rs\n"
		);
	}

	#[test]
	fn short_status_with_branch_preserves_branch_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status -sb", &cfg);
		let input = "## main...origin/main [ahead 2]\n M src/main.rs\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(
			out.text,
			"branch main...origin/main [ahead 2]\nstaged 0, unstaged 1, untracked 0\nM src/main.rs\n",
		);
	}

	#[test]
	fn status_null_output_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status -sz", &cfg);
		let input = " M src/main.rs\0?? scratch.txt\0";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn short_status_ignored_only_preserves_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --short --ignored", &cfg);
		let input = "!! ignored.log\n!! target/\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn short_status_ignored_rows_do_not_count_dirty() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --short --ignored", &cfg);
		let input = " M src/main.rs\n!! ignored.log\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(out.text, "staged 0, unstaged 1, untracked 0\nM src/main.rs\n");
	}

	#[test]
	fn long_status_clean_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to \
		             commit, working tree clean\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "branch main\nclean\n");
	}

	#[test]
	fn long_status_show_stash_preserves_requested_stash_info() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status --show-stash", &cfg);
		let input = "On branch main\nYour branch is up to date with 'origin/main'.\n\nYour stash \
		             currently has 2 entries\n\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "branch main\nYour stash currently has 2 entries\nclean\n");
	}

	#[test]
	fn supports_git_coverage_subcommands() {
		for subcommand in ["show", "branch", "fetch", "stash", "worktree"] {
			assert!(supports(Some(subcommand)), "{subcommand} should be buffered");
		}
	}

	#[test]
	fn branch_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), "git branch -a", &cfg);
		let input = "\
* main
  feat/a
  fix/b
  remotes/origin/main
  remotes/origin/x
  remotes/upstream/y
  remotes/origin/HEAD -> origin/main
";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "* main\nlocal: feat/a fix/b\nremote-only (2): origin/x upstream/y\n");
	}

	#[test]
	fn branch_listing_keeps_same_named_branch_on_other_remote() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("branch"), "git branch -a", &cfg);
		// Local `main` makes `origin/main` redundant, but `upstream/main` is a
		// distinct ref and must survive.
		let input = "\
* main
  remotes/origin/main
  remotes/upstream/main
";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("upstream/main"), "{:?}", out.text);
		assert!(!out.text.contains("origin/main"), "{:?}", out.text);
	}

	#[test]
	fn tag_format_output_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx =
			test_ctx(Some("tag"), "git tag --format=%(refname:short)|%(taggerdate:short)", &cfg);
		let input = (0..45).fold(String::new(), |mut s, idx| {
			let _ = writeln!(s, "v1.{idx}|2026-06-06");
			s
		});

		let out = filter(&ctx, &input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn tag_delete_output_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("tag"), "git tag -d v1.0 v1.1", &cfg);
		let input = (0..45).fold(String::new(), |mut s, idx| {
			let _ = writeln!(s, "Deleted tag 'v1.{idx}' (was abc1234)");
			s
		});

		let out = filter(&ctx, &input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn tag_listing_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("tag"), "git tag --list", &cfg);
		let input = (0..45).fold(String::new(), |mut s, idx| {
			let _ = writeln!(s, "v1.{idx}");
			s
		});

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.starts_with("45 entries\n"));
		assert!(out.text.contains("…\n"));
	}

	#[test]
	fn fetch_output_strips_ansi_and_dedups_progress() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let out = filter(
			&ctx,
			"\x1b[32mremote: Counting objects: 1\x1b[0m\nremote: Counting objects: 1\nerror: failed\n",
			1,
		);
		assert_eq!(out.text, "remote: Counting objects: 1 (×2)\nerror: failed\n");
	}

	#[test]
	fn fetch_output_counts_new_refs_as_updates() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch origin", &cfg);
		let out = filter(
			&ctx,
			"From github.com:can1357/oh-my-pi\n * [new branch]      feature -> origin/feature\n",
			0,
		);
		assert!(out.changed);
		assert!(
			out.text
				.contains("* [new branch]      feature -> origin/feature")
		);
		assert!(out.text.contains("ok fetched, 1 update"));
		assert!(!out.text.contains("up-to-date"));
	}

	#[test]
	fn push_output_keeps_deleted_refs() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push origin --delete old-branch", &cfg);
		let out =
			filter(&ctx, "To github.com:can1357/oh-my-pi.git\n - [deleted]         old-branch\n", 0);
		assert!(out.changed);
		assert!(out.text.contains("- [deleted]         old-branch"));
		assert!(out.text.contains("ok old-branch"));
	}

	#[test]
	fn stash_apply_preserves_changed_paths() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash apply", &cfg);
		let out = filter(
			&ctx,
			"On branch main\nChanges not staged for commit:\n  modified:   src/main.rs\n\nno changes \
			 added to commit\n",
			0,
		);
		assert!(out.changed);
		assert!(out.text.contains("branch main"));
		assert!(out.text.contains("M src/main.rs"));
		assert!(!out.text.contains("ok stash apply"));
	}

	#[test]
	fn show_path_content_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("show"), "git show HEAD:path/to/file.json", &cfg);
		let input = "{\n  \"items\": [1, 2, 3]\n}\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn show_condenses_commit_stat_and_diff_samples() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("show"), "git show HEAD", &cfg);
		let input = "commit abcdef1234567890\nAuthor: Somebody\nDate: today\n\n    fix: update \
		             thing\n\n    Keep useful body line.\n    Signed-off-by: Somebody \
		             <s@example.com>\n\ndiff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ \
		             b/src/lib.rs\n@@ -1 +1 @@\n-old\n+new\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("commit abcdef1"));
		assert!(out.text.contains("fix: update thing"));
		assert!(out.text.contains("Keep useful body line."));
		assert!(!out.text.contains("Signed-off-by"));
		assert!(out.text.contains("src/lib.rs | 2"));
		assert!(out.text.contains("--- Changes ---"));
		assert!(out.text.contains("-old"));
		assert!(out.text.contains("+new"));
	}

	#[test]
	fn show_custom_format_passes_through_inline_and_space_forms() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		// `--format`/`--pretty` reshape the commit prelude `condense_show` would
		// otherwise rewrite, in both `--flag value` and `--flag=value` forms.
		let custom = [
			"git show --format=fuller HEAD",
			"git show --format=%H HEAD",
			"git show --format fuller HEAD",
			"git show --pretty=fuller HEAD",
			"git show --pretty=%h%n%s HEAD",
		];
		let input = "abcdef1234567890\nfix: update thing\ndiff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
		for command in custom {
			let ctx = test_ctx(Some("show"), command, &cfg);
			let out = filter(&ctx, input, 0);
			assert!(!out.changed, "`{command}` must pass through custom-format show output");
			assert_eq!(out.text, input, "`{command}` must preserve output verbatim");
		}
	}

	#[test]
	fn stash_show_patch_preserves_diff() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash show -p", &cfg);
		let input = "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old\n+new\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn log_is_compacted_to_short_hashes_and_subjects() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		let mut input = String::new();
		for idx in 0..70 {
			input.push_str("commit abcdef1234567890");
			input.push_str(&idx.to_string());
			input.push('\n');
			input.push_str("Author: Somebody <s@example.com>\nDate: today\n");
			input.push_str("    message ");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("[…22 commits elided…]"));
		assert!(out.text.contains("abcdef1 message 0"));
		assert!(!out.text.contains("message 47"));
		assert!(out.text.contains("abcdef1 message 69"));
		assert!(!out.text.contains("Author:"));
		assert!(!out.text.contains("Date:"));
	}

	#[test]
	fn log_supports_subject_on_commit_line() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log --stat -10", &cfg);
		let input = "commit c84fa3c fix: add website URL (rtk-ai.app)\nAuthor: Somebody\nDate: \
		             today\n\n README.md | 8 ++++++++\n 1 file changed, 8 insertions(+)\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "c84fa3c fix: add website URL (rtk-ai.app)\n");
	}

	#[test]
	fn log_stat_line_detection_preserves_graph_pipes() {
		assert!(skip_log_line("README.md | 8 ++++++++"));
		assert!(skip_log_line("src/lib.rs |  18 ++"));
		assert!(!skip_log_line("| * commit message"));
		assert!(!skip_log_line("|\\"));
		assert!(!skip_log_line("discussion uses | as separator"));
	}

	#[test]
	fn log_keeps_useful_body_lines_and_strips_trailers() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		let input = "commit abcdef1234567890\nAuthor: Somebody\nDate: today\n\n    feat: add \
		             API\n\n    BREAKING CHANGE: response shape changed\n    Fixes #123\n    \
		             Signed-off-by: Somebody <s@example.com>\n    Co-authored-by: Other \
		             <o@example.com>\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("abcdef1 feat: add API"));
		assert!(out.text.contains("BREAKING CHANGE: response shape changed"));
		assert!(out.text.contains("Fixes #123"));
		assert!(!out.text.contains("Signed-off-by"));
		assert!(!out.text.contains("Co-authored-by"));
	}

	#[test]
	fn log_long_subject_is_truncated_with_dropped_marker() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		let long_subject = "x".repeat(200);
		let input = format!(
			"commit abcdef1234567890\nAuthor: A <a@x.com>\nDate: today\n\n    {long_subject}\n"
		);
		let out = filter(&ctx, &input, 0);
		// 200 chars → first 160 kept, 40 dropped, surfaced by truncate_line's marker.
		assert!(
			out.text
				.contains(&format!("abcdef1 {}…[+40]", "x".repeat(160))),
			"{:?}",
			out.text
		);
		assert!(!out.text.contains(&long_subject), "full subject must not survive");
	}

	#[test]
	fn log_body_over_cap_shows_elided_marker() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log", &cfg);
		// Subject + 5 body lines: 3 kept, 2 past the cap surfaced as a marker.
		let input = "commit abcdef1234567890\nAuthor: A <a@x.com>\nDate: today\n\n    feat: add \
		             API\n\n    body line one\n    body line two\n    body line three\n    body \
		             line four\n    body line five\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("abcdef1 feat: add API"), "{:?}", out.text);
		assert!(out.text.contains("body line one"));
		assert!(out.text.contains("body line three"));
		assert!(!out.text.contains("body line four"), "{:?}", out.text);
		assert!(out.text.contains("[…2ln elided…]"), "{:?}", out.text);
	}

	#[test]
	fn diff_condenses_unified_patch_to_stat_and_hunk_samples() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff HEAD~1", &cfg);
		let input = "diff --git a/index.html b/index.html\nindex 1b7488b..0ebac4f 100644\n--- \
		             a/index.html\n+++ b/index.html\n@@ -629,7 +629,7 @@\n       width: 100%;\n-      \
		             min-width: 800px;\n+      min-width: 1050px;\n@@ -1051,6 +1051,4 @@\n+    /* \
		             === Share My Gain === */\n+    .share-gain { background: var(--bg); \
		             }\n-old\n+new\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("index.html | 6 "), "{}", out.text);
		assert!(
			out.text
				.contains("1 file changed, 4 insertions(+), 2 deletions(-)")
		);
		assert!(out.text.contains("--- Changes ---"));
		assert!(out.text.contains("@@ -629,7 +629,7 @@"));
		assert!(out.text.contains("-      min-width: 800px;"));
		assert!(out.text.contains("+      min-width: 1050px;"));
	}

	#[test]
	fn diff_stat_is_summarized() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --stat", &cfg);
		let input = "\
 crates/pi-shell/src/minimizer/filters/git.rs     | 385 +++++++++++++++++------
 packages/coding-agent/src/exec/bash-executor.ts  |  18 ++
 packages/coding-agent/test/bash-executor.test.ts |  45 ++-
 3 files changed, 448 insertions(+), 100 deletions(-)
";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("git diff --stat: 3 files +448 -100\n"));
		assert!(
			out.text
				.contains("crates/pi-shell/src/minimizer/filters/git.rs")
		);
		assert!(
			out.text
				.contains("packages/coding-agent/test/bash-executor.test.ts")
		);
		assert!(!out.text.contains("3 files changed"));
	}

	#[test]
	fn diff_name_only_is_compacted_and_bounded() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --name-only HEAD~1", &cfg);
		let mut input = String::new();
		for idx in 0..26 {
			input.push_str("src/file-");
			input.push_str(&idx.to_string());
			input.push_str(".rs\n");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.starts_with("git diff --name-only: 26 files\n"));
		assert!(out.text.contains("src/file-0.rs\n"));
		assert!(out.text.contains("src/file-19.rs\n"));
		assert!(!out.text.contains("src/file-20.rs\n"));
		assert!(out.text.contains("[…6 files elided…]"));
	}

	#[test]
	fn diff_name_status_is_compacted_and_bounded() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --name-status HEAD~1", &cfg);
		let mut input = String::new();
		for idx in 0..24 {
			input.push_str(if idx % 3 == 0 {
				"R100\told-"
			} else {
				"M\tpath-"
			});
			input.push_str(&idx.to_string());
			if idx % 3 == 0 {
				input.push_str(".rs\tnew-");
				input.push_str(&idx.to_string());
			}
			input.push_str(".rs\n");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.starts_with("git diff --name-status: 24 files\n"));
		assert!(out.text.contains("R100\told-0.rs\tnew-0.rs\n"));
		assert!(out.text.contains("M\tpath-1.rs\n"));
		assert!(!out.text.contains("path-20.rs\n"));
		assert!(out.text.contains("[…4 files elided…]"));
	}

	#[test]
	fn diff_stat_summary_preserves_extended_summary_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --stat --summary", &cfg);
		let input = " foo | 1 +\n 1 file changed, 1 insertion(+)\n create mode 100644 foo\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn log_custom_format_preserves_machine_readable_hashes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log --format=%H -n 100", &cfg);
		let mut input = String::new();
		for idx in 0..80 {
			let _ = writeln!(input, "{idx:040x}");
		}
		let out = filter(&ctx, &input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn diff_numstat_is_compacted_and_bounded() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --numstat HEAD~1", &cfg);
		let mut input = String::new();
		for idx in 0..22 {
			input.push_str(&(idx + 1).to_string());
			input.push('\t');
			input.push_str(&(idx % 7).to_string());
			input.push('\t');
			input.push_str("src/file-");
			input.push_str(&idx.to_string());
			input.push_str(".rs\n");
		}

		let out = filter(&ctx, &input, 0);

		assert!(out.changed);
		assert!(out.text.starts_with("git diff --numstat: 22 files\n"));
		assert!(out.text.contains("1\t0\tsrc/file-0.rs\n"));
		assert!(out.text.contains("20\t5\tsrc/file-19.rs\n"));
		assert!(!out.text.contains("src/file-20.rs\n"));
		assert!(out.text.contains("[…2 files elided…]"));
	}

	#[test]
	fn diff_name_only_failure_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("diff"), "git diff --name-only badrev", &cfg);
		let input =
			"fatal: ambiguous argument 'badrev': unknown revision or path not in the working tree.\n";

		let out = filter(&ctx, input, 128);

		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn legacy_log_fallback_removes_metadata_when_no_commit_records_parse() {
		let input = "commitish output\nAuthor: Somebody <s@example.com>\nDate: today\nmessage 0\n";
		let out = condense_log(input, 32, 16);
		assert!(out.contains("message 0"));
		assert!(!out.contains("Author:"));
		assert!(!out.contains("Date:"));
	}

	#[test]
	fn commit_success_compacts_to_hash_with_stat_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("commit"), "git commit -m msg", &cfg);
		let input = "\
[fix/omlx-local-model-limits 5f490f764] chore: checkpoint workspace changes
 70 files changed, 3081 insertions(+), 403 deletions(-)
 create mode 100644 packages/example.ts
 delete mode 100644 old-file.ts
";
		let out = filter(&ctx, input, 0);

		// Best-of: the change summary from the stat line is folded into `ok <hash>`.
		assert_eq!(out.text, "ok 5f490f764 (70 files +3081 -403)\n");
		assert!(!out.text.contains("files changed"));
		assert!(!out.text.contains("create mode"));
	}

	#[test]
	fn commit_success_with_stat_appends_change_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("commit"), "git commit -m msg", &cfg);
		// Default `git commit` success body: "[branch hash] msg" + stat line.
		let input = "[main 1a2b3c4] msg\n 3 files changed, 10 insertions(+), 2 deletions(-)\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok 1a2b3c4 (3 files +10 -2)\n");
	}

	#[test]
	fn commit_success_without_stat_keeps_bare_hash() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("commit"), "git commit -m msg --quiet", &cfg);
		// `--quiet` suppresses the stat line; the bare hash summary is preserved.
		let input = "[main 1a2b3c4] msg\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok 1a2b3c4\n");
	}

	#[test]
	fn commit_nothing_to_commit_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("commit"), "git commit -m msg", &cfg);
		let input = "On branch main\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 1);

		assert_eq!(out.text, "nothing to commit (exit 1)\n");
	}

	#[test]
	fn push_noisy_success_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 8 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (3/3), 1.23 KiB | 1.23 MiB/s, done.
Total 3 (delta 2), reused 0 (delta 0), pack-reused 0
remote: Resolving deltas: 100% (2/2), completed with 2 local objects.
To github.com:user/repo.git
   abc1234..def5678  main -> main
";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(out.text.contains("To github.com:user/repo.git"));
		assert!(out.text.contains("main -> main"));
		assert!(out.text.contains("ok main\n"));
		assert!(!out.text.contains("Enumerating objects"));
		assert!(!out.text.contains("Counting objects"));
		assert!(!out.text.contains("Delta compression"));
		assert!(!out.text.contains("Compressing objects"));
		assert!(!out.text.contains("Writing objects"));
		assert!(!out.text.contains("Total "));
		assert!(!out.text.contains("remote: Resolving deltas"));
	}

	#[test]
	fn push_up_to_date_is_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "Everything up-to-date\n";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert_eq!(out.text, "ok (up-to-date)\n");
	}

	#[test]
	fn push_remote_warning_is_kept() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
Enumerating objects: 3, done.
Counting objects: 100% (3/3), done.
Writing objects: 100% (3/3), done.
Total 3 (delta 0), reused 0 (delta 0), pack-reused 0
remote: warning: Large object detected, consider using Git LFS
To github.com:user/repo.git
   def5678..abc1234  main -> main
";
		let out = filter(&ctx, input, 0);

		assert!(out.changed);
		assert!(out.text.contains("remote: warning: Large object detected"));
		assert!(out.text.contains("ok main\n"));
		assert!(!out.text.contains("Enumerating objects"));
	}

	#[test]
	fn push_rejected_failure_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push", &cfg);
		let input = "\
To github.com:user/repo.git
 ! [rejected]        main -> main (non-fast-forward)
error: failed to push some refs to 'github.com:user/repo.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
";
		let out = filter(&ctx, input, 1);

		assert!(!out.text.contains("ok\n"));
		assert!(!out.text.contains("ok (up-to-date)"));
		assert!(out.text.contains("rejected"));
		assert!(out.text.contains("error: failed to push"));
		assert!(out.text.contains("hint:"));
	}

	// --- Status state detection ---

	#[test]
	fn status_detects_rebasing() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch feature\nYou are currently rebasing.\n  (fix conflicts and then run \
		             \"git rebase --continue\")\n\nChanges not staged for commit:\n  modified:   \
		             src/main.rs\n\nno changes added to commit (use \"git add\")\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: rebasing\n"));
		assert!(out.text.contains("branch feature"));
		assert!(out.text.contains("src/main.rs"));
	}

	#[test]
	fn status_detects_cherry_pick() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou are currently cherry-picking commit abc1234.\n  (fix \
		             conflicts and run \"git cherry-pick --continue\")\n\nnothing to commit, \
		             working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: cherry-pick\n"));
	}

	#[test]
	fn status_detects_revert() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou are currently reverting commit abc1234.\n\nnothing to \
		             commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: revert\n"));
	}

	#[test]
	fn status_detects_bisect() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou are currently bisecting, started from branch 'feature'.\n  \
		             (use \"git bisect reset\" to get back to the original branch)\n\nnothing to \
		             commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: bisect\n"));
	}

	#[test]
	fn status_detects_am_session() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou are in the middle of an am session.\n  (fix conflicts and \
		             then run \"git am --continue\")\n\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: am\n"));
	}

	#[test]
	fn status_detects_sparse_checkout() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou are in a sparse checkout with 42% of tracked files \
		             present.\n\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: sparse-checkout\n"));
	}

	#[test]
	fn status_detects_unmerged_paths() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYou have unmerged paths.\n  (fix conflicts and run \"git \
		             commit\")\n\nUnmerged paths:\n  both modified:   conflicted.rs\n\nno changes \
		             added to commit (use \"git add\")\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: merge-conflict\n"));
		assert!(out.text.contains("conflicts 1"));
	}

	#[test]
	fn status_detects_interactive_rebase_edit() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		// Realistic default long-format body for an interactive-rebase `edit` stop.
		let input = "On branch feature\n\ninteractive rebase in progress; onto abc1234\nLast \
		             command done (1 command done):\n   edit abc123 some message\nNo commands \
		             remaining.\nYou are currently editing a commit while rebasing branch 'feature' \
		             on 'abc1234'.\n  (use \"git commit --amend\" to amend the current commit)\n  \
		             (use \"git rebase --continue\" once you are satisfied with your \
		             changes)\n\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: rebasing\n"), "{:?}", out.text);
		assert!(out.text.contains("branch feature"));
	}

	#[test]
	fn status_detects_merge_all_conflicts_fixed() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		// Realistic default long-format body after all merge conflicts are resolved.
		let input = "On branch main\n\nAll conflicts fixed but you are still merging.\n  (use \"git \
		             commit\" to conclude merge)\n\nChanges to be committed:\n  modified:   \
		             src/main.rs\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.starts_with("state: merge (ready to commit)\n"), "{:?}", out.text);
		// Distinct from the unresolved-conflict label.
		assert!(!out.text.contains("merge-conflict"));
		assert!(out.text.contains("M src/main.rs"));
	}

	#[test]
	fn status_state_not_emitted_when_no_state() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to \
		             commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(!out.text.contains("state:"));
		assert_eq!(out.text, "branch main\nclean\n");
	}

	#[test]
	fn status_untracked_file_named_like_rebase_progress_not_misread_as_state() {
		// A clean tree whose only untracked file is named like a rebase
		// progress line must NOT be reported as `state: rebasing`, and the
		// untracked file must still be counted. Regression for the
		// detect_status_state false positive inside the untracked section.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("status"), "git status", &cfg);
		let input = "On branch main\nUntracked files:\n  (use \"git add <file>...\" to include in \
		             what will be committed)\n\tNext command to do.md\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		// Pre-fix this body was reported as `state: rebasing` with the filename
		// swallowed; the fix keeps state detection out of the untracked section.
		assert!(!out.text.contains("state:"), "{:?}", out.text);
		assert!(out.text.contains("untracked 1"), "{:?}", out.text);
		assert!(out.text.contains("?? Next command to do.md"), "{:?}", out.text);
	}

	// --- Pull summaries ---

	#[test]
	fn pull_up_to_date_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pull"), "git pull", &cfg);
		let out = filter(&ctx, "Already up to date.\n", 0);
		assert!(out.changed);
		assert_eq!(out.text, "ok (up-to-date)\n");
	}

	#[test]
	fn pull_up_to_date_hyphenated() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pull"), "git pull", &cfg);
		let out = filter(&ctx, "Already up-to-date.\n", 0);
		assert!(out.changed);
		assert_eq!(out.text, "ok (up-to-date)\n");
	}

	#[test]
	fn pull_with_stat_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pull"), "git pull", &cfg);
		let input = "Updating abc1234..def5678\nFast-forward\n src/lib.rs | 12 ++++++++++++\n 1 \
		             file changed, 12 insertions(+)\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(out.text, "ok 1 files +12 -0\n");
	}

	#[test]
	fn pull_with_delete_stat_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pull"), "git pull", &cfg);
		let input =
			"Updating abc1234..def5678\n src/lib.rs | 3 ---\n 1 file changed, 3 deletions(-)\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(out.text, "ok 1 files +0 -3\n");
	}

	#[test]
	fn pull_conflict_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("pull"), "git pull", &cfg);
		let input = "Auto-merging src/lib.rs\nCONFLICT (content): Merge conflict in \
		             src/lib.rs\nAutomatic merge failed; fix conflicts and then commit the result.\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("CONFLICT"));
		assert!(!out.text.contains("ok"));
	}

	// --- Fetch summaries ---

	#[test]
	fn fetch_up_to_date_compacted() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let input = "From github.com:user/repo\n * branch            main       -> FETCH_HEAD\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("From github.com:user/repo"));
		assert!(out.text.contains("ok fetched (up-to-date)"));
	}

	#[test]
	fn fetch_with_updates() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let input = "From github.com:user/repo\n   abc1234..def5678  main       -> origin/main\n   \
		             aabbccd..eeff001  feature    -> origin/feature\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("ok fetched, 2 updates"));
	}

	#[test]
	fn fetch_single_update() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch", &cfg);
		let input = "From github.com:user/repo\n   abc1234..def5678  main       -> origin/main\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert!(out.text.contains("ok fetched, 1 update\n"));
	}

	#[test]
	fn fetch_preserves_remote_warnings() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch origin", &cfg);
		let input = "From github.com:user/repo\nremote: warning: this is a test warning\n   \
		             abc1234..def5678  main       -> origin/main\n";
		let out = filter(&ctx, input, 0);
		assert!(out.text.contains("remote: warning:"));
		assert!(out.text.contains("ok fetched, 1 update"));
	}

	#[test]
	fn fetch_failure_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("fetch"), "git fetch origin", &cfg);
		let input = "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read \
		             from remote repository.\n";
		let out = filter(&ctx, input, 128);
		assert!(out.text.contains("fatal:"));
		assert!(!out.text.contains("ok"));
	}

	// --- Stash improvements ---

	#[test]
	fn stash_push_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash push", &cfg);
		let input = "Saved working directory and index state WIP on main: abc1234 some message\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		assert_eq!(out.text, "ok stashed\n");
	}

	#[test]
	fn stash_save_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash save", &cfg);
		let input = "Saved working directory and index state On main: abc1234 some message\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok stashed\n");
	}

	#[test]
	fn stash_bare_defaults_to_push() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash", &cfg);
		let input = "Saved working directory and index state WIP on main: abc1234 some message\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok stashed\n");
	}

	#[test]
	fn stash_empty_message_stays_opaque() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash", &cfg);
		let out = filter(&ctx, "No local changes to save\n", 0);
		assert_eq!(out.text, "No local changes to save\n");
	}

	#[test]
	fn stash_apply_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash apply", &cfg);
		let input = "On branch main\nnothing to commit, working tree clean\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "branch main\nclean\n");
	}

	#[test]
	fn stash_pop_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash pop", &cfg);
		let input = "Dropped refs/stash@{0} (abc1234...)\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn stash_drop_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash drop", &cfg);
		let input = "Dropped refs/stash@{0} (abc1234...)\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok stash drop\n");
	}

	#[test]
	fn stash_branch_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash branch new-branch", &cfg);
		let input = "Switched to a new branch 'new-branch'\nDropped refs/stash@{0}\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
	}

	#[test]
	fn stash_clear_success() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash clear", &cfg);
		let out = filter(&ctx, "", 0);
		assert_eq!(out.text, "ok stash clear\n");
	}

	#[test]
	fn stash_no_local_changes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash", &cfg);
		let input = "No local changes to save\n";
		let out = filter(&ctx, input, 1);
		assert_eq!(out.text, "No local changes to save\n");
	}

	#[test]
	fn stash_list_compacts_wip_prefix() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash list", &cfg);
		let input = "stash@{0}: WIP on feature-x: abc1234 fix: something\nstash@{1}: On main: \
		             def5678 chore: clean up\nstash@{2}: WIP on dev: ghi9012 feat: add widget\n";
		let out = filter(&ctx, input, 0);
		assert!(out.changed);
		// Branch is preserved (re-emitted as `[branch]`) — it's the primary thing
		// users scan stash lists for — while the "WIP on "/"On " noise is stripped.
		assert!(
			out.text
				.contains("stash@{0}: [feature-x] abc1234 fix: something")
		);
		assert!(
			out.text
				.contains("stash@{1}: [main] def5678 chore: clean up")
		);
		assert!(
			out.text
				.contains("stash@{2}: [dev] ghi9012 feat: add widget")
		);
		assert!(!out.text.contains("WIP on "));
		assert!(!out.text.contains("On main:"));
	}

	#[test]
	fn stash_list_empty_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("stash"), "git stash list", &cfg);
		let out = filter(&ctx, "", 0);
		assert!(!out.changed);
	}

	// --- Log failure passthrough ---

	#[test]
	fn log_failure_keeps_diagnostics() {
		// `git log` on a bad rev fails with exit 128.  The filter must not
		// silently swallow the error into a zero-entry commit listing.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log --oneline badref", &cfg);
		let input = "fatal: ambiguous argument 'badref': unknown revision or path not in the \
		             working tree.\nfatal: bad default revision 'HEAD'\n";

		let out = filter(&ctx, input, 128);

		assert!(out.text.contains("fatal:"), "error header must survive: {:?}", out.text);
		assert!(out.text.contains("badref"), "offending ref must survive: {:?}", out.text);
		assert!(!out.text.contains("commits elided"), "must not fabricate commit listing on error");
	}

	#[test]
	fn log_oneline_short_run_emits_all_entries() {
		// A short log that fits within head+tail should emit all entries
		// without any "elided" line, and each entry should carry the
		// 7-char short hash followed by the subject.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("log"), "git log -5", &cfg);
		let input = "\
commit abcdef1234567890\nAuthor: A <a@x.com>\nDate: today\n    feat: first\ncommit \
		             1111111111111111\nAuthor: A <a@x.com>\nDate: today\n    fix: second\ncommit \
		             2222222222222222\nAuthor: A <a@x.com>\nDate: today\n    chore: third\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.text.contains("commits elided"));
		assert!(out.text.contains("abcdef1 feat: first"), "{:?}", out.text);
		assert!(out.text.contains("1111111 fix: second"), "{:?}", out.text);
		assert!(out.text.contains("2222222 chore: third"), "{:?}", out.text);
		assert!(!out.text.contains("Author:"), "author noise must be stripped");
		assert!(!out.text.contains("Date:"), "date noise must be stripped");
	}

	// --- Merge/rebase error preservation ---

	#[test]
	fn merge_conflict_failure_keeps_diagnostics() {
		// `git merge` that ends in conflicts must surface the conflict
		// paths, not be silently compacted into an empty success message.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("merge"), "git merge feat/x", &cfg);
		let input = "\
Auto-merging src/lib.rs\nCONFLICT (content): Merge conflict in src/lib.rs\nAutomatic merge failed; \
		             fix conflicts and then commit the result.\n";

		let out = filter(&ctx, input, 1);

		assert!(out.text.contains("CONFLICT"), "conflict marker must survive: {:?}", out.text);
		assert!(out.text.contains("src/lib.rs"), "conflict path must survive: {:?}", out.text);
		assert!(!out.text.contains("ok"), "must not emit an ok summary on failure");
	}

	#[test]
	fn rebase_conflict_failure_keeps_diagnostics() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("rebase"), "git rebase main", &cfg);
		let input = "\
error: could not apply abc1234... fix: something\nhint: Resolve all conflicts manually, mark them \
		             as resolved with\nhint: \"git add/rm <conflicted_files>\", then run \"git \
		             rebase --continue\".\nCONFLICT (content): Merge conflict in src/config.rs\n";

		let out = filter(&ctx, input, 1);

		assert!(out.text.contains("CONFLICT"), "conflict marker must survive: {:?}", out.text);
		assert!(out.text.contains("error:"), "error line must survive: {:?}", out.text);
		assert!(out.text.contains("src/config.rs"), "conflict path must survive: {:?}", out.text);
	}

	// --- Push porcelain passthrough ---

	// --- Worktree condense ---

	#[test]
	fn worktree_list_caps_and_abbreviates_home() {
		let home = "/home/alice";
		let mut input = String::new();
		// 22 listing entries under $HOME, including a bare and a detached-HEAD row.
		input.push_str("/home/alice/repo                  abc1234 (bare)\n");
		input.push_str("/home/alice/repo-detached         def5678 (detached HEAD)\n");
		for idx in 0..20 {
			let _ = writeln!(
				input,
				"/home/alice/wt-{idx:02}                    aaaaaaa{idx:02} [wt-{idx}]"
			);
		}
		let out = condense_worktree_with_home(&input, home);

		// Leading $HOME abbreviated to '~'.
		assert!(out.starts_with("~/repo "), "{out:?}");
		assert!(out.contains("~/repo-detached "));
		assert!(out.contains("(bare)"));
		assert!(out.contains("(detached HEAD)"));
		assert!(!out.contains("/home/alice"), "no absolute $HOME paths should survive: {out:?}");
		// 22 entries → capped at 20 with a 2-elided marker.
		assert!(out.contains("[…2 worktrees elided…]"), "{out:?}");
		assert_eq!(out.lines().filter(|l| l.starts_with('~')).count(), 20);
	}

	#[test]
	fn worktree_add_confirmation_passes_through() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("worktree"), "git worktree add ../wt feature", &cfg);
		// `worktree add` confirmation is not listing-shaped; it must survive.
		let input = "Preparing worktree (new branch 'feature')\nHEAD is now at abc1234 commit msg\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed, "{:?}", out.text);
		assert_eq!(out.text, input);
	}

	#[test]
	fn worktree_porcelain_passthrough() {
		// `git worktree list --porcelain` emits machine-readable records;
		// the minimizer must not insert "[…Nln elided…]" markers.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("worktree"), "git worktree list --porcelain", &cfg);
		let input = "worktree /home/user/project\nHEAD abc1234def\nbranch \
		             refs/heads/main\n\nworktree /home/user/other\nHEAD 567890ab\nbranch \
		             refs/heads/feat\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed, "porcelain worktree listing must pass through unchanged");
		assert_eq!(out.text, input, "porcelain worktree listing must pass through");
	}

	#[test]
	fn worktree_null_passthrough() {
		// `git worktree list -z` also produces machine-readable NUL-delimited output.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("worktree"), "git worktree list -z", &cfg);
		let input = "worktree /home/user/project\0HEAD abc1234def\0branch refs/heads/main\0";
		let out = filter(&ctx, input, 0);
		assert!(!out.changed, "-z worktree output must pass through unchanged");
		assert_eq!(out.text, input);
	}

	#[test]
	fn worktree_non_porcelain_still_condensed() {
		// Normal (non-porcelain) listing should still go through the condenser.
		// Build 22 listing-shaped entries so the cap (20) is exceeded; the condenser
		// would insert an "[…N worktrees elided…]" marker that a passthrough would
		// never emit.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("worktree"), "git worktree list", &cfg);
		let mut input = String::new();
		for idx in 0..22usize {
			let _ = writeln!(input, "/repo/wt-{idx:02}  aaaaaaa{idx:02} [branch-{idx}]");
		}
		let out = filter(&ctx, &input, 0);
		assert!(
			out.text.contains("worktrees elided"),
			"non-porcelain output over the cap must show elided marker; got: {:?}",
			out.text
		);
	}

	#[test]
	fn push_porcelain_output_is_passthrough() {
		// Scripts that parse `git push --porcelain` rely on the exact byte
		// sequence; the minimizer must not touch it.
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = test_ctx(Some("push"), "git push --porcelain origin main", &cfg);
		let input =
			"To github.com:user/repo.git\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n";

		let out = filter(&ctx, input, 0);

		assert!(!out.changed, "porcelain output must not be rewritten");
		assert_eq!(out.text, input);
	}
}
