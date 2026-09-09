//! P10: historical tool lifts are byte-stable and their live revision
//! dispatches normally.

#![cfg(unix)]

use std::sync::Arc;

use bytes::Bytes;
use omp_agent::{
	CancelTree, DispatchOptions, DispatchPolicy, DispatchRequest, Dispatcher, ToolCancellation,
};
use omp_core::Str;
use omp_e2e::{
	Context as _, Result,
	support::{DocServerTask, Scratch, create_session},
};
use omp_journal::blob::BlobStore;
use omp_proto::{
	inference::v1 as inference,
	thread::v1::{self as thread, item},
};
use omp_session::project_thread_history;
use omp_tool::{
	CallOutcome, CapsBase, Claims, ModelClass, Precedence, Presentation, Registry, Rev, ToolIdentity,
};
use omp_tools::edit::{
	self, Fault, FormatPolicy, LegacyReplaceParams, Payload, RejectionReason, observer::EditObserver,
};

const CAPS: CapsBase = CapsBase {
	maximum_parts:      8,
	maximum_text_bytes: 65_536,
	media:              false,
	model_class:        ModelClass::Standard,
};

fn pair(projected: &thread::Thread) -> (&thread::Item, &thread::ToolCall, &thread::ToolResult) {
	let call_index = projected
		.items
		.iter()
		.position(|item| matches!(item.kind, Some(item::Kind::ToolCall(_))))
		.expect("tool call");
	let Some(item::Kind::ToolCall(call)) = projected.items[call_index].kind.as_ref() else {
		unreachable!()
	};
	let result = projected
		.items
		.iter()
		.skip(call_index + 1)
		.find_map(|item| match item.kind.as_ref() {
			Some(item::Kind::ToolResult(result)) if result.call_id == call.id => Some(result),
			_ => None,
		})
		.expect("tool result");
	(&projected.items[call_index], call, result)
}

fn proto_value(value: &serde_json::Value) -> inference::Value {
	use inference::value::Kind;
	let kind = match value {
		serde_json::Value::Null => Kind::Null(true),
		serde_json::Value::Bool(value) => Kind::Bool(*value),
		serde_json::Value::Number(value) if value.is_i64() => Kind::Int(value.as_i64().expect("i64")),
		serde_json::Value::Number(value) if value.is_u64() => {
			Kind::Uint(value.as_u64().expect("u64"))
		},
		serde_json::Value::Number(value) => Kind::Double(value.as_f64().expect("f64")),
		serde_json::Value::String(value) => Kind::String(value.clone()),
		serde_json::Value::Array(values) => {
			Kind::List(inference::ValueList { values: values.iter().map(proto_value).collect() })
		},
		serde_json::Value::Object(values) => {
			let mut map = inference::ValueMap::default();
			map.fields.extend(
				values
					.iter()
					.map(|(key, value)| (key.clone(), proto_value(value))),
			);
			Kind::Map(map)
		},
	};
	inference::Value { kind: Some(kind) }
}

fn historical_thread(
	identity: &ToolIdentity,
	args: Bytes,
	verdict: &serde_json::Value,
) -> thread::Thread {
	let mut call_props = inference::ValueMap::default();
	call_props
		.fields
		.insert(omp_tool::TOOL_REV_PROP.to_owned(), inference::Value {
			kind: Some(inference::value::Kind::String(identity.rev.to_string())),
		});
	let mut result_props = inference::ValueMap::default();
	result_props
		.fields
		.insert(omp_tool::TOOL_REV_PROP.to_owned(), inference::Value {
			kind: Some(inference::value::Kind::String(identity.rev.to_string())),
		});
	thread::Thread {
		items: vec![
			thread::Item {
				kind: Some(item::Kind::ToolCall(thread::ToolCall {
					id: "p10-edit".to_owned(),
					name: identity.name.to_string(),
					args_json: args,
					..Default::default()
				})),
				props: Some(call_props),
				..Default::default()
			},
			thread::Item {
				kind: Some(item::Kind::ToolResult(thread::ToolResult {
					call_id: "p10-edit".to_owned(),
					name: identity.name.to_string(),
					is_error: true,
					parts: vec![thread::Part {
						kind: Some(thread::part::Kind::Text("recorded rep.1 rendering".to_owned())),
					}],
					details: Some(proto_value(verdict)),
					useless: Some(false),
					attribution: thread::tool_result::Attribution::Agent as i32,
					..Default::default()
				})),
				props: Some(result_props),
				..Default::default()
			},
		],
	}
}

