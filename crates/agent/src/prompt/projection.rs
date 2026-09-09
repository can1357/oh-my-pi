//! Pure session-DOM projections feeding prompt templates.

use std::fmt::Write as _;

use omp_core::{Hash32, Str};
use omp_dom::{Dom, PropKey, Value as DomValue};
use omp_journal::blob::{BlobRef, BlobStore};
use omp_proto::thread::v1::{Item, Part, item, part};
use omp_scribe::{Props, Value};

const PROMPT_FACTS: &str = "prompt-facts";

/// Projects the template value bag from the authoritative session tree.
///
/// Composition may journal stable prompt configuration as the `prompt-facts`
/// JSON property on `<meta>`. Live facts are always overwritten from their
/// materialized component elements, so a stale configured value cannot become
/// a second authority.
#[must_use]
pub fn template_props(dom: &Dom) -> Props {
	let mut props = default_props();
	if let Some(DomValue::Json(raw)) = dom
		.get(dom.meta())
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static(PROMPT_FACTS))))
		&& let Ok(serde_json::Value::Object(values)) =
			serde_json::from_str::<serde_json::Value>(raw.get())
	{
		for (key, value) in values {
			props.set(Str::from(key), Value::from(&value));
		}
	}

	let roster = omp_session::components::lifecycle::roster(dom);
	if !roster.is_empty() {
		props.set("tools", roster.clone());
		props.set("tool_inventory", compact_tool_inventory(&roster));
	}
	if let Some(skillful) = session_bool(dom, crate::AI_SKILLFUL.name()) {
		props.set("include_skills", skillful);
	}
	props.set(
		"turn_number",
		i64::try_from(omp_session::components::lifecycle::turn_number(dom)).unwrap_or(i64::MAX),
	);
	props
}

/// Projects canonical conversation items and resolves journaled blob parts
/// against `blobs` at the projection boundary (no process-local attachment
/// index): every user attachment must be present, so a missing one fails the
/// request. A missing snapcompact frame is omitted
/// while its summary text remains usable; a tool-result blob absent from the
/// session store stays a reference. Each present blob is read once into a
/// shared buffer the inference request then borrows.
///
/// # Errors
/// A user attachment is missing or corrupt in `blobs`.
pub fn project_thread_with_attachments(
	dom: &Dom,
	blobs: &BlobStore,
) -> Result<Vec<Item>, omp_journal::blob::Error> {
	let mut items = omp_session::project_thread(dom);
	for item in &mut items {
		match item.kind.as_mut() {
			Some(item::Kind::Message(message)) => {
				let required = message.synthetic != Some(true);
				let source = std::mem::take(&mut message.parts);
				let mut retained = Vec::with_capacity(source.len());
				for mut part in source {
					if inline_blob(&mut part, blobs, required)? {
						retained.push(part);
					}
				}
				message.parts = retained;
			},
			Some(item::Kind::ToolResult(result)) => {
				for part in &mut result.parts {
					let _ = inline_blob(part, blobs, false)?;
				}
			},
			_ => {},
		}
	}
	Ok(items)
}

fn inline_blob(
	part: &mut Part,
	blobs: &BlobStore,
	required: bool,
) -> Result<bool, omp_journal::blob::Error> {
	let Some(part::Kind::Blob(blob)) = part.kind.as_mut() else {
		return Ok(true);
	};
	if !blob.inline.is_empty() {
		return Ok(true);
	}
	let Ok(hash) = <[u8; 32]>::try_from(blob.hash.as_ref()) else {
		return Ok(required);
	};
	let reference = BlobRef { hash: Hash32::new(hash), size: blob.size };
	match blobs.get(&reference) {
		Ok(bytes) => {
			blob.inline = bytes;
			Ok(true)
		},
		Err(source) if required => Err(source),
		Err(_) => Ok(false),
	}
}

