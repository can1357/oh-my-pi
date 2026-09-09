//! Journal-derived components used by lifecycle-sensitive session features.

use omp_core::Str;
use omp_dom::{Dom, Handle, NodeSpec, PropId, PropKey, Tag, Value};
use omp_journal::{Entry, Kind, data::ToolResult, kind};

use crate::{Component, Draft};

const CHECKPOINT: &str = "checkpoint";
const PLAN_MODE: &str = "plan-mode";
const TOOL_ROSTER: &str = "tool-roster";
const DEFERRED_ACTIVATION: &str = "deferred-activation";
const TURN_COUNTER: &str = "turn-counter";
const SESSION_TRANSITIONS: &str = "session-transitions";
const ACTIVE_TOOL: &str = "active-tool";
pub(crate) const SWITCHES: &str = "switches";
pub(crate) const PROCESS_EXITED: &str = "process-exited";

/// Derives durable checkpoint references from `checkpoint` tool outcomes.
pub struct Checkpoint;

impl Component for Checkpoint {
	fn interested(&self, kind: &Kind) -> bool {
		is_genesis_or_result(kind)
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if is_genesis(entry) {
			insert_root(dom, draft, CHECKPOINT);
			return;
		}
		let Some(outcome) = tool_outcome(entry, dom, CHECKPOINT) else {
			return;
		};
		if outcome.get("action").and_then(serde_json::Value::as_str) != Some("created") {
			return;
		}
		let Some(name) = outcome
			.get("checkpoints")
			.and_then(serde_json::Value::as_array)
			.and_then(|checkpoints| checkpoints.first())
			.and_then(|checkpoint| checkpoint.get("label"))
			.and_then(serde_json::Value::as_str)
		else {
			return;
		};
		let Some(root) = component_root(dom, CHECKPOINT) else {
			return;
		};
		draft.insert(
			root,
			dom.children(root).last().copied(),
			NodeSpec::new(Tag::Custom(Str::new_static("entry")))
				.with_prop(PropId::Name, Value::Str(Str::new(name))),
		);
	}
}

/// Derives whether plan-mode restrictions are engaged.
pub struct PlanMode;

impl Component for PlanMode {
	fn interested(&self, kind: &Kind) -> bool {
		is_genesis_or_result(kind)
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if is_genesis(entry) {
			insert_root_with(dom, draft, PLAN_MODE, PropId::Engaged, Value::Bool(false));
			return;
		}
		let Some(outcome) = tool_outcome(entry, dom, PLAN_MODE) else {
			return;
		};
		let Some(active) = outcome.get("active").and_then(serde_json::Value::as_bool) else {
			return;
		};
		let Some(root) = component_root(dom, PLAN_MODE) else {
			return;
		};
		draft.set(root, PropId::Engaged.into(), Value::Bool(active));
	}
}

/// Derives the dynamically registered tool roster for the selected branch.
pub struct ToolRoster;

impl Component for ToolRoster {
	fn interested(&self, kind: &Kind) -> bool {
		is_genesis_or_result(kind)
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if is_genesis(entry) {
			insert_root(dom, draft, TOOL_ROSTER);
			return;
		}
		let Some(outcome) = tool_outcome(entry, dom, "dynamic-tools") else {
			return;
		};
		let Some(tools) = outcome.get("tools").and_then(serde_json::Value::as_array) else {
			return;
		};
		replace_tools(dom, draft, TOOL_ROSTER, tools);
	}
}

/// Derives tools activated by deferred discovery on the selected branch.
pub struct DeferredActivation;

impl Component for DeferredActivation {
	fn interested(&self, kind: &Kind) -> bool {
		is_genesis_or_result(kind)
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if is_genesis(entry) {
			insert_root(dom, draft, DEFERRED_ACTIVATION);
			return;
		}
		let Some(outcome) = tool_outcome(entry, dom, "discover-tools") else {
			return;
		};
		let Some(tools) = outcome.get("tools").and_then(serde_json::Value::as_array) else {
			return;
		};
		replace_tools(dom, draft, DEFERRED_ACTIVATION, tools);
	}
}

/// Derives the current turn ordinal by counting materialized `<turn>` nodes.
pub struct TurnCounter;

impl Component for TurnCounter {
	fn interested(&self, kind: &Kind) -> bool {
		(kind.rev == 1 && kind.name.as_str() == kind::JOURNAL)
			|| (kind.rev == 1 && kind.name.as_str() == kind::TURN_START)
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if is_genesis(entry) {
			insert_root_with(dom, draft, TURN_COUNTER, PropId::Value, Value::Int(0));
			return;
		}
		let Some(root) = component_root(dom, TURN_COUNTER) else {
			return;
		};
		let turns = i64::try_from(dom.children(dom.body()).len()).unwrap_or(i64::MAX);
		draft.set(root, PropId::Value.into(), Value::Int(turns));
	}
}

/// Declares distinct journaled state for session switches and process exit.
pub struct SessionTransitions;

impl Component for SessionTransitions {
	fn interested(&self, kind: &Kind) -> bool {
		kind.rev == 1 && kind.name.as_str() == kind::JOURNAL
	}

	fn apply(&mut self, entry: &Entry, dom: &Dom, draft: &mut Draft) {
		if !is_genesis(entry) {
			return;
		}
		let Some(con) = con_root(dom) else { return };
		draft.insert(
			con,
			dom.children(con).last().copied(),
			NodeSpec::new(Tag::Custom(Str::new_static(SESSION_TRANSITIONS)))
				.with_prop(PropKey::Custom(Str::new_static(SWITCHES)), Value::Int(0))
				.with_prop(PropKey::Custom(Str::new_static(PROCESS_EXITED)), Value::Bool(false)),
		);
	}
}

