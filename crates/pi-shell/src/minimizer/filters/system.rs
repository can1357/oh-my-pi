//! Conservative text filters for system-style commands.

use std::{collections::HashMap, fmt::Write as _};

use super::git;
use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str) -> bool {
	matches!(
		program,
		"env"
			| "log"
			| "deps"
			| "summary"
			| "err"
			| "test"
			| "diff"
			| "format"
			| "pipe"
			| "ps" | "ping"
			| "ssh"
			| "sops"
	)
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let command = ctx.program;
	let text = match command {
		"env" => {
			if ctx
				.command
				.split_whitespace()
				.any(|t| t == "-0" || t == "--null")
			{
				cleaned
			} else {
				compact_env(&cleaned)
			}
		},
		"log" => compact_log(&cleaned),
		"deps" => compact_dependency_output(&cleaned),
		"summary" => compact_summary_output(&cleaned, exit_code),
		"err" => compact_err_output(&cleaned),
		"test" => compact_test_output(&cleaned),
		"diff" => git::compact_diff_output(&cleaned),
		"format" => compact_format_output(&cleaned),
		"pipe" => compact_pipe_like_output(&cleaned, exit_code),
		"ps" => compact_ps_output(&cleaned),
		"ping" => compact_ping_output(&cleaned),
		"ssh" => compact_ssh_output(&cleaned),
		"sops" => compact_sops_output(&cleaned),
		_ => cleaned,
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn compact_env(input: &str) -> String {
	let mut out = String::new();
	let mut transformed = false;
	let mut lines = 0usize;

	for line in input.lines() {
		lines += 1;
		let rendered_line = if let Some((prefix, key, value)) = split_env_assignment(line) {
			let rendered = render_env_value(key, value);
			if rendered != value {
				transformed = true;
			}
			let mut line = String::new();
			line.push_str(prefix);
			line.push_str(key);
			line.push('=');
			line.push_str(&rendered);
			line
		} else {
			line.to_string()
		};
		out.push_str(&rendered_line);
		out.push('\n');
	}

	if lines > 80 {
		let compacted = primitives::head_tail_lines(&out, 40, 25);
		let mut with_header = format!("env output: {lines} lines\n");
		with_header.push_str(&compacted);
		return with_header;
	}

	if transformed { out } else { input.to_string() }
}

fn split_env_assignment(line: &str) -> Option<(&str, &str, &str)> {
	let trimmed = line.trim_start();
	let prefix = &line[..line.len().saturating_sub(trimmed.len())];
	let rest = trimmed
		.strip_prefix("export ")
		.map_or(trimmed, |value| value);
	let export_prefix = if rest.len() == trimmed.len() {
		""
	} else {
		"export "
	};
	let (key, value) = rest.split_once('=')?;
	if key.is_empty()
		|| !key
			.chars()
			.all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
	{
		return None;
	}
	Some((
		if export_prefix.is_empty() {
			prefix
		} else {
			"export "
		},
		key,
		value,
	))
}

fn render_env_value(key: &str, value: &str) -> String {
	if is_sensitive_key(key) {
		return mask_env_value(value);
	}
	let char_count = value.chars().count();
	if char_count > 160 {
		let preview: String = value.chars().take(80).collect();
		format!("{preview}… ({char_count} chars)")
	} else {
		value.to_string()
	}
}

fn is_sensitive_key(key: &str) -> bool {
	let lower = key.to_ascii_lowercase();
	[
		"token",
		"secret",
		"password",
		"passwd",
		"credential",
		"apikey",
		"api_key",
		"access_key",
		"private_key",
		"jwt",
		"auth",
	]
	.iter()
	.any(|needle| lower.contains(needle))
}

fn mask_env_value(value: &str) -> String {
	let chars: Vec<char> = value.chars().collect();
	if chars.len() <= 4 {
		"[redacted]".to_string()
	} else {
		let prefix: String = chars.iter().take(2).collect();
		let suffix_start = chars.len().saturating_sub(2);
		let suffix: String = chars.iter().skip(suffix_start).collect();
		format!("{prefix}[redacted]{suffix}")
	}
}

fn compact_log(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.is_empty() {
		return input.to_string();
	}

	let mut unique: Vec<LogLine> = Vec::new();
	let mut by_normalized: HashMap<String, usize> = HashMap::new();
	let mut errors = 0usize;
	let mut warnings = 0usize;
	let mut info = 0usize;

	for line in &lines {
		let lower = line.to_ascii_lowercase();
		if lower.contains("error") || lower.contains("fatal") || lower.contains("panic") {
			errors += 1;
		} else if lower.contains("warn") {
			warnings += 1;
		} else if lower.contains("info") {
			info += 1;
		}

		let normalized = normalize_log_line(line);
		if let Some(index) = by_normalized.get(&normalized).copied() {
			if let Some(entry) = unique.get_mut(index) {
				entry.count += 1;
			}
		} else {
			by_normalized.insert(normalized, unique.len());
			unique.push(LogLine { original: (*line).to_string(), count: 1 });
		}
	}

	if unique.len() == lines.len() && lines.len() <= 80 {
		return primitives::dedup_consecutive_lines(input);
	}

	let mut out = format!(
		"log summary: {} lines, {} unique, {} errors, {} warnings, {} info\n",
		lines.len(),
		unique.len(),
		errors,
		warnings,
		info
	);
	let rendered = render_counted_lines(&unique, 60, 20);
	out.push_str(&rendered);
	out
}

struct LogLine {
	original: String,
	count:    usize,
}

pub(super) fn normalize_log_line(line: &str) -> String {
	let without_timestamp = strip_leading_timestamp(line.trim());
	let mut out = String::new();
	for token in without_timestamp.split_whitespace() {
		if !out.is_empty() {
			out.push(' ');
		}
		push_normalized_token(&mut out, token);
	}
	out
}

fn strip_leading_timestamp(line: &str) -> &str {
	let bytes = line.as_bytes();
	if bytes.len() >= 19
		&& bytes.get(4) == Some(&b'-')
		&& bytes.get(7) == Some(&b'-')
		&& matches!(bytes.get(10).copied(), Some(b'T' | b' '))
	{
		if let Some(rest) = line.get(19..) {
			return rest.trim_start();
		}
		return "";
	}
	line
}

fn push_normalized_token(out: &mut String, token: &str) {
	let core = token.trim_matches(|ch: char| ch.is_ascii_punctuation() && ch != '/' && ch != '.');
	if is_uuid_like(core) {
		out.push_str("<uuid>");
		return;
	}
	if is_hex_like(core) {
		out.push_str("<hex>");
		return;
	}
	if is_path_like(core) {
		out.push_str("<path>");
		return;
	}

	let mut digits = String::new();
	for ch in token.chars() {
		if ch.is_ascii_digit() {
			digits.push(ch);
			continue;
		}
		flush_digits(out, &mut digits);
		out.push(ch);
	}
	flush_digits(out, &mut digits);
}

fn is_uuid_like(token: &str) -> bool {
	token.len() == 36
		&& token.bytes().enumerate().all(|(idx, byte)| {
			if matches!(idx, 8 | 13 | 18 | 23) {
				byte == b'-'
			} else {
				byte.is_ascii_hexdigit()
			}
		})
}

fn is_hex_like(token: &str) -> bool {
	let token = token.strip_prefix("0x").unwrap_or(token);
	token.len() >= 8 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_path_like(token: &str) -> bool {
	(token.starts_with('/') || token.starts_with("./") || token.starts_with("../"))
		&& token.len() > 1
}

fn flush_digits(out: &mut String, digits: &mut String) {
	if digits.is_empty() {
		return;
	}
	if digits.len() >= 4 {
		out.push_str("<n>");
	} else {
		out.push_str(digits);
	}
	digits.clear();
}

pub(super) fn compact_log_lines(
	input: &str,
	head: usize,
	tail: usize,
	key_fn: impl Fn(&str) -> String,
) -> String {
	let mut unique: Vec<LogLine> = Vec::new();
	let mut by_key: HashMap<String, usize> = HashMap::new();

	for (idx, line) in input.lines().enumerate() {
		let key = if line.trim().is_empty() {
			// Blank lines are section separators; do not globally deduplicate them.
			// drop_repeated_blank_lines already collapsed consecutive blanks.
			format!("<blank-{idx}>")
		} else {
			let key = key_fn(line);
			if key.is_empty() {
				line.to_string()
			} else {
				key
			}
		};
		if let Some(index) = by_key.get(&key).copied() {
			if let Some(entry) = unique.get_mut(index) {
				entry.count += 1;
			}
		} else {
			by_key.insert(key, unique.len());
			unique.push(LogLine { original: line.to_string(), count: 1 });
		}
	}

	render_counted_lines(&unique, head, tail)
}

fn render_counted_lines(lines: &[LogLine], head: usize, tail: usize) -> String {
	let mut out = String::new();
	if lines.len() <= head + tail {
		for line in lines {
			push_counted_line(&mut out, &line.original, line.count);
		}
		return out;
	}
	for line in lines.iter().take(head) {
		push_counted_line(&mut out, &line.original, line.count);
	}
	let _ = writeln!(out, "[…{} unique lines elided…]", lines.len() - head - tail);
	for line in lines.iter().skip(lines.len() - tail) {
		push_counted_line(&mut out, &line.original, line.count);
	}
	out
}

fn push_counted_line(out: &mut String, line: &str, count: usize) {
	out.push_str(line);
	if count > 1 {
		out.push_str(" (×");
		out.push_str(&count.to_string());
		out.push(')');
	}
	out.push('\n');
}

fn compact_dependency_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 80 {
		return input.to_string();
	}
	let mut out = String::from("dependency output summary\n");
	for line in lines
		.iter()
		.copied()
		.filter(|line| is_dependency_heading(line))
	{
		out.push_str(line);
		out.push('\n');
	}
	out.push_str(&primitives::head_tail_lines(input, 35, 25));
	out
}

fn is_dependency_heading(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("dependencies")
		|| lower.contains("packages")
		|| lower.ends_with("package.json:")
		|| lower.ends_with("cargo.toml:")
		|| lower.ends_with("go.mod:")
		|| lower.ends_with("requirements.txt:")
}

fn compact_summary_output(input: &str, exit_code: i32) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 100 {
		return input.to_string();
	}
	let mut out = format!("summary output: {} lines, exit {exit_code}\n", lines.len());
	push_important_lines(&mut out, input, 30);
	out.push_str(&primitives::head_tail_lines(input, 35, 25));
	out
}

fn compact_err_output(input: &str) -> String {
	compact_failure_output(
		input,
		2,
		12,
		is_err_signal_line,
		is_err_summary_line,
		is_err_noise,
		is_err_relevant_line,
	)
}

fn compact_test_output(input: &str) -> String {
	compact_failure_output(
		input,
		1,
		12,
		is_test_signal_line,
		is_test_summary_line,
		is_test_noise,
		is_test_relevant_line,
	)
}

fn compact_failure_output(
	input: &str,
	keep_before: usize,
	keep_after: usize,
	is_signal_line: fn(&str) -> bool,
	is_summary_line: fn(&str) -> bool,
	is_noise_line: fn(&str) -> bool,
	is_relevant_line: fn(&str) -> bool,
) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.is_empty() {
		return input.to_string();
	}

	let mut keep = vec![false; lines.len()];
	let mut saw_relevant = false;

	for (idx, line) in lines.iter().enumerate() {
		let trimmed = line.trim_start();
		if is_relevant_line(trimmed) {
			saw_relevant = true;
		}
		if is_summary_line(trimmed) {
			keep[idx] = true;
			continue;
		}
		if is_signal_line(trimmed) {
			let start = idx.saturating_sub(keep_before);
			let end = idx
				.saturating_add(keep_after)
				.min(lines.len().saturating_sub(1));
			for slot in keep.iter_mut().take(end + 1).skip(start) {
				*slot = true;
			}
		}
	}

	if !saw_relevant {
		return input.to_string();
	}

	let mut out = String::new();
	for (idx, line) in lines.iter().enumerate() {
		if !keep[idx] {
			continue;
		}
		let trimmed = line.trim_start();
		if is_noise_line(trimmed) {
			continue;
		}
		out.push_str(line);
		out.push('\n');
	}

	primitives::dedup_consecutive_lines(&out)
}

