//! Normalization for the 29 checker output formats.

use std::{path::Path, sync::LazyLock};

use omp_core::Str;
use regex::Regex;

use super::types::{Diagnostic, Severity};

static LOCATION: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^(?P<file>.*?):(?P<line>\d+)(?::(?P<column>\d+))?(?::|\s+-\s+|\s+)(?P<message>.+)$")
		.expect("static diagnostic location regex")
});
static RUST_ARROW: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^\s*-->\s+(?P<file>.+?):(?P<line>\d+):(?P<column>\d+)\s*$")
		.expect("static Rust span regex")
});
static CODE_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"^(?P<severity>error|warning|warn|info|note)(?:\[(?P<code>[^]]+)\])?:\s*(?P<message>.+)$",
	)
	.expect("static severity regex")
});

/// Supported checker-output parser vocabulary.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ParserKind {
	/// Rust compiler JSON.
	Rust,
	/// Rust test compiler and panic output.
	RustTest,
	/// Go compiler output.
	Go,
	/// `go test -json`.
	GoTest,
	/// staticcheck Unix output.
	Staticcheck,
	/// golangci-lint JSON.
	Golangci,
	/// Ruff JSON.
	Ruff,
	/// Pyright JSON.
	Pyright,
	/// Mypy text.
	Mypy,
	/// Pylint JSON.
	Pylint,
	/// Flake8 text.
	Flake8,
	/// Astral ty text.
	Ty,
	/// ESLint JSON.
	Eslint,
	/// Biome JSON.
	Biome,
	/// Oxlint Unix output.
	Oxlint,
	/// Deno lint JSON.
	DenoLint,
	/// Stylelint JSON.
	Stylelint,
	/// Rubocop JSON.
	Rubocop,
	/// PHPStan JSON.
	Phpstan,
	/// Psalm JSON.
	Psalm,
	/// SwiftLint JSON.
	Swiftlint,
	/// Dart machine output.
	Dart,
	/// Credo JSON.
	Credo,
	/// ShellCheck JSON.
	Shellcheck,
	/// HLint JSON.
	Hlint,
	/// Terraform validate JSON.
	Terraform,
	/// TFLint JSON.
	Tflint,
	/// Actionlint text.
	Actionlint,
	/// Generic file/line/column text or JSON.
	Generic,
}

/// Captured checker output.
pub struct ParserInput<'a> {
	/// Stable checker id.
	pub checker:      &'a str,
	/// Checker manifest root.
	pub checker_root: &'a Path,
	/// Project root used to relativize paths.
	pub project_root: &'a Path,
	/// Standard output.
	pub stdout:       &'a str,
	/// Standard error.
	pub stderr:       &'a str,
}

/// Parses one invocation into deduplicated project-relative diagnostics.
pub fn parse(kind: ParserKind, input: &ParserInput<'_>) -> Vec<Diagnostic> {
	let combined = if input.stderr.is_empty() {
		input.stdout.to_owned()
	} else if input.stdout.is_empty() {
		input.stderr.to_owned()
	} else {
		format!("{}\n{}", input.stdout, input.stderr)
	};
	let mut diagnostics = Vec::new();
	for value in json_values(&combined) {
		parse_json_value(kind, &value, input, &mut diagnostics);
	}
	parse_text(kind, &combined, input, &mut diagnostics);
	diagnostics.sort_by(|left, right| {
		left
			.file
			.cmp(&right.file)
			.then(left.line.cmp(&right.line))
			.then(left.column.cmp(&right.column))
			.then(left.message.cmp(&right.message))
	});
	diagnostics.dedup_by(|left, right| {
		left.file == right.file
			&& left.line == right.line
			&& left.column == right.column
			&& left.code == right.code
			&& left.message == right.message
	});
	diagnostics
}

fn json_values(text: &str) -> Vec<serde_json::Value> {
	let mut values = Vec::new();
	if let Ok(value) = serde_json::from_str(text.trim()) {
		values.push(value);
		return values;
	}
	for line in text.lines() {
		let line = line.trim();
		if (line.starts_with('{') || line.starts_with('['))
			&& let Ok(value) = serde_json::from_str(line)
		{
			values.push(value);
		}
	}
	values
}

fn parse_json_value(
	kind: ParserKind,
	value: &serde_json::Value,
	input: &ParserInput<'_>,
	output: &mut Vec<Diagnostic>,
) {
	match value {
		serde_json::Value::Array(values) => {
			for value in values {
				parse_json_value(kind, value, input, output);
			}
		},
		serde_json::Value::Object(object) => {
			if kind == ParserKind::GoTest
				&& let Some(text) = object.get("Output").and_then(serde_json::Value::as_str)
			{
				parse_text(kind, text, input, output);
			}
			if let Some(diagnostic) = object_diagnostic(kind, object, input) {
				output.push(diagnostic);
			}
			for key in ["diagnostics", "messages", "errors", "issues", "files", "results", "runs"] {
				if let Some(value) = object.get(key) {
					parse_json_value(kind, value, input, output);
				}
			}
			if let Some(value) = object.get("message")
				&& value.is_object()
			{
				parse_json_value(kind, value, input, output);
			}
		},
		_ => {},
	}
}