/// Reads one journaled boolean convar directly from the authoritative DOM.
///
/// `Value::Display` uses command-stream spelling (`1`/`0`), while imported
/// sessions may contain the equivalent words.
fn session_bool(dom: &Dom, name: &str) -> Option<bool> {
	omp_session::components::con::con_writes(dom)
		.into_iter()
		.rev()
		.find(|write| write.name == name)
		.and_then(|write| match write.value.as_str() {
			"1" | "true" | "on" => Some(true),
			"0" | "false" | "off" => Some(false),
			_ => None,
		})
}

fn default_props() -> Props {
	let mut props = Props::new();
	props.set("cwd", "");
	props.set("host", omp_scribe::map! {
		"os" => "", "distro" => "", "kernel" => "", "arch" => "",
		"cpu" => "", "terminal" => "", "gpus" => Vec::<Str>::new(),
	});
	props.set("model", omp_scribe::map! { "identifier" => "", "codex_task_policy" => false });
	props.set("repositories", Vec::<Value>::new());
	props.set("roots", omp_scribe::map! { "revision" => 0, "roots" => Vec::<Value>::new() });
	props.set("additional_roots", Vec::<Value>::new());
	props.set("context_files", Vec::<Value>::new());
	props.set("directory_context", Vec::<Value>::new());
	props.set("workspace_trees", Vec::<Value>::new());
	props.set("skills", Vec::<Value>::new());
	props.set("rules", Vec::<Value>::new());
	props.set("always_apply_rules", Vec::<Value>::new());
	props.set("personality", include_str!("../../prompts/personality/default.md"));
	props.set("render_mermaid", true);
	props.set("include_workstation", true);
	props.set("include_model", true);
	props.set("include_workspace_tree", false);
	props.set("include_skills", true);
	props.set("secrets_enabled", false);
	props.set("null_prompt", false);
	props.set("tool_inventory", "");
	props.set("tools", Vec::<Str>::new());
	props.set("schemes", Vec::<Value>::new());
	props.set("scheme_selectors", false);
	props.set("computer", false);
	props.set("delegation", omp_scribe::map! {
		"enabled" => false, "eager" => "off", "batch" => false,
		"concurrency" => 0, "queued" => 0, "scout_available" => false,
		"coordination" => false,
	});
	props.set("mutations", omp_scribe::map! {
		"format_on_write" => false, "fetch" => false, "editor" => false,
		"escalation" => false,
	});
	props.set("edit_hashline", false);
	props.set("edit_apply_patch", false);
	props.set("edit_sloppy", false);
	props.set("turn_number", 0);
	props.set("date", "");
	props.set("mounts", Vec::<Value>::new());
	props
}

fn compact_tool_inventory(roster: &[Str]) -> Str {
	if roster.is_empty() {
		return Str::default();
	}
	let mut out = String::from("\n# Tool Inventory\n");
	for tool in roster {
		let _ = writeln!(out, "- `{tool}`");
	}
	Str::from(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn empty_dom_projects_legacy_default_values() {
		let props = template_props(&Dom::new());
		assert_eq!(props.get("turn_number"), Some(&Value::Int(0)));
		assert!(!props.get("tools").unwrap().is_truthy());
		assert!(props.get("personality").unwrap().is_truthy());
	}

	#[test]
	fn all_process_facts_are_rendered_only_by_the_volatile_projection() {
		let dom = Dom::new();
		let mut props = default_props();
		props.set("cwd", "/work/omp");
		props.set("date", "2026-09-02");
		props.set("mounts", vec!["/work"]);
		let stable = crate::prompt::assets::project()
			.render_scoped_str(crate::prompt::assets::engine(), &props.with_dom(&dom))
			.unwrap();
		assert!(!stable.contains("/work/omp"));
		assert!(!stable.contains("2026-09-02"));
		assert!(!stable.contains("mounts:"));
		let volatile = crate::prompt::assets::status()
			.render_scoped_str(crate::prompt::assets::engine(), &props.with_dom(&dom))
			.unwrap();
		assert!(volatile.contains("cwd: /work/omp"));
		assert!(volatile.contains("date: 2026-09-02"));
		assert!(volatile.contains("mounts:\n- /work"));
	}
}
