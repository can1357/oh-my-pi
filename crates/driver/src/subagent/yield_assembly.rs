//! Pure assembly of a child's `yield` calls into the payload that output-schema
//! validation consumes.
//!
//! An array-typed `type` contributes an incremental section and never decides
//! termination on its own; a string-typed `type` with an empty `result` makes
//! the child's last assistant turn the raw terminal result; any other terminal
//! yield contributes the complete payload verbatim. When the run ends with only
//! incremental sections, the accumulated sections are the result.

use omp_core::{FastHashMap, FastHashSet, Str};
use omp_dom::{KnownTag, PropId, PropKey, Tag, Value};
use omp_session::Session;
use omp_tools::yield_tool::{
	Params as YieldParams, ResultEnvelope, WorkpoolItem, WorkpoolParams, YieldType,
};
use serde_json::{Map, Value as Json};
use thiserror::Error;

/// Standard prefix when a yield explicitly contains null data.
pub(crate) const WARNING_NULL_YIELD: &str =
	"[subagent null yield] no usable structured data was returned";

/// Terminal payload folded from every successful `yield` call of one run.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Assembled {
	/// No yield decided the run.
	Missing,
	/// The run's complete structured (or raw-text) result.
	Data(Json),
	/// The child explicitly failed, or finalized without usable data.
	Error(String),
}

impl Assembled {
	/// Splits into the `(data, error)` pair the spawner reports.
	pub(crate) fn into_parts(self) -> (Option<Json>, Option<String>) {
		match self {
			Self::Missing => (None, None),
			Self::Data(data) => (Some(data), None),
			Self::Error(error) => (None, Some(error)),
		}
	}
}

/// Every `yield` call that settled `ok`, in journal order.
pub(crate) fn settled_yields(session: &Session) -> Vec<YieldParams> {
	let dom = session.dom();
	let yield_tag = Tag::Custom(Str::new_static("yield"));
	dom.handles()
		.filter_map(|handle| {
			let node = dom.get(handle)?;
			if node.tag != yield_tag
				|| node
					.prop(&PropKey::from(PropId::Status))
					.and_then(Value::as_str)
					!= Some("ok")
			{
				return None;
			}
			let input = dom.children(handle).iter().find_map(|child| {
				let node = dom.get(*child)?;
				(node.tag == omp_dom::Tag::Known(omp_dom::KnownTag::Input)).then_some(node)
			})?;
			let raw = input.content.as_deref().or_else(|| {
				input
					.prop(&PropKey::from(PropId::Text))
					.and_then(Value::as_str)
			})?;
			serde_json::from_str::<YieldParams>(raw).ok()
		})
		.collect()
}

/// Reconstructs one workpool batch result from its latest replayed turn.
///
/// Successful fields are inserted in the batch's authored item order, never
/// tool-call order. The fold revalidates correlation so a malformed or stale
/// journal cannot smuggle duplicate or unknown item ids into the aggregate.
pub(super) fn assemble_workpool_batch(
	session: &Session,
	items: &[WorkpoolItem],
) -> Result<Json, WorkpoolAssemblyError> {
	let mut by_index = FastHashMap::default();
	let mut ids = FastHashSet::default();
	for item in items {
		if by_index.insert(item.index, item).is_some() || !ids.insert(item.id.clone()) {
			return Err(WorkpoolAssemblyError::DuplicateItem { id: item.id.clone() });
		}
	}
	let mut yielded = FastHashMap::<Str, Json>::default();
	for raw in settled_yield_inputs_in_last_turn(session) {
		let params = serde_json::from_str::<WorkpoolParams>(raw)
			.map_err(|source| WorkpoolAssemblyError::Malformed { source })?;
		let item = by_index
			.get(&params.key)
			.ok_or(WorkpoolAssemblyError::UnknownItem { key: params.key })?;
		if yielded.contains_key(&item.id) {
			return Err(WorkpoolAssemblyError::DuplicateItem { id: item.id.clone() });
		}
		match (params.data, params.error) {
			(Some(data), None) => {
				yielded.insert(item.id.clone(), data);
			},
			(None, Some(error)) if error.trim().is_empty() => {
				return Err(WorkpoolAssemblyError::Envelope { id: item.id.clone() });
			},
			(None, Some(error)) => {
				return Err(WorkpoolAssemblyError::ItemFailed { id: item.id.clone(), error });
			},
			_ => return Err(WorkpoolAssemblyError::Envelope { id: item.id.clone() }),
		}
	}
	let missing = items
		.iter()
		.filter(|item| !yielded.contains_key(&item.id))
		.map(|item| item.id.clone())
		.collect::<Vec<_>>();
	if !missing.is_empty() {
		return Err(WorkpoolAssemblyError::MissingItems { ids: missing });
	}
	let mut output = Map::with_capacity(items.len());
	for item in items {
		if let Some(value) = yielded.remove(&item.id) {
			output.insert(item.id.to_string(), value);
		}
	}
	Ok(Json::Object(output))
}

