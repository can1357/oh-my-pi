use omp_core::Str;

use super::{
	CommitError, ConventionalCommit, ValidationIssue,
	parse::{CommitType, ParsedCommit},
};

const SUMMARY_HARD_LIMIT: usize = 128;
const BODY_BYTE_BUDGET: usize = 800;

pub(super) fn normalize_and_validate(
	mut parsed: ParsedCommit,
	diff: &str,
	inferred_scope: Option<&str>,
) -> Result<ConventionalCommit, CommitError> {
	parsed.scope = match parsed.scope.as_deref() {
		Some(scope) => normalize_scope(scope).filter(|scope| !is_project_scope(scope)),
		None => inferred_scope.and_then(normalize_scope),
	};

	let mut subject = normalize_subject(&parsed.subject);
	if subject.is_empty() {
		subject = fallback_subject(parsed.kind, diff);
	}
	subject = normalize_summary_verb(&subject, parsed.kind);
	if !is_past_tense_first_word(subject.split_whitespace().next().unwrap_or_default()) {
		let remainder = strip_repeated_type_word(&subject, parsed.kind);
		subject = format!("{} {}", parsed.kind.fallback_verb(), remainder)
			.trim()
			.to_owned();
	}
	if parsed.kind == CommitType::Refactor && subject.starts_with("refactored") {
		subject.replace_range(.."refactored".len(), "restructured");
	}
	if subject.is_empty() {
		return Err(CommitError::InvalidOutput { issue: ValidationIssue::EmptySummary });
	}

	let prefix = parsed
		.scope
		.as_ref()
		.map_or_else(|| format!("{}: ", parsed.kind), |scope| format!("{}({scope}): ", parsed.kind));
	let subject_budget = SUMMARY_HARD_LIMIT.saturating_sub(prefix.len());
	if subject_budget < parsed.kind.fallback_verb().len() {
		return Err(CommitError::InvalidOutput { issue: ValidationIssue::SummaryTooLong });
	}
	subject = truncate_at_word(&subject, subject_budget);
	if subject.is_empty() {
		return Err(CommitError::InvalidOutput { issue: ValidationIssue::SummaryTooLong });
	}
	let summary = Str::from(format!("{prefix}{subject}"));
	let body = normalize_body(parsed.details);
	Ok(ConventionalCommit { summary, body })
}

fn normalize_subject(subject: &str) -> String {
	let flattened = subject
		.replace(|character| matches!(character, '\r' | '\n'), " ")
		.replace(|character| matches!(character, '‘' | '’'), "'")
		.replace(|character| matches!(character, '“' | '”'), "\"")
		.replace(|character| matches!(character, '–' | '—'), "-");
	let mut normalized = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
	while normalized.ends_with(|character| matches!(character, '.' | ';' | ':')) {
		normalized.pop();
	}
	lowercase_first(&mut normalized);
	normalized
}

fn normalize_summary_verb(subject: &str, kind: CommitType) -> String {
	let Some(first) = subject.split_whitespace().next() else {
		return String::new();
	};
	let rest = subject[first.len()..].trim_start();
	let lower = first.to_ascii_lowercase();
	if is_past_tense_first_word(&lower) {
		if kind == CommitType::Refactor && lower == "refactored" {
			return join("restructured", rest);
		}
		return subject.to_owned();
	}
	if lower == "re" && rest.starts_with('-') {
		return subject.to_owned();
	}
	if let Some(past) = present_to_past(&lower) {
		let past = if kind == CommitType::Refactor && past == "refactored" {
			"restructured"
		} else {
			past
		};
		return join(past, rest);
	}
	for suffix in ["ies", "es", "s"] {
		let Some(stem) = lower.strip_suffix(suffix) else {
			continue;
		};
		let candidate = if suffix == "ies" {
			format!("{stem}y")
		} else {
			stem.to_owned()
		};
		if let Some(past) = present_to_past(&candidate) {
			return join(past, rest);
		}
	}
	subject.to_owned()
}

