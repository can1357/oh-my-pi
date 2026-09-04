//! Environment-executed workspace checker presets and bounded result parsing.

use std::{
	future::Future,
	path::{Path, PathBuf},
};

use omp_core::Str;
use omp_proto::lsp::{Diagnostic, Position, Range, Severity};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// Cache identity for one checker generation.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CheckerCacheKey {
	/// Canonical workspace.
	pub workspace:         PathBuf,
	/// Authority-resolved executable.
	pub executable:        PathBuf,
	/// Checker configuration fingerprint.
	pub config_generation: u64,
	/// LSP binding generation when the checker wraps a server.
	pub server_generation: Option<u64>,
}

/// A bounded process request that must execute through Environment authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckerRequest {
	/// Executable name, resolved by Environment.
	pub program:    Str,
	/// Arguments.
	pub args:       Vec<Str>,
	/// Workspace-relative cwd.
	pub cwd:        PathBuf,
	/// Maximum captured stdout and stderr lines.
	pub line_limit: usize,
}

/// Environment process completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckerOutput {
	/// Exit status, when a process was launched.
	pub status: Option<i32>,
	/// Bounded stdout.
	pub stdout: Str,
	/// Bounded stderr.
	pub stderr: Str,
}

/// Typed distinction between code findings and a broken toolchain.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckerFault {
	/// Executable is unavailable.
	#[error("checker executable is unavailable")]
	ExecutableUnavailable,
	/// Process could not be launched.
	#[error("checker process failed to launch")]
	LaunchFailed,
	/// Process exceeded its authority-owned deadline.
	#[error("checker timed out")]
	TimedOut,
	/// Output was not the checker's declared format.
	#[error("checker emitted malformed output")]
	MalformedOutput,
	/// Caller cancelled the checker.
	#[error("checker was cancelled")]
	Cancelled,
	/// Checker launched but failed before producing source findings.
	#[error("checker toolchain failed")]
	ToolchainFailed,
}

/// Authority seam for checker execution.
pub trait CheckerExecutor: Clone + Send + Sync + 'static {
	/// Runs one bounded request under Environment cancellation and ownership.
	fn run(
		&self,
		request: CheckerRequest,
		cancel: CancellationToken,
	) -> impl Future<Output = Result<CheckerOutput, CheckerFault>> + Send + '_;
}

/// Built-in checker command selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
pub enum Preset {
	/// `cargo check --message-format=json`.
	Cargo,
	/// TypeScript no-emit check.
	TypeScript,
	/// Go workspace/package check.
	Go,
	/// Pyright JSON check.
	Pyright,
	/// Biome JSON lint.
	Biome,
	/// `SwiftLint` JSON lint.
	SwiftLint,
	/// An installed LSP binding acting as checker.
	LspBinding,
}

/// Builds a bounded command for one workspace/file.
pub fn request(preset: Preset, workspace: &Path, target: Option<&Path>) -> CheckerRequest {
	let target = target.map(|path| Str::from(path.to_string_lossy().as_ref()));
	let (program, mut args): (&str, Vec<Str>) = match preset {
		Preset::Cargo => (
			"cargo",
			["check", "--message-format=json"]
				.into_iter()
				.map(Str::from)
				.collect(),
		),
		Preset::TypeScript => (
			"tsc",
			["--noEmit", "--pretty", "false"]
				.into_iter()
				.map(Str::from)
				.collect(),
		),
		Preset::Go => ("go", ["build", "./..."].into_iter().map(Str::from).collect()),
		Preset::Pyright => ("pyright", ["--outputjson"].into_iter().map(Str::from).collect()),
		Preset::Biome => (
			"biome",
			["lint", "--reporter=json"]
				.into_iter()
				.map(Str::from)
				.collect(),
		),
		Preset::SwiftLint => (
			"swiftlint",
			["lint", "--quiet", "--reporter", "json"]
				.into_iter()
				.map(Str::from)
				.collect(),
		),
		Preset::LspBinding => ("", Vec::new()),
	};
	if let Some(target) = target {
		args.push(target);
	}
	CheckerRequest {
		program: Str::from(program),
		args,
		cwd: workspace.to_path_buf(),
		line_limit: 50,
	}
}

/// Selects the nearest authority-discovered `go.work` directory, otherwise the
/// workspace.
pub fn go_workspace<'a>(
	file: &Path,
	workspace: &'a Path,
	go_work_directories: &'a [PathBuf],
) -> &'a Path {
	go_work_directories
		.iter()
		.filter(|directory| file.starts_with(directory.as_path()))
		.max_by_key(|directory| directory.components().count())
		.map_or(workspace, PathBuf::as_path)
}

