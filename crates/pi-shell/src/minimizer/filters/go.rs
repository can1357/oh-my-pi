//! Go toolchain output filters.

use std::fmt::Write as _;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, subcommand: Option<&str>) -> bool {
	match program {
		"go" => matches!(subcommand, Some("test" | "build" | "vet" | "tool")),
		"golangci-lint" => matches!(subcommand, None | Some("run")),
		_ => false,
	}
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let text = if ctx.program == "golangci-lint" || is_go_tool_golangci_lint(ctx) {
		filter_golangci_lint(&cleaned)
	} else {
		match ctx.subcommand {
			Some("test") => filter_go_test(&cleaned, exit_code),
			Some("build") => filter_go_build(&cleaned, exit_code),
			Some("vet") => filter_go_vet(&cleaned),
			Some("tool") => input.to_string(),
			_ => compact_general(&cleaned),
		}
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

fn is_go_tool_golangci_lint(ctx: &MinimizerCtx<'_>) -> bool {
	if ctx.program != "go" || ctx.subcommand != Some("tool") {
		return false;
	}

	let mut saw_tool = false;
	for token in ctx.command.split_whitespace() {
		if saw_tool {
			return token == "golangci-lint";
		}
		if token == "tool" {
			saw_tool = true;
		}
	}
	false
}

fn filter_go_test(input: &str, exit_code: i32) -> String {
	// On success, no per-test/per-package detail carries signal: re-derive rtk's
	// aggregation against DEFAULT text (and opportunistic JSON), counting package
	// and test markers into a single summary line instead of echoing every PASS/ok.
	if exit_code == 0 {
		return aggregate_go_test_success(input);
	}

	let mut out = String::new();
	let mut kept = 0usize;
	let mut keep_next_after_location = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}

		if let Some(rendered) = render_go_test_json_line(trimmed) {
			let rendered_trimmed = rendered.trim();
			let keep_line = keep_next_after_location || should_keep_go_test_line(&rendered, exit_code);
			keep_next_after_location = is_go_location_line(rendered_trimmed);
			if keep_line {
				out.push_str(&rendered);
				out.push('\n');
				kept += 1;
			}
			continue;
		}

		let keep_line = keep_next_after_location || should_keep_go_test_line(trimmed, exit_code);
		keep_next_after_location = is_go_location_line(trimmed);
		if keep_line {
			out.push_str(line.trim_end());
			out.push('\n');
			kept += 1;
		}
	}

	if kept == 0 {
		return compact_general(input);
	}

	primitives::head_tail_lines(&primitives::dedup_consecutive_lines(&out), 140, 80)
}

/// Success-path aggregation: count package and test markers (re-derived for
/// DEFAULT text, with opportunistic JSON rendering) and emit one summary line.
fn aggregate_go_test_success(input: &str) -> String {
	// Benchmark output is signal — don't collapse it into a count.
	if input
		.lines()
		.any(|l| l.trim_start().starts_with("Benchmark"))
	{
		return primitives::head_tail_lines(input, 140, 80);
	}

	let mut packages_ok = 0usize;
	let mut no_tests = 0usize;
	let mut tests_skipped = 0usize;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			continue;
		}

		// Opportunistic JSON: render to the same text shape, then count.
		// Also check for JSON-wrapped benchmark output — those lines start with
		// "{" so the raw-line guard above misses them.  Bail to head_tail
		// early so benchmark results are never collapsed into a package count.
		if trimmed.starts_with('{')
			&& let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
			&& let Some(output) = value.get("Output").and_then(|v| v.as_str())
			&& output.trim_start().starts_with("Benchmark")
		{
			return primitives::head_tail_lines(input, 140, 80);
		}

		let candidate = render_go_test_json_line(trimmed);
		let line_to_count = candidate.as_deref().unwrap_or(trimmed);
		let lower = line_to_count.trim().to_ascii_lowercase();

		if lower.starts_with("ok\t") || lower.starts_with("ok  ") {
			packages_ok += 1;
		} else if lower.starts_with("?\t") || lower.starts_with("?   ") {
			no_tests += 1;
		} else if lower.starts_with("--- skip") {
			tests_skipped += 1;
		}
	}

	if packages_ok == 0 && no_tests == 0 && tests_skipped == 0 {
		return compact_general(input);
	}

	let mut summary = format!("go test: {packages_ok} packages ok");
	if no_tests > 0 {
		let _ = write!(summary, ", {no_tests} no tests");
	}
	if tests_skipped > 0 {
		let _ = write!(summary, ", {tests_skipped} tests skipped");
	}
	summary.push('\n');
	summary
}