/// Returns checkpoint names in journal order from the selected branch.
#[must_use]
pub fn checkpoints(dom: &Dom) -> Vec<Str> {
	component_values(dom, CHECKPOINT)
}

/// Returns whether the selected branch has plan mode engaged.
#[must_use]
pub fn plan_mode_active(dom: &Dom) -> bool {
	component_root(dom, PLAN_MODE)
		.and_then(|handle| dom.get(handle))
		.and_then(|node| node.prop(&PropKey::from(PropId::Engaged)))
		.is_some_and(|value| matches!(value, Value::Bool(true)))
}

/// Returns the dynamically registered tool names on the selected branch.
#[must_use]
pub fn roster(dom: &Dom) -> Vec<Str> {
	component_values(dom, TOOL_ROSTER)
}

/// Returns the deferred tool names active on the selected branch.
#[must_use]
pub fn deferred_tools(dom: &Dom) -> Vec<Str> {
	component_values(dom, DEFERRED_ACTIVATION)
}

/// Returns the selected branch's recorded session-switch count.
#[must_use]
pub fn session_switch_count(dom: &Dom) -> u64 {
	transitions_handle(dom)
		.and_then(|handle| dom.get(handle))
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static(SWITCHES))))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		})
		.unwrap_or_default()
}

/// Returns whether a distinct process-exit transition was recorded.
#[must_use]
pub fn process_exit_observed(dom: &Dom) -> bool {
	transitions_handle(dom)
		.and_then(|handle| dom.get(handle))
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static(PROCESS_EXITED))))
		.is_some_and(|value| matches!(value, Value::Bool(true)))
}

/// Returns the selected branch's derived turn number.
#[must_use]
pub fn turn_number(dom: &Dom) -> u64 {
	component_root(dom, TURN_COUNTER)
		.and_then(|handle| dom.get(handle))
		.and_then(|node| node.prop(&PropKey::from(PropId::Value)))
		.and_then(|value| match value {
			Value::Int(value) => u64::try_from(*value).ok(),
			_ => None,
		})
		.unwrap_or_default()
}

fn is_genesis_or_result(kind: &Kind) -> bool {
	kind.rev == 1 && matches!(kind.name.as_str(), kind::JOURNAL | kind::TOOL_RESULT)
}

fn is_genesis(entry: &Entry) -> bool {
	entry.kind.rev == 1 && entry.kind.name.as_str() == kind::JOURNAL
}

fn insert_root(dom: &Dom, draft: &mut Draft, tag: &'static str) {
	let Some(con) = con_root(dom) else { return };
	draft.insert(
		con,
		dom.children(con).last().copied(),
		NodeSpec::new(Tag::Custom(Str::new_static(tag))),
	);
}

fn insert_root_with(dom: &Dom, draft: &mut Draft, tag: &'static str, prop: PropId, value: Value) {
	let Some(con) = con_root(dom) else { return };
	draft.insert(
		con,
		dom.children(con).last().copied(),
		NodeSpec::new(Tag::Custom(Str::new_static(tag))).with_prop(prop, value),
	);
}

fn con_root(dom: &Dom) -> Option<Handle> {
	dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(omp_dom::KnownTag::Con))
	})
}

pub(crate) fn transitions_handle(dom: &Dom) -> Option<Handle> {
	component_root(dom, SESSION_TRANSITIONS)
}

fn component_root(dom: &Dom, tag: &str) -> Option<Handle> {
	let con = con_root(dom)?;
	dom.children(con).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag.as_str() == tag)
	})
}

fn component_values(dom: &Dom, component: &str) -> Vec<Str> {
	let Some(root) = component_root(dom, component) else {
		return Vec::new();
	};
	dom.children(root)
		.iter()
		.filter_map(|handle| {
			dom.get(*handle)?
				.prop(&PropKey::from(PropId::Name))?
				.as_str()
				.map(Str::new)
		})
		.collect()
}

fn tool_outcome(entry: &Entry, dom: &Dom, tool: &str) -> Option<serde_json::Value> {
	let call = entry.by?;
	let wanted = call.to_string();
	let matches_tool = dom.handles().any(|handle| {
		dom.get(handle).is_some_and(|node| {
			node.tag.as_str() == tool
				&& node
					.prop(&PropKey::from(PropId::Cause))
					.and_then(Value::as_str)
					.is_some_and(|cause| cause == wanted)
		})
	});
	if !matches_tool {
		return None;
	}
	let ToolResult::Outcome { outcome, .. } = serde_json::from_str(entry.data.as_str()).ok()? else {
		return None;
	};
	serde_json::from_str(outcome.get()).ok()
}

fn replace_tools(dom: &Dom, draft: &mut Draft, component: &str, tools: &[serde_json::Value]) {
	let Some(root) = component_root(dom, component) else {
		return;
	};
	for child in dom.children(root) {
		draft.remove(*child);
	}
	let mut after = None;
	let mut next = dom.high_water() + 1;
	for tool in tools.iter().filter_map(serde_json::Value::as_str) {
		draft.insert(
			root,
			after,
			NodeSpec::new(Tag::Custom(Str::new_static(ACTIVE_TOOL)))
				.with_prop(PropId::Name, Value::Str(Str::new(tool))),
		);
		after = Handle::new(next);
		next += 1;
	}
}