/// Enforces the common 50-line projection bound.
pub fn bounded_lines(text: &str) -> Str {
	Str::from(text.lines().take(50).collect::<Vec<_>>().join("\n"))
}
/// Parses one checker completion into canonical source diagnostics.
pub fn parse_output(
	preset: Preset,
	output: &CheckerOutput,
) -> Result<Vec<Diagnostic>, CheckerFault> {
	let diagnostics = match preset {
		Preset::Cargo => parse_cargo(output.stdout.as_str())?,
		Preset::TypeScript => parse_delimited(output.stdout.as_str(), "typescript"),
		Preset::Go => parse_delimited(
			if output.stderr.is_empty() {
				output.stdout.as_str()
			} else {
				output.stderr.as_str()
			},
			"go",
		),
		Preset::Pyright => parse_pyright(output.stdout.as_str())?,
		Preset::Biome => parse_biome(output.stdout.as_str())?,
		Preset::SwiftLint => parse_swiftlint(output.stdout.as_str())?,
		Preset::LspBinding => parse_lsp_binding(output.stdout.as_str())?,
	};
	if diagnostics.is_empty() && output.status.is_some_and(|status| status != 0) {
		return Err(CheckerFault::ToolchainFailed);
	}
	Ok(diagnostics)
}

fn parse_cargo(text: &str) -> Result<Vec<Diagnostic>, CheckerFault> {
	let mut diagnostics = Vec::new();
	for line in text.lines().filter(|line| !line.trim().is_empty()) {
		let Ok(value) = serde_json::from_str::<Value>(line) else {
			continue;
		};
		if value.get("reason").and_then(Value::as_str) != Some("compiler-message") {
			continue;
		}
		let Some(message) = value.get("message") else {
			continue;
		};
		let level = message
			.get("level")
			.and_then(Value::as_str)
			.unwrap_or("error");
		let code = message
			.pointer("/code/code")
			.and_then(Value::as_str)
			.map(Str::from);
		let rendered = message
			.get("message")
			.and_then(Value::as_str)
			.unwrap_or("Rust compiler diagnostic");
		for span in message
			.get("spans")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter(|span| {
				span
					.get("is_primary")
					.and_then(Value::as_bool)
					.unwrap_or(false)
			}) {
			let Some(file) = span.get("file_name").and_then(Value::as_str) else {
				continue;
			};
			diagnostics.push(Diagnostic {
				uri:      Str::from(file),
				range:    range(
					span.get("line_start").and_then(Value::as_u64),
					span.get("column_start").and_then(Value::as_u64),
					span.get("line_end").and_then(Value::as_u64),
					span.get("column_end").and_then(Value::as_u64),
					true,
				),
				severity: severity(level),
				message:  Str::from(rendered),
				code:     code.clone(),
				source:   Str::new_static("cargo"),
			});
		}
	}
	Ok(diagnostics)
}

fn parse_delimited(text: &str, source: &'static str) -> Vec<Diagnostic> {
	text
		.lines()
		.filter_map(|line| {
			let (prefix, message) = line.split_once(": ")?;
			let (path, row, column) = parse_location(prefix)?;
			let (level, code, message) = parse_message(message);
			Some(Diagnostic {
				uri:      Str::from(path),
				range:    range(
					Some(row),
					Some(column),
					Some(row),
					Some(column.saturating_add(1)),
					true,
				),
				severity: severity(level),
				message:  Str::from(message),
				code:     code.map(Str::from),
				source:   Str::new_static(source),
			})
		})
		.collect()
}

fn parse_location(prefix: &str) -> Option<(&str, u64, u64)> {
	if let Some(open) = prefix.rfind('(')
		&& let Some(close) = prefix.rfind(')')
		&& close > open
	{
		let (row, column) = prefix.get(open + 1..close)?.split_once(',')?;
		return Some((prefix.get(..open)?, row.parse().ok()?, column.parse().ok()?));
	}
	let (before_column, column) = prefix.rsplit_once(':')?;
	let (path, row) = before_column.rsplit_once(':')?;
	Some((path, row.parse().ok()?, column.parse().ok()?))
}

fn parse_message(message: &str) -> (&str, Option<&str>, &str) {
	let (head, body) = message.split_once(": ").unwrap_or(("", message));
	let mut fields = head.split_whitespace();
	let level = fields.next().unwrap_or("error");
	let code = fields
		.next()
		.filter(|code| code.chars().any(|character| character.is_ascii_digit()));
	(level, code, body)
}