fn render_go_test_json_line(line: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(line).ok()?;
	let action = value
		.get("Action")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);
	let package = value
		.get("Package")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);
	let test = value
		.get("Test")
		.and_then(|v| v.as_str())
		.map_or("", |value| value);

	if let Some(output) = value.get("Output").and_then(|v| v.as_str()) {
		let rendered = output.trim_end();
		if rendered.is_empty() {
			return None;
		}
		return Some(rendered.to_string());
	}

	match action {
		"fail" if !test.is_empty() => Some(format!("--- FAIL: {test}")),
		"fail" if !package.is_empty() => Some(format!("FAIL\t{package}")),
		"pass" if !package.is_empty() && test.is_empty() => None,
		"skip" if !test.is_empty() => Some(format!("--- SKIP: {test}")),
		_ => None,
	}
}

fn should_keep_go_test_line(line: &str, exit_code: i32) -> bool {
	let trimmed = line.trim();
	let lower = trimmed.to_ascii_lowercase();

	if exit_code == 0 {
		return trimmed.starts_with("--- PASS")
			|| trimmed.starts_with("--- SKIP")
			|| lower.starts_with("ok\t")
			|| lower.starts_with("ok  ")
			|| lower.starts_with("?\t");
	}

	trimmed.starts_with("FAIL")
		|| trimmed.starts_with("--- FAIL")
		|| trimmed.starts_with("panic:")
		|| trimmed.starts_with("# ")
		|| is_go_location_line(trimmed)
		|| lower.contains("error:")
		|| lower.contains("fatal")
		|| lower.contains("failed")
		|| lower.contains("expected")
		|| lower.contains("actual")
		|| lower.contains("got") && lower.contains("want")
		|| lower.contains("assert")
		|| lower.contains("killed with quit")
		|| lower.starts_with("ok\t")
		|| lower.starts_with("ok  ")
		|| lower.starts_with("?\t")
		|| exit_code != 0 && (lower.contains("timeout") || lower.contains("signal"))
}

fn filter_go_build(input: &str, exit_code: i32) -> String {
	let mut out = String::new();
	let mut saw_diagnostic = false;

	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_go_noise(trimmed) {
			continue;
		}
		if trimmed.starts_with("# ")
			|| is_go_build_diagnostic(trimmed)
			|| exit_code != 0 && looks_like_go_error(trimmed)
		{
			saw_diagnostic = true;
			out.push_str(trimmed);
			out.push('\n');
		}
	}

	if !saw_diagnostic {
		return compact_general(input);
	}

	let grouped = primitives::group_by_file(&out, 24);
	primitives::head_tail_lines(&grouped, 120, 80)
}

fn filter_go_vet(input: &str) -> String {
	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || trimmed.starts_with("# ") {
			continue;
		}
		if is_go_location_line(trimmed) || looks_like_go_error(trimmed) {
			out.push_str(trimmed);
			out.push('\n');
		}
	}

	if out.is_empty() {
		return compact_general(input);
	}

	let grouped = primitives::group_by_file(&out, 24);
	primitives::head_tail_lines(&grouped, 120, 80)
}

fn filter_golangci_lint(input: &str) -> String {
	if let Some(json_line) = input
		.lines()
		.find(|line| line.trim_start().starts_with('{'))
		&& let Some(summary) = summarize_golangci_json(json_line.trim())
	{
		return summary;
	}

	let mut out = String::new();
	for line in input.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() || is_golangci_noise(trimmed) {
			continue;
		}
		out.push_str(trimmed);
		out.push('\n');
	}

	if out.is_empty() {
		compact_general(input)
	} else {
		let grouped = primitives::group_by_file(&out, 24);
		primitives::head_tail_lines(&grouped, 160, 80)
	}
}

