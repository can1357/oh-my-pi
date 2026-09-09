//! Subagent terminal and incremental structured-output submission.

use async_stream::stream;
use futures::Stream;
use omp_core::{FastHashSet, Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Effects, Ev, IncomingParams, ParamError,
	Part, PromptCaps, ProtocolSchemaError, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::output_schema::{self, OutputStatus, SchemaError, SchemaMode, SchemaViolation};

/// Arguments accepted by ordinary `yield@2`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Terminal label or non-empty incremental section path.
	#[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
	pub kind:   Option<YieldType>,
	/// Success/failure envelope.
	pub result: ResultEnvelope,
}

/// One item in a workpool batch's dynamic yield contract.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
pub struct WorkpoolItem {
	/// Stable pool item identity.
	pub id:    Str,
	/// One-based position advertised to the child.
	pub index: u32,
}

/// Arguments accepted by a workpool child's batch-local `yield@2`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkpoolParams {
	/// One-based item position from the active batch contract.
	pub key:   u32,
	/// Self-contained successful item result.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub data:  Option<Value>,
	/// Item failure, which fails the active batch.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub error: Option<Str>,
}

/// Terminal label or incremental section path.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum YieldType {
	/// Named terminal result.
	Terminal(Str),
	/// Non-empty incremental section path.
	Sections(Vec<Str>),
}

/// Structured success or failure.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum ResultEnvelope {
	/// Successful structured output.
	Data {
		/// Caller-schema-bound structured value.
		data: Value,
	},
	/// Terminal failure description.
	Error {
		/// Human-readable failure.
		error: Str,
	},
	/// Typed terminal success which uses the child's last assistant turn.
	LastTurn {},
}

/// Durable yield acknowledgement. The caller consumes the original argument
/// bytes for schema validation; this payload never substitutes for them.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Whether this is an incremental section.
	pub incremental:   bool,
	/// Whether finalization must consume the child's last assistant turn.
	pub use_last_turn: bool,
	/// Immediate terminal validation verdict when a caller schema is installed.
	pub validation:    Option<OutputStatus>,
	/// Correlated workpool item id for a batch-local yield.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub item_id:       Option<Str>,
	/// Correlated one-based workpool position.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub item_index:    Option<u32>,
	/// Whether this yield completed the active workpool batch.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub complete:      bool,
	/// Whether this workpool item explicitly failed the active batch.
	#[serde(default, skip_serializing_if = "std::ops::Not::not")]
	pub failed:        bool,
}

/// Yield does not stream updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Invalid yield envelope or caller-schema result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum Fault {
	/// Incremental section labels were empty.
	#[error("type sections must be non-empty strings")]
	EmptySections,
	/// Last-turn extraction was requested without a terminal type.
	#[error("an empty result requires a terminal string type")]
	LastTurnWithoutTerminalType,
	/// Terminal data violated the installed caller schema.
	#[error(transparent)]
	SchemaViolation(#[from] SchemaViolation),
	/// The submitted workpool position is not in the active batch.
	#[error("workpool item {key} is not in the active batch")]
	UnknownWorkpoolItem {
		/// Rejected one-based position.
		key: u32,
	},
	/// The active batch already accepted this item.
	#[error("workpool item {key} was already submitted")]
	DuplicateWorkpoolItem {
		/// Repeated one-based position.
		key: u32,
	},
	/// A workpool submission must choose success or failure exactly once.
	#[error("workpool yield requires exactly one of `data` or `error`")]
	WorkpoolEnvelope,
	/// Arguments used the wrong yield contract for this child.
	#[error("yield arguments do not match the active child contract")]
	ContractMismatch,
}

