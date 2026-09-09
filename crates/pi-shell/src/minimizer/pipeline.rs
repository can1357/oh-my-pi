//! Declarative filter pipelines loaded from TOML.
//!
//! Companion to the Rust-native filters in [`filters`](super::filters). A
//! pipeline is a small, data-driven transform compiled from a TOML definition
//! that ships either as a built-in (concatenated at build time) or supplied
//! through a user-provided settings file via [`MinimizerConfig`].
//!
//! ## Pipeline stages (applied in order)
//!
//! 1. `strip_ansi`           — remove ANSI CSI escape codes
//! 2. `replace`              — ordered regex substitutions, line-by-line
//! 3. `match_output`         — short-circuit to a one-line summary when the
//!    full output blob matches, honoring an optional `unless` anti-pattern
//! 4. `strip_lines_matching` / `keep_lines_matching` — a line survives iff it
//!    matches the keep set (when present) and does not match the strip set
//!    (when present)
//! 5. `replace_after`        — ordered regex substitutions, line-by-line,
//!    applied after line filtering and before truncation so substitutions that
//!    shorten lines (e.g. path compaction) see the full, untruncated text
//! 6. `truncate_lines_at`    — per-line Unicode-safe char cap
//! 7. `head_lines` / `tail_lines` — keep first/last N lines with a marker
//! 8. `max_lines`            — hard cap after head/tail
//! 9. `preserve_if_empty`    — keep the original input when filtering removes
//!    every line
//! 10. `on_empty`            — replace an empty result with a sentinel
//!
//! Pipelines never panic for the caller: regex compilation errors are
//! surfaced when the pipeline is loaded, and runtime application is total.

use std::borrow::Cow;

use regex::{Regex, RegexSet};
use serde::Deserialize;

use crate::minimizer::primitives;

/// Raw TOML shape for a single filter definition.
#[derive(Debug, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct PipelineDef {
	/// Human-readable one-liner. Not consumed at runtime.
	#[serde(default)]
	pub description:          Option<String>,
	/// Regex that selects which commands this pipeline claims. Matched against
	/// the first token of the command (post-wrapper stripping).
	pub match_command:        String,
	/// Optional regex matched against the detected subcommand. When absent,
	/// any subcommand is accepted.
	#[serde(default)]
	pub match_subcommand:     Option<String>,
	#[serde(default)]
	pub strip_ansi:           bool,
	#[serde(default)]
	pub replace:              Vec<ReplaceDef>,
	#[serde(default)]
	pub match_output:         Vec<MatchOutputDef>,
	#[serde(default)]
	pub strip_lines_matching: Vec<String>,
	#[serde(default)]
	pub keep_lines_matching:  Vec<String>,
	/// Ordered regex substitutions applied after the strip/keep line filter
	/// and before `truncate_lines_at`, so substitutions that shorten lines
	/// (e.g. path compaction) see the full, untruncated text.
	#[serde(default)]
	pub replace_after:        Vec<ReplaceDef>,
	pub truncate_lines_at:    Option<usize>,
	pub head_lines:           Option<usize>,
	pub tail_lines:           Option<usize>,
	pub max_lines:            Option<usize>,
	pub on_empty:             Option<String>,
	/// Return the original input unchanged when all filtering stages remove it.
	/// Useful for diagnostic filters that must not discard an unrecognized
	/// successful output, such as a compiler query response.
	#[serde(default)]
	pub preserve_if_empty:    bool,
	/// Apply only when the command exit code is in this list. Empty = always.
	#[serde(default)]
	pub only_on_exit:         Vec<i32>,
	/// Apply only when the command exit code is NOT in this list. Empty =
	/// always.
	#[serde(default)]
	pub except_on_exit:       Vec<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceDef {
	pub pattern:     String,
	pub replacement: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchOutputDef {
	pub pattern: String,
	pub message: String,
	#[serde(default)]
	pub unless:  Option<String>,
}

/// Inline filter test embedded next to pipeline definitions via
/// `[[tests.NAME]]`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PipelineTest {
	pub name:     String,
	pub input:    String,
	pub expected: String,
	#[serde(default)]
	pub exit:     Option<i32>,
}

