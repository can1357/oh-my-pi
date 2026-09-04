//! Journal-derived `todo@3` execution over `<meta><todo>`.

use omp_agent::{SessionTool, SessionToolCx, SessionToolError, SessionToolFuture};
use omp_core::{FastHashMap, FastHashSet, Str};
use omp_dom::{KnownTag, PropId, PropKey, Tag, Value as DomValue};
use omp_tool::{CallOutcome, Part, ToolSpec};
use omp_tools::todo::{self, Phase, Status, Task};

const PHASE: &str = "phase";
const PHASE_ORDER: &str = "phase-order";

/// Session-owned todo reducer. It holds only the immutable declaration; every
/// invocation selects its input from the authoritative session DOM.
pub struct TodoSessionTool {
	spec: ToolSpec,
}

impl TodoSessionTool {
	/// Creates the canonical journal-derived todo executor.
	#[must_use]
	pub fn new() -> Self {
		Self { spec: todo::spec() }
	}
}

impl Default for TodoSessionTool {
	fn default() -> Self {
		Self::new()
	}
}

impl SessionTool for TodoSessionTool {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn project(
		&self,
		outcome: &CallOutcome<Box<serde_json::value::RawValue>, Box<serde_json::value::RawValue>>,
	) -> Result<Vec<Part>, SessionToolError> {
		let text = match outcome {
			CallOutcome::Ok(raw) => {
				let payload: todo::Payload = serde_json::from_str(raw.get())?;
				Some(todo::model_output(Ok(&payload)))
			},
			CallOutcome::Faulted(raw) => {
				let fault: todo::Fault = serde_json::from_str(raw.get())?;
				Some(todo::model_output(Err(&fault)))
			},
			CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => None,
		};
		Ok(text.map_or_else(Vec::new, |text| vec![Part::Text { text: Str::from(text) }]))
	}

	fn call<'a>(
		&'a self,
		cx: SessionToolCx<'a>,
		args: Box<serde_json::value::RawValue>,
	) -> SessionToolFuture<'a> {
		Box::pin(async move {
			let mut raw: serde_json::Value = serde_json::from_str(args.get())?;
			if let Some(object) = raw.as_object_mut() {
				object.remove("i");
				object.remove("notrunc");
			}
			let mut phases = phases_from_dom(cx.session.dom());
			let params = match todo::resolve_params(raw, !phases.is_empty()) {
				Ok(params) => params,
				Err(issue) => return Ok(CallOutcome::ArgsRejected(issue)),
			};
			if cx.cancel.is_cancelled() {
				return Ok(CallOutcome::aborted(omp_tool::Abort::Skipped {
					reason: Str::new_static("todo operation cancelled before its atomic commit"),
				}));
			}
			match todo::apply(&mut phases, params) {
				Ok(payload) => Ok(CallOutcome::Ok(serde_json::value::to_raw_value(&payload)?)),
				Err(fault) => Ok(CallOutcome::Faulted(serde_json::value::to_raw_value(&fault)?)),
			}
		})
	}
}