fn is_err_signal_line(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	lower.starts_with("error:")
		|| lower.starts_with("fatal:")
		|| lower.starts_with("failed:")
		|| lower.starts_with("panic:")
		|| lower.starts_with("exception:")
		|| lower.starts_with("traceback ")
		|| lower.starts_with("assertionerror")
		|| lower.starts_with("timeouterror")
		|| lower.starts_with("caused by:")
		|| lower.starts_with("warning:")
		|| lower.starts_with("warn:")
		|| lower.contains(": error:")
		|| lower.contains(": warning:")
		|| lower.contains(" fatal error")
		|| lower.contains(" failed")
		|| lower.contains(" panic")
		|| lower.contains(" exception")
}

fn is_err_summary_line(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	lower.starts_with("build failed")
		|| lower.starts_with("failures!")
		|| lower.starts_with("failed")
		|| lower.starts_with("errors:")
		|| lower.starts_with("warnings:")
		|| lower.starts_with("play recap")
		|| lower.starts_with("summary")
		|| lower.starts_with("test result")
		|| lower.starts_with("test files")
		|| lower.starts_with("tests:")
		|| is_count_summary(trimmed)
}

fn is_err_noise(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	lower.starts_with("compiling ")
		|| lower.starts_with("building ")
		|| lower.starts_with("checking ")
		|| lower.starts_with("running ")
		|| lower.starts_with("executing ")
		|| lower.starts_with("fetching ")
		|| lower.starts_with("resolving ")
		|| lower.starts_with("downloading ")
		|| lower.starts_with("installing ")
		|| lower.starts_with("finished ")
		|| lower.starts_with("done ")
		|| lower.starts_with("pass ")
		|| lower.starts_with("✓")
		|| lower.starts_with("✔")
		|| lower.starts_with("√")
		|| lower.starts_with("○")
		|| lower.starts_with("ok ")
		|| lower.contains(" ... ok")
}

