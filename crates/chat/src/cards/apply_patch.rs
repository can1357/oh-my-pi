//! Apply-patch identity using the shared edit transaction presentation.

use omp_tui::UiContext;

use super::{Card, CardView, Component, edit::render_edit};

/// Card for the `apply_patch` compatibility identity.
pub struct ApplyPatchCard;

impl Card for ApplyPatchCard {
	fn tool(&self) -> &'static str {
		"apply_patch"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		render_edit(view, expanded, true, ui)
	}
}