/// Reconstructs the typed phase tree from its DOM projection. `phase-order`
/// retains empty phases while item children remain directly selectable by old
/// actors and user-authored patches.
fn phases_from_dom(dom: &omp_dom::Dom) -> Vec<Phase> {
	let Some(todo) = dom.children(dom.meta()).iter().copied().find(|handle| {
		dom.get(*handle)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
	}) else {
		return Vec::new();
	};
	let order = dom
		.get(todo)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static(PHASE_ORDER))))
		.and_then(|value| match value {
			DomValue::Json(raw) => serde_json::from_str::<Vec<Str>>(raw.get()).ok(),
			_ => None,
		})
		.unwrap_or_default();
	let mut phases = Vec::with_capacity(order.len());
	let mut by_name = FastHashMap::<Str, usize>::default();
	for name in order {
		if by_name.contains_key(&name) {
			continue;
		}
		by_name.insert(name.clone(), phases.len());
		phases.push(Phase { name, tasks: Vec::new() });
	}
	let mut seen_tasks = FastHashSet::<Str>::default();
	for handle in dom.children(todo) {
		let Some(node) = dom.get(*handle) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Item) {
			continue;
		}
		let Some(content) = node
			.prop(&PropId::Label.into())
			.and_then(DomValue::as_str)
			.map(Str::new)
		else {
			continue;
		};
		// A malformed user patch must not create an unaddressable second
		// identity. The earliest tree-ordered item remains authoritative.
		if !seen_tasks.insert(content.clone()) {
			continue;
		}
		let phase = node
			.prop(&PropKey::Custom(Str::new_static(PHASE)))
			.and_then(DomValue::as_str)
			.map_or_else(|| Str::new_static("Tasks"), Str::new);
		let phase_index = by_name.get(&phase).copied().unwrap_or_else(|| {
			let index = phases.len();
			by_name.insert(phase.clone(), index);
			phases.push(Phase { name: phase.clone(), tasks: Vec::new() });
			index
		});
		let status = node
			.prop(&PropId::Status.into())
			.and_then(DomValue::as_str)
			.and_then(|status| status.parse::<Status>().ok())
			.unwrap_or_default();
		let blocker = node
			.prop(&PropId::Detail.into())
			.and_then(DomValue::as_str)
			.map(Str::new);
		phases[phase_index]
			.tasks
			.push(Task { content, status, blocker });
	}
	phases
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use omp_dom::{NodeSpec, Op, Txn};
	use omp_session::{ComponentRegistry, Session};

	use super::*;

	fn session() -> (tempfile::TempDir, Session) {
		let directory = tempfile::tempdir().expect("temporary directory");
		let session =
			Session::create(directory.path().join("todo.oms"), ComponentRegistry::standard())
				.expect("session");
		(directory, session)
	}

	#[test]
	fn model_projection_is_the_todo_summary_not_raw_json() {
		let tool = TodoSessionTool::new();
		let payload = todo::Payload {
			op:              todo::Op::View,
			phases:          vec![Phase {
				name:  sf!("Build"),
				tasks: vec![Task {
					content: sf!("Compile crate"),
					status:  Status::InProgress,
					blocker: None,
				}],
			}],
			completed_tasks: Vec::new(),
		};
		let outcome: CallOutcome<Box<serde_json::value::RawValue>, Box<serde_json::value::RawValue>> =
			CallOutcome::Ok(serde_json::value::to_raw_value(&payload).expect("todo payload"));
		let parts = tool.project(&outcome).expect("model projection");
		assert!(matches!(
			parts.as_slice(),
			[Part::Text { text }] if text.contains("Compile crate [in_progress] (Build)")
		));
	}

	#[test]
	fn dom_projection_preserves_phase_order_empty_phases_and_user_patches() {
		let (_directory, mut session) = session();
		let cause = session.head().expect("genesis");
		let todo = session
			.dom()
			.children(session.dom().meta())
			.iter()
			.copied()
			.find(|handle| {
				session
					.dom()
					.get(*handle)
					.is_some_and(|node| node.tag == Tag::Known(KnownTag::Todo))
			})
			.expect("todo root");
		let order =
			serde_json::value::to_raw_value(&vec![sf!("Build"), sf!("Ship")]).expect("phase order");
		session
			.patch(Txn {
				cause,
				label: Some(sf!("todo.fixture")),
				ops: vec![
					Op::Set {
						h:     todo,
						prop:  PropKey::Custom(sf!(PHASE_ORDER)),
						value: DomValue::Json(order),
					},
					Op::Ins {
						parent: todo,
						after:  None,
						node:   NodeSpec::new(KnownTag::Item)
							.with_prop(PropId::Label, DomValue::Str(sf!("Compile crate")))
							.with_prop(PropId::Status, DomValue::Str(sf!("blocked")))
							.with_prop(PropId::Detail, DomValue::Str(sf!("waiting")))
							.with_prop(PropKey::Custom(sf!(PHASE)), DomValue::Str(sf!("Build"))),
					},
				],
			})
			.expect("patch");
		let phases = phases_from_dom(session.dom());
		assert_eq!(phases.len(), 2);
		assert_eq!(phases[0].name, "Build");
		assert_eq!(phases[0].tasks[0].status, Status::Blocked);
		assert_eq!(phases[0].tasks[0].blocker.as_deref(), Some("waiting"));
		assert_eq!(phases[1], Phase { name: sf!("Ship"), tasks: Vec::new() });
	}
}