fn summarize_golangci_json(line: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(line).ok()?;
	let issues = value.get("Issues")?.as_array()?;
	if issues.is_empty() {
		return Some("golangci-lint: no issues found\n".to_string());
	}

	let mut out = format!("golangci-lint: {} issues\n", issues.len());
	for issue in issues.iter().take(40) {
		let file = issue
			.get("Pos")
			.and_then(|pos| pos.get("Filename"))
			.and_then(|v| v.as_str())
			.map_or("<unknown>", |value| value);
		let line_no = issue
			.get("Pos")
			.and_then(|pos| pos.get("Line"))
			.and_then(serde_json::Value::as_u64)
			.unwrap_or(0);
		let col_no = issue
			.get("Pos")
			.and_then(|pos| pos.get("Column"))
			.and_then(serde_json::Value::as_u64)
			.unwrap_or(0);
		let linter = issue
			.get("FromLinter")
			.and_then(|v| v.as_str())
			.map_or("lint", |value| value);
		let text = issue
			.get("Text")
			.and_then(|v| v.as_str())
			.map_or("", |value| value);
		out.push_str(file);
		out.push(':');
		out.push_str(&line_no.to_string());
		out.push(':');
		out.push_str(&col_no.to_string());
		out.push_str(": ");
		out.push_str(text);
		out.push_str(" (");
		out.push_str(linter);
		out.push_str(")\n");
	}
	if issues.len() > 40 {
		out.push_str("[…");
		out.push_str(&(issues.len() - 40).to_string());
		out.push_str(" issues elided…]\n");
	}
	Some(out)
}

fn compact_general(input: &str) -> String {
	let stripped = primitives::strip_lines(input, &[is_go_noise]);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	primitives::head_tail_lines(&deduped, 100, 60)
}

fn is_go_build_diagnostic(line: &str) -> bool {
	is_go_location_line(line)
		|| line.contains("go.mod:")
		|| line.contains("go.work:")
		|| line.contains("go.sum:")
}

fn is_go_location_line(line: &str) -> bool {
	line.contains(".go:")
}

fn looks_like_go_error(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.starts_with("undefined: ")
		|| lower.starts_with("cannot use ")
		|| lower.starts_with("cannot find package ")
		|| lower.starts_with("no required module provides package ")
		|| lower.starts_with("missing go.sum entry")
		|| lower.starts_with("found packages ")
		|| lower.starts_with("pattern ")
		|| lower.starts_with("no go files in ")
		|| lower.starts_with("go: cannot load module ")
		|| lower.starts_with("go: updates to go.mod needed")
		|| lower.starts_with("go: inconsistent vendoring")
		|| lower.starts_with("go: ")
			&& (lower.contains("error") || lower.contains("failed") || lower.contains("not found"))
		|| lower.contains("import cycle not allowed")
		|| lower.contains("build constraints exclude all go files")
		|| lower.contains("function main is undeclared in the main package")
}

fn is_go_noise(line: &str) -> bool {
	let lower = line.trim_start().to_ascii_lowercase();
	lower.starts_with("go: downloading ")
		|| lower.starts_with("go: finding ")
		|| lower.starts_with("go: extracting ")
		|| lower.starts_with("go: upgraded ")
		|| lower.starts_with("go: added ")
}