fn is_test_signal_line(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	trimmed.starts_with("FAIL ")
		|| trimmed.starts_with("FAILURES")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("● ")
		|| trimmed.starts_with("✕")
		|| trimmed.starts_with("×")
		|| trimmed.starts_with("✗")
		|| trimmed.starts_with("❯")
		|| lower.starts_with("error:")
		|| lower.starts_with("assertionerror")
		|| lower.starts_with("timeouterror")
		|| lower.starts_with("panic:")
		|| lower.starts_with("failed ")
}

fn is_test_summary_line(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	trimmed.starts_with("Test Suites:")
		|| trimmed.starts_with("Test Suites")
		|| trimmed.starts_with("Tests:")
		|| trimmed.starts_with("Tests")
		|| trimmed.starts_with("Test Files")
		|| trimmed.starts_with("Snapshots:")
		|| trimmed.starts_with("Snapshots")
		|| trimmed.starts_with("Time:")
		|| trimmed.starts_with("Duration")
		|| trimmed.starts_with("Start at")
		|| trimmed.starts_with("Ran all test suites")
		|| trimmed.starts_with("Ran ")
		|| trimmed.starts_with("Failed Tests")
		|| trimmed.starts_with("FAILURES")
		|| trimmed.starts_with("Summary")
		|| lower.starts_with("build failed")
		|| lower.starts_with("test run failed")
		|| lower.starts_with("test result")
		|| is_count_summary(trimmed)
}

