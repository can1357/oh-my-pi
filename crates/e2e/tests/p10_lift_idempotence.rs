//! Executable P10 proof that replaying the production `edit@rep.1 -> hl.1`
//! lift is byte-stable and does not compound projection output.

#![cfg(unix)]

use std::sync::Arc;

use bytes::Bytes;
use omp_agent::{Journal, project_journal};
use omp_core::sf;
use omp_e2e::{
	Context as _, Result,
	support::{DocServerTask, Scratch, tool_call_item, tool_result_item},
};
use omp_proto::thread::v1::{self as thread, item};
use omp_storage::transcript::{Header, SessionId};
use omp_tool::{
	CallOutcome, CapsBase, Claims, ModelClass, Precedence, Presentation, Registry, Rev, ToolIdentity,
};
use omp_tools::edit::{self, Fault, FormatPolicy, Payload, RejectionReason, ReplaceParams};
use serde_json::to_value;

const CAPS: CapsBase = CapsBase {
	maximum_parts:      8,
	maximum_text_bytes: 65_536,
	media:              false,
	model_class:        ModelClass::Standard,
};

fn claims() -> Claims {
	Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
}

fn projected_pair(projected: &thread::Thread) -> (&thread::ToolCall, &thread::ToolResult) {
	let [call_item, result_item] = projected.items.as_slice() else {
		panic!("projection must retain exactly one call and its result")
	};
	let Some(item::Kind::ToolCall(call)) = call_item.kind.as_ref() else {
		panic!("first projected item was not a tool call")
	};
	let Some(item::Kind::ToolResult(result)) = result_item.kind.as_ref() else {
		panic!("second projected item was not a tool result")
	};
	(call, result)
}

#[tokio::test]
async fn p10_edit_lift_is_idempotent_across_journal_projections() -> Result<()> {
	let scratch = Scratch::new().context("create P10 project")?;
	let docserver =
		DocServerTask::spawn(scratch.project(), scratch.socket("p10-docserver.sock"), Vec::new())
			.await?;
	let documents = docserver.connect().await?;

	let mut registry = Registry::new();
	registry.register(
		edit::replace_tool(documents.clone(), FormatPolicy::BestEffort),
		Presentation::Slot,
		claims(),
	)?;
	registry.register(
		edit::tool(documents, FormatPolicy::BestEffort),
		Presentation::Slot,
		claims(),
	)?;
	let registry = Arc::new(registry);

	let historical = ToolIdentity { name: sf!("edit"), rev: Rev { family: sf!("rep"), n: 1 } };
	let source_args = serde_json::to_vec(&ReplaceParams { edits: Vec::new() })?;
	let source_verdict = CallOutcome::<Payload, Fault>::Faulted(Fault {
		reason:    RejectionReason::InvalidPatch { message: sf!("no match") },
		conflicts: Vec::new(),
	});
	let source_verdict_json = to_value(&source_verdict)?;
	let call = tool_call_item(2, "p10-edit", &historical, Bytes::from(source_args));
	let result =
		tool_result_item(3, "p10-edit", &historical, &source_verdict_json, true, false, vec![
			thread::Part {
				kind: Some(thread::part::Kind::Text("recorded rep.1 rendering".to_owned())),
			},
		])?;

	let transcript = scratch.state().join("p10-lift.jsonl");
	let header = Header {
		v:       4,
		id:      SessionId(sf!("p10-lift-idempotence")),
		created: 1,
		cwd:     scratch.project().to_path_buf(),
	};
	let mut journal = Journal::create(&transcript, &header)?;
	journal.append_optimistic(2, call, None)?;
	journal.append_optimistic(3, result, None)?;
	drop(journal);
	let journal = Journal::open(&transcript)?;
	let log = journal.load()?;

	let first = project_journal(&log, registry.as_ref(), &CAPS)?;
	let second = project_journal(&log, registry.as_ref(), &CAPS)?;
	let (first_call, first_result) = projected_pair(&first);
	let (second_call, second_result) = projected_pair(&second);

	assert_eq!(
		first_call.args_json, second_call.args_json,
		"a second projection changed already-lifted argument bytes",
	);
	assert_eq!(
		first_result.details, second_result.details,
		"a second projection changed lifted verdict bytes",
	);
	assert_eq!(
		first_result.parts, second_result.parts,
		"a second projection changed the rendered Vec<Part>",
	);
	assert_eq!(first_result.is_error, second_result.is_error);
	assert_eq!(first_result.useless, second_result.useless);
	assert_eq!(
		serde_json::from_slice::<edit::Params>(&first_call.args_json)?.input,
		"",
		"production rep.1 history did not lift into hl.1 arguments",
	);
	assert_ne!(
		first_result.parts,
		vec![thread::Part {
			kind: Some(thread::part::Kind::Text("recorded rep.1 rendering".to_owned())),
		}],
		"projection retained the historical rendering instead of using live hl.1",
	);

	drop(log);
	docserver.shutdown().await?;
	Ok(())
}
