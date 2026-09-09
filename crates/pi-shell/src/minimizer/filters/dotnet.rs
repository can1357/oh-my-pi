//! .NET CLI output filters.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	program == "dotnet" && matches!(subcommand, Some("build" | "test" | "restore" | "format"))
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.subcommand {
		Some("build") => filter_build_like("dotnet build", &cleaned, exit_code),
		Some("test") => filter_test(&cleaned, exit_code),
		Some("restore") => filter_build_like("dotnet restore", &cleaned, exit_code),
		Some("format") => filter_format(&cleaned),
		_ => compact_general(&cleaned),
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn filter_build_like(label: &str, input: &str, exit_code: i32) -> String {
	let mut diagnostics = String::new();
	let mut summaries = String::new();

	if exit_code == 0 && matches!(label, "dotnet build" | "dotnet restore") {
		let lines: Vec<&str> = input.lines().collect();
		// Find the LAST occurrence of "0 Warning(s)" followed by indented "0 Error(s)".
		let mut last_match = None;
		for i in 0..lines.len().saturating_sub(1) {
			if lines[i].trim() == "0 Warning(s)"
				&& lines[i + 1].trim() == "0 Error(s)"
				&& lines[i + 1].starts_with(char::is_whitespace)
			{
				last_match = Some(i);
			}
		}
		if let Some(i) = last_match {
			// Only short-circuit if no warnings or errors appear after this pair.
			let has_later_issues = lines[i + 2..].iter().any(|line| {
				let trimmed = line.trim();
				let lower = trimmed.to_ascii_lowercase();
				let is_count_summary = (lower.ends_with("warning(s)") || lower.ends_with("error(s)"))
					&& trimmed
						.split_whitespace()
						.next()
						.is_some_and(|first| first.chars().all(|c| c.is_ascii_digit()));
				let is_later_failure = lower.starts_with("failed! ")
					|| lower.starts_with("failed ")
					|| lower.starts_with("error ")
					|| lower.starts_with("warning ");
				is_count_summary || is_msbuild_diagnostic(trimmed) || is_later_failure
			});
			if !has_later_issues {
				let noun = if label == "dotnet restore" {
					"restore"
				} else {
					"build"
				};
				return format!("ok ({noun} succeeded)\n");
			}
		}
	}

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_dotnet_boilerplate(trimmed) {
			continue;
		}
		let truncated = primitives::truncate_line(trimmed, primitives::CapClass::Errors.lines());
		if is_dotnet_summary(trimmed) {
			summaries.push_str(&truncated);
			summaries.push('\n');
		} else if is_msbuild_diagnostic(trimmed) || is_failure_line(trimmed) {
			diagnostics.push_str(&truncated);
			diagnostics.push('\n');
		}
	}

	let mut out = String::new();
	if exit_code != 0 {
		out.push_str(label);
		out.push_str(": failed\n");
	}
	out.push_str(&primitives::group_by_file(&diagnostics, 24));
	out.push_str(&summaries);

	if out.trim().is_empty() {
		compact_general(input)
	} else {
		primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 140, 80)
	}
}

fn filter_test(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut in_failed_test = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_dotnet_boilerplate(trimmed) {
			continue;
		}
		let truncated = primitives::truncate_line(trimmed, primitives::CapClass::Errors.lines());

		if is_failed_test_start(trimmed) {
			in_failed_test = true;
			out.push_str(&truncated);
			out.push('\n');
			continue;
		}

		if in_failed_test {
			if is_test_section_boundary(trimmed) {
				in_failed_test = false;
			} else {
				out.push_str(&truncated);
				out.push('\n');
				continue;
			}
		}

		if is_msbuild_diagnostic(trimmed) || is_failure_line(trimmed) || is_test_summary(trimmed) {
			out.push_str(&truncated);
			out.push('\n');
		}
	}

	if out.trim().is_empty() {
		return filter_build_like("dotnet test", input, exit_code);
	}

	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 180, 100)
}

fn filter_format(input: &str) -> String {
	let trimmed = input.trim();
	if (trimmed.starts_with('{') || trimmed.starts_with('['))
		&& let Some(out) = compact_format_json(trimmed)
	{
		return out;
	}

	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_dotnet_format_noise(trimmed) {
			continue;
		}
		let truncated = primitives::truncate_line(trimmed, primitives::CapClass::Errors.lines());
		if is_msbuild_diagnostic(trimmed)
			|| looks_like_path(trimmed)
			|| contains_format_signal(trimmed)
		{
			out.push_str(&truncated);
			out.push('\n');
		}
	}

	if out.is_empty() {
		compact_general(input)
	} else {
		primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 140, 80)
	}
}

