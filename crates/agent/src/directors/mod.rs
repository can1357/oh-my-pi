//! Built-in Director specifications.

pub mod advisor;
pub mod autoresearch;
pub mod compaction;
pub mod force_tool;
pub mod goal;
pub mod loop_mode;
pub mod plan;
pub mod prewalk;
pub mod todo_reminder;
pub mod vibe;

use crate::director::DirectorRegistry;

/// Mode prompts a Director engagement selects through its `ai_prompt_mode`
/// bind; the kernel renders the selected one as a system item on every
/// request while the bind is effective.
pub const MODE_PROMPTS: &[(&str, &str)] = &[
	("plan", include_str!("../../prompts/modes/plan.md")),
	("vibe", include_str!("../../prompts/modes/vibe.md")),
	("autoresearch", include_str!("../../prompts/modes/autoresearch.md")),
];

/// The prompt text for one `ai_prompt_mode` value.
#[must_use]
pub fn mode_prompt(mode: &str) -> Option<&'static str> {
	MODE_PROMPTS
		.iter()
		.find(|(name, _)| *name == mode)
		.map(|(_, text)| *text)
}

/// Registers every built-in Director constructor.
pub fn register_standard(registry: &mut DirectorRegistry) {
	registry.register(advisor::FAMILY, |node| Box::new(advisor::Advisor::from_node(node)));
	registry.register("autoresearch", |node| Box::new(autoresearch::Autoresearch::from_node(node)));
	registry.register("compaction", |_| Box::new(compaction::CompactionDirector::new()));
	registry.register("force_tool", |node| Box::new(force_tool::ForceTool::from_node(node)));
	registry.register("goal", |node| Box::new(goal::Goal::from_node(node)));
	registry.register("loop_mode", |node| Box::new(loop_mode::LoopMode::from_node(node)));
	registry.register("plan", |node| Box::new(plan::Plan::from_node(node)));
	registry.register("prewalk", |node| Box::new(prewalk::Prewalk::from_node(node)));
	registry
		.register("todo_reminder", |node| Box::new(todo_reminder::TodoReminder::from_node(node)));
	registry.register("vibe", |node| Box::new(vibe::Vibe::from_node(node)));
}
