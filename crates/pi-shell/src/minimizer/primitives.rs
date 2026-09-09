//! Reusable text transforms shared by minimizer filters.

use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapClass {
	Errors,
	Warnings,
	List,
	Inventory,
}

impl CapClass {
	#[must_use]
	pub const fn lines(self) -> usize {
		match self {
			Self::Errors => 160,
			Self::Warnings => 120,
			Self::List => 80,
			Self::Inventory => 40,
		}
	}
}

#[must_use]
pub const fn reduced(cap: usize, by: usize) -> usize {
	let reduced = cap.saturating_sub(by);
	if reduced == 0 && cap > 0 { 1 } else { reduced }
}

/// Remove ANSI CSI escape sequences while preserving line endings verbatim.
#[must_use]
pub fn strip_ansi(input: &str) -> String {
	let mut out = String::with_capacity(input.len());
	let mut chars = input.chars().peekable();
	while let Some(ch) = chars.next() {
		if ch == '\x1b' && chars.peek().is_some_and(|next| *next == '[') {
			let _ = chars.next();
			for c in chars.by_ref() {
				if ('@'..='~').contains(&c) {
					break;
				}
			}
			continue;
		}
		out.push(ch);
	}
	out
}

/// Collapse consecutive identical lines as `line (×N)`.
#[must_use]
pub fn dedup_consecutive_lines(input: &str) -> String {
	let mut out = String::new();
	let mut previous: Option<&str> = None;
	let mut count = 0usize;
	for line in input.lines() {
		if previous == Some(line) {
			count += 1;
			continue;
		}
		flush_repeated(&mut out, previous, count);
		previous = Some(line);
		count = 1;
	}
	flush_repeated(&mut out, previous, count);
	out
}