fn present_to_past(verb: &str) -> Option<&'static str> {
	Some(match verb {
		"add" => "added",
		"allow" => "allowed",
		"build" => "built",
		"change" => "changed",
		"clean" => "cleaned",
		"correct" => "corrected",
		"create" => "created",
		"deprecate" => "deprecated",
		"disable" => "disabled",
		"document" => "documented",
		"drop" => "dropped",
		"enable" => "enabled",
		"ensure" => "ensured",
		"extend" => "extended",
		"fix" => "fixed",
		"format" => "formatted",
		"handle" => "handled",
		"implement" => "implemented",
		"improve" => "improved",
		"initialize" => "initialized",
		"introduce" => "introduced",
		"make" => "made",
		"merge" => "merged",
		"move" => "moved",
		"normalize" => "normalized",
		"optimize" => "optimized",
		"prevent" => "prevented",
		"refactor" => "refactored",
		"release" => "released",
		"remove" => "removed",
		"rename" => "renamed",
		"replace" => "replaced",
		"require" => "required",
		"resolve" => "resolved",
		"restore" => "restored",
		"restructure" => "restructured",
		"return" => "returned",
		"revert" => "reverted",
		"simplify" => "simplified",
		"support" => "supported",
		"test" => "tested",
		"track" => "tracked",
		"update" => "updated",
		"use" => "used",
		"validate" => "validated",
		"write" => "wrote",
		_ => return None,
	})
}

fn is_past_tense_first_word(word: &str) -> bool {
	let word = word
		.trim_matches(|character: char| !character.is_ascii_alphabetic())
		.to_ascii_lowercase();
	if [
		"built",
		"made",
		"wrote",
		"set",
		"read",
		"split",
		"updated",
		"fixed",
		"added",
		"changed",
		"restructured",
		"removed",
		"improved",
		"supported",
		"used",
		"handled",
	]
	.contains(&word.as_str())
	{
		return true;
	}
	if ["need", "red", "hundred", "method", "invalid", "nested", "unified"].contains(&word.as_str())
	{
		return false;
	}
	word.len() >= 4 && (word.ends_with("ed") || word.ends_with('d'))
}

fn normalize_scope(scope: &str) -> Option<String> {
	if matches!(scope.trim().to_ascii_lowercase().as_str(), "" | "null" | "none" | "(none)" | "n/a")
	{
		return None;
	}
	let mut segments = Vec::with_capacity(2);
	for raw in scope.replace('\\', "/").split('/') {
		let mut segment = String::with_capacity(raw.len());
		let mut separator = false;
		for character in raw.trim().chars() {
			if character.is_ascii_alphanumeric() {
				segment.push(character.to_ascii_lowercase());
				separator = false;
			} else if (character == '-'
				|| character == '_'
				|| character == '.'
				|| character.is_whitespace())
				&& !segment.is_empty()
				&& !separator
			{
				segment.push('-');
				separator = true;
			}
		}
		while segment.ends_with('-') {
			segment.pop();
		}
		if !segment.is_empty() {
			segments.push(segment);
		}
		if segments.len() == 2 {
			break;
		}
	}
	let joined = segments.join("/");
	(!joined.is_empty() && joined.len() <= 40).then_some(joined)
}

fn is_project_scope(scope: &str) -> bool {
	matches!(scope, "project" | "repo" | "repository" | "global" | "all")
}

fn strip_repeated_type_word<'a>(subject: &'a str, kind: CommitType) -> &'a str {
	let first = subject.split_whitespace().next().unwrap_or_default();
	if first.eq_ignore_ascii_case(kind.as_ref()) {
		subject[first.len()..].trim_start()
	} else {
		subject
	}
}

fn fallback_subject(kind: CommitType, diff: &str) -> String {
	let subject = diff
		.lines()
		.find_map(|line| {
			line
				.strip_prefix("diff --git ")?
				.split_whitespace()
				.nth(1)
				.map(|path| {
					path
						.trim_start_matches("b/")
						.rsplit('/')
						.next()
						.unwrap_or(path)
				})
		})
		.unwrap_or("files");
	format!("{} {subject}", kind.fallback_verb())
}

