//! Generic fallback transforms.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, primitives};

#[must_use]
pub fn filter(_ctx: &MinimizerCtx<'_>, input: &str, _exit_code: i32) -> MinimizerOutput {
	let stripped = primitives::strip_ansi(input);
	let deduped = primitives::dedup_consecutive_lines(&stripped);
	let text = if deduped.lines().count() > primitives::CapClass::Errors.lines() {
		primitives::head_tail_cap(&deduped, primitives::CapClass::Errors)
	} else {
		deduped
	};
	if text == input {
		MinimizerOutput::passthrough(input)
	} else {
		MinimizerOutput::transformed(text, input.len())
	}
}