fn flush_repeated(out: &mut String, line: Option<&str>, count: usize) {
	let Some(line) = line else {
		return;
	};
	out.push_str(line);
	if count > 1 {
		out.push_str(" (×");
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

/// Keep the first `head` and last `tail` lines with an omission marker.
#[must_use]
pub fn head_tail_lines(input: &str, head: usize, tail: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= head + tail {
		return input.to_string();
	}
	let omitted = lines.len() - head - tail;
	let mut out = String::new();
	for line in lines.iter().take(head) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("[…");
	out.push_str(&omitted.to_string());
	out.push_str("ln elided…]\n");
	for line in lines.iter().skip(lines.len() - tail) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Keep head/tail lines using a named cap class.
#[must_use]
pub fn head_tail_cap(input: &str, class: CapClass) -> String {
	let cap = class.lines();
	let head = reduced(cap, cap / 3);
	let tail = cap - head;
	head_tail_lines(input, head, tail)
}

/// Drop lines matching any of the supplied predicates.
pub fn strip_lines(input: &str, predicates: &[fn(&str) -> bool]) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if predicates.iter().any(|predicate| predicate(line)) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Group `file:line:message` style diagnostics by file.
#[must_use]
pub fn group_by_file(input: &str, max_per_file: usize) -> String {
	let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
	let mut ungrouped = Vec::new();
	for line in input.lines() {
		if let Some((file, rest)) = split_file_line(line) {
			grouped
				.entry(file.to_string())
				.or_default()
				.push(rest.to_string());
		} else {
			ungrouped.push(line.to_string());
		}
	}
	if grouped.is_empty() {
		return input.to_string();
	}
	let mut out = String::new();
	for (file, entries) in grouped {
		out.push_str(&file);
		out.push_str(":\n");
		for entry in entries.iter().take(max_per_file) {
			out.push_str("  ");
			out.push_str(entry);
			out.push('\n');
		}
		if entries.len() > max_per_file {
			out.push_str("  … ");
			out.push_str(&(entries.len() - max_per_file).to_string());
			out.push_str(" more\n");
		}
	}
	for line in ungrouped {
		out.push_str(&line);
		out.push('\n');
	}
	out
}

fn split_file_line(line: &str) -> Option<(&str, &str)> {
	let (file, rest) = line.split_once(':')?;
	if file.is_empty()
		|| file.starts_with(' ')
		|| !rest.chars().next().is_some_and(|c| c.is_ascii_digit())
	{
		return None;
	}
	Some((file, rest))
}

#[must_use]
pub fn command_has_ordered_tokens(command: &str, first: &str, second: &str) -> bool {
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

#[must_use]
pub fn command_has_any_token(command: &str, tokens: &[&str]) -> bool {
	command.split_whitespace().any(|part| {
		tokens.iter().any(|token| {
			part == *token
				|| part
					.strip_prefix(*token)
					.is_some_and(|suffix| suffix.starts_with('='))
		})
	})
}

/// Dedup consecutive lines then apply a 120-head / 80-tail cap.
#[must_use]
pub fn head_tail_dedup(input: &str) -> String {
	head_tail_lines(&dedup_consecutive_lines(input), 120, 80)
}

#[must_use]
pub fn is_markdown_badge_or_image(line: &str) -> bool {
	line.starts_with("![") || line.starts_with("[![") || line.contains("img.shields.io")
}

#[must_use]
pub fn is_horizontal_rule(line: &str) -> bool {
	line.len() >= 3
		&& line.chars().all(|ch| matches!(ch, '-' | '*' | '_' | ' '))
		&& line.chars().any(|ch| matches!(ch, '-' | '*' | '_'))
}

/// Compact a long plain listing to head/tail form.
#[must_use]
pub fn compact_listing(input: &str, max_lines: usize) -> String {
	let lines: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.collect();
	if lines.len() <= max_lines {
		return input.to_string();
	}
	let mut out = String::new();
	out.push_str(&lines.len().to_string());
	out.push_str(" entries\n");
	for line in lines.iter().take(max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("…\n");
	for line in lines.iter().skip(lines.len() - max_lines / 2) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Truncate a single line to at most `max_chars` characters (Unicode scalars,
/// not bytes).
///
/// When truncation happens, appends a `…[+N]` marker where `N` is the number
/// of dropped Unicode scalars. The bracketed tally lets agents and humans
/// distinguish minimizer truncation from genuine `…` in the source data
/// (see issue #1046), and gives a concrete count so the agent can decide
/// whether the missing tail is recoverable inline or needs the
/// `artifact://<id>` footer surfaced by the bash wrapper.
///
/// `max_chars == 0` is treated as "drop the line"; no marker is emitted in
/// that case since the caller asked for an empty result.
#[must_use]
pub fn truncate_line(line: &str, max_chars: usize) -> String {
	if max_chars == 0 {
		return String::new();
	}
	let mut chars = line.chars();
	let mut out = String::new();
	for _ in 0..max_chars {
		match chars.next() {
			Some(ch) => out.push(ch),
			None => return out,
		}
	}
	let dropped = chars.count();
	if dropped > 0 {
		use std::fmt::Write as _;
		// 5–6 bytes typical; this avoids pulling `itoa` for a marker tally.
		let _ = write!(out, "…[+{dropped}]");
	}
	out
}

/// Keep only the first `head` lines; append a summary marker when truncated.
#[must_use]
pub fn head_lines_only(input: &str, head: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= head {
		return input.to_string();
	}
	let omitted = lines.len() - head;
	let mut out = String::new();
	for line in lines.iter().take(head) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("[…");
	out.push_str(&omitted.to_string());
	out.push_str("ln elided…]\n");
	out
}

/// Keep only the last `tail` lines; prepend a summary marker when truncated.
#[must_use]
pub fn tail_lines_only(input: &str, tail: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= tail {
		return input.to_string();
	}
	let omitted = lines.len() - tail;
	let mut out = String::new();
	out.push_str("[…");
	out.push_str(&omitted.to_string());
	out.push_str("ln elided…]\n");
	for line in lines.iter().skip(omitted) {
		out.push_str(line);
		out.push('\n');
	}
	out
}

/// Hard cap: keep at most `max` lines, append a truncation marker otherwise.
#[must_use]
pub fn max_lines(input: &str, max: usize) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= max {
		return input.to_string();
	}
	let dropped = lines.len() - max;
	let mut out = String::new();
	for line in lines.iter().take(max) {
		out.push_str(line);
		out.push('\n');
	}
	out.push_str("[…");
	out.push_str(&dropped.to_string());
	out.push_str("ln elided…]\n");
	out
}

/// Line filter combining an optional keep set and an optional strip set.
///
/// A line survives iff it matches the keep set (when present) AND does not
/// match the strip set (when present) — i.e. keep is `K AND NOT S`. An
/// absent set imposes no constraint, so pure strip and pure keep filtering
/// are the degenerate single-set cases.
#[must_use]
pub fn filter_lines_regex(
	input: &str,
	strip: Option<&regex::RegexSet>,
	keep: Option<&regex::RegexSet>,
) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if keep.is_none_or(|set| set.is_match(line)) && !strip.is_some_and(|set| set.is_match(line)) {
			out.push_str(line);
			out.push('\n');
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn strips_ansi_sequences() {
		assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
	}

	#[test]
	fn strip_ansi_preserves_carriage_returns() {
		assert_eq!(strip_ansi("a\r\nb\rc"), "a\r\nb\rc");
	}

	#[test]
	fn dedups_consecutive_lines() {
		assert_eq!(dedup_consecutive_lines("a\na\nb\n"), "a (×2)\nb\n");
	}

	#[test]
	fn head_tail_marks_omitted_lines() {
		let out = head_tail_lines("1\n2\n3\n4\n5\n", 2, 1);
		assert_eq!(out, "1\n2\n[…2ln elided…]\n5\n");
	}

	#[test]
	fn named_caps_have_nonzero_reductions() {
		assert_eq!(CapClass::Errors.lines(), 160);
		assert_eq!(reduced(1, 10), 1);
		assert_eq!(reduced(0, 10), 0);
	}

	#[test]
	fn head_tail_cap_uses_named_budget() {
		let input = (0..100)
			.map(|idx| idx.to_string())
			.collect::<Vec<_>>()
			.join("\n");
		let out = head_tail_cap(&input, CapClass::List);
		assert!(out.contains("ln elided…]"));
		assert!(out.lines().count() <= CapClass::List.lines() + 1);
	}

	#[test]
	fn groups_file_diagnostics() {
		let out = group_by_file("src/a.ts:1:2 error one\nsrc/a.ts:2:3 error two\n", 10);
		assert_eq!(out, "src/a.ts:\n  1:2 error one\n  2:3 error two\n");
	}

	#[test]
	fn truncate_line_short_passes_through() {
		assert_eq!(truncate_line("hi", 10), "hi");
	}

	#[test]
	fn truncate_line_at_exact_length_emits_no_marker() {
		assert_eq!(truncate_line("abcde", 5), "abcde");
	}

	#[test]
	fn truncate_line_appends_dropped_char_tally() {
		// "abcdefghij" (10 chars) capped at 4 drops 6 chars.
		assert_eq!(truncate_line("abcdefghij", 4), "abcd\u{2026}[+6]");
	}

	#[test]
	fn truncate_line_counts_unicode_scalars_not_bytes() {
		// "aaaα" is 4 scalars, 5 bytes. Cap at 2 drops 2 scalars.
		assert_eq!(truncate_line("aaaα", 2), "aa\u{2026}[+2]");
	}

	#[test]
	fn truncate_line_max_zero_yields_empty() {
		assert_eq!(truncate_line("anything", 0), "");
	}

	#[test]
	fn filter_lines_regex_combines_keep_and_strip() {
		let strip = regex::RegexSet::new(["noise"]).unwrap();
		let keep = regex::RegexSet::new(["^task"]).unwrap();
		let input = "task ok\ntask noise\nnoise only\nunrelated\n";

		// Combined: survives iff matches keep AND NOT strip.
		assert_eq!(filter_lines_regex(input, Some(&strip), Some(&keep)), "task ok\n");
		// Strip only: absent keep set imposes no constraint.
		assert_eq!(filter_lines_regex(input, Some(&strip), None), "task ok\nunrelated\n");
		// Keep only: absent strip set imposes no constraint.
		assert_eq!(filter_lines_regex(input, None, Some(&keep)), "task ok\ntask noise\n");
		// Neither: identity modulo trailing-newline normalization.
		assert_eq!(filter_lines_regex(input, None, None), input);
	}

	#[test]
	fn test_command_has_ordered_tokens_basic() {
		assert!(command_has_ordered_tokens("glab mr diff 42", "mr", "diff"));
		assert!(
			!command_has_ordered_tokens("glab diff mr 42", "mr", "diff"),
			"wrong order must be false"
		);
		assert!(
			!command_has_ordered_tokens("glab mr", "mr", "diff"),
			"missing second token must be false"
		);
	}

	#[test]
	fn test_command_has_ordered_tokens_first_equals_second() {
		// edge case: first == second — both must appear in order
		assert!(command_has_ordered_tokens("git push push", "push", "push"));
		assert!(
			!command_has_ordered_tokens("git push", "push", "push"),
			"only one occurrence — must be false"
		);
	}

	#[test]
	fn test_command_has_any_token_equals_form() {
		// Exact token match and non-match.
		assert!(command_has_any_token("eslint --format json src", &["json"]));
		assert!(!command_has_any_token("eslint --format json src", &["xml"]));
		// Equals-form: --flag=value matches when the search token is the flag prefix.
		assert!(command_has_any_token("eslint --format=json src", &["--format"]));
		// Value-only search does NOT match an equals-form part (token is prefix, not
		// suffix).
		assert!(
			!command_has_any_token("eslint --format=json src", &["json"]),
			"value after = must not match when token is not the flag prefix"
		);
		// Substring of a standalone word must not match.
		assert!(
			!command_has_any_token("eslint --format foobar src", &["bar"]),
			"substring of a token must not match"
		);
	}

	#[test]
	fn test_horizontal_rule_requires_non_space() {
		assert!(is_horizontal_rule("---"));
		assert!(is_horizontal_rule("- - -"));
		assert!(is_horizontal_rule("***"));
		assert!(!is_horizontal_rule("   "), "whitespace-only must not be a rule");
		assert!(!is_horizontal_rule("  "), "short whitespace must not be a rule");
	}
}