fn is_golangci_noise(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	// Strip runner-log info/warn chatter (snip strips `^level=` wholesale), but
	// DELIBERATELY KEEP `level=error` — those lines carry config/typecheck failures
	// that would otherwise vanish silently.
	// `level=error` carries config/typecheck failures (incl. the canonical
	// `level=error msg="[linters_context]…"` typecheck headline) — never strip it,
	// even when it routes through the linters_context component.
	if lower.starts_with("level=error") {
		return false;
	}
	lower.starts_with("level=info")
		|| lower.starts_with("level=warning")
		|| lower.starts_with("level=warn")
		|| lower.starts_with("level=") && lower.contains("msg=\"[linters_context]")
		|| lower.starts_with("golangci-lint has version")
		|| lower.starts_with("running ") && lower.contains("linters")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	#[test]
	fn keeps_go_test_failure_from_json_lines() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test ./...",
			config:     &cfg,
		};
		let input = r#"{"Action":"run","Package":"example.com/app","Test":"TestBad"}
{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"=== RUN   TestBad\n"}
{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"    app_test.go:12: expected 2, got 1\n"}
{"Action":"fail","Package":"example.com/app","Test":"TestBad"}
{"Action":"fail","Package":"example.com/app"}
"#;

		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("app_test.go:12"));
		assert!(out.text.contains("expected 2, got 1"));
		assert!(out.text.contains("--- FAIL: TestBad"));
		assert!(!out.text.contains("=== RUN"));
	}

	#[test]
	fn keeps_go_test_json_location_followup_context() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test -json ./...",
			config:     &cfg,
		};
		let input = r#"{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"    app_test.go:42:\n"}
	{"Action":"output","Package":"example.com/app","Test":"TestBad","Output":"        important table diff without keywords\n"}
	{"Action":"output","Package":"example.com/app","Output":"Test killed with quit: ran too long\n"}
	{"Action":"fail","Package":"example.com/app","Test":"TestBad"}
	"#;

		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("app_test.go:42:"));
		assert!(out.text.contains("important table diff without keywords"));
		assert!(out.text.contains("Test killed with quit"));
	}

	#[test]
	fn go_test_verbose_success_aggregates_to_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test ./... -v",
			config:     &cfg,
		};
		let input = "=== RUN   TestControllers\nRunning Suite: Controller Suite\nSUCCESS! -- 1 \
		             Passed | 0 Failed | 0 Pending\n--- PASS: TestControllers (6.04s)\nPASS\nok  \
		             kubecraft.ai/.../controller  6.610s\n=== RUN   TestNewClient\n--- PASS: \
		             TestNewClient (0.00s)\nPASS\nok  kubecraft.ai/.../llm  0.776s\n";
		let out = filter(&ctx, input, 0);
		// On success the two `ok` packages collapse to one summary line; the per-test
		// PASS lines and `=== RUN`/ginkgo banner noise disappear.
		assert!(out.text.contains("go test: 2 packages ok"));
		assert!(!out.text.contains("--- PASS"));
		assert!(!out.text.contains("=== RUN"));
		assert!(!out.text.contains("SUCCESS!"));
	}

	#[test]
	fn go_test_success_default_text_counts_no_tests_and_skips() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("test"),
			command:    "go test ./...",
			config:     &cfg,
		};
		let input = "ok  \texample.com/a\t0.10s\n?   \texample.com/b\t[no test files]\nok  \
		             \texample.com/c\t0.20s\n--- SKIP: TestSkipped (0.00s)\nok  \
		             \texample.com/d\t0.30s\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text.trim(), "go test: 3 packages ok, 1 no tests, 1 tests skipped");
	}

	#[test]
	fn summarizes_golangci_json_issues() {
		let input = r#"{"Issues":[{"FromLinter":"govet","Text":"unreachable code","Pos":{"Filename":"main.go","Line":7,"Column":2}}]}"#;
		let out = filter_golangci_lint(input);
		assert!(out.contains("golangci-lint: 1 issues"));
		assert!(out.contains("main.go:7:2: unreachable code (govet)"));

		// Match up-to-40 limits, testing elison formatting
		let mut many_issues = r#"{"Issues":["#.to_string();
		for i in 0..42 {
			if i > 0 {
				many_issues.push(',');
			}
			let _ = write!(
				many_issues,
				r#"{{"FromLinter":"govet","Text":"err {i}","Pos":{{"Filename":"main.go","Line":{i},"Column":2}}}}"#
			);
		}
		many_issues.push_str("]}");
		let out_many = filter_golangci_lint(&many_issues);
		assert!(out_many.contains("golangci-lint: 42 issues"));
		assert!(out_many.contains("[…2 issues elided…]"));
	}

	#[test]
	fn go_tool_golangci_lint_is_filtered() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("tool"),
			command:    "go tool golangci-lint run ./...",
			config:     &cfg,
		};
		let input = r#"{"Issues":[{"FromLinter":"govet","Text":"bad","Pos":{"Filename":"main.go","Line":7,"Column":2}}]}"#;
		let out = filter(&ctx, input, 1);
		assert!(out.changed);
		assert!(out.text.contains("main.go:7:2: bad (govet)"));
	}

	#[test]
	fn looks_like_go_error_recognizes_non_location_error_shapes() {
		// Ported from rtk go_cmd inline inputs: module/compiler failures that carry
		// no file.go:line:col location must still register as errors.
		assert!(looks_like_go_error("undefined: missingFunc"));
		assert!(looks_like_go_error("cannot find package \"foo/bar\""));
		assert!(looks_like_go_error(
			"found packages a (a.go) and b (b.go) in /tmp/rtk-go-build-probe-mix"
		));
		assert!(looks_like_go_error("imports example.com/cycle/a: import cycle not allowed"));
		assert!(looks_like_go_error(
			"package example.com/buildtag: build constraints exclude all Go files in /tmp/x"
		));
		assert!(looks_like_go_error("no Go files in /tmp/example"));
		assert!(looks_like_go_error(
			"go: cannot load module missing listed in go.work file: open missing/go.mod: no such \
			 file or directory"
		));
		assert!(looks_like_go_error("go: updates to go.mod needed; to update it: go mod tidy"));
		assert!(looks_like_go_error(
			"go: inconsistent vendoring in /tmp/example: run 'go mod vendor' to sync"
		));
		assert!(looks_like_go_error(
			"runtime.main_main·f: function main is undeclared in the main package"
		));
		assert!(looks_like_go_error(
			"pattern ./...: directory prefix . does not contain main module or its selected \
			 dependencies"
		));
		// go.mod-not-found is already covered via the `go: ... not found` arm.
		assert!(looks_like_go_error(
			"go: go.mod file not found in current directory or any parent directory; see 'go help \
			 modules'"
		));
		// NOTE: `go: downloading …/errors …` trips the broad `go: …error…` arm,
		// but `is_go_noise` strips those lines upstream in filter_go_build
		// before this helper runs, so the build-level test below is the real
		// guard.
	}

	#[test]
	fn go_build_failure_preserves_non_location_error_shapes() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("build"),
			command:    "go build ./...",
			config:     &cfg,
		};
		let input = "pattern ./...: directory prefix . does not contain main module or its selected \
		             dependencies\nno Go files in /tmp/example\ngo: inconsistent vendoring in \
		             /tmp/x: run 'go mod vendor'\nruntime.main_main·f: function main is undeclared \
		             in the main package\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("does not contain main module"));
		assert!(out.text.contains("no Go files in /tmp/example"));
		assert!(out.text.contains("inconsistent vendoring"));
		assert!(
			out.text
				.contains("function main is undeclared in the main package")
		);
	}

	#[test]
	fn golangci_strips_info_warn_but_keeps_level_error() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "golangci-lint",
			subcommand: Some("run"),
			command:    "golangci-lint run ./...",
			config:     &cfg,
		};
		// Real default (non-json) golangci run: the typecheck headline is emitted by
		// the logrus logger in its canonical `level=error msg="[linters_context]…"`
		// shape — the exact format that must survive. Surrounding runner chatter
		// (incl. a warn-level linters_context line) is stripped.
		let input = "level=info Active 5 linters\nlevel=warning The linter 'deadcode' is \
		             deprecated\nlevel=warning msg=\"[linters_context] stale cache\"\nlevel=error \
		             msg=\"[linters_context] typechecking error: cannot find \
		             package\"\nmain.go:10:2: undefined: Foo (typecheck)\n";
		let out = filter(&ctx, input, 1);
		assert!(out.text.contains("level=error"));
		assert!(out.text.contains("typechecking error"));
		// `group_by_file` regroups the per-issue line under a `main.go:` header,
		// so assert on the surviving location + linter, not the joined string.
		assert!(out.text.contains("main.go"));
		assert!(out.text.contains("undefined: Foo (typecheck)"));
		assert!(!out.text.contains("level=info"));
		assert!(!out.text.contains("level=warning"));
		// The warn-level linters_context chatter is still dropped — the keep is
		// scoped to error level, not to every linters_context line.
		assert!(!out.text.contains("stale cache"));
	}

	#[test]
	fn unknown_go_tool_is_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = MinimizerCtx {
			program:    "go",
			subcommand: Some("tool"),
			command:    "go tool pprof profile.out",
			config:     &cfg,
		};
		let input = "Type: cpu\nShowing nodes accounting for 10ms\ngo: downloading noise\n";
		let out = filter(&ctx, input, 0);
		assert_eq!(out.text, input);
		assert!(!out.changed);
	}

	#[test]
	fn go_json_no_double_count() {
		// A -json stream has both an Output "ok\t{pkg}" line AND a pass event.
		// We must count only once.
		let json = "{\"Action\":\"output\",\"Package\":\"example/pkg\",\"Output\":\"ok\\texample/\
		            pkg\\n\"}\n{\"Action\":\"pass\",\"Package\":\"example/pkg\",\"Elapsed\":0.123}\n";
		let result = aggregate_go_test_success(json);
		assert!(result.contains("1 packages ok"), "got: {result}");
		assert!(!result.contains("2 packages ok"), "double-counted: {result}");
	}

	#[test]
	fn go_benchmark_preserved_on_success() {
		let input = "BenchmarkFoo-8\t1000000\t1234 ns/op\nok\texample/pkg\t1.234s\n";
		let result = filter_go_test(input, 0);
		assert!(result.contains("BenchmarkFoo"), "benchmark stripped: {result}");
	}

	#[test]
	fn test_json_benchmark_preserved() {
		let input = r#"{"Action":"run","Test":"BenchmarkFoo"}
{"Action":"output","Output":"BenchmarkFoo-8   1000   1234 ns/op\n"}
{"Action":"output","Output":"ok  example.com/pkg  1.234s\n"}
{"Action":"pass","Elapsed":1.234}"#;
		let result = aggregate_go_test_success(input);
		// Should NOT produce "packages ok" summary — should return head_tail of input
		assert!(!result.contains("packages ok"), "benchmark json run must not be collapsed");
		assert!(result.contains("BenchmarkFoo"), "benchmark lines must survive");
	}
}
