//! Resource-owning built-in tools for the OMP environment.
//!
//! Executors consume the same streaming invocation contract as extensions:
//! speculative preparation may begin while arguments arrive, while filesystem
//! and process effects remain behind the explicit commitment gate. Durable
//! payloads are revisioned truth and prompt parts are deterministic
//! projections.
// The `view!` macro expands absolute `::omp_tools::…` paths; alias the crate
// to itself so expansions inside this crate resolve identically.
extern crate self as omp_tools;

/// Stable identity of one production native tool family.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BuiltinToolIdentity {
	/// Model-facing family name.
	pub name:   &'static str,
	/// Whether the family is omitted from ordinary user-facing lists.
	pub hidden: bool,
}

const BUILTIN_TOOL_IDENTITIES: &[BuiltinToolIdentity] = &[
	BuiltinToolIdentity { name: "read", hidden: false },
	BuiltinToolIdentity { name: "web_search", hidden: false },
	BuiltinToolIdentity { name: "recall", hidden: false },
	BuiltinToolIdentity { name: "reflect", hidden: false },
	BuiltinToolIdentity { name: "retain", hidden: false },
	BuiltinToolIdentity { name: "memory_edit", hidden: false },
	BuiltinToolIdentity { name: "edit", hidden: false },
	BuiltinToolIdentity { name: "write", hidden: false },
	BuiltinToolIdentity { name: "grep", hidden: false },
	BuiltinToolIdentity { name: "glob", hidden: false },
	BuiltinToolIdentity { name: "bash", hidden: false },
	BuiltinToolIdentity { name: "eval", hidden: false },
	BuiltinToolIdentity { name: "todo", hidden: false },
	BuiltinToolIdentity { name: "task", hidden: false },
	BuiltinToolIdentity { name: "ask", hidden: false },
	BuiltinToolIdentity { name: "hub", hidden: false },
	BuiltinToolIdentity { name: "github", hidden: false },
	BuiltinToolIdentity { name: "debug", hidden: false },
	BuiltinToolIdentity { name: "checkpoint", hidden: false },
	BuiltinToolIdentity { name: "ast_grep", hidden: false },
	BuiltinToolIdentity { name: "ast_edit", hidden: false },
	BuiltinToolIdentity { name: "rewind", hidden: false },
	BuiltinToolIdentity { name: "think", hidden: true },
	BuiltinToolIdentity { name: "goal", hidden: true },
	BuiltinToolIdentity { name: "yield", hidden: true },
	BuiltinToolIdentity { name: "image_gen", hidden: false },
	BuiltinToolIdentity { name: "tts", hidden: false },
	BuiltinToolIdentity { name: "report_issue", hidden: true },
	BuiltinToolIdentity { name: "learn", hidden: true },
	BuiltinToolIdentity { name: "manage_skill", hidden: true },
	BuiltinToolIdentity { name: "computer", hidden: false },
	BuiltinToolIdentity { name: "security_scan", hidden: false },
];

/// Returns the stable native builtin and hidden identity set.
pub const fn builtin_tool_identities() -> &'static [BuiltinToolIdentity] {
	BUILTIN_TOOL_IDENTITIES
}

/// Shared foreground-wait and managed-job transfer helpers.
pub mod auto_background;

/// Interactive user question picker.
pub mod ask;
/// Structural multi-target rewrites.
pub mod ast_edit;
/// Structural multi-target search.
pub mod ast_grep;
/// Supervised embedded browser automation.
pub mod browser;
/// Named durable workspace/session checkpoint and boundary-rewind tools.
pub mod checkpoint;
/// Native desktop capture, input, and accessibility.
pub mod computer;
/// Workspace-confinement and selector path utilities.
pub mod path;
mod render;
/// Typed policy projection owned by file tools.
pub mod settings;
/// Shared staged-proposal lifecycle for preview-producing tools.
pub mod staging;

/// Builds one typed renderer view tree from markup with child-level `for`,
/// `if`, and `match` control flow (see [`render::view`]).
pub use omp_macros::view;
pub use render::{BuiltinRendererIdentities, live_renderers, register_builtin_renderers};

/// Revisioned project debugger tool.
pub mod debug;
/// Bounded debugger snapshot renderers.
pub mod debug_render;
/// Stable dynamic device transport and catalog rendering.
pub mod device;
/// Schema-derived command-line mappings for dynamic devices.
pub mod device_ctl;
/// Hashline document transactions with speculative previews.
pub mod edit;
/// Persistent Python evaluation.
pub mod eval;
/// Native renderer lifecycle fixtures for visual QA.
pub mod gallery;
/// Direct GitHub API and isolated pull-request operations.
pub mod github;
/// Deterministic workspace path matching.
pub mod glob;
/// Hidden durable goal lifecycle tool.
pub mod goal;
/// Workspace byte and pattern search.
pub mod grep;
/// Peer, detached-job, and named-process coordination.
pub mod hub;
/// Durable lesson capture with optional managed-skill publication.
pub mod learn;
/// Revisioned project language-server tool.
pub mod lsp;
/// Isolated generated-skill create, update, and delete tool.
pub mod manage_skill;
/// Typed Mnemopi recall, reflect, and retain tools.
pub mod memory;
/// Typed Mnemopi mutation tool.
pub mod memory_edit;
/// Structured child-output validation against caller-provided JSON Schemas.
pub mod output_schema;
/// Reads across local and special sources.
pub mod read;
/// Review finding parsing and priority normalization.
pub mod review;
/// Long-tail repository security scan device.
pub mod security_scan;
/// Persistent-session shell execution.
pub mod shell;
/// Pre-authorization guidance for shell intents served by dedicated tools.
pub mod shell_intercept;
/// Internal-resource URI scanner used before environment execution.
pub mod shell_uri;
/// Child-agent runs over an injected host-side spawner.
pub mod task;
/// Private no-op reasoning scratch notes.
pub mod think;
/// Phased session task tracking.
pub mod todo;
/// Canonical provider-routed web search.
pub mod web_search;
/// Whole-file writes.
pub mod write;
/// Structured subagent result submission.
pub mod yield_tool;