fn object_diagnostic(
	kind: ParserKind,
	object: &serde_json::Map<String, serde_json::Value>,
	input: &ParserInput<'_>,
) -> Option<Diagnostic> {
	let message = string_at(object, &["message", "description", "reason", "text", "title"])?;
	let file = string_at(object, &["filePath", "filename", "file", "path", "uri"])
		.or_else(|| {
			object
				.get("location")
				.and_then(|location| string_value(location, &["file", "path"]))
		})
		.or_else(|| {
			first_span(object).and_then(|span| string_at(span, &["file_name", "file", "path"]))
		})
		.and_then(|path| relative_path(path, input));
	let line = number_at(object, &["line", "lineNumber", "startLine"])
		.or_else(|| position_number(object, "range", "start", "line"))
		.or_else(|| first_span(object).and_then(|span| number_at(span, &["line_start", "line"])))
		.map(adjust_zero_based(kind));
	let column = number_at(object, &["column", "columnNumber", "startColumn"])
		.or_else(|| position_number(object, "range", "start", "character"))
		.or_else(|| first_span(object).and_then(|span| number_at(span, &["column_start", "column"])))
		.map(adjust_zero_based(kind));
	let end_line = number_at(object, &["endLine"])
		.or_else(|| position_number(object, "range", "end", "line"))
		.or_else(|| first_span(object).and_then(|span| number_at(span, &["line_end"])))
		.map(adjust_zero_based(kind));
	let end_column = number_at(object, &["endColumn"])
		.or_else(|| position_number(object, "range", "end", "character"))
		.or_else(|| first_span(object).and_then(|span| number_at(span, &["column_end"])))
		.map(adjust_zero_based(kind));
	let code = string_at(object, &["code", "ruleId", "rule", "symbol", "name"])
		.or_else(|| {
			object
				.get("code")
				.and_then(|value| string_value(value, &["code", "value"]))
		})
		.map(Str::from);
	let severity = object
		.get("severity")
		.or_else(|| object.get("level"))
		.or_else(|| object.get("type"))
		.map(severity_value)
		.unwrap_or(Severity::Error);
	let suggestion = string_at(object, &["suggestion", "replacement", "help", "fix"])
		.or_else(|| object.get("children").and_then(first_help))
		.map(Str::from);
	Some(Diagnostic {
		checker: Str::from(input.checker),
		file,
		line,
		column,
		end_line,
		end_column,
		code,
		severity,
		message: Str::from(message),
		suggestion,
	})
}

fn first_span(
	object: &serde_json::Map<String, serde_json::Value>,
) -> Option<&serde_json::Map<String, serde_json::Value>> {
	object
		.get("spans")?
		.as_array()?
		.iter()
		.find_map(serde_json::Value::as_object)
}

fn first_help(value: &serde_json::Value) -> Option<&str> {
	value.as_array()?.iter().find_map(|child| {
		let object = child.as_object()?;
		matches!(string_at(object, &["level"]), Some("help" | "note"))
			.then(|| string_at(object, &["message"]))
			.flatten()
	})
}

fn string_at<'a>(
	object: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| object.get(*key).and_then(serde_json::Value::as_str))
}

fn string_value<'a>(value: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
	string_at(value.as_object()?, keys)
}