fn is_test_noise(trimmed: &str) -> bool {
	let lower = trimmed.to_ascii_lowercase();
	lower.starts_with("pass ")
		|| trimmed.starts_with("✓")
		|| trimmed.starts_with("✔")
		|| trimmed.starts_with("√")
		|| trimmed.starts_with("○")
		|| lower.starts_with("running ")
		|| lower.starts_with("run ")
		|| lower.starts_with("dev ")
		|| lower.starts_with("ok ")
		|| lower.contains(" ... ok")
}

fn is_err_relevant_line(trimmed: &str) -> bool {
	is_err_signal_line(trimmed) || is_err_summary_line(trimmed)
}

fn is_test_relevant_line(trimmed: &str) -> bool {
	is_test_signal_line(trimmed) || is_test_summary_line(trimmed) || is_test_noise(trimmed)
}

fn is_count_summary(trimmed: &str) -> bool {
	let mut parts = trimmed.split_whitespace();
	let Some(count) = parts.next() else {
		return false;
	};
	if !count.chars().all(|ch| ch.is_ascii_digit()) {
		return false;
	}

	let Some(kind) = parts
		.next()
		.map(|word| word.trim_matches(|ch: char| ch.is_ascii_punctuation()))
	else {
		return false;
	};
	if matches!(
		kind,
		"failed"
			| "passed"
			| "skipped"
			| "flaky"
			| "pass"
			| "fail"
			| "error"
			| "errors"
			| "warning"
			| "warnings"
			| "information"
			| "informations"
	) {
		return true;
	}

	if kind == "of" {
		let Some(total) = parts.next() else {
			return false;
		};
		if !total.chars().all(|ch| ch.is_ascii_digit()) {
			return false;
		}
		return parts
			.next()
			.map(|word| word.trim_matches(|ch: char| ch.is_ascii_punctuation()))
			.is_some_and(|kind| {
				matches!(
					kind,
					"failed"
						| "passed" | "skipped"
						| "flaky" | "pass"
						| "fail" | "error"
						| "errors" | "warning"
						| "warnings" | "information"
						| "informations"
				)
			});
	}

	false
}

