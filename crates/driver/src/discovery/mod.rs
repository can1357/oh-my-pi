//! Credential-blind catalog configuration, role selection, native extension
//! admission, and the discovered prompt material: skills, context files,
//! rules, and prompt templates.

pub mod active_repo;
pub mod models;
pub mod native;
pub mod prompts;
pub mod protected;
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
	/// User-only: a workspace's `.omp/config.cfg` cannot set it
	/// (`ConError::ProjectVarDenied`), so a repository can never switch off a
	/// guard extension the user installed.
	pub static CL_DISABLED_EXTENSIONS = cl_disabled_extensions: Vec<Str> {
		default: Vec::new(),
		flags: archive,
		meta: {
			"legacy.path": "disabledExtensions",
		},
	};
}

#[cfg(test)]
mod tests {
	use std::fs;

	use omp_con::{ConError, Ctx, Source};
	use omp_core::Str;

	use super::*;
	use crate::cfg::CfgFiles;

	/// A project overlay setting `cl_disabled_extensions` is refused with the
	/// typed project denial and leaves the effective set alone.
	#[test]
	fn a_project_overlay_cannot_disable_extensions() {
		let ctx = Ctx::new();
		let denied = ctx
			.exec(
				"cl_disabled_extensions [acme.guard]",
				Source::Project(Str::new_static("config.cfg")),
			)
			.expect_err("project overlay is denied");
		assert!(matches!(denied, ConError::ProjectVarDenied { .. }), "{denied:?}");
		assert!(CL_DISABLED_EXTENSIONS.get(&ctx).is_empty());
	}

	/// Through the production cfg loader: `<project>/.omp/config.cfg` is
	/// counted as denied and changes nothing, while `~/.o2/config.cfg` still
	/// disables what it names.
	#[test]
	fn only_the_user_cfg_disables_extensions() {
		let dir = tempfile::tempdir().unwrap();
		let user = dir.path().join("o2");
		let project = dir.path().join("proj/.omp");
		fs::create_dir_all(&user).unwrap();
		fs::create_dir_all(&project).unwrap();
		fs::write(project.join("config.cfg"), "cl_disabled_extensions [acme.guard]\n").unwrap();
		let files = CfgFiles::with_roots(user.clone(), Some(project));

		let ctx = Ctx::new();
		let outcome = ctx.exec_configs(&files, None).unwrap();
		assert_eq!(outcome.denied, 1, "{outcome:?}");
		assert!(CL_DISABLED_EXTENSIONS.get(&ctx).is_empty());

		fs::write(user.join("config.cfg"), "cl_disabled_extensions [skill:review]\n").unwrap();
		let ctx = Ctx::new();
		let outcome = ctx.exec_configs(&files, None).unwrap();
		assert_eq!(outcome.denied, 1, "{outcome:?}");
		assert_eq!(CL_DISABLED_EXTENSIONS.get(&ctx), [Str::new_static("skill:review")]);
	}
}
