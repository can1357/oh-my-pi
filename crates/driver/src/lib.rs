#![recursion_limit = "256"]

//! Journal-first production composition for OMP application modes.

pub mod adw;
pub mod auth_backend;
pub mod auth_flow;
pub mod bridges;
pub mod cfg;
pub mod cleanse;
pub mod collab;
pub mod commit;
pub mod compress;
pub mod control_visibility;
pub mod delegated_prompt;
pub mod discovery;
pub mod exec_composer;
pub mod ext_updates;
pub mod headless;
pub mod keybindings;
pub mod legacy_settings;
pub mod plugin_commands;
pub mod plugin_hooks;
pub mod prompt_input;
pub mod prompt_templates;
pub mod registry;
pub mod remote_build;
pub(crate) mod roster;
pub mod rules;
pub mod secrets;
pub mod session_bridge;
pub mod session_wire;
pub use session_wire::SessionWire;
pub mod delegated_acp;
pub mod delegated_host;
pub mod delegated_policy;
pub mod delegated_resolver;
pub mod session_imports;
pub mod sessions;
pub mod settings;
pub mod share;
pub mod subagent;
pub mod telemetry_upload;
pub mod v1_import;
pub mod verification;
pub mod workspace_trust;

/// Renders an error cause once into model-facing fault text at this
/// presentation boundary (ADR 0035 / PR #411 pattern).
pub(crate) fn fault(cause: impl std::fmt::Display) -> omp_core::Str {
	omp_core::sf!("{cause}")
}

/// Renders an error `cause` prefixed by `context` once into model-facing
/// fault text at this presentation boundary (ADR 0035 / PR #411 pattern).
pub(crate) fn fault_in(
	context: impl std::fmt::Display,
	cause: impl std::fmt::Display,
) -> omp_core::Str {
	omp_core::sf!("{context}: {cause}")
}
