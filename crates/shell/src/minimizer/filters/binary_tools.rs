//! Binary-inspection tool filters (Tier 3b): `xxd`, `strings`, `od`.
//!
//! These tools all share the same failure mode in the minimizer's
//! `unknown` bucket: very long head-or-tail-or-elide outputs (5000+
//! lines) on multi-megabyte binaries dwarf the 64 KB capture budget and
//! waste the agent's context window on repetitive hex/string dumps. We
//! preserve the first 50 lines and last 20 lines and elide the middle
//! with a count marker — diagnostic anchors (magic bytes at the head,
//! footer/trailer bytes at the tail) survive intact while the bulk
//! middle is dropped.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

const HEAD_LINES: usize = 50;
const TAIL_LINES: usize = 20;

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	matches!(program, "xxd" | "strings" | "od")
}

#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	// Kill-switch parity (M2): legacy_filters_active=true skips this
	// filter so callers can rollback without recompile.
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}

	let cleaned = primitives::strip_ansi(input);
	let total_lines = cleaned.lines().count();
	if total_lines <= HEAD_LINES + TAIL_LINES {
		// Short dump — passthrough. Even errored runs are tiny enough
		// here that the head/tail cap would not help.
		let _ = exit_code;
		return MinimizerOutput::passthrough(input);
	}

	let text = primitives::head_tail_lines(&cleaned, HEAD_LINES, TAIL_LINES);
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(program: &'a str, command: &'a str, config: &'a MinimizerConfig) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand: None, command, config }
	}

	fn build_lines(prefix: &str, count: usize) -> String {
		let mut s = String::new();
		for i in 0..count {
			let _ = writeln!(s, "{prefix}{i:08x}");
		}
		s
	}

	#[test]
	fn xxd_long_dump_compacts_with_head_tail_marker() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = build_lines("00000000: ", 5000);
		let context = ctx("xxd", "xxd /bin/ls", &cfg);
		let out = filter(&context, &input, 0);
		assert!(out.changed);
		// 50 head + 20 tail + 1 marker = 71 lines
		let line_count = out.text.lines().count();
		assert_eq!(line_count, HEAD_LINES + TAIL_LINES + 1, "got {line_count} lines: {out:?}");
		assert!(out.text.contains("ln elided…]"));
		// Head anchor preserved.
		assert!(out.text.starts_with("00000000: 00000000"));
	}

	#[test]
	fn xxd_short_dump_passthrough() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = build_lines("00000000: ", 60);
		let context = ctx("xxd", "xxd small", &cfg);
		let out = filter(&context, &input, 0);
		assert!(!out.changed);
		assert_eq!(out.text, input);
	}

	#[test]
	fn strings_long_output_compacts() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = build_lines("symbol_", 2000);
		let context = ctx("strings", "strings /bin/ls", &cfg);
		let out = filter(&context, &input, 0);
		assert!(out.changed);
		assert!(out.text.contains("ln elided…]"));
	}

	#[test]
	fn od_long_output_compacts() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let input = build_lines("0000000 ", 1500);
		let context = ctx("od", "od -c /bin/ls", &cfg);
		let out = filter(&context, &input, 0);
		assert!(out.changed);
		assert!(out.text.contains("ln elided…]"));
	}

	#[test]
	fn binary_tools_legacy_filters_active_passes_through() {
		// Kill-switch parity (M2).
		let cfg =
			MinimizerConfig { enabled: true, legacy_filters_active: true, ..Default::default() };
		let input = build_lines("00000000: ", 5000);
		for prog in ["xxd", "strings", "od"] {
			let context = ctx(prog, "binary-tool", &cfg);
			let out = filter(&context, &input, 0);
			assert!(!out.changed, "{prog} should passthrough with kill-switch");
			assert_eq!(out.text, input);
		}
	}
}