fn parse_pyright(text: &str) -> Result<Vec<Diagnostic>, CheckerFault> {
	let value: Value = serde_json::from_str(text).map_err(|_| CheckerFault::MalformedOutput)?;
	Ok(value
		.get("generalDiagnostics")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(|item| {
			Some(Diagnostic {
				uri:      Str::from(item.get("file")?.as_str()?),
				range:    json_range(item.get("range")?, false),
				severity: severity(
					item
						.get("severity")
						.and_then(Value::as_str)
						.unwrap_or("error"),
				),
				message:  Str::from(item.get("message")?.as_str()?),
				code:     item.get("rule").and_then(Value::as_str).map(Str::from),
				source:   Str::new_static("pyright"),
			})
		})
		.collect())
}

fn parse_biome(text: &str) -> Result<Vec<Diagnostic>, CheckerFault> {
	let value: Value = serde_json::from_str(text).map_err(|_| CheckerFault::MalformedOutput)?;
	let items = value
		.get("diagnostics")
		.or_else(|| value.get("items"))
		.and_then(Value::as_array)
		.ok_or(CheckerFault::MalformedOutput)?;
	Ok(items
		.iter()
		.filter_map(|item| {
			let location = item.get("location").unwrap_or(item);
			let uri = location
				.pointer("/path/file")
				.or_else(|| location.get("path"))
				.or_else(|| item.get("filePath"))
				.and_then(Value::as_str)?;
			let span = location.get("span").and_then(Value::as_array);
			let start = span
				.and_then(|span| span.first())
				.and_then(Value::as_u64)
				.unwrap_or(0);
			let end = span
				.and_then(|span| span.get(1))
				.and_then(Value::as_u64)
				.unwrap_or(start);
			Some(Diagnostic {
				uri:      Str::from(uri),
				range:    Range {
					start: Position {
						line:      0,
						character: u32::try_from(start).unwrap_or(u32::MAX),
					},
					end:   Position { line: 0, character: u32::try_from(end).unwrap_or(u32::MAX) },
				},
				severity: severity(
					item
						.get("severity")
						.and_then(Value::as_str)
						.unwrap_or("error"),
				),
				message:  Str::from(
					item
						.get("description")
						.or_else(|| item.get("message"))
						.and_then(Value::as_str)
						.unwrap_or("Biome diagnostic"),
				),
				code:     item.get("category").and_then(Value::as_str).map(Str::from),
				source:   Str::new_static("biome"),
			})
		})
		.collect())
}

fn parse_swiftlint(text: &str) -> Result<Vec<Diagnostic>, CheckerFault> {
	let value: Value = serde_json::from_str(text).map_err(|_| CheckerFault::MalformedOutput)?;
	let items = value.as_array().ok_or(CheckerFault::MalformedOutput)?;
	Ok(items
		.iter()
		.filter_map(|item| {
			let row = item.get("line").and_then(Value::as_u64).unwrap_or(1);
			let column = item.get("character").and_then(Value::as_u64).unwrap_or(1);
			Some(Diagnostic {
				uri:      Str::from(item.get("file")?.as_str()?),
				range:    range(
					Some(row),
					Some(column),
					Some(row),
					Some(column.saturating_add(1)),
					true,
				),
				severity: severity(
					item
						.get("severity")
						.and_then(Value::as_str)
						.unwrap_or("error"),
				),
				message:  Str::from(item.get("reason")?.as_str()?),
				code:     item.get("rule_id").and_then(Value::as_str).map(Str::from),
				source:   Str::new_static("swiftlint"),
			})
		})
		.collect())
}

fn parse_lsp_binding(text: &str) -> Result<Vec<Diagnostic>, CheckerFault> {
	let value: Value = serde_json::from_str(text).map_err(|_| CheckerFault::MalformedOutput)?;
	let uri = value.get("uri").and_then(Value::as_str).unwrap_or_default();
	let items = value
		.get("diagnostics")
		.or_else(|| value.get("items"))
		.and_then(Value::as_array)
		.ok_or(CheckerFault::MalformedOutput)?;
	Ok(items
		.iter()
		.filter_map(|item| {
			Some(Diagnostic {
				uri:      Str::from(item.get("uri").and_then(Value::as_str).unwrap_or(uri)),
				range:    json_range(item.get("range")?, false),
				severity: Severity::from_lsp(item.get("severity").and_then(Value::as_u64)),
				message:  Str::from(item.get("message")?.as_str()?),
				code:     item.get("code").and_then(Value::as_str).map(Str::from),
				source:   item
					.get("source")
					.and_then(Value::as_str)
					.map_or_else(|| Str::new_static("lsp"), Str::from),
			})
		})
		.collect())
}