/// Failure to construct a caller-specific yield contract.
#[derive(Debug, thiserror::Error)]
pub enum SchemaContractError {
	/// The caller's output schema is malformed.
	#[error(transparent)]
	Schema(#[from] SchemaError),
	/// The generated parameter schema could not receive protocol fields.
	#[error(transparent)]
	Protocol(#[from] ProtocolSchemaError),
	/// The generated schema could not be encoded.
	#[error("generated yield schema could not be encoded")]
	Json(#[from] serde_json::Error),
	/// A dynamic workpool contract has no items.
	#[error("workpool yield contracts require at least one item")]
	EmptyWorkpoolBatch,
	/// A workpool item id is empty.
	#[error("workpool item ids must not be empty")]
	EmptyWorkpoolItem,
	/// A workpool item has no valid one-based position.
	#[error("workpool item index must be greater than zero")]
	InvalidWorkpoolIndex,
	/// A workpool item id or index occurs more than once.
	#[error("workpool item ids and indices must be unique")]
	DuplicateWorkpoolItem,
}

/// Yield executor. A child-specific instance validates terminal data before
/// the call settles, allowing strict mode to reprompt inside the child rather
/// than reporting a late parent-side failure.
pub struct Yield {
	spec:     ToolSpec,
	schema:   Option<Value>,
	mode:     SchemaMode,
	workpool: Option<WorkpoolContract>,
}

struct WorkpoolContract {
	items:     Vec<WorkpoolItem>,
	submitted: Mutex<FastHashSet<Str>>,
}

/// Creates unconstrained `yield@2`.
pub fn tool() -> Yield {
	Yield {
		spec:     yield_spec(loose_record_schema_value(), SchemaMode::Permissive)
			.expect("the built-in loose yield schema is valid"),
		schema:   None,
		mode:     SchemaMode::Permissive,
		workpool: None,
	}
}

/// Creates `yield@2` with one child's effective output contract.
///
/// `null` selects the unconstrained contract. String schemas are parsed using
/// the same normalization as task settlement.
pub fn tool_for_schema(raw_schema: &Value, mode: SchemaMode) -> Result<Yield, SchemaContractError> {
	let schema = output_schema::normalize(raw_schema)?;
	let data_schema = schema.clone().unwrap_or_else(loose_record_schema_value);
	Ok(Yield { spec: yield_spec(data_schema, mode)?, schema, mode, workpool: None })
}

/// Builds the closed assembled-output schema for one workpool batch.
///
/// Each item id is required exactly once, values remain intentionally open so
/// workers can submit task-specific partial structured fields, and no unknown
/// id can enter the aggregate.
#[must_use]
pub fn workpool_output_schema(items: &[WorkpoolItem]) -> Value {
	let mut properties = serde_json::Map::with_capacity(items.len());
	for item in items {
		properties.insert(item.id.to_string(), serde_json::json!({}));
	}
	serde_json::json!({
		"type": "object",
		"properties": properties,
		"required": items.iter().map(|item| item.id.clone()).collect::<Vec<_>>(),
		"additionalProperties": false
	})
}

/// Creates the strict, batch-local `yield@2` contract for one workpool child.
///
/// The model sees only one-based keys from `items`; each accepted call maps
/// back to the stable item id and a repeated item is rejected in-band.
pub fn tool_for_workpool(items: Vec<WorkpoolItem>) -> Result<Yield, SchemaContractError> {
	if items.is_empty() {
		return Err(SchemaContractError::EmptyWorkpoolBatch);
	}
	let mut ids = FastHashSet::default();
	let mut indices = FastHashSet::default();
	for item in &items {
		if item.id.trim().is_empty() {
			return Err(SchemaContractError::EmptyWorkpoolItem);
		}
		if item.index == 0 {
			return Err(SchemaContractError::InvalidWorkpoolIndex);
		}
		if !ids.insert(item.id.clone()) || !indices.insert(item.index) {
			return Err(SchemaContractError::DuplicateWorkpoolItem);
		}
	}
	let spec = workpool_yield_spec(&items)?;
	Ok(Yield {
		spec,
		schema: None,
		mode: SchemaMode::Permissive,
		workpool: Some(WorkpoolContract { items, submitted: Mutex::default() }),
	})
}

fn yield_spec(data_schema: Value, mode: SchemaMode) -> Result<ToolSpec, SchemaContractError> {
	let schema = yield_parameter_schema(data_schema);
	let encoded = serde_json::to_vec(&schema)?;
	let schema = omp_tool::inject_protocol_schema(&encoded)?;
	Ok(ToolSpec {
		name: sf!("yield"),
		rev: Rev { family: Default::default(), n: 2 },
		description: sf!(
			"Submits terminal or incremental subagent output. Structured success uses `result.data`; \
			 failure uses `result.error`. A terminal typed yield may pass an empty `result` object \
			 to use the last assistant turn.",
		),
		schema,
		constraint: if mode == SchemaMode::Strict {
			Constraint::Schema { priority: 100, on_unsupported: omp_tool::Fallback::Unspecified }
		} else {
			Constraint::None
		},
		effects: Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("yield_tool.rs"),
		)
		.into(),
	})
}

fn workpool_yield_spec(items: &[WorkpoolItem]) -> Result<ToolSpec, SchemaContractError> {
	let keys = items.iter().map(|item| item.index).collect::<Vec<_>>();
	let schema = serde_json::json!({
		"type": "object",
		"description": "Submit exactly one active workpool item outcome.",
		"properties": {
			"key": {
				"type": "integer",
				"enum": keys,
				"description": "One-based workpool item number."
			},
			"data": {
				"description": "Self-contained outcome and evidence for this item."
			},
			"error": {
				"type": "string",
				"minLength": 1,
				"description": "Failure reason for this item."
			}
		},
		"required": ["key"],
		"additionalProperties": false
	});
	let encoded = serde_json::to_vec(&schema)?;
	let schema = omp_tool::inject_protocol_schema(&encoded)?;
	Ok(ToolSpec {
		name: sf!("yield"),
		rev: Rev { family: Default::default(), n: 2 },
		description: sf!(
			"Submit ONE workpool item at a time. Use the numbered key from the active batch and \
			 provide exactly one of `data` or `error`. Successful items may contain partial \
			 structured fields; submit every item before ending the turn.",
		),
		schema,
		// Per-item `data` is deliberately unconstrained. Keep native strict
		// sampling off while runtime validation strictly closes
		// keys, envelopes, duplicates, and final assembled ids.
		constraint: Constraint::None,
		effects: Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("yield_tool.rs"),
		)
		.into(),
	})
}

fn loose_record_schema_value() -> Value {
	serde_json::json!({
		"type": "object",
		"additionalProperties": true
	})
}

fn yield_parameter_schema(mut data_schema: Value) -> Value {
	let mut root_defs = serde_json::Map::new();
	if let Some(object) = data_schema.as_object_mut() {
		for key in ["$defs", "definitions"] {
			if let Some(value) = object.remove(key) {
				root_defs.insert(key.to_owned(), value);
			}
		}
	}
	let data_schema = with_section_variants(data_schema);
	let mut root = serde_json::json!({
		"type": "object",
		"description": "Submit terminal or incremental child output.",
		"properties": {
			"type": {
				"oneOf": [
					{"type": "string", "minLength": 1},
					{
						"type": "array",
						"minItems": 1,
						"items": {"type": "string", "minLength": 1}
					}
				]
			},
			"result": {
				"oneOf": [
					{
						"type": "object",
						"properties": {"data": data_schema},
						"required": ["data"],
						"additionalProperties": false
					},
					{
						"type": "object",
						"properties": {"error": {"type": "string"}},
						"required": ["error"],
						"additionalProperties": false
					},
					{
						"type": "object",
						"properties": {},
						"additionalProperties": false
					}
				]
			}
		},
		"required": ["result"],
		"additionalProperties": false
	});
	if let Some(object) = root.as_object_mut() {
		object.extend(root_defs);
	}
	root
}

fn with_section_variants(schema: Value) -> Value {
	let Some(object) = schema.as_object() else {
		return schema;
	};
	if object.get("type").and_then(Value::as_str) != Some("object") {
		return schema;
	}
	let Some(properties) = object.get("properties").and_then(Value::as_object) else {
		return schema;
	};
	let mut branches = vec![schema.clone()];
	for property in properties.values() {
		if !branches.contains(property) {
			branches.push(property.clone());
		}
		if let Some(items) = property
			.as_object()
			.filter(|property| property.get("type").and_then(Value::as_str) == Some("array"))
			.and_then(|property| property.get("items"))
			&& !branches.contains(items)
		{
			branches.push(items.clone());
		}
	}
	if branches.len() == 1 {
		schema
	} else {
		serde_json::json!({"anyOf": branches})
	}
}

impl Tool for Yield {
	type Fault = Fault;
	type Params = Value;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let raw = match incoming.whole::<Value>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; }
			};
			if let Some(contract) = &self.workpool {
				let Ok(params) = serde_json::from_value::<WorkpoolParams>(raw) else {
					yield done(Err(Fault::ContractMismatch));
					return;
				};
				let Some(item) = contract.items.iter().find(|item| item.index == params.key) else {
					yield done(Err(Fault::UnknownWorkpoolItem { key: params.key }));
					return;
				};
				if params.data.is_some() == params.error.is_some() {
					yield done(Err(Fault::WorkpoolEnvelope));
					return;
				}
				if let Some(error) = &params.error
					&& error.trim().is_empty()
				{
					yield done(Err(Fault::WorkpoolEnvelope));
					return;
				}
				if contract.submitted.lock().contains(&item.id) {
					yield done(Err(Fault::DuplicateWorkpoolItem { key: params.key }));
					return;
				}
				if let Err(error) = incoming.interruptable().committed().await {
					yield commit_event(error);
					return;
				}
				let (inserted, complete) = {
					let mut submitted = contract.submitted.lock();
					let inserted = submitted.insert(item.id.clone());
					(inserted, params.error.is_none() && submitted.len() == contract.items.len())
				};
				if !inserted {
					yield done(Err(Fault::DuplicateWorkpoolItem { key: params.key }));
					return;
				}
				yield done(Ok(Payload {
					incremental: true,
					use_last_turn: false,
					validation: None,
					item_id: Some(item.id.clone()),
					item_index: Some(item.index),
					complete,
					failed: params.error.is_some(),
				}));
				return;
			}
			let Ok(params) = serde_json::from_value::<Params>(raw) else {
				yield done(Err(Fault::ContractMismatch));
				return;
			};
			let incremental = matches!(&params.kind, Some(YieldType::Sections(_)));
			if let Some(YieldType::Sections(parts)) = &params.kind
				&& (parts.is_empty() || parts.iter().any(|part| part.trim().is_empty()))
			{
				yield done(Err(Fault::EmptySections));
				return;
			}
			let use_last_turn = matches!(&params.result, ResultEnvelope::LastTurn {});
			if use_last_turn
				&& (params.kind.is_none() || incremental)
			{
				yield done(Err(Fault::LastTurnWithoutTerminalType));
				return;
			}
			let validation = match validate_terminal(
				self.schema.as_ref(),
				self.mode,
				incremental,
				&params.result,
			) {
				Ok(validation) => validation,
				Err(fault) => {
					yield done(Err(fault));
					return;
				},
			};
			if let Err(error) = incoming.interruptable().committed().await { yield commit_event(error); return; }
			yield done(Ok(Payload {
				incremental,
				use_last_turn,
				validation,
				item_id: None,
				item_index: None,
				complete: false,
				failed: false,
			}));
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(Payload { item_index: Some(index), failed: true, .. }) => {
					sf!("Item {index} failed; the active workpool batch is ending.")
				},
				Ok(Payload { item_index: Some(index), complete: true, .. }) => {
					sf!("Item {index} submitted. All workpool items are complete.")
				},
				Ok(Payload { item_index: Some(index), .. }) => sf!("Item {index} submitted."),
				Ok(payload) if payload.incremental => sf!("Incremental section accepted."),
				Ok(Payload { validation: Some(OutputStatus::Invalid), .. }) => {
					sf!("Result accepted with a schema warning.")
				},
				Ok(_) => sf!("Result accepted."),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

