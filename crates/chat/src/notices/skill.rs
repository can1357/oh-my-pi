//! User-invoked skill prompt cards projected from typed session payloads.

use std::path::Path;

use omp_core::{Str, sf};
use omp_dom::{Node, PropId, PropKey, Value};
use omp_journal::data::SkillPrompt;
use omp_tui::{IntoComponent as _, dom};

use crate::cards::{Component, file_link};

const SKILL_PROMPT_PROP: &str = "skill_prompt";

/// Decodes the typed payload of a journaled `<user skill_prompt=true>`.
#[must_use]
pub fn prompt(node: &Node) -> Option<SkillPrompt> {
	let marked = node
		.prop(&PropKey::Custom(Str::new_static(SKILL_PROMPT_PROP)))
		.is_some_and(|value| matches!(value, Value::Bool(true)));
	if !marked {
		return None;
	}
	let Value::Json(raw) = node.prop(&PropId::Data.into())? else {
		return None;
	};
	serde_json::from_str(raw.get()).ok()
}

/// Renders a rounded `skill <name> <args>` frame.
///
/// The source path keeps its full `file://` target while its label shortens
/// the home prefix. The expanded form reveals the exact model-facing prompt
/// as Markdown under the shared Ctrl+O expansion state.
#[must_use]
pub fn prompt_card(prompt: &SkillPrompt, expanded: bool) -> Component {
	let name = if prompt.name.trim().is_empty() {
		Str::new_static("unknown")
	} else {
		Str::new(prompt.name.trim())
	};
	let args = prompt
		.args
		.as_deref()
		.map(flatten_args)
		.filter(|args| !args.is_empty());
	let path = shortened_path(prompt.path.as_str());
	let href = file_link(prompt.path.as_str());
	let lines = if prompt.line_count == 1 {
		sf!("{} line", prompt.line_count)
	} else {
		sf!("{} lines", prompt.line_count)
	};
	let body = prompt.prompt_body.clone();

	dom! {
		<box border=round bc=border bg=surface pad="1 1">
			<row gap=1>
				<i:skill fg=accent/>
				<text bold fg=accent>{"skill"}</text>
				<text bold>{name}</text>
				if let Some(args) = args { <text fg=muted>{args}</text> }
			</row>
			<row gap=1 pad-x=2>
				<text fg=accent href={href}>{path}</text>
				<i:dot fg=muted/>
				<text fg=muted>{lines}</text>
			</row>
			if expanded && !body.is_empty() {
				<spacer/>
				<text fg=muted>{"prompt"}</text>
				<spacer/>
				<md>{body}</md>
			}
		</box>
	}
	.into_component()
}

/// Plain semantic description used by headless actors and transcript dumps.
#[must_use]
pub fn prompt_text(prompt: &SkillPrompt) -> Str {
	let name = prompt.name.trim();
	let args = prompt
		.args
		.as_deref()
		.map(flatten_args)
		.filter(|args| !args.is_empty());
	let unit = if prompt.line_count == 1 {
		"line"
	} else {
		"lines"
	};
	match args {
		Some(args) => sf!(
			"skill {name} {args}\n{} · {} {unit}\n\n{}",
			prompt.path,
			prompt.line_count,
			prompt.prompt_body
		),
		None => sf!(
			"skill {name}\n{} · {} {unit}\n\n{}",
			prompt.path,
			prompt.line_count,
			prompt.prompt_body
		),
	}
}

fn flatten_args(args: &str) -> Str {
	let mut flattened = String::with_capacity(args.len());
	for word in args.split_whitespace() {
		if !flattened.is_empty() {
			flattened.push(' ');
		}
		flattened.push_str(word);
	}
	Str::new(flattened)
}

fn shortened_path(path: &str) -> Str {
	let Some(home) = std::env::var_os("HOME") else {
		return Str::new(path);
	};
	let home = Path::new(&home).to_string_lossy();
	shortened_path_from(path, home.as_ref())
}

fn shortened_path_from(path: &str, home: &str) -> Str {
	omp_core::shorten_home_path(path, home).map_or_else(|| Str::new(path), Str::new)
}

#[cfg(test)]
mod tests {
	use omp_dom::{KnownTag, Tag};
	use omp_tui::{Ui, UiContext, frame_text};

	use super::*;

	fn payload() -> SkillPrompt {
		SkillPrompt {
			name:        Str::new_static("atomic-commit"),
			args:        Some(Str::new_static("stage all\nthen split")),
			path:        Str::new_static("/Users/example/.o2/skills/atomic-commit/SKILL.md"),
			prompt_body: Str::new_static("Use **atomic** commits.\n\n- Verify each hunk"),
			line_count:  88,
		}
	}

	fn rows(component: Component) -> String {
		let ui = Ui::from_root(component, 100, UiContext::default());
		frame_text(ui.frame())
	}

	#[test]
	fn typed_payload_requires_the_skill_marker() {
		let data = serde_json::value::to_raw_value(&payload()).expect("payload");
		let mut node = Node {
			tag:     Tag::Known(KnownTag::User),
			props:   Default::default(),
			kids:    Vec::new(),
			content: None,
		};
		node.props.push((PropId::Data.into(), Value::Json(data)));
		assert!(prompt(&node).is_none());
		node
			.props
			.push((PropKey::Custom(Str::new_static(SKILL_PROMPT_PROP)), Value::Bool(true)));
		assert_eq!(prompt(&node), Some(payload()));
	}

	#[test]
	fn frame_flattens_args_and_reveals_markdown_only_when_expanded() {
		let collapsed = rows(prompt_card(&payload(), false));
		assert!(collapsed.contains("skill atomic-commit stage all then split"), "{collapsed:?}");
		assert!(collapsed.contains("88 lines"), "{collapsed:?}");
		assert!(!collapsed.contains("Use atomic commits"), "{collapsed:?}");
		assert!(
			collapsed
				.lines()
				.next()
				.is_some_and(|row| row.starts_with('╭'))
		);

		let expanded = rows(prompt_card(&payload(), true));
		assert!(expanded.contains("prompt"), "{expanded:?}");
		assert!(expanded.contains("Use atomic commits"), "{expanded:?}");
		assert!(expanded.contains("Verify each hunk"), "{expanded:?}");
	}

	#[test]
	fn source_path_shortens_only_its_visible_home_prefix() {
		assert_eq!(
			shortened_path_from("/Users/example/.o2/skills/review/SKILL.md", "/Users/example"),
			"~/.o2/skills/review/SKILL.md"
		);
		assert_eq!(
			shortened_path_from("/work/project/SKILL.md", "/Users/example"),
			"/work/project/SKILL.md"
		);
	}

	#[test]
	fn singular_line_and_semantic_copy_text_are_exact() {
		let mut prompt = payload();
		prompt.line_count = 1;
		assert!(rows(prompt_card(&prompt, false)).contains("1 line"));
		assert_eq!(
			prompt_text(&prompt),
			"skill atomic-commit stage all then \
			 split\n/Users/example/.o2/skills/atomic-commit/SKILL.md · 1 line\n\nUse **atomic** \
			 commits.\n\n- Verify each hunk"
		);
	}
}
