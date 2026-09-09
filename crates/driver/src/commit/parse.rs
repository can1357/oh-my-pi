use std::str::FromStr as _;

use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::AsRefStr, strum::Display, strum::EnumString)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub(super) enum CommitType {
	Feat,
	Fix,
	Refactor,
	Docs,
	Test,
	Chore,
	Style,
	Perf,
	Build,
	Ci,
	Revert,
	Deps,
	Security,
	Config,
	Ux,
	Release,
	Hotfix,
	Infra,
	Init,
	Merge,
	Hack,
	Wip,
}

impl CommitType {
	pub(super) fn parse(raw: &str) -> Option<Self> {
		let normalized = raw.trim().to_ascii_lowercase();
		Self::from_str(&normalized)
			.ok()
			.or_else(|| match normalized.as_str() {
				"feature" | "add" | "enhancement" => Some(Self::Feat),
				"bug" | "bugfix" | "patch" => Some(Self::Fix),
				"doc" | "documentation" => Some(Self::Docs),
				"tests" | "testing" => Some(Self::Test),
				"dependency" | "dependencies" => Some(Self::Deps),
				"maintenance" | "maint" => Some(Self::Chore),
				"ui" | "user-interface" => Some(Self::Ux),
				"performance" => Some(Self::Perf),
				"pipeline" => Some(Self::Ci),
				_ => None,
			})
	}

