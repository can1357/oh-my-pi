//! Compiled canonical prompt assets.

use std::sync::LazyLock;

use omp_scribe::{Engine, Template};

macro_rules! template {
	($name:ident, $logical:literal, $path:literal) => {
		#[doc = concat!("Returns the compiled `", $logical, "` prompt template.")]
		pub fn $name() -> &'static Template {
			static TEMPLATE: LazyLock<Template> = LazyLock::new(|| {
				engine()
					.compile($logical, include_str!($path))
					.unwrap_or_else(|source| panic!("invalid embedded prompt template: {source}"))
			});
			&TEMPLATE
		}
	};
}

/// Returns the process-wide deterministic template engine.
pub fn engine() -> &'static Engine {
	static ENGINE: LazyLock<Engine> = LazyLock::new(Engine::new);
	&ENGINE
}

template!(conventions, "system/conventions", "../../prompts/system/conventions.md");
template!(role, "system/role", "../../prompts/system/role.md");
template!(runtime, "system/runtime", "../../prompts/system/runtime.md");
template!(tool_policy, "system/tool-policy", "../../prompts/system/tool-policy.md");
template!(workflow, "system/workflow", "../../prompts/system/workflow.md");
template!(delivery, "system/delivery", "../../prompts/system/delivery.md");
template!(computer_safety, "system/computer-safety", "../../prompts/system/computer-safety.md");
template!(project, "system/project", "../../prompts/system/project.md");
template!(active_repo, "system/active-repo", "../../prompts/system/active-repo.md");
template!(status, "system/status", "../../prompts/system/status.md");

template!(
	workspace_fallback,
	"system/workspace-fallback",
	"../../prompts/system/workspace-fallback.md"
);

/// Returns every agent-owned system template.
pub fn system_templates() -> [&'static Template; 11] {
	[
		conventions(),
		role(),
		runtime(),
		tool_policy(),
		workflow(),
		delivery(),
		computer_safety(),
		project(),
		active_repo(),
		status(),
		workspace_fallback(),
	]
}