fn settled_yield_inputs_in_last_turn(session: &Session) -> Vec<&str> {
	let dom = session.dom();
	let Some(turn) = dom
		.children(dom.body())
		.iter()
		.rev()
		.copied()
		.find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Turn))
		})
	else {
		return Vec::new();
	};
	dom.children(turn)
		.iter()
		.filter_map(|handle| {
			let node = dom.get(*handle)?;
			if node.tag != Tag::Custom(Str::new_static("yield"))
				|| node
					.prop(&PropKey::from(PropId::Status))
					.and_then(Value::as_str)
					!= Some("ok")
			{
				return None;
			}
			dom.children(*handle).iter().find_map(|child| {
				let input = dom.get(*child)?;
				if input.tag != Tag::Known(KnownTag::Input) {
					return None;
				}
				input.content.as_deref().or_else(|| {
					input
						.prop(&PropKey::from(PropId::Text))
						.and_then(Value::as_str)
				})
			})
		})
		.collect()
}

/// Invalid or incomplete replayed workpool yield sequence.
#[derive(Debug, Error)]
pub(super) enum WorkpoolAssemblyError {
	/// A settled input is not the batch-local yield shape.
	#[error("settled workpool yield has malformed arguments")]
	Malformed {
		/// JSON decoding cause.
		#[source]
		source: serde_json::Error,
	},
	/// A key was not advertised for this batch.
	#[error("workpool item key {key} is not in the active batch")]
	UnknownItem {
		/// Rejected one-based key.
		key: u32,
	},
	/// The same stable item was accepted twice.
	#[error("workpool item `{id}` was submitted more than once")]
	DuplicateItem {
		/// Repeated item identity.
		id: Str,
	},
	/// A settled item did not choose exactly one outcome.
	#[error("workpool item `{id}` must contain exactly one of data or error")]
	Envelope {
		/// Malformed item identity.
		id: Str,
	},
	/// A child explicitly failed one item.
	#[error("workpool item `{id}` failed")]
	ItemFailed {
		/// Failed item identity.
		id:    Str,
		/// Child-supplied reason.
		error: Str,
	},
	/// The child ended its turn before every item yielded.
	#[error("workpool turn ended without every required item")]
	MissingItems {
		/// Missing stable item identities in authored order.
		ids: Vec<Str>,
	},
}

impl WorkpoolAssemblyError {
	/// Converts a failed batch into the stable structured artifact projection.
	pub(super) fn into_output(self) -> Json {
		match self {
			Self::Malformed { .. } => serde_json::json!({
				"status": "failed",
				"code": "malformed_yield"
			}),
			Self::UnknownItem { key } => serde_json::json!({
				"status": "failed",
				"code": "unknown_item",
				"key": key
			}),
			Self::DuplicateItem { id } => serde_json::json!({
				"status": "failed",
				"code": "duplicate_item",
				"id": id
			}),
			Self::Envelope { id } => serde_json::json!({
				"status": "failed",
				"code": "invalid_envelope",
				"id": id
			}),
			Self::ItemFailed { id, error } => serde_json::json!({
				"status": "failed",
				"code": "item_failed",
				"id": id,
				"error": error
			}),
			Self::MissingItems { ids } => serde_json::json!({
				"status": "failed",
				"code": "missing_items",
				"ids": ids
			}),
		}
	}
}