fn compact_format_json(input: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(input).ok()?;
	let mut rows = Vec::new();
	collect_format_json_rows(&value, None, &mut rows);
	if rows.is_empty() {
		return Some("dotnet format: no diagnostics in report\n".to_string());
	}

	let mut out = format!("dotnet format: {} diagnostics\n", rows.len());
	for row in rows.iter().take(40) {
		out.push_str(&primitives::truncate_line(row, primitives::CapClass::Errors.lines()));
		out.push('\n');
	}
	if rows.len() > 40 {
		out.push_str("[…");
		out.push_str(&(rows.len() - 40).to_string());
		out.push_str(" diagnostics elided…]\n");
	}
	Some(out)
}

fn collect_format_json_rows(
	value: &serde_json::Value,
	inherited_path: Option<&str>,
	rows: &mut Vec<String>,
) {
	match value {
		serde_json::Value::Object(map) => {
			let path =
				first_string(map, &["FileName", "FilePath", "Path", "DocumentPath"]).or(inherited_path);
			let diagnostic = first_string(map, &["DiagnosticId", "Id", "RuleId"]);
			let message = first_string(map, &["Message", "FormatDescription", "Description"]);
			let line = first_number(map, &["LineNumber", "Line"]);
			let column = first_number(map, &["CharNumber", "Column"]);

			if diagnostic.is_some() || message.is_some() || line.is_some() {
				let mut row = if let Some(path) = path {
					path.to_string()
				} else {
					"<unknown>".to_string()
				};
				if let Some(line) = line {
					row.push(':');
					row.push_str(&line.to_string());
				}
				if let Some(column) = column {
					row.push(':');
					row.push_str(&column.to_string());
				}
				if let Some(diagnostic) = diagnostic {
					row.push_str(": ");
					row.push_str(diagnostic);
				}
				if let Some(message) = message {
					if diagnostic.is_none() {
						row.push_str(": ");
					} else {
						row.push_str(" - ");
					}
					row.push_str(message);
				}
				rows.push(row);
			}

			for child in map.values() {
				collect_format_json_rows(child, path, rows);
			}
		},
		serde_json::Value::Array(items) => {
			for item in items {
				collect_format_json_rows(item, inherited_path, rows);
			}
		},
		_ => {},
	}
}

fn first_string<'a>(
	map: &'a serde_json::Map<String, serde_json::Value>,
	keys: &[&str],
) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(|value| value.as_str()))
}

fn first_number(map: &serde_json::Map<String, serde_json::Value>, keys: &[&str]) -> Option<u64> {
	keys
		.iter()
		.find_map(|key| map.get(*key).and_then(serde_json::Value::as_u64))
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_dotnet_boilerplate]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 120, 80)
}

fn is_dotnet_boilerplate(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("determining projects to restore")
		|| lower.starts_with("all projects are up-to-date for restore")
		|| lower.starts_with("restored ") && !contains_diagnostic_signal(&lower)
		|| lower.starts_with("build started")
		|| lower.starts_with("test run for ")
		|| lower.starts_with("starting test execution")
		|| lower.starts_with("a total of ") && lower.contains("test files matched")
}

fn is_dotnet_format_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	is_dotnet_boilerplate(line)
		|| lower.starts_with("formatting code files")
		|| lower.starts_with("running formatters")
		|| lower.starts_with("  formatted ") && !contains_diagnostic_signal(&lower)
}

fn is_msbuild_diagnostic(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	looks_like_msbuild_location(line) && (lower.contains("error") || lower.contains("warning"))
}

fn looks_like_msbuild_location(line: &str) -> bool {
	line.contains(":line ")
		|| line.contains(".cs(")
		|| line.contains(".fs(")
		|| line.contains(".vb(")
		|| line.contains(".csproj")
		|| line.contains(".fsproj")
		|| line.contains(".vbproj")
		|| line.contains(".sln")
}

fn looks_like_path(line: &str) -> bool {
	line.contains('/')
		|| line.contains('\\')
		|| line.contains(".cs")
		|| line.contains(".fs")
		|| line.contains(".vb")
}

fn is_failure_line(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	contains_diagnostic_signal(&lower)
		|| lower.starts_with("failed! ")
		|| lower.starts_with("failed ")
		|| lower.starts_with("error ")
		|| lower.starts_with("warning ")
}