#[tokio::test]
async fn p10_edit_lift_is_idempotent_and_dispatches_at_the_live_revision() -> Result<()> {
	let scratch = Scratch::new().context("create P10 project")?;
	let docserver = DocServerTask::spawn(
		scratch.project().to_path_buf(),
		scratch.socket("p10-docserver.sock"),
		Vec::new(),
	)
	.await?;
	let documents = docserver.connect().await?;
	let claims = Claims {
		precedence: Precedence::CORE,
		claimant:   Str::new_static("omp/core"),
		replaces:   None,
	};
	let mut registry = Registry::new();
	registry.register(
		edit::legacy_replace_tool_with_observer(
			documents.clone(),
			FormatPolicy::BestEffort,
			EditObserver::default(),
			true,
			true,
			false,
		),
		Presentation::Slot,
		claims.clone(),
	)?;
	registry.register(
		edit::tool(documents, FormatPolicy::BestEffort),
		Presentation::Slot,
		claims,
	)?;
	let registry = Arc::new(registry);

	let historical = ToolIdentity {
		name: Str::new_static("edit"),
		rev:  Rev { family: Str::new_static("rep"), n: 1 },
	};
	let args = Bytes::from(serde_json::to_vec(&LegacyReplaceParams { edits: Vec::new() })?);
	let verdict = serde_json::to_value(CallOutcome::<Payload, Fault>::Faulted(Fault {
		reason:    RejectionReason::InvalidPatch { message: Str::new_static("no match") },
		conflicts: Vec::new(),
	}))?;
	let raw = historical_thread(&historical, args, &verdict);
	let first = project_thread_history(&raw, registry.as_ref(), &CAPS)?;
	let second = project_thread_history(&first, registry.as_ref(), &CAPS)?;
	let (first_item, first_call, first_result) = pair(&first);
	let (second_item, second_call, second_result) = pair(&second);
	assert_eq!(first_call.args_json, second_call.args_json);
	assert_eq!(first_result.details, second_result.details);
	assert_eq!(first_result.parts, second_result.parts);
	assert_eq!(first_item.props, second_item.props);
	assert_eq!(serde_json::from_slice::<edit::Params>(&first_call.args_json)?.input, "");
	let rev = first_item
		.props
		.as_ref()
		.and_then(|props| props.fields.get("omp/tool-rev"))
		.and_then(|value| value.kind.as_ref())
		.and_then(|kind| match kind {
			omp_proto::inference::v1::value::Kind::String(value) => Some(value.as_str()),
			_ => None,
		})
		.expect("lifted revision property");
	assert_eq!(
		rev,
		registry
			.resolved_identity("edit")
			.expect("live edit")
			.rev
			.to_string()
	);

	let live_identity = registry.resolved_identity("edit").expect("live identity");
	let live_args =
		serde_json::value::RawValue::from_string(String::from_utf8(first_call.args_json.to_vec())?)?;
	let dispatch_path = scratch.state().join("dispatch.oms");
	let mut dispatch_session = create_session(&dispatch_path)?;
	dispatch_session.begin_turn()?;
	dispatch_session.user("dispatch lifted edit", Vec::new())?;
	let dispatch_call = dispatch_session.call(
		"edit",
		u32::from(live_identity.rev.n),
		"p10-live",
		None,
		Some(live_args.clone()),
		None,
	)?;
	let dispatcher = Dispatcher::new(
		Arc::clone(&registry),
		DispatchPolicy::new(BlobStore::open(scratch.state().join("blobs"))?),
	);
	let report = dispatcher
		.dispatch(&mut dispatch_session, DispatchRequest {
			identity:     live_identity,
			call_id:      Str::new_static("p10-live"),
			call:         dispatch_call,
			args:         live_args,
			options:      DispatchOptions { notrunc: false },
			cancellation: ToolCancellation::Foreground(
				CancelTree::new().begin_turn().foreground_mutation(),
			),
		})
		.await?;
	assert!(report.is_error, "empty lifted edit is rejected by the real tool, not the dispatcher");
	let journal = std::fs::read_to_string(dispatch_path)?;
	assert!(journal.contains("event: tool.result@1"));
	assert!(journal.contains("by: "));
	docserver.shutdown().await?;
	Ok(())
}