fn normalize_body(details: Vec<String>) -> Str {
	let mut lines = Vec::new();
	let mut bytes = 0_usize;
	for raw in details {
		let mut detail = raw
			.trim()
			.trim_start_matches(|character| matches!(character, '-' | '*' | '+' | '•' | '–'))
			.trim()
			.replace(|character| matches!(character, '\r' | '\n'), " ")
			.split_whitespace()
			.collect::<Vec<_>>()
			.join(" ");
		while detail.ends_with(|character| matches!(character, '.' | ';' | ',')) {
			detail.pop();
		}
		if detail.is_empty() {
			continue;
		}
		uppercase_first(&mut detail);
		detail.push('.');
		let line = format!("- {detail}");
		if bytes.saturating_add(line.len()) > BODY_BYTE_BUDGET {
			continue;
		}
		bytes = bytes.saturating_add(line.len());
		lines.push(line);
	}
	if lines.is_empty() {
		Str::new_static("")
	} else {
		Str::from(lines.join("\n"))
	}
}

fn truncate_at_word(text: &str, max_bytes: usize) -> String {
	if text.len() <= max_bytes {
		return text.to_owned();
	}
	let mut end = max_bytes.min(text.len());
	while end > 0 && !text.is_char_boundary(end) {
		end -= 1;
	}
	let sliced = &text[..end];
	let boundary = sliced.rfind(char::is_whitespace).unwrap_or(end);
	sliced[..boundary]
		.trim_end_matches(|character| matches!(character, ' ' | ',' | ';' | ':' | '-'))
		.to_owned()
}

fn lowercase_first(text: &mut String) {
	let Some(first) = text.chars().next() else {
		return;
	};
	if first.is_lowercase()
		|| first.is_ascii_uppercase()
			&& text
				.split_whitespace()
				.next()
				.is_some_and(|word| word.chars().all(|character| !character.is_lowercase()))
	{
		return;
	}
	let replacement = first.to_lowercase().collect::<String>();
	text.replace_range(..first.len_utf8(), &replacement);
}

fn uppercase_first(text: &mut String) {
	let Some(first) = text.chars().next() else {
		return;
	};
	if first.is_uppercase() {
		return;
	}
	let replacement = first.to_uppercase().collect::<String>();
	text.replace_range(..first.len_utf8(), &replacement);
}

fn join(first: &str, rest: &str) -> String {
	if rest.is_empty() {
		first.to_owned()
	} else {
		format!("{first} {rest}")
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parsed(kind: CommitType, subject: &str) -> ParsedCommit {
		ParsedCommit { kind, scope: None, subject: subject.to_owned(), details: Vec::new() }
	}

	#[test]
	fn normalizes_present_tense_and_refactor_vocabulary() {
		let diff = "diff --git a/src/parser.rs b/src/parser.rs\n-old\n+new";
		assert_eq!(
			normalize_and_validate(parsed(CommitType::Fix, "replace dependencies"), diff, None)
				.expect("repair")
				.summary,
			"fix: replaced dependencies"
		);
		assert_eq!(
			normalize_and_validate(parsed(CommitType::Refactor, "refactor parser state"), diff, None)
				.expect("repair")
				.summary,
			"refactor: restructured parser state"
		);
	}

	#[test]
	fn repairs_non_verbs_and_normalizes_body_bullets() {
		let mut value = parsed(CommitType::Feat, "hundred files");
		value.details = vec!["added parser recovery".to_owned(), "Guarded empty input.".to_owned()];
		let commit =
			normalize_and_validate(value, "diff --git a/a.rs b/a.rs\n+x", None).expect("repair");
		assert_eq!(commit.summary, "feat: added hundred files");
		assert_eq!(commit.body, "- Added parser recovery.\n- Guarded empty input.");
	}

	#[test]
	fn drops_project_scope_and_caps_the_complete_first_line() {
		let mut value = parsed(CommitType::Fix, &format!("correct {}", "parser ".repeat(40)));
		value.scope = Some("project".to_owned());
		let commit =
			normalize_and_validate(value, "diff --git a/src/parser.rs b/src/parser.rs\n+x", None)
				.expect("repair");
		assert!(commit.summary.starts_with("fix: corrected parser"));
		assert!(commit.summary.len() <= SUMMARY_HARD_LIMIT);
		assert!(!commit.summary.contains("(project)"));
	}
}