/// On-disk schema for the builtin / user settings TOML.
#[derive(Debug, Deserialize, Default)]
pub struct PipelineFile {
	pub schema_version: Option<u32>,
	#[serde(default)]
	pub filters:        std::collections::BTreeMap<String, PipelineDef>,
	#[serde(default)]
	pub tests:          std::collections::BTreeMap<String, Vec<PipelineTest>>,
}

pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub struct CompiledReplace {
	pattern:     Regex,
	replacement: String,
}

#[derive(Debug)]
pub struct CompiledMatchOutput {
	pattern: Regex,
	message: String,
	unless:  Option<Regex>,
}

/// A pipeline with every regex pre-compiled.
#[derive(Debug)]
pub struct CompiledPipeline {
	pub name:              String,
	pub description:       Option<String>,
	pub match_command:     Regex,
	pub match_subcommand:  Option<Regex>,
	pub strip_ansi:        bool,
	pub replace:           Vec<CompiledReplace>,
	pub match_output:      Vec<CompiledMatchOutput>,
	pub strip_lines:       Option<RegexSet>,
	pub keep_lines:        Option<RegexSet>,
	pub replace_after:     Vec<CompiledReplace>,
	pub truncate_lines_at: Option<usize>,
	pub head_lines:        Option<usize>,
	pub tail_lines:        Option<usize>,
	pub max_lines:         Option<usize>,
	pub on_empty:          Option<String>,
	pub preserve_if_empty: bool,
	pub only_on_exit:      Vec<i32>,
	pub except_on_exit:    Vec<i32>,
}

/// Compile an ordered regex-substitution list; `label` names the TOML key
/// (`replace` or `replace_after`) in error messages.
fn compile_replaces(rules: Vec<ReplaceDef>, label: &str) -> Result<Vec<CompiledReplace>, String> {
	rules
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid {label} pattern '{}': {e}", rule.pattern))?;
			Ok(CompiledReplace { pattern, replacement: rule.replacement })
		})
		.collect()
}

/// Compile a raw TOML definition. Returns a descriptive error on regex
/// issues.
pub fn compile(name: String, def: PipelineDef) -> Result<CompiledPipeline, String> {
	let match_command =
		Regex::new(&def.match_command).map_err(|e| format!("invalid match_command: {e}"))?;
	let match_subcommand = def
		.match_subcommand
		.as_deref()
		.map(|p| Regex::new(p).map_err(|e| format!("invalid match_subcommand: {e}")))
		.transpose()?;

	let replace = compile_replaces(def.replace, "replace")?;
	let replace_after = compile_replaces(def.replace_after, "replace_after")?;

	let match_output = def
		.match_output
		.into_iter()
		.map(|rule| {
			let pattern = Regex::new(&rule.pattern)
				.map_err(|e| format!("invalid match_output pattern '{}': {e}", rule.pattern))?;
			let unless = rule
				.unless
				.as_deref()
				.map(|u| Regex::new(u).map_err(|e| format!("invalid match_output unless: {e}")))
				.transpose()?;
			Ok(CompiledMatchOutput { pattern, message: rule.message, unless })
		})
		.collect::<Result<Vec<_>, String>>()?;

	let strip_lines = if def.strip_lines_matching.is_empty() {
		None
	} else {
		Some(
			RegexSet::new(&def.strip_lines_matching)
				.map_err(|e| format!("invalid strip_lines_matching: {e}"))?,
		)
	};
	let keep_lines = if def.keep_lines_matching.is_empty() {
		None
	} else {
		Some(
			RegexSet::new(&def.keep_lines_matching)
				.map_err(|e| format!("invalid keep_lines_matching: {e}"))?,
		)
	};

	Ok(CompiledPipeline {
		name,
		description: def.description,
		match_command,
		match_subcommand,
		strip_ansi: def.strip_ansi,
		replace,
		match_output,
		strip_lines,
		keep_lines,
		replace_after,
		truncate_lines_at: def.truncate_lines_at,
		head_lines: def.head_lines,
		tail_lines: def.tail_lines,
		max_lines: def.max_lines,
		on_empty: def.on_empty,
		preserve_if_empty: def.preserve_if_empty,
		only_on_exit: def.only_on_exit,
		except_on_exit: def.except_on_exit,
	})
}