	pub(super) const fn fallback_verb(self) -> &'static str {
		match self {
			Self::Feat => "added",
			Self::Fix | Self::Hotfix | Self::Security => "fixed",
			Self::Refactor => "restructured",
			Self::Docs => "documented",
			Self::Test => "tested",
			Self::Style => "formatted",
			Self::Perf => "optimized",
			Self::Revert => "reverted",
			Self::Release => "released",
			Self::Init => "initialized",
			Self::Merge => "merged",
			Self::Build
			| Self::Ci
			| Self::Deps
			| Self::Config
			| Self::Infra
			| Self::Chore
			| Self::Hack
			| Self::Wip
			| Self::Ux => "updated",
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ParsedCommit {
	pub(super) kind:    CommitType,
	pub(super) scope:   Option<String>,
	pub(super) subject: String,
	pub(super) details: Vec<String>,
}

pub(super) fn parse_completion(raw: &str) -> ParsedCommit {
	let cleaned = clean_fence(raw);
	if let Some(parsed) = parse_json(cleaned) {
		return parsed;
	}
	parse_markdown(cleaned)
}

fn parse_json(text: &str) -> Option<ParsedCommit> {
	let candidate = text
		.trim()
		.strip_prefix("Result:")
		.or_else(|| text.trim().strip_prefix("result:"))
		.unwrap_or(text)
		.trim();
	let value = serde_json::from_str::<Value>(candidate).ok()?;
	let object = value.as_object()?;
	let raw_type = object
		.get("type")
		.or_else(|| object.get("commit_type"))
		.and_then(Value::as_str)
		.unwrap_or("chore");
	let kind = CommitType::parse(raw_type).unwrap_or(CommitType::Chore);
	let scope = object
		.get("scope")
		.and_then(Value::as_str)
		.map(str::to_owned);
	let subject = object
		.get("summary")
		.or_else(|| object.get("title"))
		.or_else(|| object.get("message"))
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned();
	let details = object
		.get("details")
		.or_else(|| object.get("body"))
		.map(detail_values)
		.unwrap_or_default();
	Some(ParsedCommit { kind, scope, subject: strip_type_prefix(&subject), details })
}

fn detail_values(value: &Value) -> Vec<String> {
	match value {
		Value::String(text) => text.lines().filter_map(strip_bullet_or_text).collect(),
		Value::Array(items) => items
			.iter()
			.filter_map(|item| {
				item
					.as_str()
					.map(str::to_owned)
					.or_else(|| item.as_object()?.get("text")?.as_str().map(str::to_owned))
			})
			.collect(),
		_ => Vec::new(),
	}
}

fn parse_markdown(text: &str) -> ParsedCommit {
	let lines = text.lines().collect::<Vec<_>>();
	for (index, line) in lines.iter().take(5).enumerate() {
		let heading = strip_heading(line);
		if let Some((prefix, subject)) = heading.split_once(':') {
			if let Some((raw_type, scope)) = split_prefix(prefix) {
				let explicit_heading = line.trim_start().starts_with('#');
				let kind =
					CommitType::parse(raw_type).or(explicit_heading.then_some(CommitType::Chore));
				if let Some(kind) = kind {
					let details = lines[index + 1..]
						.iter()
						.filter_map(|line| strip_bullet(line))
						.collect();
					return ParsedCommit {
						kind,
						scope: scope.map(str::to_owned),
						subject: unwrap_summary(subject),
						details,
					};
				}
			}
		}
	}
	ParsedCommit {
		kind:    CommitType::Chore,
		scope:   None,
		subject: unwrap_summary(text),
		details: Vec::new(),
	}
}

fn split_prefix(prefix: &str) -> Option<(&str, Option<&str>)> {
	let trimmed = prefix.trim().trim_end_matches('!').trim();
	if let Some(open) = trimmed.find('(') {
		let close = trimmed.rfind(')')?;
		if close < open {
			return None;
		}
		let scope = trimmed[open + 1..close].trim();
		return Some((trimmed[..open].trim(), (!scope.is_empty()).then_some(scope)));
	}
	Some((trimmed, None))
}

fn strip_type_prefix(text: &str) -> String {
	let trimmed = text.trim();
	let Some((prefix, subject)) = trimmed.split_once(':') else {
		return trimmed.to_owned();
	};
	if split_prefix(prefix).is_some_and(|(kind, _)| CommitType::parse(kind).is_some()) {
		subject.trim().to_owned()
	} else {
		trimmed.to_owned()
	}
}

fn clean_fence(text: &str) -> &str {
	let trimmed = text.trim();
	let Some(after_open) = trimmed.strip_prefix("```") else {
		return trimmed;
	};
	let body = after_open
		.split_once('\n')
		.map_or(after_open, |(_, body)| body);
	body.strip_suffix("```").unwrap_or(body).trim()
}

fn strip_heading(text: &str) -> &str {
	let mut value = text.trim();
	while let Some(stripped) = value.strip_prefix('#') {
		value = stripped.trim_start();
	}
	for marker in ["**", "__", "*", "_"] {
		if value.starts_with(marker) && value.ends_with(marker) && value.len() > marker.len() * 2 {
			value = value[marker.len()..value.len() - marker.len()].trim();
		}
	}
	value
}

fn unwrap_summary(text: &str) -> String {
	let mut value = text.trim();
	for label in ["Title:", "title:", "Summary:", "summary:", "Description:", "description:"] {
		if let Some(stripped) = value.strip_prefix(label) {
			value = stripped.trim();
			break;
		}
	}
	if let Some(open_end) = value.to_ascii_lowercase().find("<summary>") {
		let after = &value[open_end + "<summary>".len()..];
		let lower = after.to_ascii_lowercase();
		value = lower
			.find("</summary>")
			.map_or(after, |end| &after[..end])
			.trim();
	}
	let pairs = [('"', '"'), ('\'', '\''), ('`', '`'), ('“', '”'), ('‘', '’')];
	if let Some((left, right)) = pairs.iter().find(|(left, _)| value.starts_with(*left)) {
		if value.ends_with(*right) && value.len() >= left.len_utf8() + right.len_utf8() {
			value = value[left.len_utf8()..value.len() - right.len_utf8()].trim();
		}
	}
	value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_bullet(line: &&str) -> Option<String> {
	strip_bullet_or_text(line).filter(|_| {
		let trimmed = line.trim_start();
		["- ", "* ", "+ ", "• ", "– "]
			.iter()
			.any(|marker| trimmed.starts_with(marker))
			|| numeric_bullet(trimmed).is_some()
	})
}

fn strip_bullet_or_text(line: &str) -> Option<String> {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return None;
	}
	for marker in ["- ", "* ", "+ ", "• ", "– "] {
		if let Some(stripped) = trimmed.strip_prefix(marker) {
			return (!stripped.trim().is_empty()).then(|| stripped.trim().to_owned());
		}
	}
	Some(numeric_bullet(trimmed).unwrap_or(trimmed).trim().to_owned())
}

fn numeric_bullet(text: &str) -> Option<&str> {
	let digits = text.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 {
		return None;
	}
	let tail = &text[digits..];
	tail.strip_prefix(". ").or_else(|| tail.strip_prefix(") "))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_canonical_aliased_unknown_and_json_outputs() {
		let canonical = parse_completion(
			"# feat(api): added authentication endpoint\n\n- Added POST /auth/login \
			 endpoint.\n\nFixes: #123",
		);
		assert_eq!(canonical.kind, CommitType::Feat);
		assert_eq!(canonical.scope.as_deref(), Some("api"));
		assert_eq!(canonical.subject, "added authentication endpoint");
		assert_eq!(canonical.details, ["Added POST /auth/login endpoint."]);
		assert_eq!(parse_completion("# ui: improved navigation").kind, CommitType::Ux);
		assert_eq!(parse_completion("# wibble: tweaked knobs").kind, CommitType::Chore);
		assert_eq!(
			parse_completion(
				"Result: {\"type\":\"fix\",\"scope\":null,\"summary\":\"corrected \
				 parser\",\"details\":[]}"
			)
			.subject,
			"corrected parser"
		);
	}

	#[test]
	fn parses_summary_wrappers() {
		for text in [
			"<summary>Added JWT auth</summary>",
			"\"Added JWT auth\"",
			"Title: Added JWT auth",
			"```md\n<summary>\nAdded JWT auth\n</summary>\n```",
		] {
			assert_eq!(parse_completion(text).subject, "Added JWT auth");
		}
	}
}