fn push_important_lines(out: &mut String, input: &str, max: usize) {
	let mut pushed = 0usize;
	for line in input.lines() {
		if pushed >= max {
			break;
		}
		if is_important_line(line) && !out.lines().any(|existing| existing == line) {
			out.push_str(line);
			out.push('\n');
			pushed += 1;
		}
	}
}

fn is_important_line(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("failure")
		|| lower.contains("fatal")
		|| lower.contains("panic")
		|| lower.contains("warning")
		|| lower.contains("warn")
		|| lower.contains("passed")
		|| lower.contains("summary")
}

fn compact_format_output(input: &str) -> String {
	let lines: Vec<&str> = input.lines().collect();
	if lines.len() <= 80 {
		return input.to_string();
	}

	let mut errors = Vec::new();
	let mut files = Vec::new();
	let mut summary = Vec::new();
	for line in &lines {
		let lower = line.to_ascii_lowercase();
		if lower.contains("error") || lower.contains("failed") || lower.contains("oh no") {
			errors.push(*line);
		} else if is_format_file_line(line) {
			files.push(*line);
		} else if lower.contains("formatted")
			|| lower.contains("reformatted")
			|| lower.contains("unchanged")
			|| lower.contains("checked")
		{
			summary.push(*line);
		}
	}

	let mut out = format!("format output: {} lines\n", lines.len());
	if !errors.is_empty() {
		out.push_str("errors:\n");
		for line in errors.iter().take(40) {
			out.push_str(line);
			out.push('\n');
		}
	}
	if !summary.is_empty() {
		out.push_str("summary:\n");
		for line in summary.iter().take(20) {
			out.push_str(line);
			out.push('\n');
		}
	}
	if !files.is_empty() {
		out.push_str("files:\n");
		for line in files.iter().take(50) {
			out.push_str(line);
			out.push('\n');
		}
		if files.len() > 50 {
			let _ = writeln!(out, "[…{} files elided…]", files.len() - 50);
		}
	}
	if errors.is_empty() && summary.is_empty() && files.is_empty() {
		out.push_str(&primitives::head_tail_lines(input, 40, 30));
	}
	out
}

fn is_format_file_line(line: &str) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();
	let source_extensions = ["rs", "py", "js", "jsx", "ts", "tsx", "json", "css", "md"];
	let has_source_extension = std::path::Path::new(trimmed)
		.extension()
		.and_then(|ext| ext.to_str())
		.is_some_and(|ext| {
			source_extensions
				.iter()
				.any(|candidate| ext.eq_ignore_ascii_case(candidate))
		});
	has_source_extension || lower.contains("would reformat") || lower.contains("reformatted")
}

fn compact_pipe_like_output(input: &str, exit_code: i32) -> String {
	if looks_like_diff(input) || looks_jsonish(input) || exit_code != 0 {
		return input.to_string();
	}
	if looks_like_file_diagnostics(input) {
		return primitives::group_by_file(input, 12);
	}
	if looks_like_path_listing(input) {
		return primitives::compact_listing(input, 80);
	}
	if input.lines().any(is_important_line) {
		return input.to_string();
	}
	let deduped = primitives::dedup_consecutive_lines(input);
	if deduped.lines().count() > 120 {
		primitives::head_tail_lines(&deduped, 60, 40)
	} else {
		deduped
	}
}

fn looks_like_diff(input: &str) -> bool {
	input
		.lines()
		.take(20)
		.any(|line| line.starts_with("@@") || line.starts_with("diff --git "))
}

