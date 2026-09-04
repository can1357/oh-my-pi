//! Conservative shell-intent guidance derived from BashIR command segments.

use std::{collections::BTreeSet, iter};

use omp_core::{Str, sf};

/// One configured shell interception rule.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
	/// Regular expression matched against conservative candidates.
	pub pattern: Str,
	/// Dedicated live tool required by the rule.
	pub tool:    Str,
	/// Model-facing guidance.
	pub message: Str,
}

/// One construction-time compiled live rule.
#[derive(Clone, Debug)]
pub struct CompiledRule {
	regex:   regex::Regex,
	tool:    Str,
	message: Str,
}

/// One pre-authorization recommendation to use a dedicated tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Guidance {
	/// Live alternative tool to invoke.
	pub tool:    Str,
	/// Human-readable reason retaining the original command.
	pub message: Str,
}

/// Compiles only rules whose alternative tool is live.
pub fn compile(rules: &[Rule], live_tools: &[Str]) -> Vec<CompiledRule> {
	let live = live_tools.iter().map(Str::as_str).collect::<BTreeSet<_>>();
	rules
		.iter()
		.filter(|rule| live.contains(rule.tool.as_str()))
		.filter_map(|rule| {
			regex::Regex::new(&rule.pattern)
				.ok()
				.map(|regex| CompiledRule {
					regex,
					tool: rule.tool.clone(),
					message: rule.message.clone(),
				})
		})
		.collect()
}

/// Returns the first matching configured recommendation.
pub fn analyze_configured(command: &str, rules: &[CompiledRule]) -> Option<Guidance> {
	for candidate in candidates(command) {
		for rule in rules {
			if rule.regex.is_match(candidate) {
				return Some(Guidance {
					tool:    rule.tool.clone(),
					message: sf!("{}\n\nOriginal command: {command}", rule.message),
				});
			}
		}
	}
	None
}

/// Returns the first applicable dedicated-tool recommendation.
///
/// Segments consuming piped stdin are deliberately ignored: path-oriented
/// tools cannot reproduce their stream semantics. Leading assignments and
/// redirections are removed before classifying the executable.
pub fn analyze(command: &str, live_tools: &[Str]) -> Option<Guidance> {
	let live = live_tools.iter().map(Str::as_str).collect::<BTreeSet<_>>();
	for candidate in candidates(command) {
		let candidate = strip_prefixes(candidate)?;
		let (program, rest) = split_word(candidate)?;
		let tool = classify(program, rest)?;
		if !live.contains(tool) {
			continue;
		}
		return Some(Guidance {
			tool:    Str::new(tool),
			message: sf!(
				"Use the dedicated {tool} tool instead of shell for this operation. Original command: \
				 {command}"
			),
		});
	}
	None
}

fn candidates(command: &str) -> impl Iterator<Item = &str> {
	iter::once(command.trim()).chain(
		omp_shell::parser::flat_shell_segments(command)
			.into_iter()
			.filter(|segment| !segment.piped_stdin)
			.map(|segment| segment.text),
	)
}

fn classify<'a>(program: &'a str, rest: &str) -> Option<&'a str> {
	let base = program.rsplit('/').next().unwrap_or(program);
	match base {
		"cat" | "head" | "tail" | "less" | "more" => Some("read"),
		"grep" | "egrep" | "fgrep" | "rg" => Some("grep"),
		"find" | "fd" => Some("glob"),
		"sed"
			if rest
				.split_ascii_whitespace()
				.any(|arg| arg == "-i" || arg.starts_with("-i")) =>
		{
			Some("edit")
		},
		"echo" | "printf" if has_output_redirect(rest) => Some("write"),
		"npm" | "pnpm" | "yarn" | "bun" | "cargo"
			if rest
				.split_ascii_whitespace()
				.any(|arg| matches!(arg, "dev" | "serve" | "watch" | "start" | "test:watch")) =>
		{
			Some("hub")
		},
		"gdb" | "lldb" | "dlv" | "watch" => Some("hub"),
		_ if rest.trim_end().ends_with('&') => Some("hub"),
		_ => None,
	}
}

fn has_output_redirect(text: &str) -> bool {
	let bytes = text.as_bytes();
	let mut quote = 0u8;
	let mut escaped = false;
	for (index, &byte) in bytes.iter().enumerate() {
		if escaped {
			escaped = false;
			continue;
		}
		if byte == b'\\' && quote != b'\'' {
			escaped = true;
			continue;
		}
		if matches!(byte, b'\'' | b'"') {
			if quote == 0 {
				quote = byte;
			} else if quote == byte {
				quote = 0;
			}
			continue;
		}
		if quote == 0 && byte == b'>' && index.checked_sub(1).is_none_or(|i| bytes[i] != b'&') {
			return true;
		}
	}
	false
}

fn strip_prefixes(mut text: &str) -> Option<&str> {
	loop {
		text = text.trim_start();
		let (word, rest) = split_word(text)?;
		if is_assignment(word) || is_redirection(word) {
			text = rest;
			continue;
		}
		return Some(text);
	}
}

fn is_assignment(word: &str) -> bool {
	let Some((name, _)) = word.split_once('=') else {
		return false;
	};
	let mut bytes = name.bytes();
	bytes
		.next()
		.is_some_and(|b| b == b'_' || b.is_ascii_alphabetic())
		&& bytes.all(|b| b == b'_' || b.is_ascii_alphanumeric())
}

fn is_redirection(word: &str) -> bool {
	word.starts_with('<')
		|| word.starts_with('>')
		|| word.bytes().next().is_some_and(|b| b.is_ascii_digit())
			&& word.bytes().any(|b| matches!(b, b'<' | b'>'))
}

fn split_word(text: &str) -> Option<(&str, &str)> {
	let end = text
		.char_indices()
		.find_map(|(index, character)| character.is_whitespace().then_some(index))
		.unwrap_or(text.len());
	(end != 0).then(|| (&text[..end], &text[end..]))
}

#[cfg(test)]
mod tests {
	use omp_core::Str;

	use super::analyze;

	fn tools() -> Vec<Str> {
		["read", "grep", "glob", "edit", "write", "hub"]
			.into_iter()
			.map(Str::new)
			.collect()
	}

	#[test]
	fn assignments_and_redirections_do_not_hide_reader_intent() {
		assert_eq!(
			analyze("FOO=bar 2>/dev/null cat file", &tools())
				.unwrap()
				.tool,
			"read"
		);
	}

	#[test]
	fn piped_consumers_are_not_redirected() {
		assert!(analyze("generate | grep needle", &tools()).is_none());
	}

	#[test]
	fn suggestions_require_a_live_alternative() {
		assert!(analyze("cat file", &[]).is_none());
	}
}