impl CompiledPipeline {
	/// Whether this pipeline claims the given `(program, subcommand)` pair.
	#[must_use]
	pub fn matches(&self, program: &str, subcommand: Option<&str>) -> bool {
		if !self.match_command.is_match(program) {
			return false;
		}
		if let Some(sub_rx) = self.match_subcommand.as_ref() {
			let sub = subcommand.unwrap_or("");
			if !sub_rx.is_match(sub) {
				return false;
			}
		}
		true
	}

	/// Whether this pipeline is gated off for the supplied exit code.
	#[must_use]
	pub fn skipped_by_exit(&self, exit_code: i32) -> bool {
		if !self.only_on_exit.is_empty() && !self.only_on_exit.contains(&exit_code) {
			return true;
		}
		if self.except_on_exit.contains(&exit_code) {
			return true;
		}
		false
	}

	/// Apply the full 10-stage pipeline to `input`.
	#[must_use]
	pub fn apply<'a>(&self, input: &'a str) -> Cow<'a, str> {
		// Stage 1: strip_ansi
		let stage1: Cow<'_, str> = if self.strip_ansi {
			Cow::Owned(primitives::strip_ansi(input))
		} else {
			Cow::Borrowed(input)
		};

		// Stage 2: replace (ordered, line-by-line)
		let stage2 = apply_replaces(stage1, &self.replace);

		// Stage 3: match_output short-circuit
		if !self.match_output.is_empty() {
			for rule in &self.match_output {
				if !rule.pattern.is_match(&stage2) {
					continue;
				}
				if let Some(anti) = rule.unless.as_ref()
					&& anti.is_match(&stage2)
				{
					continue;
				}
				return Cow::Owned(rule.message.clone());
			}
		}

		// Stage 4: strip/keep lines (keep AND NOT strip; absent set = no
		// constraint)
		let stage4: Cow<'_, str> = if self.strip_lines.is_some() || self.keep_lines.is_some() {
			Cow::Owned(primitives::filter_lines_regex(
				&stage2,
				self.strip_lines.as_ref(),
				self.keep_lines.as_ref(),
			))
		} else {
			stage2
		};

		// Stage 5: replace_after (ordered, line-by-line) — post-filter so
		// only surviving lines are substituted, pre-truncate so shortening
		// substitutions (path compaction) see the full line.
		let stage5 = apply_replaces(stage4, &self.replace_after);

		// Stage 6: truncate each line
		let stage6: Cow<'_, str> = if let Some(n) = self.truncate_lines_at {
			let mut out = String::with_capacity(stage5.len());
			for line in stage5.lines() {
				out.push_str(&primitives::truncate_line(line, n));
				out.push('\n');
			}
			Cow::Owned(out)
		} else {
			stage5
		};

		// Stage 7: head + tail
		let stage7: Cow<'_, str> = match (self.head_lines, self.tail_lines) {
			(Some(h), Some(t)) => Cow::Owned(primitives::head_tail_lines(&stage6, h, t)),
			(Some(h), None) => Cow::Owned(primitives::head_lines_only(&stage6, h)),
			(None, Some(t)) => Cow::Owned(primitives::tail_lines_only(&stage6, t)),
			(None, None) => stage6,
		};

		// Stage 8: max_lines
		let stage8: Cow<'_, str> = if let Some(m) = self.max_lines {
			Cow::Owned(primitives::max_lines(&stage7, m))
		} else {
			stage7
		};

		// Stage 9: preserve the source when a keep-only filter removed every line.
		// This prevents a successful query/diagnostic command's meaningful output
		// from being replaced by the engine's generic "OK" sentinel.
		if self.preserve_if_empty && stage8.trim().is_empty() {
			return Cow::Borrowed(input);
		}

		// Stage 10: on_empty
		if let Some(msg) = self.on_empty.as_deref()
			&& stage8.trim().is_empty()
		{
			return Cow::Owned(msg.to_string());
		}

		stage8
	}
}