fn number_at(object: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u32> {
	keys
		.iter()
		.find_map(|key| object.get(*key).and_then(number_value))
}

fn number_value(value: &serde_json::Value) -> Option<u32> {
	value
		.as_u64()
		.and_then(|value| value.try_into().ok())
		.or_else(|| value.as_str()?.parse().ok())
}

fn position_number(
	object: &serde_json::Map<String, serde_json::Value>,
	outer: &str,
	position: &str,
	field: &str,
) -> Option<u32> {
	object
		.get(outer)?
		.get(position)?
		.get(field)
		.and_then(number_value)
}

fn adjust_zero_based(kind: ParserKind) -> impl Fn(u32) -> u32 {
	move |value| {
		if matches!(kind, ParserKind::Pyright | ParserKind::DenoLint | ParserKind::Biome) {
			value.saturating_add(1)
		} else {
			value
		}
	}
}

fn severity_value(value: &serde_json::Value) -> Severity {
	if let Some(number) = value.as_u64() {
		return match number {
			2.. => Severity::Error,
			1 => Severity::Warning,
			_ => Severity::Info,
		};
	}
	match value
		.as_str()
		.unwrap_or_default()
		.to_ascii_lowercase()
		.as_str()
	{
		"error" | "fatal" | "failure" | "2" => Severity::Error,
		"warning" | "warn" | "convention" | "refactor" | "1" => Severity::Warning,
		_ => Severity::Info,
	}
}

fn parse_text(kind: ParserKind, text: &str, input: &ParserInput<'_>, output: &mut Vec<Diagnostic>) {
	let mut pending: Option<(Severity, Option<Str>, Str)> = None;
	for line in text.lines() {
		let line = strip_control(line);
		let line = line.trim();
		if line.is_empty() {
			continue;
		}
		if let Some(capture) = CODE_PREFIX.captures(line) {
			pending = Some((
				severity_text(&capture["severity"]),
				capture.name("code").map(|value| Str::from(value.as_str())),
				Str::from(&capture["message"]),
			));
			continue;
		}
		if let Some(capture) = RUST_ARROW.captures(line) {
			let (severity, code, message) =
				pending
					.take()
					.unwrap_or((Severity::Error, None, Str::from("compiler diagnostic")));
			output.push(Diagnostic {
				checker: Str::from(input.checker),
				file: relative_path(&capture["file"], input),
				line: capture["line"].parse().ok(),
				column: capture["column"].parse().ok(),
				end_line: None,
				end_column: None,
				code,
				severity,
				message,
				suggestion: None,
			});
			continue;
		}
		let Some(capture) = LOCATION.captures(line) else {
			continue;
		};
		let mut message = capture["message"].trim();
		let mut severity = Severity::Error;
		let mut code = None;
		if let Some((prefix, rest)) = message.split_once(':') {
			let prefix = prefix.trim();
			if matches!(
				prefix.to_ascii_lowercase().as_str(),
				"error" | "warning" | "warn" | "info" | "note"
			) {
				severity = severity_text(prefix);
				message = rest.trim();
			}
		}
		if let Some((candidate, rest)) = message.split_once(' ')
			&& candidate.len() <= 32
			&& candidate.chars().any(char::is_numeric)
		{
			code = Some(Str::from(candidate.trim_matches(['[', ']', ':'])));
			message = rest.trim_start_matches([':', ' ']);
		}
		output.push(Diagnostic {
			checker: Str::from(input.checker),
			file: relative_path(&capture["file"], input),
			line: capture["line"].parse().ok(),
			column: capture
				.name("column")
				.and_then(|value| value.as_str().parse().ok()),
			end_line: None,
			end_column: None,
			code,
			severity,
			message: Str::from(message),
			suggestion: None,
		});
	}
	if matches!(kind, ParserKind::RustTest | ParserKind::GoTest)
		&& output.is_empty()
		&& text.contains("panicked at")
	{
		output.push(Diagnostic {
			checker:    Str::from(input.checker),
			file:       None,
			line:       None,
			column:     None,
			end_line:   None,
			end_column: None,
			code:       None,
			severity:   Severity::Error,
			message:    Str::from(
				text
					.lines()
					.find(|line| line.contains("panicked at"))
					.unwrap_or("test panic"),
			),
			suggestion: None,
		});
	}
}

fn relative_path(path: &str, input: &ParserInput<'_>) -> Option<Str> {
	let path = path.trim().trim_start_matches("file://");
	if path.is_empty() || path == "<unknown>" {
		return None;
	}
	let path = Path::new(path);
	let absolute = if path.is_absolute() {
		path.to_path_buf()
	} else {
		input.checker_root.join(path)
	};
	let relative = absolute.strip_prefix(input.project_root).unwrap_or(path);
	Some(Str::from(relative.to_string_lossy().replace('\\', "/")))
}

fn severity_text(value: &str) -> Severity {
	match value.to_ascii_lowercase().as_str() {
		"error" | "fatal" => Severity::Error,
		"warning" | "warn" => Severity::Warning,
		_ => Severity::Info,
	}
}

fn strip_control(value: &str) -> String {
	let mut output = String::with_capacity(value.len());
	let mut escape = false;
	for character in value.chars() {
		if escape {
			if character.is_ascii_alphabetic() {
				escape = false;
			}
			continue;
		}
		if character == '\u{1b}' {
			escape = true;
		} else if !character.is_control() || character == '\t' {
			output.push(character);
		}
	}
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rust_json_and_generic_locations_normalize() {
		let root = Path::new("/repo");
		let input = ParserInput {
			checker:      "cargo-check",
			checker_root: root,
			project_root: root,
			stdout:       r#"{"message":"bad type","level":"error","code":{"code":"E1"},"spans":[{"file_name":"src/lib.rs","line_start":2,"column_start":3}]}"#,
			stderr:       "src/main.rs:4:5: warning: unused",
		};
		let diagnostics = parse(ParserKind::Rust, &input);
		assert_eq!(diagnostics.len(), 2);
		assert_eq!(diagnostics[0].file.as_deref(), Some("src/lib.rs"));
		assert_eq!(diagnostics[1].severity, Severity::Warning);
	}
}