/// Top-level output-schema property names declared as arrays. An incremental
/// section for such a label accumulates into a list even when the child emits
/// exactly one, so a single `type: ["findings"]` yield still validates.
pub(crate) fn array_valued_labels(schema: &Json) -> Vec<&str> {
	schema
		.get("properties")
		.and_then(Json::as_object)
		.map(|properties| {
			properties
				.iter()
				.filter(|(_, property)| is_array_typed(schema, property, 0))
				.map(|(name, _)| name.as_str())
				.collect()
		})
		.unwrap_or_default()
}

fn is_array_typed(root: &Json, schema: &Json, depth: u8) -> bool {
	const MAX_REF_DEPTH: u8 = 8;
	let Some(record) = schema.as_object() else {
		return false;
	};
	match record.get("type") {
		Some(Json::String(kind)) if kind == "array" => return true,
		Some(Json::Array(kinds)) if kinds.iter().any(|kind| kind.as_str() == Some("array")) => {
			return true;
		},
		_ => {},
	}
	if depth < MAX_REF_DEPTH
		&& let Some(reference) = record.get("$ref").and_then(Json::as_str)
		&& let Some(target) = resolve_local_ref(root, reference)
		&& is_array_typed(root, target, depth.saturating_add(1))
	{
		return true;
	}
	["anyOf", "oneOf", "allOf"].iter().any(|key| {
		record
			.get(*key)
			.and_then(Json::as_array)
			.is_some_and(|variants| {
				variants
					.iter()
					.any(|variant| is_array_typed(root, variant, depth.saturating_add(1)))
			})
	})
}

fn resolve_local_ref<'s>(root: &'s Json, reference: &str) -> Option<&'s Json> {
	let pointer = reference.strip_prefix('#')?;
	root.pointer(pointer)
}

/// Folds the run's yields (journal order) into its terminal payload.
///
/// `last_turn` is the child's final assistant text, used by a string-typed
/// terminal yield with an empty `result`. `array_labels` names the sections
/// that always accumulate into a list.
pub(crate) fn assemble(
	yields: &[YieldParams],
	last_turn: &str,
	array_labels: &[&str],
) -> Assembled {
	let Some(last) = yields.last() else {
		return Assembled::Missing;
	};
	// An aborting final yield ends the run
	// with its error regardless of what was accumulated before it.
	if let ResultEnvelope::Error { error } = &last.result {
		return Assembled::Error(error.to_string());
	}
	let terminal = yields
		.iter()
		.rev()
		.find(|params| !matches!(params.kind, Some(YieldType::Sections(_))));
	let mut sections = Map::new();
	let mut missing_data = false;
	for params in yields {
		let Some(YieldType::Sections(labels)) = &params.kind else {
			continue;
		};
		let value = match &params.result {
			ResultEnvelope::Data { data } => data.clone(),
			// Aborted sections are skipped; a data-less section reads the
			// last assistant turn.
			ResultEnvelope::Error { .. } => continue,
			ResultEnvelope::LastTurn {} => Json::String(last_turn.to_owned()),
		};
		missing_data |= value.is_null() || matches!(&value, Json::String(text) if text.is_empty());
		for label in labels {
			let label = label.as_str().trim();
			if label.is_empty() {
				continue;
			}
			append_section(&mut sections, label, value.clone(), array_labels.contains(&label));
		}
	}
	match terminal.map(|params| &params.result) {
		// An explicit terminal payload wins and is used verbatim, never
		// wrapped in a section.
		Some(ResultEnvelope::Data { data }) if data.is_null() => {
			Assembled::Error(WARNING_NULL_YIELD.to_owned())
		},
		Some(ResultEnvelope::Data { data }) => Assembled::Data(data.clone()),
		Some(ResultEnvelope::Error { error }) => Assembled::Error(error.to_string()),
		// A data-less terminal finalize keeps accumulated sections; only when
		// none exist does the last assistant turn become the raw result.
		_ if !sections.is_empty() => {
			if missing_data {
				Assembled::Error(WARNING_NULL_YIELD.to_owned())
			} else {
				Assembled::Data(Json::Object(sections))
			}
		},
		None => Assembled::Missing,
		Some(ResultEnvelope::LastTurn {}) if last_turn.is_empty() => {
			Assembled::Error(WARNING_NULL_YIELD.to_owned())
		},
		Some(ResultEnvelope::LastTurn {}) => Assembled::Data(Json::String(last_turn.to_owned())),
	}
}