fn looks_jsonish(input: &str) -> bool {
	input.lines().find_map(|line| {
		let trimmed = line.trim_start();
		if trimmed.is_empty() {
			None
		} else {
			Some(trimmed.starts_with('{') || trimmed.starts_with('['))
		}
	}) == Some(true)
}

fn looks_like_file_diagnostics(input: &str) -> bool {
	input.lines().take(10).any(|line| {
		let mut parts = line.splitn(3, ':');
		let file = parts.next();
		let line_no = parts.next();
		file.is_some_and(|value| !value.is_empty())
			&& line_no.is_some_and(|value| value.parse::<usize>().is_ok())
			&& parts.next().is_some()
	})
}

fn looks_like_path_listing(input: &str) -> bool {
	let non_empty: Vec<&str> = input
		.lines()
		.filter(|line| !line.trim().is_empty())
		.take(20)
		.collect();
	!non_empty.is_empty()
		&& non_empty.iter().all(|line| {
			let trimmed = line.trim();
			!trimmed.contains(':')
				&& (trimmed.starts_with('.') || trimmed.starts_with('/') || trimmed.contains('/'))
		})
}

fn compact_ps_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		out.push_str(&truncate_chars(line, 120));
		out.push('\n');
	}
	if out.lines().count() > 30 {
		primitives::head_tail_lines(&out, 15, 15)
	} else {
		out
	}
}

fn truncate_chars(line: &str, max: usize) -> String {
	if line.chars().count() <= max {
		return line.to_string();
	}
	let mut out: String = line.chars().take(max.saturating_sub(1)).collect();
	out.push('…');
	out
}

fn compact_ping_output(input: &str) -> String {
	let mut kept = String::new();
	for line in input.lines() {
		if is_ping_noise(line) {
			continue;
		}
		if line.trim().is_empty() && kept.is_empty() {
			continue;
		}
		kept.push_str(line);
		kept.push('\n');
	}
	if kept.is_empty() {
		input.to_string()
	} else {
		kept
	}
}

fn is_ping_noise(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.starts_with("PING ")
		|| trimmed.starts_with("Pinging ")
		|| (trimmed.contains(" bytes from ") && trimmed.contains("icmp_seq"))
		|| trimmed.starts_with("Reply from ")
}

fn compact_ssh_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if is_ssh_noise(line) {
			continue;
		}
		out.push_str(&truncate_chars(line, 120));
		out.push('\n');
	}
	if out.lines().count() > 200 {
		primitives::head_tail_lines(&out, 100, 80)
	} else if out.is_empty() {
		input.to_string()
	} else {
		out
	}
}

fn is_ssh_noise(line: &str) -> bool {
	let trimmed = line.trim();
	trimmed.is_empty()
		|| trimmed.starts_with("Warning: Permanently added")
		|| trimmed.starts_with("Connection to ") && trimmed.ends_with(" closed.")
		|| trimmed.starts_with("Authenticated to ")
		|| trimmed.starts_with("debug1:")
		|| trimmed.starts_with("OpenSSH_")
		|| trimmed.starts_with("Pseudo-terminal")
}

fn compact_sops_output(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		if !line.trim().is_empty() {
			out.push_str(line);
			out.push('\n');
		}
	}
	if out.lines().count() > 40 {
		primitives::head_tail_lines(&out, 20, 20)
	} else if out.is_empty() && !input.is_empty() {
		input.to_string()
	} else {
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, cfg: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command: program, config: cfg }
	}

	#[test]
	fn log_dedups_repeated_normalized_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("log", &cfg);
		let input = "2026-01-01 10:00:00 ERROR worker 12345 failed\n2026-01-01 10:00:01 ERROR \
		             worker 67890 failed\nINFO ready\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("3 lines, 2 unique"));
		assert!(out.text.contains("(×2)"));
	}

	#[test]
	fn log_dedups_normalized_uuid_hex_and_paths() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("log", &cfg);
		let input = "2026-01-01T10:00:00 ERROR request 550e8400-e29b-41d4-a716-446655440000 file \
		             /tmp/a.rs hash deadbeef failed\n2026-01-01T10:00:01 ERROR request \
		             123e4567-e89b-12d3-a456-426614174000 file /tmp/b.rs hash cafebabe failed\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("2 lines, 1 unique"));
		assert!(out.text.contains("(×2)"));
	}

	#[test]
	fn env_masks_secrets_and_compacts_long_values() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("env", &cfg);
		let input = format!("API_TOKEN=supersecrettoken\nPATH={}\n", "a".repeat(170));
		let out = filter(&ctx, &input, 0);
		assert!(out.text.contains("API_TOKEN=su[redacted]en"));
		assert!(out.text.contains("(170 chars)"));
		assert!(!out.text.contains("supersecrettoken"));
	}

	#[test]
	fn err_output_keeps_diagnostics_and_context() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("err", &cfg);
		let input = "\
Compiling app v0.1.0
running 1 test
test pass ... ok
src/main.rs:10:5: error: cannot find value `foo` in this scope
   |
