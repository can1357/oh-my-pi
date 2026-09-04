//! Credential-blind catalog configuration, role selection, native extension
//! admission, and the discovered prompt material: skills, context files,
//! rules, and prompt templates.

pub mod active_repo;
pub mod models;
pub mod native;
pub mod prompts;
pub mod roles;
pub mod rules;
pub mod skills;

use omp_core::Str;

/// Discovered prompt material a session journals as `prompt-facts` (the
/// stable inputs of `crates/agent/prompts/system/{runtime,project}.md`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PromptFacts {
	/// `{name, description}` rows of [`skills::ActiveSkills::prompt_facts`].
	pub skills:             Vec<serde_json::Value>,
	/// `{origin, content}` rows of [`rules::ContextFiles::prompt_facts`]; empty
	/// under `--no-context-files`.
	pub context_files:      Vec<serde_json::Value>,
	/// `{name, content}` rows injected whole
	/// ([`rules::ActiveRules::prompt_facts`]); empty under `--no-rules`.
	pub always_apply_rules: Vec<serde_json::Value>,
	/// `{name, description, globs}` rulebook rows read through `rule://`.
	pub rules:              Vec<serde_json::Value>,
	/// The single direct-child repository beneath a non-repository cwd
	/// ([`active_repo::resolve`]); renders `active-repo.md` when present.
	pub active_repository:  Option<active_repo::ActiveRepository>,
}

omp_con::var! {
	/// Extension and resource ids the runtime never
	/// loads. Native extension manifest ids disable the whole extension;
	/// `skill:<name>` drops one skill (`omp ext config` edits this list).
	pub static CL_DISABLED_EXTENSIONS = cl_disabled_extensions: Vec<Str> {
		default: Vec::new(),
		flags: archive,
		meta: {
			"legacy.path": "disabledExtensions",
		},
	};
}