fn append_section(sections: &mut Map<String, Json>, label: &str, value: Json, force_array: bool) {
	match sections.get_mut(label) {
		None => {
			let value = if force_array {
				Json::Array(vec![value])
			} else {
				value
			};
			sections.insert(label.to_owned(), value);
		},
		Some(Json::Array(existing)) => existing.push(value),
		Some(existing) => {
			let first = std::mem::take(existing);
			*existing = Json::Array(vec![first, value]);
		},
	}
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::*;

	fn params(value: Json) -> YieldParams {
		serde_json::from_value(value).expect("yield params")
	}

	fn settle_workpool(session: &mut Session, call_id: &str, args: Json) {
		let raw = serde_json::value::to_raw_value(&args).expect("workpool args");
		let call = session
			.call("yield", 2, Str::new(call_id), None, Some(raw), None)
			.expect("yield call");
		let outcome = serde_json::value::to_raw_value(&json!({
			"incremental": true,
			"use_last_turn": false,
			"validation": null,
			"complete": false
		}))
		.expect("yield outcome");
		session.settle(call, outcome).expect("yield settlement");
	}

	#[test]
	fn workpool_batch_assembles_in_item_order_and_replays_identically() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let path = temp.path().join("worker.oms");
		let mut session = Session::create(&path, omp_session::ComponentRegistry::standard())
			.expect("worker session");
		session.begin_turn().expect("turn");
		session.user("batch", Vec::new()).expect("prompt");
		settle_workpool(&mut session, "second", json!({"key": 2, "data": {"answer": 2}}));
		settle_workpool(
			&mut session,
			"first",
			json!({"key": 1, "data": {"summary": "partial", "confidence": 0.8}}),
		);
		let items =
			vec![WorkpoolItem { id: Str::new_static("pool#first"), index: 1 }, WorkpoolItem {
				id:    Str::new_static("pool#second"),
				index: 2,
			}];
		let live = assemble_workpool_batch(&session, &items).expect("live assembly");
		assert_eq!(
			live.to_string(),
			r#"{"pool#first":{"summary":"partial","confidence":0.8},"pool#second":{"answer":2}}"#
		);
		drop(session);
		let replayed = Session::open(&path, omp_session::ComponentRegistry::standard())
			.expect("replayed session");
		assert_eq!(assemble_workpool_batch(&replayed, &items).expect("replayed assembly"), live);
	}

	#[test]
	fn workpool_batch_rejects_unknown_duplicate_missing_and_error_outcomes() {
		let items = vec![WorkpoolItem { id: Str::new_static("pool#1"), index: 1 }, WorkpoolItem {
			id:    Str::new_static("pool#2"),
			index: 2,
		}];
		let make = |calls: &[(&str, Json)]| {
			let temp = tempfile::tempdir().expect("temporary directory");
			let mut session = Session::create(
				temp.path().join("worker.oms"),
				omp_session::ComponentRegistry::standard(),
			)
			.expect("worker session");
			session.begin_turn().expect("turn");
			session.user("batch", Vec::new()).expect("prompt");
			for (id, args) in calls {
				settle_workpool(&mut session, id, args.clone());
			}
			session
		};
		assert!(matches!(
			assemble_workpool_batch(&make(&[("unknown", json!({"key": 9, "data": "x"}))]), &items),
			Err(WorkpoolAssemblyError::UnknownItem { key: 9 })
		));
		assert!(matches!(
			assemble_workpool_batch(
				&make(&[
					("one", json!({"key": 1, "data": "x"})),
					("again", json!({"key": 1, "data": "y"}))
				]),
				&items
			),
			Err(WorkpoolAssemblyError::DuplicateItem { .. })
		));
		assert!(matches!(
			assemble_workpool_batch(&make(&[("one", json!({"key": 1, "data": "x"}))]), &items),
			Err(WorkpoolAssemblyError::MissingItems { .. })
		));
		assert!(matches!(
			assemble_workpool_batch(
				&make(&[("failed", json!({"key": 1, "error": "blocked"}))]),
				&items
			),
			Err(WorkpoolAssemblyError::ItemFailed { .. })
		));
	}

	#[test]
	fn incremental_sections_merge_into_a_data_less_terminal_yield() {
		let yields = [
			params(json!({"type": ["summary"], "result": {"data": "first pass"}})),
			params(json!({"type": ["findings"], "result": {"data": {"title": "a"}}})),
			params(json!({"type": ["findings"], "result": {"data": {"title": "b"}}})),
			params(json!({"type": "result", "result": {}})),
		];
		assert_eq!(
			assemble(&yields, "ignored last turn", &[]),
			Assembled::Data(json!({
				"summary": "first pass",
				"findings": [{"title": "a"}, {"title": "b"}],
			}))
		);
	}

	#[test]
	fn sections_alone_finalize_on_idle() {
		let yields = [params(json!({"type": ["notes"], "result": {"data": {"ok": true}}}))];
		assert_eq!(assemble(&yields, "", &[]), Assembled::Data(json!({"notes": {"ok": true}})));
	}

	#[test]
	fn array_valued_labels_accumulate_a_single_section_into_a_list() {
		let schema = json!({
			"type": "object",
			"properties": {
				"findings": {"$ref": "#/$defs/list"},
				"summary": {"type": "string"},
				"either": {"anyOf": [{"type": "null"}, {"type": ["array", "null"]}]},
			},
			"$defs": {"list": {"type": "array", "items": {"type": "object"}}},
		});
		let labels = array_valued_labels(&schema);
		assert_eq!(labels, ["findings", "either"]);
		let yields = [params(json!({"type": ["findings"], "result": {"data": {"title": "only"}}}))];
		assert_eq!(
			assemble(&yields, "", &labels),
			Assembled::Data(json!({"findings": [{"title": "only"}]}))
		);
	}

	#[test]
	fn explicit_terminal_data_wins_over_sections() {
		let yields = [
			params(json!({"type": ["findings"], "result": {"data": [1]}})),
			params(json!({"result": {"data": {"complete": true}}})),
		];
		assert_eq!(assemble(&yields, "", &[]), Assembled::Data(json!({"complete": true})));
	}

	#[test]
	fn last_turn_terminal_uses_assistant_text_only_without_sections() {
		let only_last_turn = [params(json!({"type": "result", "result": {}}))];
		assert_eq!(
			assemble(&only_last_turn, "final words", &[]),
			Assembled::Data(json!("final words"))
		);
		assert_eq!(
			assemble(&only_last_turn, "", &[]),
			Assembled::Error(WARNING_NULL_YIELD.to_owned())
		);
	}

	#[test]
	fn a_failing_final_yield_ends_the_run_with_its_error() {
		let yields = [
			params(json!({"type": ["findings"], "result": {"data": [1]}})),
			params(json!({"result": {"error": "blocked"}})),
		];
		assert_eq!(assemble(&yields, "", &[]), Assembled::Error("blocked".to_owned()));
	}

	#[test]
	fn null_data_is_a_null_yield() {
		let yields = [params(json!({"result": {"data": null}}))];
		assert_eq!(assemble(&yields, "", &[]), Assembled::Error(WARNING_NULL_YIELD.to_owned()));
		assert_eq!(assemble(&[], "", &[]), Assembled::Missing);
	}
}