/// Apply an ordered regex-substitution list line-by-line. Returns `input`
/// untouched (no allocation) when `rules` is empty.
fn apply_replaces<'a>(input: Cow<'a, str>, rules: &[CompiledReplace]) -> Cow<'a, str> {
	if rules.is_empty() {
		return input;
	}
	let mut out = String::with_capacity(input.len());
	for line in input.lines() {
		let mut current = Cow::Borrowed(line);
		for rule in rules {
			let replaced = rule
				.pattern
				.replace_all(&current, rule.replacement.as_str());
			if let Cow::Owned(s) = replaced {
				current = Cow::Owned(s);
			}
		}
		out.push_str(&current);
		out.push('\n');
	}
	Cow::Owned(out)
}

/// Return type of [`parse_file`]: the compiled pipelines alongside their
/// inline tests grouped by pipeline name.
pub type ParsedPipelineFile = (Vec<CompiledPipeline>, Vec<(String, Vec<PipelineTest>)>);

/// Compiled registry of all known pipelines, listed in priority order
/// (builtin last — user definitions win). Also carries the inline tests so
/// `verify()` can exercise them.
#[derive(Debug, Default)]
pub struct PipelineRegistry {
	pub pipelines: Vec<CompiledPipeline>,
	pub tests:     Vec<(String, Vec<PipelineTest>)>,
}

impl PipelineRegistry {
	/// Find the first pipeline that claims this `(program, subcommand)` pair.
	#[must_use]
	pub fn find(&self, program: &str, subcommand: Option<&str>) -> Option<&CompiledPipeline> {
		self
			.pipelines
			.iter()
			.find(|p| p.matches(program, subcommand))
	}
}

/// Parse and compile a full TOML file. Emits one `Err(String)` with all
/// parse/compile errors joined; a well-formed file with N filters returns
/// `Ok((Vec<CompiledPipeline>, tests))`.
pub fn parse_file(contents: &str, source_label: &str) -> Result<ParsedPipelineFile, String> {
	let file: PipelineFile =
		toml::from_str(contents).map_err(|e| format!("[{source_label}] TOML parse error: {e}"))?;

	if let Some(v) = file.schema_version
		&& v != SUPPORTED_SCHEMA_VERSION
	{
		return Err(format!(
			"[{source_label}] unsupported schema_version {v} (expected {SUPPORTED_SCHEMA_VERSION})"
		));
	}

	let mut compiled = Vec::with_capacity(file.filters.len());
	let mut errors = Vec::new();
	for (name, def) in file.filters {
		match compile(name.clone(), def) {
			Ok(pipeline) => compiled.push(pipeline),
			Err(e) => errors.push(format!("[{source_label}] filter '{name}': {e}")),
		}
	}
	if !errors.is_empty() {
		return Err(errors.join("\n"));
	}

	let tests = file.tests.into_iter().collect();
	Ok((compiled, tests))
}

/// Outcome for a single inline test.
#[derive(Debug, Clone)]
pub struct TestOutcome {
	pub filter_name: String,
	pub test_name:   String,
	pub passed:      bool,
	pub actual:      String,
	pub expected:    String,
}