10 |     foo();
   |     ^^^
note: required by a bound in `bar`
warning: unused import: `baz`
";
		let out = filter(&ctx, input, 1);
		assert!(out.changed);
		assert!(!out.text.contains("Compiling app v0.1.0"));
		assert!(!out.text.contains("running 1 test"));
		assert!(!out.text.contains("test pass ... ok"));
		assert!(
			out.text
				.contains("src/main.rs:10:5: error: cannot find value `foo` in this scope")
		);
		assert!(out.text.contains("10 |     foo();"));
		assert!(out.text.contains("note: required by a bound in `bar`"));
		assert!(out.text.contains("warning: unused import: `baz`"));
	}

	#[test]
	fn diff_output_reuses_unified_diff_compaction() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("diff", &cfg);
		let mut input = String::from("--- a/a.rs\n+++ b/a.rs\n@@ -1,140 +1,140 @@\n");
		for idx in 0..140 {
			input.push_str("-old ");
			input.push_str(&idx.to_string());
			input.push_str("\n+new ");
			input.push_str(&idx.to_string());
			input.push('\n');
		}
		let out = filter(&ctx, &input, 0);
		assert!(out.changed);
		assert!(out.text.contains("a.rs | 280"));
		assert!(
			out.text
				.contains("1 file changed, 140 insertions(+), 140 deletions(-)")
		);
		assert!(out.text.contains("--- Changes ---"));
		assert!(out.text.contains("-old 0"));
		assert!(out.text.contains("+new 0"));
		assert_ne!(out.text, input);
	}

	#[test]
	fn test_output_drops_pass_chatter_and_keeps_failure_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("test", &cfg);
		let input = "\
PASS src/pass.test.ts
✓ src/ok.test.ts (3ms)
FAIL src/fail.test.ts
  suite > breaks
    Error: expected 1 to equal 2
      at src/fail.test.ts:12:3

Test Files  1 failed | 1 passed (2)
Tests       1 failed | 3 passed (4)
Time        0.42s
";
		let out = filter(&ctx, input, 1);
		assert!(out.changed);
		assert!(!out.text.contains("PASS src/pass.test.ts"));
		assert!(!out.text.contains("✓ src/ok.test.ts"));
		assert!(out.text.contains("FAIL src/fail.test.ts"));
		assert!(out.text.contains("Error: expected 1 to equal 2"));
		assert!(out.text.contains("Test Files  1 failed | 1 passed (2)"));
		assert!(out.text.contains("Tests       1 failed | 3 passed (4)"));
		assert!(out.text.contains("Time        0.42s"));
	}

	#[test]
	fn format_compaction_preserves_errors_and_files() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("format", &cfg);
		let mut input = String::from("error: failed to parse src/bad.py\n");
		for idx in 0..100 {
			input.push_str("would reformat src/file_");
			input.push_str(&idx.to_string());
			input.push_str(".py\n");
		}
		let out = filter(&ctx, &input, 1);
		assert!(out.text.contains("errors:"));
		assert!(out.text.contains("failed to parse src/bad.py"));
		assert!(out.text.contains("files:"));
		assert!(out.text.contains("[…50 files elided…]"));
	}

	#[test]
	fn pipe_preserves_json_diff_and_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("pipe", &cfg);
		let mut json = String::new();
		for idx in 0..150 {
			json.push_str("{\"idx\":");
			json.push_str(&idx.to_string());
			json.push_str("}\n");
		}
		assert_eq!(filter(&ctx, &json, 0).text, json);

		let diff = "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n";
		assert_eq!(filter(&ctx, diff, 0).text, diff);

		let error = "error: resource-with-a-very-long-name failed validation\n";
		assert_eq!(filter(&ctx, error, 1).text, error);
	}
}