fn json_range(value: &Value, one_based: bool) -> Range {
	range(
		value.pointer("/start/line").and_then(Value::as_u64),
		value.pointer("/start/character").and_then(Value::as_u64),
		value.pointer("/end/line").and_then(Value::as_u64),
		value.pointer("/end/character").and_then(Value::as_u64),
		one_based,
	)
}

fn range(
	start_line: Option<u64>,
	start_character: Option<u64>,
	end_line: Option<u64>,
	end_character: Option<u64>,
	one_based: bool,
) -> Range {
	let offset = u64::from(one_based);
	let position = |line: Option<u64>, character: Option<u64>| Position {
		line:      u32::try_from(line.unwrap_or(offset).saturating_sub(offset)).unwrap_or(u32::MAX),
		character: u32::try_from(character.unwrap_or(offset).saturating_sub(offset))
			.unwrap_or(u32::MAX),
	};
	Range {
		start: position(start_line, start_character),
		end:   position(end_line.or(start_line), end_character.or(start_character)),
	}
}

fn severity(level: &str) -> Severity {
	match level.to_ascii_lowercase().as_str() {
		"warning" | "warn" => Severity::Warning,
		"information" | "info" | "note" => Severity::Information,
		"hint" => Severity::Hint,
		_ => Severity::Error,
	}
}
#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_cargo_and_typescript_locations() {
		let cargo = CheckerOutput {
			status: Some(1),
			stdout: Str::from(
				r#"{"reason":"compiler-message","message":{"message":"mismatch","code":{"code":"E0308"},"level":"error","spans":[{"file_name":"src/lib.rs","line_start":4,"column_start":3,"line_end":4,"column_end":8,"is_primary":true}]}}"#,
			),
			stderr: Str::default(),
		};
		let diagnostics = parse_output(Preset::Cargo, &cargo).expect("cargo diagnostics");
		assert_eq!(diagnostics[0].uri.as_str(), "src/lib.rs");
		assert_eq!(diagnostics[0].range.start, Position { line: 3, character: 2 });
		assert_eq!(diagnostics[0].code.as_deref(), Some("E0308"));

		let tsc = CheckerOutput {
			status: Some(2),
			stdout: Str::from("src/main.ts(7,9): error TS2322: Type mismatch"),
			stderr: Str::default(),
		};
		let diagnostics = parse_output(Preset::TypeScript, &tsc).expect("tsc diagnostics");
		assert_eq!(diagnostics[0].range.start, Position { line: 6, character: 8 });
		assert_eq!(diagnostics[0].code.as_deref(), Some("TS2322"));
	}

	#[test]
	fn parses_pyright_biome_and_swiftlint_json() {
		let pyright = CheckerOutput {
			status: Some(1),
			stdout: Str::from(
				r#"{"generalDiagnostics":[{"file":"a.py","severity":"warning","message":"unused","rule":"reportUnusedImport","range":{"start":{"line":1,"character":2},"end":{"line":1,"character":3}}}]}"#,
			),
			stderr: Str::default(),
		};
		assert_eq!(
			parse_output(Preset::Pyright, &pyright).expect("pyright diagnostics")[0].severity,
			Severity::Warning
		);

		let biome = CheckerOutput {
			status: Some(1),
			stdout: Str::from(
				r#"{"diagnostics":[{"category":"lint/style","description":"style","severity":"warning","location":{"path":{"file":"a.ts"},"span":[4,8]}}]}"#,
			),
			stderr: Str::default(),
		};
		assert_eq!(
			parse_output(Preset::Biome, &biome).expect("biome diagnostics")[0]
				.uri
				.as_str(),
			"a.ts"
		);

		let swift = CheckerOutput {
			status: Some(2),
			stdout: Str::from(
				r#"[{"file":"A.swift","line":2,"character":4,"severity":"Warning","reason":"style","rule_id":"rule"}]"#,
			),
			stderr: Str::default(),
		};
		assert_eq!(
			parse_output(Preset::SwiftLint, &swift).expect("swiftlint diagnostics")[0]
				.range
				.start,
			Position { line: 1, character: 3 }
		);
	}
}
