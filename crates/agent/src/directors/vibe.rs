//! Vibe-mode Director declaration.

use omp_core::Str;
use omp_dom::Node;

use crate::director::{BindValue, Director, Slot};

const CLAIMS: &[Slot] = &[Slot::Mode, Slot::Loop];
/// Tools the vibe coordinator may use: inspection, tracking, and the real
/// `task`/`hub` session orchestration primitives; never direct mutation.
pub const VIBE_TOOLS: &[&str] =
	&["read", "grep", "glob", "todo", "think", "ask", "task", "hub", "yield"];

/// Restricts the roster and defers delivery while coordinating vibe workers.
pub struct Vibe {
	binds: Vec<(Str, BindValue)>,
}

impl Vibe {
	/// Creates the standard vibe engagement.
	#[must_use]
	pub fn new() -> Self {
		Self { binds: vibe_binds() }
	}

	/// Reconstructs a vibe engagement from its DOM element.
	#[must_use]
	pub fn from_node(_node: &Node) -> Self {
		Self::new()
	}
}

impl Default for Vibe {
	fn default() -> Self {
		Self::new()
	}
}

impl Director for Vibe {
	fn id(&self) -> &'static str {
		"vibe"
	}

	fn claims(&self) -> &'static [Slot] {
		CLAIMS
	}

	fn binds(&self) -> &[(Str, BindValue)] {
		&self.binds
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![(Str::new_static("tool"), BindValue::Str(Str::new_static("task")))]
	}
}

/// The engagement layer vibe mode installs: the mode prompt slot and the
/// coordinator roster (ADR 0012/0015).
fn vibe_binds() -> Vec<(Str, BindValue)> {
	vec![
		(Str::new_static("ai_prompt_mode"), BindValue::Str(Str::new_static("vibe"))),
		(Str::new_static("sv_tools"), BindValue::list(VIBE_TOOLS)),
	]
}