/// Run every inline test in `registry` and return the outcomes.
#[must_use]
pub fn run_tests(registry: &PipelineRegistry) -> Vec<TestOutcome> {
	let mut out = Vec::new();
	for (filter_name, tests) in &registry.tests {
		let Some(pipeline) = registry.pipelines.iter().find(|p| &p.name == filter_name) else {
			for test in tests {
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name:   test.name.clone(),
					passed:      false,
					actual:      format!("pipeline '{filter_name}' not found"),
					expected:    test.expected.clone(),
				});
			}
			continue;
		};
		for test in tests {
			if let Some(exit) = test.exit
				&& pipeline.skipped_by_exit(exit)
			{
				// Explicit exit gate — pipeline is disabled for this exit;
				// expected output should be the raw input unchanged.
				let passed = test.input == test.expected;
				out.push(TestOutcome {
					filter_name: filter_name.clone(),
					test_name: test.name.clone(),
					passed,
					actual: test.input.clone(),
					expected: test.expected.clone(),
				});
				continue;
			}
			let actual = pipeline.apply(&test.input).to_string();
			let passed = actual == test.expected;
			out.push(TestOutcome {
				filter_name: filter_name.clone(),
				test_name: test.name.clone(),
				passed,
				actual,
				expected: test.expected.clone(),
			});
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn compile_one(toml_src: &str) -> CompiledPipeline {
		let (mut pipelines, _) = parse_file(toml_src, "test").expect("parse + compile");
		pipelines.pop().expect("one pipeline")
	}

	#[test]
	fn pipeline_runs_all_stages() {
		let src = r#"
schema_version = 1
[filters.demo]
match_command = "^demo$"
strip_ansi = true
strip_lines_matching = ["^Downloading"]
truncate_lines_at = 10
max_lines = 5
on_empty = "demo: ok"

[[tests.demo]]
name = "basic"
input = "\u001b[31mfirst\u001b[0m\nDownloading foo\nA_really_long_line_indeed\n"
expected = "first\nA_really_l\u2026[+15]\n"
"#;
		let pipeline = compile_one(src);
		let out =
			pipeline.apply("\u{1b}[31mfirst\u{1b}[0m\nDownloading foo\nA_really_long_line_indeed\n");
		assert_eq!(out.as_ref(), "first\nA_really_l\u{2026}[+15]\n");
	}

	#[test]
	fn short_circuit_wins_over_later_stages() {
		let src = r#"
schema_version = 1
[filters.ok]
match_command = "^ok$"
[[filters.ok.match_output]]
pattern = "BUILD SUCCESSFUL"
message = "build: ok"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("noise\nBUILD SUCCESSFUL in 5s\n");
		assert_eq!(out.as_ref(), "build: ok");
	}

	#[test]
	fn unless_prevents_swallowing_errors() {
		let src = r#"
schema_version = 1
[filters.ok]
match_command = "^ok$"
[[filters.ok.match_output]]
pattern = "BUILD SUCCESSFUL"
message = "build: ok"
unless = "(?i)error|fail"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("BUILD SUCCESSFUL but later ERROR: oops\n");
		assert!(out.as_ref().contains("ERROR"));
	}

	#[test]
	fn strip_and_keep_combine_as_keep_and_not_strip() {
		let src = r#"
schema_version = 1
[filters.combo]
match_command = "^combo$"
keep_lines_matching = ["^> Task "]
strip_lines_matching = ["UP-TO-DATE$"]
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("> Task :a UP-TO-DATE\n> Task :b\nDownloading dep\n");
		// Only lines matching the keep set AND not the strip set survive.
		assert_eq!(out.as_ref(), "> Task :b\n");
	}

	#[test]
	fn replace_after_substitutes_surviving_lines_post_filter() {
		let src = r#"
schema_version = 1
[filters.paths]
match_command = "^paths$"
keep_lines_matching = ["^src/"]
[[filters.paths.replace_after]]
pattern = "^src/very/long/prefix/"
replacement = ".../"
"#;
		let pipeline = compile_one(src);
		// The keep filter matches the ORIGINAL line (`^src/`); if the
		// substitution ran before filtering, the rewritten `.../main.rs`
		// would no longer match the keep set and be dropped.
		let out = pipeline.apply("src/very/long/prefix/main.rs\nnoise line\nsrc/lib.rs\n");
		assert_eq!(out.as_ref(), ".../main.rs\nsrc/lib.rs\n");
	}

	#[test]
	fn replace_after_runs_before_truncate_lines_at() {
		let src = r#"
schema_version = 1
[filters.shorten]
match_command = "^shorten$"
truncate_lines_at = 12
[[filters.shorten.replace_after]]
pattern = "^/workspace/project/deep/"
replacement = ""
"#;
		let pipeline = compile_one(src);
		// The raw line exceeds the 12-char cap; the substitution shortens it
		// below the cap first, so no truncation marker appears. If truncation
		// ran first, the pattern would no longer match the clipped line.
		let out = pipeline.apply("/workspace/project/deep/file.rs\n");
		assert_eq!(out.as_ref(), "file.rs\n");
	}

	#[test]
	fn preserve_if_empty_returns_original_when_filter_drops_every_line() {
		let src = r#"
schema_version = 1
[filters.keep]
match_command = "^keep$"
keep_lines_matching = ["^diagnostic:"]
preserve_if_empty = true
"#;
		let pipeline = compile_one(src);
		let input = "query result\n";
		assert_eq!(pipeline.apply(input).as_ref(), input);
	}

	#[test]
	fn on_empty_fires_when_output_is_blank() {
		let src = r#"
schema_version = 1
[filters.silent]
match_command = "^silent$"
strip_lines_matching = [".*"]
on_empty = "silent: ok"
"#;
		let pipeline = compile_one(src);
		let out = pipeline.apply("noise\nmore noise\n");
		assert_eq!(out.as_ref(), "silent: ok");
	}

	#[test]
	fn exit_gates_respected() {
		let src = r#"
schema_version = 1
[filters.okonly]
match_command = "^okonly$"
only_on_exit = [0]
"#;
		let pipeline = compile_one(src);
		assert!(!pipeline.skipped_by_exit(0));
		assert!(pipeline.skipped_by_exit(1));

		let src2 = r#"
schema_version = 1
[filters.notfail]
match_command = "^notfail$"
except_on_exit = [1, 2]
"#;
		let pipeline2 = compile_one(src2);
		assert!(!pipeline2.skipped_by_exit(0));
		assert!(pipeline2.skipped_by_exit(1));
	}

	#[test]
	fn unsupported_schema_errors() {
		let src = "schema_version = 99\n[filters.foo]\nmatch_command = \"^foo$\"\n";
		let err = parse_file(src, "bad").unwrap_err();
		assert!(err.contains("schema_version"));
	}

	#[test]
	fn inline_tests_run_and_pass() {
		let src = r#"
schema_version = 1
[filters.gradle]
match_command = "^gradle$"
strip_lines_matching = ["^> Task :.*UP-TO-DATE$"]
on_empty = "gradle: ok"

[[tests.gradle]]
name = "strip UP-TO-DATE"
input = "> Task :a UP-TO-DATE\n> Task :b\n"
expected = "> Task :b\n"

[[tests.gradle]]
name = "empty becomes sentinel"
input = "> Task :a UP-TO-DATE\n"
expected = "gradle: ok"
"#;
		let (pipelines, tests) = parse_file(src, "test").expect("ok");
		let registry = PipelineRegistry { pipelines, tests };
		let outcomes = run_tests(&registry);
		assert_eq!(outcomes.len(), 2);
		for outcome in outcomes {
			assert!(
				outcome.passed,
				"test {} failed: actual={:?} expected={:?}",
				outcome.test_name, outcome.actual, outcome.expected
			);
		}
	}
}
