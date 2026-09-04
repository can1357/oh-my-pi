//! P4: live schemas are isolated from history and calls journal the selected
//! revision.

use std::sync::Arc;

use async_stream::stream;
use bytes::Bytes;
use omp_agent::{DispatchPolicy, Kernel, RunControl, StaticPrompt, TurnInput};
use omp_ai::{
	BlockKind, ChatEvent, Completion, ExecutionReceipt, FinishReason, ToolCall, Usage,
	call::OpaqueJson,
};
use omp_core::Str;
use omp_e2e::support::{ScriptedInference, create_session};
use omp_journal::blob::BlobStore;
use omp_tool::{
	Claims, Constraint, Effects, Ev, IncomingParams, Part, Precedence, Presentation, PromptCaps,
	Registry, Rev, Tool, ToolSpec, ToolTerminal,
};
use serde_json::Value;

struct RevisionedTool(ToolSpec);

impl RevisionedTool {
	fn new(revision: u16, field: &'static str) -> Self {
		let schema = serde_json::to_vec(&serde_json::json!({
			"type": "object",
			"properties": { field: { "type": "boolean" } },
			"required": [field],
			"additionalProperties": false,
		}))
		.expect("schema");
		Self(ToolSpec {
			name:            Str::new_static("versioned"),
			rev:             Rev { family: Str::new_static("e2e"), n: revision },
			description:     Str::new_static("versioned schema proof"),
			schema:          Bytes::from(schema),
			constraint:      Constraint::None,
			effects:         Effects::empty(),
			projection_code: [revision as u8; 32],
		})
	}
}

impl Tool for RevisionedTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.0
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			let _ = params.committed().await;
			yield Ev::Done(ToolTerminal::Done { result: Ok(serde_json::json!({"revision": self.0.rev.n})), useless: false });
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

fn complete(reason: FinishReason, blocks: u32) -> ChatEvent {
	ChatEvent::Completed(Completion {
		reason,
		blocks,
		usage: Usage::default(),
		receipt: ExecutionReceipt::default().into(),
	})
}

#[tokio::test]
async fn p4_live_schema_isolated_and_tool_call_journals_revision() {
	let mut registry = Registry::new();
	for tool in [RevisionedTool::new(1, "old"), RevisionedTool::new(2, "new")] {
		registry
			.register(tool, Presentation::Slot, Claims {
				precedence: Precedence::CORE,
				claimant:   Str::new_static("omp-e2e"),
				replaces:   None,
			})
			.expect("revision registers");
	}
	let registry = Arc::new(registry);
	let call = ToolCall {
		id:        "versioned-1".into(),
		name:      Str::new_static("versioned"),
		arguments: OpaqueJson::new(serde_json::json!({"new": true})),
	};
	let script = vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::ToolCall },
		ChatEvent::ToolCallStarted { index: 0, id: call.id.clone(), name: call.name.clone() },
		ChatEvent::ToolCallReady { index: 0, call },
		complete(FinishReason::ToolCalls, 1),
	];
	let (inference, requests) = ScriptedInference::new([script, vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
		ChatEvent::TextDelta { index: 0, text: Str::new_static("done") },
		complete(FinishReason::Stop, 1),
	]]);
	let temp = tempfile::tempdir().expect("P4 scratch");
	let path = temp.path().join("schema.oms");
	let mut kernel = Kernel::new(
		inference,
		Arc::clone(&registry),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blob store")),
		StaticPrompt(Str::new_static("P4")),
	);
	let mut session = create_session(&path).expect("session");
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: Str::new_static("call versioned"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	let requests = requests.lock();
	let advertised = &requests[0].tools;
	assert_eq!(advertised.len(), 1);
	let (schema, _) = advertised[0]
		.input
		.json_schema()
		.expect("structured live schema");
	assert!(
		schema
			.as_value()
			.get("properties")
			.is_some_and(|value| value.get("new").is_some())
	);
	assert!(
		!schema
			.as_value()
			.get("properties")
			.is_some_and(|value| value.get("old").is_some())
	);
	drop(requests);
	let journal = std::fs::read_to_string(path).expect("journal");
	assert!(journal.contains("event: tool.call@1"));
	assert!(journal.contains("\"rev\":2"));
	assert!(!journal.contains("\"rev\":1"));
}
