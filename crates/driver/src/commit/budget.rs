use std::borrow::Cow;

const MAX_DIFF_TOKENS: usize = 25_000;
const MAX_DIFF_BYTES: usize = MAX_DIFF_TOKENS * 4;
const MAX_FILE_BYTES: usize = 40_000;
const LONG_LINE_BYTES: usize = 512;

struct Section<'a> {
	text:     &'a str,
	priority: u8,
}

pub(super) fn budget_diff(diff: &str) -> Cow<'_, str> {
	if diff.len() <= MAX_DIFF_BYTES && !diff.lines().any(|line| line.len() > LONG_LINE_BYTES) {
		return Cow::Borrowed(diff);
	}
	let mut sections = split_sections(diff);
	sections.sort_by_key(|section| std::cmp::Reverse(section.priority));
	let mut output = String::with_capacity(MAX_DIFF_BYTES);
	let mut omitted = 0_usize;
	for section in sections {
		let remaining = MAX_DIFF_BYTES.saturating_sub(output.len());
		if remaining < 256 {
			omitted = omitted.saturating_add(1);
			continue;
		}
		let allowance = remaining.min(MAX_FILE_BYTES);
		let rendered = collapse_long_lines(section.text, allowance);
		if rendered.len() > remaining {
			omitted = omitted.saturating_add(1);
			continue;
		}
		if !output.is_empty() {
			output.push('\n');
		}
		output.push_str(&rendered);
	}
	if omitted > 0 {
		let notice = format!("\n\n... ({omitted} lower-priority files omitted) ...");
		if output.len().saturating_add(notice.len()) <= MAX_DIFF_BYTES {
			output.push_str(&notice);
		}
	}
	Cow::Owned(output)
}

fn split_sections(diff: &str) -> Vec<Section<'_>> {
	let mut starts = Vec::new();
	for (offset, _) in diff.match_indices("diff --git ") {
		if offset == 0 || diff.as_bytes().get(offset.wrapping_sub(1)) == Some(&b'\n') {
			starts.push(offset);
		}
	}
	if starts.is_empty() {
		return vec![Section { text: diff, priority: 50 }];
	}
	let mut sections = Vec::with_capacity(starts.len());
	for (index, start) in starts.iter().copied().enumerate() {
		let end = starts.get(index + 1).copied().unwrap_or(diff.len());
		let text = &diff[start..end];
		let path = text
			.lines()
			.next()
			.and_then(|line| line.split_whitespace().nth(3))
			.unwrap_or("")
			.trim_start_matches("b/");
		sections.push(Section { text, priority: file_priority(path, text) });
	}
	sections
}

fn file_priority(path: &str, section: &str) -> u8 {
	let lower = path.to_ascii_lowercase();
	if section
		.lines()
		.any(|line| line.starts_with("Binary files "))
	{
		return 0;
	}
	if lower.ends_with("cargo.toml")
		|| lower.ends_with("package.json")
		|| lower.ends_with("go.mod")
		|| lower.ends_with("pyproject.toml")
	{
		return 80;
	}
	if lower.contains("/test") || lower.contains("_test.") || lower.contains(".test.") {
		return 20;
	}
	match lower.rsplit_once('.').map(|(_, extension)| extension) {
		Some(
			"rs" | "go" | "py" | "js" | "ts" | "tsx" | "jsx" | "java" | "c" | "cpp" | "h" | "hpp",
		) => 100,
		Some("sql" | "sh" | "bash") => 90,
		Some("lock" | "snap" | "sum" | "md" | "txt" | "log" | "json" | "yaml" | "yml" | "toml") => 30,
		_ => 50,
	}
}

fn collapse_long_lines(text: &str, allowance: usize) -> String {
	let mut output = String::with_capacity(text.len().min(allowance));
	for line in text.lines() {
		if !output.is_empty() {
			output.push('\n');
		}
		let remaining = allowance.saturating_sub(output.len());
		if remaining < 64 {
			output.push_str("... (file truncated)");
			break;
		}
		if line.len() <= LONG_LINE_BYTES {
			push_bounded(&mut output, line, remaining);
			continue;
		}
		let head_end = floor_char_boundary(line, 120.min(line.len()));
		let tail_start = ceil_char_boundary(line, line.len().saturating_sub(24));
		let omitted = tail_start.saturating_sub(head_end);
		let collapsed =
			format!("{}[..omitted {omitted}B..]{}", &line[..head_end], &line[tail_start..]);
		push_bounded(&mut output, &collapsed, remaining);
	}
	output
}

fn push_bounded(output: &mut String, text: &str, remaining: usize) {
	if text.len() <= remaining {
		output.push_str(text);
		return;
	}
	let marker = "... (truncated)";
	let available = remaining.saturating_sub(marker.len());
	let end = floor_char_boundary(text, available);
	output.push_str(&text[..end]);
	output.push_str(marker);
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
	index = index.min(text.len());
	while index > 0 && !text.is_char_boundary(index) {
		index -= 1;
	}
	index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
	index = index.min(text.len());
	while index < text.len() && !text.is_char_boundary(index) {
		index += 1;
	}
	index
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn collapses_blob_lines_within_the_global_budget() {
		let diff = format!(
			"diff --git a/blob.ts b/blob.ts\n@@ -1 +1 @@\n-{}\n+{}",
			"a".repeat(700),
			"b".repeat(700)
		);
		let scrubbed = budget_diff(&diff);
		assert!(scrubbed.contains("[..omitted 557B..]"));
		assert!(scrubbed.len() < 1_000);
	}
}
