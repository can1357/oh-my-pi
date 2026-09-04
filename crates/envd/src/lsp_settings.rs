//! Typed settings owned by the project LSP runtime.

use omp_con::Ctx;
use serde::{Deserialize, Serialize};

omp_con::var! {
	/// Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename).
	pub static SV_LSP_ENABLED = sv_lsp_enabled: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "LSP",
			"legacy.path": "lsp.enabled",
		},
	};
	/// Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup.
	pub static SV_LSP_LAZY = sv_lsp_lazy: bool {
		default: true,
		flags: archive,
		meta: {
			"ui.tab": "files",
			"ui.group": "LSP",
			"ui.label": "Lazy LSP Startup",
			"legacy.path": "lsp.lazy",
		},
	};
}

/// Layered language-server enablement and mutation feedback policy.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct LspSettings {
	/// Enables language-server bindings and the model-facing LSP surface.
	pub enabled:                 bool,
	/// Defers language-server startup until the first matching operation.
	pub lazy:                    bool,
	/// Formats supported files after a write transaction.
	pub format_on_write:         bool,
	/// Returns diagnostics after write transactions.
	pub diagnostics_on_write:    bool,
	/// Returns diagnostics after edit transactions.
	pub diagnostics_on_edit:     bool,
	/// Suppresses unchanged diagnostics already surfaced in this session.
	pub diagnostics_deduplicate: bool,
}

impl Default for LspSettings {
	fn default() -> Self {
		Self {
			enabled:                 true,
			lazy:                    true,
			format_on_write:         false,
			diagnostics_on_write:    true,
			diagnostics_on_edit:     false,
			diagnostics_deduplicate: true,
		}
	}
}

impl LspSettings {
	/// Resolves language-server policy from the process control context.
	#[must_use]
	pub fn from_con(ctx: &Ctx) -> Self {
		Self {
			enabled:                 SV_LSP_ENABLED.get(ctx),
			lazy:                    SV_LSP_LAZY.get(ctx),
			format_on_write:         omp_tools::settings::SV_LSP_FORMAT_ON_WRITE.get(ctx),
			diagnostics_on_write:    omp_tools::settings::SV_LSP_DIAGNOSTICS_ON_WRITE.get(ctx),
			diagnostics_on_edit:     omp_tools::settings::SV_LSP_DIAGNOSTICS_ON_EDIT.get(ctx),
			diagnostics_deduplicate: omp_tools::settings::SV_LSP_DIAGNOSTICS_DEDUPLICATE.get(ctx),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn defaults_match_pi_policy_without_shared_toggle() {
		assert_eq!(LspSettings::from_con(&Ctx::new()), LspSettings::default());
	}

	#[test]
	fn con_projection_is_typed() {
		let ctx = Ctx::new();
		SV_LSP_ENABLED.set(&ctx, false).expect("set enabled");
		omp_tools::settings::SV_LSP_DIAGNOSTICS_ON_EDIT
			.set(&ctx, true)
			.expect("set diagnostics");
		assert_eq!(LspSettings::from_con(&ctx), LspSettings {
			enabled: false,
			diagnostics_on_edit: true,
			..LspSettings::default()
		});
	}
}