fn is_dotnet_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("build failed")
		|| lower.starts_with("restore failed")
		|| lower.starts_with("build succeeded")
		|| lower.starts_with("restore succeeded")
		|| lower.starts_with("time elapsed")
		|| lower.contains(" error(s)")
		|| lower.contains(" warning(s)")
		|| lower.contains(" -> ")
}

fn is_test_summary(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("total tests:")
		|| lower.starts_with("passed:")
		|| lower.starts_with("failed:")
		|| lower.starts_with("skipped:")
		|| lower.starts_with("test run failed")
		|| lower.starts_with("test run successful")
		|| lower.contains("failed:") && lower.contains("passed:")
}

fn is_failed_test_start(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("failed ") || lower.starts_with("[fail]") || lower.contains(" failed [")
}

fn is_test_section_boundary(line: &str) -> bool {
	is_test_summary(line) || line.starts_with("Passed ") || line.starts_with("Skipped ")
}

fn contains_format_signal(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("format")
		|| lower.contains("whitespace")
		|| lower.contains("diagnostic")
		|| lower.contains("files formatted")
		|| lower.contains("files need formatting")
}

fn contains_diagnostic_signal(lower: &str) -> bool {
	lower.contains("error")
		|| lower.contains("warning")
		|| lower.contains("failed")
		|| lower.contains("exception")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn keeps_dotnet_build_diagnostic_and_strips_restore_noise() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		let input = "  Determining projects to restore...\n  Restored app.csproj (in 1 \
		             sec).\nProgram.cs(10,5): error CS1002: ; expected [/repo/app.csproj]\nBuild \
		             FAILED.\n    0 Warning(s)\n    1 Error(s)\n";

		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("dotnet build: failed"));
		assert!(out.text.contains("Program.cs(10,5): error CS1002"));
		assert!(out.text.contains("1 Error(s)"));
		assert!(!out.text.contains("Determining projects"));
		assert!(!out.text.contains("Restored app.csproj"));
	}

	#[test]
	fn compacts_dotnet_format_json_report() {
		let input = r#"{"FileName":"src/App.cs","Changes":[{"DiagnosticId":"IDE0055","LineNumber":4,"CharNumber":9,"FormatDescription":"Fix formatting"}]}"#;
		let out = filter_format(input);
		assert!(out.contains("dotnet format: 1 diagnostics"));
		assert!(out.contains("src/App.cs:4:9"));
		assert!(out.contains("IDE0055"));
	}

	#[test]
	fn dotnet_build_success_short_circuits() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		let input = "Microsoft (R) Build Engine version 17.8.3+195e7f5a3\nCopyright (C) Microsoft \
		             Corporation. All rights reserved.\n\nDetermining projects to restore...\nAll \
		             projects are up-to-date for restore.\nMyApp -> \
		             /home/user/MyApp/bin/Debug/net8.0/MyApp.dll\n\nBuild succeeded.\n    0 \
		             Warning(s)\n    0 Error(s)\n\nTime Elapsed 00:00:02.34\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok (build succeeded)\n");
	}

	#[test]
	fn dotnet_restore_success_short_circuits() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("restore"),
			command:    "dotnet restore",
			config:     &cfg,
		};
		let input = "Microsoft (R) Build Engine version 17.8.3+195e7f5a3\nCopyright (C) Microsoft \
		             Corporation. All rights reserved.\n\n  Determining projects to restore...\n  \
		             All projects are up-to-date for restore.\n\n  0 Warning(s)\n  0 \
		             Error(s)\n\nTime Elapsed 00:00:01.23\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, "ok (restore succeeded)\n");
	}

	#[test]
	fn dotnet_build_unindented_summary_not_short_circuited() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		// Real warnings appear after an early unindented "0 Warning(s)" line;
		// the def's regex required consecutive lines with the second indented.
		let input = "pre-build validation: 0 Warning(s)\nSome other line\nsrc/Program.cs(1,1): \
		             warning CS8600: Converting null literal or possible null value to non-nullable \
		             type\nBuild succeeded.\n    1 Warning(s)\n    0 Error(s)\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.text.contains("ok (build succeeded)"));
		assert!(out.text.contains("1 Warning(s)"));
	}

	#[test]
	fn dotnet_build_consecutive_unindented_summary_not_short_circuited() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		// The def's regex required the second line to be indented (\s+);
		// consecutive unindented lines must not short-circuit.
		let input = "Build succeeded.\n0 Warning(s)\n0 Error(s)\n";
		let out = filter(&ctx, input, 0);
		assert!(!out.text.contains("ok (build succeeded)"));
		assert!(out.text.contains("0 Warning(s)"));
	}

	#[test]
	fn dotnet_build_with_warnings_not_short_circuited() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		let input = "Microsoft (R) Build Engine version 17.8.3+195e7f5a3\nCopyright (C) Microsoft \
		             Corporation. All rights reserved.\n\nDetermining projects to restore...\nMyApp \
		             -> /home/user/MyApp/bin/Debug/net8.0/MyApp.dll\n\nBuild succeeded.\n3 \
		             Warning(s)\n0 Error(s)\n\nTime Elapsed 00:00:01.87\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(
			out.text,
			"MyApp -> /home/user/MyApp/bin/Debug/net8.0/MyApp.dll\nBuild succeeded.\n3 Warning(s)\n0 \
			 Error(s)\nTime Elapsed 00:00:01.87\n"
		);
	}

	#[test]
	fn dotnet_build_errors_preserved() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		let input = "Microsoft (R) Build Engine version 17.8.3+195e7f5a3\nCopyright (C) Microsoft \
		             Corporation. All rights reserved.\n\nDetermining projects to \
		             restore...\nsrc/Program.cs(10,5): error CS1002: ; expected \
		             [/home/user/MyApp/MyApp.csproj]\n\nBuild FAILED.\n0 Warning(s)\n1 Error(s)\n";
		let out = filter(&ctx, input, 1);
		assert_eq!(
			out.text,
			"dotnet build: failed\nsrc/Program.cs(10,5): error CS1002: ; expected \
			 [/home/user/MyApp/MyApp.csproj]\nBuild FAILED.\n0 Warning(s)\n1 Error(s)\n"
		);
	}

	#[test]
	fn truncates_long_lines_in_build_output() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "dotnet",
			subcommand: Some("build"),
			command:    "dotnet build",
			config:     &cfg,
		};
		let long_tail = "x".repeat(200);
		let input = format!(
			"src/Program.cs(1,1): error CS0000: {long_tail}\nBuild FAILED.\n    0 Warning(s)\n    1 \
			 Error(s)\n"
		);
		let out = filter(&ctx, &input, 1);
		let line = out
			.text
			.lines()
			.find(|l| l.starts_with("src/Program.cs"))
			.unwrap();
		let prefix_len = "src/Program.cs(1,1): error CS0000: ".chars().count();
		let dropped = (prefix_len + long_tail.chars().count())
			.saturating_sub(primitives::CapClass::Errors.lines());
		assert!(line.ends_with(&format!("…[+{dropped}]")));
	}

	#[test]
	fn truncates_long_lines_in_test_output() {
		let long_tail = "x".repeat(200);
		let input = format!("Failed TestMethod\n  Stack trace: {long_tail}\nTotal tests: 1\n");
		let out = filter_test(&input, 1);
		let line = out.lines().find(|l| l.starts_with("Stack trace:")).unwrap();
		let prefix_len = "Stack trace: ".chars().count();
		let dropped = (prefix_len + long_tail.chars().count())
			.saturating_sub(primitives::CapClass::Errors.lines());
		assert!(line.ends_with(&format!("…[+{dropped}]")));
	}

	#[test]
	fn truncates_long_lines_in_format_text_output() {
		let long_tail = "x".repeat(200);
		let input = format!("src/Program.cs(1,1): warning CS8600: {long_tail}\n");
		let out = filter_format(&input);
		let line = out.lines().next().unwrap();
		let prefix_len = "src/Program.cs(1,1): warning CS8600: ".chars().count();
		let dropped = (prefix_len + long_tail.chars().count())
			.saturating_sub(primitives::CapClass::Errors.lines());
		assert!(line.ends_with(&format!("…[+{dropped}]")));
	}

	#[test]
	fn truncates_long_lines_in_format_json_output() {
		let long_tail = "x".repeat(200);
		let input = format!(
			r#"{{"FileName":"src/App.cs","Changes":[{{"DiagnosticId":"IDE0055","LineNumber":4,"CharNumber":9,"FormatDescription":"Fix formatting {long_tail}"}}]}}"#
		);
		let out = filter_format(&input);
		let line = out.lines().find(|l| l.starts_with("src/App.cs")).unwrap();
		let prefix_len = "src/App.cs:4:9: IDE0055 - Fix formatting ".chars().count();
		let dropped = (prefix_len + long_tail.chars().count())
			.saturating_sub(primitives::CapClass::Errors.lines());
		assert!(line.ends_with(&format!("…[+{dropped}]")));
	}
}
