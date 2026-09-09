use omp_core::{FastHashSet, Str};
use omp_dom::{Dom, Handle, KnownTag, NodeSpec, PropId, PropKey, Tag, Value};
use omp_journal::{Entry, Kind, data::ToolResult, kind};

use crate::{Component, Draft};

/// Rebuilds `<meta><todo>` from successful `todo` tool snapshots.
pub struct TodoComponent;

impl Component for TodoComponent {
	fn interested(&self, kind: &Kind) -> bool {
		kind.rev == 1 && kind.name.as_str() == kind::TOOL_RESULT
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		let Some(call_id) = entry.by else { return };
		if !is_todo_call(dom, call_id) {
			return;
		}
		let Ok(ToolResult::Outcome { outcome, .. }) = serde_json::from_str(entry.data.as_str())
		else {
			return;
		};
		let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(outcome.get()) else {
			return;
		};
		if payload.get("kind").and_then(serde_json::Value::as_str) == Some("ok") {
			payload = payload
				.get_mut("value")
				.map_or(serde_json::Value::Null, serde_json::Value::take);
		}
		let Some(phases) = payload.get("phases").and_then(serde_json::Value::as_array) else {
			return;
		};
		// Decode the complete snapshot before staging any mutation. A corrupt
		// historical result must not erase the last valid todo state.
		let Some(phases) = decode_phases(phases) else {
			return;
		};
		let Some(todo) = find_tag(dom, dom.meta(), KnownTag::Todo) else {
			return;
		};
		for child in dom.children(todo) {
			draft.remove(*child);
		}
		if let Ok(order) = serde_json::value::to_raw_value(
			&phases.iter().map(|phase| &phase.name).collect::<Vec<_>>(),
		) {
			draft.set(todo, PropKey::Custom(Str::new_static("phase-order")), Value::Json(order));
		}
		let mut after = None;
		let mut next = dom.high_water() + 1;
		for phase in phases {
			for item in phase.tasks {
				let mut node = NodeSpec::new(KnownTag::Item)
					.with_prop(PropId::Label, Value::Str(item.content))
					.with_prop(PropId::Status, Value::Str(item.status))
					.with_prop(
						PropKey::Custom(Str::new_static("phase")),
						Value::Str(phase.name.clone()),
					);
				if let Some(blocker) = item.blocker {
					node = node.with_prop(PropId::Detail, Value::Str(blocker));
				}
				draft.insert(todo, after, node);
				after = Handle::new(next);
				next += 1;
			}
		}
	}
}

struct PhaseSnapshot {
	name:  Str,
	tasks: Vec<ItemSnapshot>,
}

struct ItemSnapshot {
	content: Str,
	status:  Str,
	blocker: Option<Str>,
}

/// Accepts the current `todo@3` payload and the historical `todo@1`/`todo@2`
/// shapes. Duplicate identities and malformed records reject the snapshot
/// atomically.
fn decode_phases(phases: &[serde_json::Value]) -> Option<Vec<PhaseSnapshot>> {
	let mut decoded = Vec::with_capacity(phases.len());
	let mut phase_names = FastHashSet::<&str>::default();
	let mut task_names = FastHashSet::<&str>::default();
	for phase in phases {
		let name = phase
			.get("name")
			.or_else(|| phase.get("phase"))
			.and_then(serde_json::Value::as_str)?;
		if !phase_names.insert(name) {
			return None;
		}
		let tasks = phase
			.get("tasks")
			.or_else(|| phase.get("items"))
			.and_then(serde_json::Value::as_array)?;
		let mut items = Vec::with_capacity(tasks.len());
		for task in tasks {
			let content = task
				.get("content")
				.or_else(|| task.get("text"))
				.and_then(serde_json::Value::as_str)?;
			if !task_names.insert(content) {
				return None;
			}
			let status = task
				.get("status")
				.and_then(serde_json::Value::as_str)
				.unwrap_or("pending");
			if !matches!(status, "pending" | "in_progress" | "completed" | "abandoned" | "blocked") {
				return None;
			}
			let blocker = match task.get("blocker").or_else(|| task.get("reason")) {
				Some(value) => Some(value.as_str()?),
				None => None,
			};
			items.push(ItemSnapshot {
				content: Str::new(content),
				status:  Str::new(status),
				blocker: blocker.map(Str::new),
			});
		}
		decoded.push(PhaseSnapshot { name: Str::new(name), tasks: items });
	}
	Some(decoded)
}

fn is_todo_call(dom: &Dom, entry_id: omp_journal::EntryId) -> bool {
	let wanted = entry_id.to_string();
	dom.handles().any(|handle| {
		dom.get(handle).is_some_and(|node| {
			node.tag == Tag::Custom(Str::new_static("todo"))
				&& node
					.prop(&PropKey::from(PropId::Cause))
					.and_then(Value::as_str)
					.is_some_and(|cause| cause == wanted)
		})
	})
}

fn find_tag(dom: &Dom, parent: Handle, tag: KnownTag) -> Option<Handle> {
	dom.children(parent).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(tag))
	})
}