fn validate_terminal(
	schema: Option<&Value>,
	mode: SchemaMode,
	incremental: bool,
	result: &ResultEnvelope,
) -> Result<Option<OutputStatus>, Fault> {
	let Some(schema) = schema else {
		return Ok(None);
	};
	let ResultEnvelope::Data { data } = result else {
		return Ok(None);
	};
	if incremental {
		return Ok(None);
	}
	match output_schema::validate(schema, data) {
		Ok(Ok(())) => Ok(Some(OutputStatus::Valid)),
		Ok(Err(violation)) if mode == SchemaMode::Strict => Err(violation.into()),
		Ok(Err(_)) => Ok(Some(OutputStatus::Invalid)),
		// `tool_for_schema` normalized the schema, but defects such as broken
		// local references are discovered only when traversed. Treat those as
		// unavailable in permissive mode and as a violation in strict mode by
		// using one stable root diagnostic.
		Err(_) if mode == SchemaMode::Permissive => Ok(Some(OutputStatus::Unavailable)),
		Err(_) => Err(
			SchemaViolation {
				pointer: Str::new_static(""),
				reason:  Str::new_static("the installed output schema is not traversable"),
			}
			.into(),
		),
	}
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless: false })
}
fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}
fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"result":{{"data":{{}}}}}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use futures::StreamExt;

	use super::*;

	async fn invoke(tool: &Yield, raw: &'static str) -> Ev<Update, Payload, Fault> {
		let (feed, incoming) = IncomingParams::channel();
		feed.arg_text(raw.into()).expect("argument stream");
		feed.args_committed(raw.into()).expect("argument commit");
		tool
			.call(incoming)
			.collect::<Vec<_>>()
			.await
			.into_iter()
			.next()
			.expect("terminal event")
	}

	#[test]
	fn accepts_terminal_incremental_and_last_turn_envelopes() {
		let terminal: Params =
			serde_json::from_value(serde_json::json!({"result":{"data":{"ok":true}}})).unwrap();
		assert!(matches!(terminal.result, ResultEnvelope::Data { .. }));
		let incremental: Params =
			serde_json::from_value(serde_json::json!({"type":["findings"],"result":{"data":[1,2]}}))
				.unwrap();
		assert!(matches!(incremental.kind, Some(YieldType::Sections(_))));
		let fallback: Params =
			serde_json::from_value(serde_json::json!({"type":"result","result":{}})).unwrap();
		assert!(matches!(fallback.result, ResultEnvelope::LastTurn {}));
		assert!(serde_json::from_value::<Params>(serde_json::json!({"type":"result"})).is_err());
	}

	#[test]
	fn envelope_rejects_unknown_fields() {
		assert!(
			serde_json::from_value::<Params>(
				serde_json::json!({"result":{"data":1},"schemaOverridden":true})
			)
			.is_err()
		);
	}

	#[tokio::test]
	async fn workpool_contract_correlates_items_and_rejects_unknown_or_duplicate_keys() {
		let tool =
			tool_for_workpool(vec![WorkpoolItem { id: sf!("pool#alpha"), index: 1 }, WorkpoolItem {
				id:    sf!("pool#beta"),
				index: 2,
			}])
			.expect("workpool yield");
		assert!(matches!(tool.spec().constraint, Constraint::None));
		let schema: Value = serde_json::from_slice(&tool.spec().schema).expect("schema");
		assert_eq!(schema["properties"]["key"]["enum"], serde_json::json!([1, 2]));
		assert_eq!(schema["additionalProperties"], false);
		assert_eq!(
			workpool_output_schema(&[
				WorkpoolItem { id: sf!("pool#alpha"), index: 1 },
				WorkpoolItem { id: sf!("pool#beta"), index: 2 },
			]),
			serde_json::json!({
				"type": "object",
				"properties": {"pool#alpha": {}, "pool#beta": {}},
				"required": ["pool#alpha", "pool#beta"],
				"additionalProperties": false
			})
		);

		let first = invoke(&tool, r#"{"key":1,"data":{"summary":"partial","score":0.5}}"#).await;
		assert!(matches!(
			&first,
			Ev::Done(ToolTerminal::Done {
				result: Ok(Payload {
					item_id: Some(id),
					item_index: Some(1),
					complete: false,
					..
				}),
				..
			}) if id == "pool#alpha"
		));
		let duplicate = invoke(&tool, r#"{"key":1,"data":"again"}"#).await;
		assert!(matches!(
			duplicate,
			Ev::Done(ToolTerminal::Done { result: Err(Fault::DuplicateWorkpoolItem { key: 1 }), .. })
		));
		let unknown = invoke(&tool, r#"{"key":9,"data":"unknown"}"#).await;
		assert!(matches!(
			unknown,
			Ev::Done(ToolTerminal::Done { result: Err(Fault::UnknownWorkpoolItem { key: 9 }), .. })
		));
		let complete = invoke(&tool, r#"{"key":2,"data":{"answer":42}}"#).await;
		assert!(matches!(
			&complete,
			Ev::Done(ToolTerminal::Done {
				result: Ok(Payload {
					item_id: Some(id),
					item_index: Some(2),
					complete: true,
					..
				}),
				..
			}) if id == "pool#beta"
		));
	}

	#[tokio::test]
	async fn workpool_contract_requires_exactly_one_outcome_and_error_fails_batch() {
		let tool = tool_for_workpool(vec![WorkpoolItem { id: sf!("pool#1"), index: 1 }])
			.expect("workpool yield");
		for raw in
			[r#"{"key":1}"#, r#"{"key":1,"data":{},"error":"both"}"#, r#"{"key":1,"error":""}"#]
		{
			assert!(matches!(
				invoke(&tool, raw).await,
				Ev::Done(ToolTerminal::Done {
					result: Err(Fault::WorkpoolEnvelope | Fault::ContractMismatch),
					..
				})
			));
		}
		let failed = invoke(&tool, r#"{"key":1,"error":"blocked"}"#).await;
		assert!(matches!(
			&failed,
			Ev::Done(ToolTerminal::Done {
				result: Ok(Payload { item_id: Some(id), complete: false, failed: true, .. }),
				..
			}) if id == "pool#1"
		));
		assert!(matches!(
			invoke(&tool, r#"{"key":1,"error":"again"}"#).await,
			Ev::Done(ToolTerminal::Done { result: Err(Fault::DuplicateWorkpoolItem { key: 1 }), .. })
		));
	}

	#[test]
	fn caller_schema_is_installed_in_the_wire_contract() {
		let yield_tool = tool_for_schema(
			&serde_json::json!({
				"type": "object",
				"properties": {"answer": {"type": "integer"}},
				"required": ["answer"],
				"additionalProperties": false
			}),
			SchemaMode::Strict,
		)
		.unwrap();
		assert!(matches!(yield_tool.spec().constraint, Constraint::Schema { .. }));
		assert_eq!(yield_tool.spec().rev.n, 2);
		let schema: Value = serde_json::from_slice(&yield_tool.spec().schema).unwrap();
		let data = &schema["properties"]["result"]["oneOf"][0]["properties"]["data"];
		assert_eq!(data["anyOf"][0]["properties"]["answer"]["type"], "integer");
		assert_eq!(data["anyOf"][1]["type"], "integer");
		assert_eq!(schema["required"][0], "i");
	}

	#[test]
	fn strict_rejects_and_permissive_reports_invalid_terminal_data() {
		let schema = serde_json::json!({
			"type": "object",
			"properties": {"answer": {"type": "integer"}},
			"required": ["answer"],
			"additionalProperties": false
		});
		let invalid = ResultEnvelope::Data { data: serde_json::json!({"answer": "not-an-integer"}) };
		let strict = validate_terminal(Some(&schema), SchemaMode::Strict, false, &invalid)
			.expect_err("strict validation rejects");
		assert!(matches!(strict, Fault::SchemaViolation(_)));
		let encoded = serde_json::to_string(&strict).unwrap();
		let decoded: Fault = serde_json::from_str(&encoded).unwrap();
		assert_eq!(decoded, strict);
		assert_eq!(
			validate_terminal(Some(&schema), SchemaMode::Permissive, false, &invalid).unwrap(),
			Some(OutputStatus::Invalid)
		);
		let valid = ResultEnvelope::Data { data: serde_json::json!({"answer": 7}) };
		assert_eq!(
			validate_terminal(Some(&schema), SchemaMode::Strict, false, &valid).unwrap(),
			Some(OutputStatus::Valid)
		);
	}

	#[test]
	fn local_refs_remain_valid_after_wrapping() {
		let yield_tool = tool_for_schema(
			&serde_json::json!({
				"$defs": {"answer": {"type": "integer"}},
				"$ref": "#/$defs/answer"
			}),
			SchemaMode::Strict,
		)
		.unwrap();
		let schema: Value = serde_json::from_slice(&yield_tool.spec().schema).unwrap();
		assert_eq!(schema["$defs"]["answer"]["type"], "integer");
		assert_eq!(
			schema["properties"]["result"]["oneOf"][0]["properties"]["data"]["$ref"],
			"#/$defs/answer"
		);
	}
}
