//! Private no-op reasoning scratch tool.

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Effects, Ev, IncomingParams, ParamError,
	Part, PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Arguments accepted by `think@1`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Private reasoning note retained in the durable tool-call journal.
	pub thoughts: Str,
}

/// Durable acknowledgement.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Confirms that the note was committed with the tool call.
	pub recorded: bool,
}

/// Think has no genuine output updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// A rejected scratch note.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	message: Str,
}
impl Fault {
	/// Stable scratch-note failure explanation.
	pub(crate) fn message(&self) -> &str {
		&self.message
	}
}

/// No-op scratch executor; normal tool journaling is the note's durable truth.
pub struct Think {
	spec: ToolSpec,
}

/// Creates `think@1`.
pub fn tool() -> Think {
	Think {
		spec: ToolSpec {
			name:            sf!("think"),
			rev:             Rev { family: Default::default(), n: 1 },
			description:     sf!(
				"Records a private reasoning scratch note. It has no external effect and returns only \
				 an acknowledgement.",
			),
			schema:          omp_tool::schema::<Params>(),
			constraint:      Constraint::Schema {
				priority:       100,
				on_unsupported: omp_tool::Fallback::Unspecified,
			},
			effects:         Effects::empty(),
			projection_code: omp_tool::native_projection_code(
				env!("CARGO_PKG_NAME"),
				env!("CARGO_PKG_VERSION"),
				include_bytes!("think.rs"),
			)
			.into(),
		},
	}
}

impl Tool for Think {
	type Fault = Fault;
	type Params = Params;
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
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; }
			};
			if params.thoughts.trim().is_empty() {
				yield Ev::Done(ToolTerminal::Done { result: Err(Fault { message: sf!("thoughts must not be empty") }), useless: true });
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await { yield commit_event(error); return; }
			yield Ev::Done(ToolTerminal::Done { result: Ok(Payload { recorded: true }), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(_) => sf!("------"),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
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
		example:  Some(sf!(r#"{{"thoughts":"reasoning"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn scratch_schema_is_closed_and_requires_text() {
		assert!(
			serde_json::from_value::<Params>(serde_json::json!({"thoughts":"private","visible":true}))
				.is_err()
		);
		assert!(serde_json::from_value::<Params>(serde_json::json!({"thoughts":"private"})).is_ok());
	}
}
