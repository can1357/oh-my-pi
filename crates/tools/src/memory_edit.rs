//! Revisioned typed Mnemopi update, forget, and invalidate tool.

use std::sync::Arc;

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, StrMut, sf};
pub use omp_memory::runtime::EditOutcome;
use omp_memory::{
	MemoryRuntime,
	runtime::{EditOperation, EditStatus, MAX_MEMORY_CONTENT_BYTES},
};
use omp_tool::{
	ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Effects, Ev, IncomingParams,
	LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Arguments accepted by `memory_edit@2`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Edit operation.
	pub op:             Operation,
	/// Memory id returned by recall or a full `memory://` read.
	#[schemars(length(min = 1, max = 128))]
	pub id:             Str,
	/// Whole replacement content for update.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(min = 1, max = 262144))]
	pub content:        Option<Str>,
	/// Replacement importance, clamped to `[0, 1]`.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub importance:     Option<f64>,
	/// Optional superseding memory id for invalidate.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(min = 1, max = 128))]
	pub replacement_id: Option<Str>,
}

/// Model-facing edit operation.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	JsonSchema,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Operation {
	/// Replace working-memory content and/or importance.
	Update,
	/// Permanently delete one working-memory row.
	Forget,
	/// Softly supersede working or episodic memory.
	Invalidate,
}

impl From<Operation> for EditOperation {
	fn from(operation: Operation) -> Self {
		match operation {
			Operation::Update => Self::Update,
			Operation::Forget => Self::Forget,
			Operation::Invalidate => Self::Invalidate,
		}
	}
}

/// Memory edit does not stream progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Typed memory-edit failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Mnemopi is not live for this session.
	#[error("Mnemopi memory is unavailable")]
	Unavailable,
	/// Operation-specific arguments were missing or invalid.
	#[error("memory edit arguments are invalid")]
	InvalidInput,
	/// The durable edit operation failed.
	#[error("memory edit failed")]
	Operation,
}

/// Revisioned typed memory-edit executor.
pub struct MemoryEditTool {
	runtime: Arc<MemoryRuntime>,
	spec:    ToolSpec,
}

/// Builds the host-free `memory_edit@2` declaration.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("memory_edit"),
		rev:             Rev { family: Str::default(), n: 2 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("memory_edit.rs"),
		)
		.into(),
	}
}

/// Creates `memory_edit@2` over one active runtime.
pub fn tool(runtime: Arc<MemoryRuntime>) -> MemoryEditTool {
	MemoryEditTool { runtime, spec: spec() }
}

impl Tool for MemoryEditTool {
	type Fault = Fault;
	type Params = Params;
	type Payload = EditOutcome;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, EditOutcome, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			if params.id.trim().is_empty()
				|| params.id.len() > 128
				|| params.importance.is_some_and(|value| !value.is_finite())
				|| (params.op == Operation::Update
					&& params.content.is_none()
					&& params.importance.is_none())
				|| params.content.as_ref().is_some_and(|value| {
					value.trim().is_empty() || value.len() > MAX_MEMORY_CONTENT_BYTES
				})
				|| params.replacement_id.as_ref().is_some_and(|value| {
					value.trim().is_empty() || value.len() > 128
				})
			{
				yield done(Err(Fault::InvalidInput), true);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			match self.runtime.edit(
				params.op.into(),
				params.id.as_str(),
				params.content.as_deref(),
				params.importance.map(|value| value.clamp(0.0, 1.0)),
				params.replacement_id.as_deref(),
			) {
				Ok(outcome) => {
					let useless = outcome.status == EditStatus::NotFound;
					yield done(Ok(outcome), useless);
				},
				Err(omp_memory::Error::Inactive) => yield done(Err(Fault::Unavailable), false),
				Err(omp_memory::Error::InvalidIdentifier | omp_memory::Error::InputTooLarge) => {
					yield done(Err(Fault::InvalidInput), true);
				},
				Err(_) => yield done(Err(Fault::Operation), false),
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		if !from.family.is_empty() || from.n != 1 {
			return None;
		}
		let mut raw_args = serde_json::from_slice::<serde_json::Value>(call.raw_args).ok()?;
		let object = raw_args.as_object_mut()?;
		object.remove("i");
		object.remove("notrunc");
		serde_json::from_value::<Params>(raw_args).ok()?;
		let mut verdict = serde_json::from_slice::<serde_json::Value>(call.verdict).ok()?;
		if verdict.get("kind").and_then(serde_json::Value::as_str) == Some("ok") {
			let value = verdict.get_mut("value")?.as_object_mut()?;
			let tier = match value.get("status").and_then(serde_json::Value::as_str) {
				Some("updated" | "forgotten") => serde_json::Value::String("working".to_owned()),
				Some("not_editable") => serde_json::Value::String("fact".to_owned()),
				_ => serde_json::Value::Null,
			};
			value.insert("tier".to_owned(), tier);
		}
		serde_json::from_value::<CallOutcome<EditOutcome, Fault>>(verdict.clone()).ok()?;
		Some(LiftedCall {
			raw_args: Bytes::copy_from_slice(call.raw_args),
			verdict:  Bytes::from(serde_json::to_vec(&verdict).ok()?),
		})
	}

	fn prompt(&self, view: Result<&EditOutcome, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(outcome) => render_outcome(outcome),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

fn render_outcome(outcome: &EditOutcome) -> Str {
	let mut text = StrMut::new("");
	text.push_str("Memory ");
	text.push_str(&outcome.id);
	match outcome.status {
		EditStatus::Updated => text.push_str(" updated"),
		EditStatus::Forgotten => text.push_str(" forgotten"),
		EditStatus::Invalidated => text.push_str(" invalidated"),
		EditStatus::NotFound => text.push_str(" was not found"),
		EditStatus::NotEditable => {
			text.push_str(" is a read-only extracted fact and cannot be edited; inspect memory://");
			text.push_str(&outcome.id);
		},
	}
	if let Some(bank) = outcome.bank.as_ref() {
		text.push_str(" in bank ");
		text.push_str(bank.as_str());
	}
	if let Some(tier) = outcome.tier {
		text.push_str(" (");
		text.push_str(<&'static str>::from(tier));
		text.push(')');
	}
	text.push('.');
	text.freeze()
}

const fn done(result: Result<EditOutcome, Fault>, useless: bool) -> Ev<Update, EditOutcome, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless })
}

fn param_event(error: ParamError) -> Ev<Update, EditOutcome, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, EditOutcome, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(omp_tool::Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  None,
		found:    Some(message),
	}
}

const DESCRIPTION: &str = "Edit Mnemopi memories by id. update replaces working-memory content \
                           and/or importance; forget permanently deletes working memory; \
                           invalidate softly supersedes working or episodic memory. Extracted \
                           facts are immutable. Read a full memory:// id before update because \
                           recall previews may be truncated.";
