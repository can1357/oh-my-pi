//! Host-owned tools the server calls back into (`set_host_tools`,
//! `host_tool_call`).

use std::{
	fmt,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use serde_json::{Map, Value};

use crate::{
	client::{Error, Guard, Shared},
	wire::{
		HostToolDefinition, HostToolResultPayload, HostToolUpdate, RpcInbound, TextContent,
		ToolLoadMode, UserContent,
	},
};

/// Error a handler returns; its text becomes the tool's error result.
pub type HostToolError = Box<dyn std::error::Error + Send + Sync>;

type Handler = dyn Fn(Map<String, Value>, &HostToolContext) -> Result<HostToolOutput, HostToolError>
	+ Send
	+ Sync;

/// A tool definition plus the handler that runs it on the host.
#[derive(Clone)]
pub struct HostTool {
	definition: HostToolDefinition,
	handler:    Arc<Handler>,
}

impl HostTool {
	/// `parameters` is the JSON Schema of the arguments object. The handler runs
	/// on its own thread for every call and receives the arguments object.
	pub fn new(
		name: impl Into<String>,
		description: impl Into<String>,
		parameters: Map<String, Value>,
		handler: impl Fn(Map<String, Value>, &HostToolContext) -> Result<HostToolOutput, HostToolError>
		+ Send
		+ Sync
		+ 'static,
	) -> Self {
		Self {
			definition: HostToolDefinition {
				name: name.into(),
				description: description.into(),
				parameters,
				label: None,
				hidden: Some(false),
				load_mode: None,
				reads_skill_uris: Some(false),
			},
			handler:    Arc::new(handler),
		}
	}

	pub fn label(mut self, label: impl Into<String>) -> Self {
		self.definition.label = Some(label.into());
		self
	}

	pub fn hidden(mut self, hidden: bool) -> Self {
		self.definition.hidden = Some(hidden);
		self
	}

	pub fn load_mode(mut self, mode: ToolLoadMode) -> Self {
		self.definition.load_mode = Some(mode);
		self
	}

	/// The tool can read `skill://` content, so prompts include skill guidance.
	pub fn reads_skill_uris(mut self, reads: bool) -> Self {
		self.definition.reads_skill_uris = Some(reads);
		self
	}

	/// The definition sent with `set_host_tools`.
	pub fn definition(&self) -> &HostToolDefinition {
		&self.definition
	}

	pub(crate) fn run(
		&self,
		arguments: Map<String, Value>,
		context: &HostToolContext,
	) -> Result<HostToolOutput, HostToolError> {
		(self.handler)(arguments, context)
	}
}

impl fmt::Debug for HostTool {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("HostTool")
			.field("definition", &self.definition)
			.finish_non_exhaustive()
	}
}

/// A handler's result: plain text or a full payload.
#[derive(Debug, Clone, PartialEq)]
pub enum HostToolOutput {
	/// Shortcut for `{content: [{type: "text", text}]}`.
	Text(String),
	Payload(HostToolResultPayload),
}

impl From<String> for HostToolOutput {
	fn from(text: String) -> Self {
		Self::Text(text)
	}
}

impl From<&str> for HostToolOutput {
	fn from(text: &str) -> Self {
		Self::Text(text.to_owned())
	}
}

impl From<HostToolResultPayload> for HostToolOutput {
	fn from(payload: HostToolResultPayload) -> Self {
		Self::Payload(payload)
	}
}

impl HostToolOutput {
	pub(crate) fn into_payload(self) -> HostToolResultPayload {
		match self {
			Self::Payload(payload) => payload,
			Self::Text(text) => text_payload(text, None),
		}
	}
}

pub(crate) fn text_payload(text: String, details: Option<Value>) -> HostToolResultPayload {
	HostToolResultPayload {
		content: vec![UserContent::Text(TextContent {
			text:           Some(text),
			text_signature: None,
			extra:          Map::new(),
		})],
		details,
		is_error: None,
		useless: None,
		provider_metadata: None,
	}
}

/// Per-call context handed to a handler.
pub struct HostToolContext {
	pub(crate) tool_call_id: String,
	pub(crate) request_id:   String,
	pub(crate) cancelled:    Arc<AtomicBool>,
	pub(crate) shared:       Arc<Shared>,
}

impl HostToolContext {
	/// The agent's tool call id.
	pub fn tool_call_id(&self) -> &str {
		&self.tool_call_id
	}

	/// True once the server sent `host_tool_cancel` for this call or the client
	/// closed; nothing more is sent for a cancelled call.
	pub fn is_cancelled(&self) -> bool {
		self.cancelled.load(Ordering::SeqCst)
	}

	/// Queues a partial result (`host_tool_update`); a no-op once cancelled.
	/// The writer re-checks cancellation right before writing, so an update
	/// still queued when the call is cancelled is dropped.
	pub fn send_update(&self, partial: impl Into<HostToolOutput>) -> Result<(), Error> {
		if self.is_cancelled() {
			return Ok(());
		}
		let update = RpcInbound::HostToolUpdate(HostToolUpdate {
			id:             self.request_id.clone(),
			partial_result: partial.into().into_payload(),
		});
		let guard = Guard { cancelled: Arc::clone(&self.cancelled), release: None };
		self.shared.enqueue(&update, Some(guard))
	}
}
