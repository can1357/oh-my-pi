//! Rust toolchain filters that are not `cargo` subcommands (Tier 3a).
//!
//! Today this module hosts the `rustfmt` filter — real-data evidence (~6
//! invocations / 7d, 38 KB average, ~0.23 MB total) showed rustfmt landing
//! in the minimizer's `unknown` bucket. The filter groups diff-style
//! output by file and elides per-file unified-diff chunks for `--check`
//! mode while letting silent runs (no diffs / formatter no-op) pass
//! through unchanged.

use std::fmt::Write;

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "rustfmt")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	// Kill-switch parity (M2): legacy_filters_active=true skips this
	// filter so callers can rollback without recompile.
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let text = match ctx.program {
		"rustfmt" => condense_rustfmt(&cleaned, exit_code),
		_ => cleaned,
	};

	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

/// Condense `rustfmt`/`rustfmt --check` output.
///
/// Two main shapes are handled:
///
/// - **Check mode** emits `Diff in <path> at line <N>:` headers followed by
///   per-hunk `+`/`-` lines. We collect the set of affected files, print a
///   one-line header (`N files reformatted (M with diffs):`), the first 3 file
///   paths, and elide every diff body — the agent rarely needs the full diff
///   inline; the artifact reference carries the original.
/// - **Silent runs** (rustfmt formatted in place, no `--check`) emit no stdout.
///   The empty buffer passes through; no transformation.
///
/// On compile errors / panics rustfmt prints to stderr in tens-of-lines
/// form, well under the head/tail cap below — we keep it as-is.
fn condense_rustfmt(input: &str, exit_code: i32) -> String {
	if input.trim().is_empty() {
		return input.to_string();
	}

	let files: Vec<&str> = collect_diff_files(input);
	if files.is_empty() {
		// No `Diff in ` markers — likely a panic / parse error / usage
		// message. Cap with the standard error head/tail budget.
		if exit_code != 0 {
			return primitives::head_tail_lines(input, 80, 40);
		}
		return input.to_string();
	}

	let mut out = String::new();
	let unique: Vec<&&str> = {
		let mut seen = std::collections::BTreeSet::new();
		files.iter().filter(|f| seen.insert(**f)).collect()
	};
	let total = unique.len();
	let _ = writeln!(out, "{total} files reformatted:");
	for file in unique.iter().take(3) {
		out.push_str("  ");
		out.push_str(file);
		out.push('\n');
	}
	if total > 3 {
		let _ = writeln!(out, "  […{} files elided…]", total - 3);
	}
	out
}

fn collect_diff_files(input: &str) -> Vec<&str> {
	let mut files = Vec::new();
	for line in input.lines() {
		if let Some(rest) = line.strip_prefix("Diff in ") {
			// rest looks like: `<path> at line <N>:`
			let path = rest
				.split(" at line ")
				.next()
				.unwrap_or(rest)
				.trim_end_matches(':');
			files.push(path);
		}
	}
	files
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command, config }
	}

	#[test]
	fn rustfmt_diff_output_compacts() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let mut input = String::new();
		for i in 0..50 {
			let _ = writeln!(input, "Diff in src/file_{i}.rs at line 10:");
			for _ in 0..8 {
				input.push_str("-    old line\n");
				input.push_str("+    new line\n");
			}
		}
		let context = ctx("rustfmt", "rustfmt --check src/", &cfg);
		let out = filter(&context, &input, 1);
		assert!(out.changed);
		assert!(out.text.contains("50 files reformatted"));
		assert!(out.text.contains("src/file_0.rs"));
		assert!(out.text.contains("[…47 files elided…]"));
		// Diff bodies must be elided.
		assert!(!out.text.contains("old line"));
		// Savings ratio ≥ 0.7
		let saved_ratio = 1.0 - (out.text.len() as f64 / input.len() as f64);
		assert!(saved_ratio >= 0.7, "expected ≥0.7 savings, got {saved_ratio}");
	}

	#[test]
	fn rustfmt_silent_output_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("rustfmt", "rustfmt src/lib.rs", &cfg);
		let out = filter(&context, "", 0);
		assert!(!out.changed);
		assert_eq!(out.text, "");
	}

	#[test]
	fn rustfmt_error_output_capped() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let context = ctx("rustfmt", "rustfmt --check missing.rs", &cfg);
		// Simulate a long usage/error dump with no `Diff in ` headers.
		let mut input = String::new();
		for i in 0..400 {
			let _ = writeln!(input, "error: usage line {i}");
		}
		let out = filter(&context, &input, 1);
		assert!(out.changed);
		// head_tail_lines(input, 80, 40) keeps 120 lines + marker.
		assert!(out.text.contains("ln elided…]"));
	}

	#[test]
	fn rustfmt_legacy_filters_active_passes_through() {
		// Kill-switch parity (M2).
		let cfg =
			MinimizerConfig { enabled: true, legacy_filters_active: true, ..Default::default() };
		let context = ctx("rustfmt", "rustfmt --check src/", &cfg);
		let input = "Diff in src/a.rs at line 1:\n-old\n+new\n";
		let out = filter(&context, input, 1);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}
}
