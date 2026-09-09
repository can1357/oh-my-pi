//! Typed Mnemopi recall, reflect, and retain tools.

use std::sync::Arc;

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{Str, StrMut, sf};
use omp_memory::{
	MemoryRuntime,
	recall::{RecallBounds, RecallResult},
	runtime::{
		MAX_MEMORY_BATCH_BYTES, MAX_MEMORY_CONTENT_BYTES, MAX_MEMORY_CONTEXT_BYTES, SaveRequest,
	},
};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Effects, Ev,
	IncomingParams, LiftedCall, ParamError, Part, PromptCaps, RecordedCall, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

const DEFAULT_TOKEN_BUDGET: usize = 2_000;
const MAX_TOKEN_BUDGET: usize = 16_000;
const MAX_QUERY_BYTES: usize = 64 * 1024;
const MAX_RETAIN_ITEMS: usize = 64;

/// Arguments accepted by `recall@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RecallParams {
	/// Natural-language search query.
	#[schemars(length(min = 1, max = 65536))]
	pub query:        Str,
	/// Approximate result token budget.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(range(min = 1, max = 16000))]
	pub token_budget: Option<usize>,
}

/// Deterministic recall payload.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RecallPayload {
	/// Original query.
	pub query: Str,
	/// Relevance-ranked scoped results.
	pub items: Vec<RecallResult>,
}

/// Arguments accepted by `reflect@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReflectParams {
	/// Question answered from long-term memory.
	#[schemars(length(min = 1, max = 65536))]
	pub query:        Str,
	/// Optional angle or current context for synthesis.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(max = 65536))]
	pub context:      Option<Str>,
	/// Approximate recall token budget.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(range(min = 1, max = 16000))]
	pub token_budget: Option<usize>,
}

/// Synthesized reflection payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReflectPayload {
	/// Coherent answer produced from recalled evidence.
	pub answer:   Str,
	/// Number of memories supplied to synthesis.
	pub recalled: usize,
}

/// One durable fact supplied to `retain@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RetainItem {
	/// Specific, self-contained information to remember.
	#[schemars(length(min = 1, max = 262144))]
	pub content: Str,
	/// Optional source context.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	#[schemars(length(max = 65536))]
	pub context: Option<Str>,
}

/// Arguments accepted by `retain@2`.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RetainParams {
	/// Durable facts to store as one bounded batch.
	#[schemars(length(min = 1, max = 64))]
	pub items: Vec<RetainItem>,
}

/// Durable retain receipt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RetainPayload {
	/// Stored memory ids in input order.
	pub ids: Vec<Str>,
}

/// Memory tools do not stream progress.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Typed memory-tool failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// Mnemopi is not live for this session.
	#[error("Mnemopi memory is unavailable")]
	Unavailable,
	/// A query or retain batch was empty or outside its documented bound.
	#[error("memory tool arguments are invalid")]
	InvalidInput,
	/// The durable memory operation failed.
	#[error("memory operation failed")]
	Operation,
	/// Auxiliary synthesis failed without a model answer.
	#[error("memory reflection synthesis failed")]
	Synthesis,
}

/// Bounded reflection request crossing from the memory device to app inference.
#[derive(Clone, Debug)]
pub struct ReflectionRequest {
	/// Question to answer.
	pub query:    Str,
	/// Optional current context.
	pub context:  Option<Str>,
	/// Bounded relevance-ranked evidence.
	pub memories: Arc<[RecallResult]>,
}

/// Typed refusal from the app inference authority.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ReflectionHostError {
	/// No app inference authority is currently bound.
	#[error("memory reflection host is unavailable")]
	Unavailable,
	/// Inference ended without a usable synthesis.
	#[error("memory reflection inference failed")]
	Inference,
}

/// App-owned auxiliary synthesis authority injected into the memory device.
#[async_trait::async_trait]
pub trait ReflectionHost: Send + Sync + 'static {
	/// Synthesizes an answer from bounded, relevance-ranked memories.
	async fn reflect(&self, request: ReflectionRequest) -> Result<Str, ReflectionHostError>;
}

#[async_trait::async_trait]
impl<H: ReflectionHost + ?Sized> ReflectionHost for Arc<H> {
	async fn reflect(&self, request: ReflectionRequest) -> Result<Str, ReflectionHostError> {
		self.as_ref().reflect(request).await
	}
}

/// Typed `recall@2` executor.
pub struct RecallTool {
	runtime: Arc<MemoryRuntime>,
	spec:    ToolSpec,
}

/// Typed `reflect@2` executor.
pub struct ReflectTool<H> {
	runtime: Arc<MemoryRuntime>,
	host:    H,
	spec:    ToolSpec,
}

/// Typed `retain@2` executor.
pub struct RetainTool {
	runtime: Arc<MemoryRuntime>,
	spec:    ToolSpec,
}

/// Builds the host-free `recall@2` declaration.
pub fn recall_spec() -> ToolSpec {
	memory_spec::<RecallParams>("recall", RECALL_DESCRIPTION)
}

/// Builds the host-free `reflect@2` declaration.
pub fn reflect_spec() -> ToolSpec {
	memory_spec::<ReflectParams>("reflect", REFLECT_DESCRIPTION)
}

/// Builds the host-free `retain@2` declaration.
pub fn retain_spec() -> ToolSpec {
	memory_spec::<RetainParams>("retain", RETAIN_DESCRIPTION)
}

/// Creates the revisioned recall leaf.
pub fn recall_tool(runtime: Arc<MemoryRuntime>) -> RecallTool {
	RecallTool { runtime, spec: recall_spec() }
}

/// Creates the revisioned reflect leaf.
pub fn reflect_tool<H: ReflectionHost>(runtime: Arc<MemoryRuntime>, host: H) -> ReflectTool<H> {
	ReflectTool { runtime, host, spec: reflect_spec() }
}

/// Creates the revisioned retain leaf.
pub fn retain_tool(runtime: Arc<MemoryRuntime>) -> RetainTool {
	RetainTool { runtime, spec: retain_spec() }
}

impl Tool for RecallTool {
	type Fault = Fault;
	type Params = RecallParams;
	type Payload = RecallPayload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, RecallPayload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<RecallParams>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			if params.query.trim().is_empty()
				|| params.query.len() > MAX_QUERY_BYTES
				|| params
					.token_budget
					.is_some_and(|budget| budget == 0 || budget > MAX_TOKEN_BUDGET)
			{
				yield terminal(Err(Fault::InvalidInput), true);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let token_budget = params.token_budget.unwrap_or(DEFAULT_TOKEN_BUDGET).clamp(1, MAX_TOKEN_BUDGET);
			match self.runtime.search(
				params.query.as_str(),
				None,
				RecallBounds { token_budget, ..RecallBounds::default() },
			) {
				Ok(outcome) if outcome.message.is_some() => yield terminal(Err(Fault::Unavailable), false),
				Ok(outcome) => {
					let useless = outcome.items.is_empty();
					yield terminal(Ok(RecallPayload { query: outcome.query, items: outcome.items }), useless);
				},
				Err(_) => yield terminal(Err(Fault::Operation), false),
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_v1::<RecallParams, RecallPayload>(from, call)
	}

	fn prompt(&self, view: Result<&RecallPayload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => render_recall(payload),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

impl<H: ReflectionHost> Tool for ReflectTool<H> {
	type Fault = Fault;
	type Params = ReflectParams;
	type Payload = ReflectPayload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, ReflectPayload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<ReflectParams>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			if params.query.trim().is_empty()
				|| params.query.len() > MAX_QUERY_BYTES
				|| params.context.as_ref().is_some_and(|context| context.len() > MAX_MEMORY_CONTEXT_BYTES)
				|| params
					.token_budget
					.is_some_and(|budget| budget == 0 || budget > MAX_TOKEN_BUDGET)
			{
				yield terminal(Err(Fault::InvalidInput), true);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let token_budget = params
				.token_budget
				.unwrap_or(DEFAULT_TOKEN_BUDGET)
				.clamp(1, MAX_TOKEN_BUDGET);
			let mut recall_query = params.query.to_string();
			if let Some(context) = params
				.context
				.as_ref()
				.map(|value| value.trim())
				.filter(|value| !value.is_empty())
			{
				recall_query.push_str("\n\nAdditional context:\n");
				recall_query.push_str(context.as_str());
			}
			let outcome = match self.runtime.search(
				&recall_query,
				None,
				RecallBounds { token_budget, ..RecallBounds::default() },
			) {
				Ok(value) if value.message.is_none() => value,
				Ok(_) => {
					yield terminal(Err(Fault::Unavailable), false);
					return;
				},
				Err(_) => {
					yield terminal(Err(Fault::Operation), false);
					return;
				},
			};
			if outcome.items.is_empty() {
				yield terminal(
					Ok(ReflectPayload {
						answer: sf!("No relevant information found to reflect on."),
						recalled: 0,
					}),
					true,
				);
				return;
			}
			let request = ReflectionRequest {
				query: params.query,
				context: params.context,
				memories: Arc::from(outcome.items),
			};
			let recalled = request.memories.len();
			let fallback = render_reflection_evidence(&request.memories);
			let reflection = self.host.reflect(request);
			tokio::pin!(reflection);
			tokio::select! {
				biased;
				interrupt = incoming.next_interrupt() => {
					yield match interrupt {
						Ok(interrupt) => Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
						Err(_) => Ev::Aborted(Abort::InputDropped),
					};
				},
				result = &mut reflection => match result {
					Ok(answer) if !answer.trim().is_empty() => {
						yield terminal(Ok(ReflectPayload { answer, recalled }), false);
					},
					Err(ReflectionHostError::Unavailable) => {
						yield terminal(Ok(ReflectPayload {
							answer: fallback,
							recalled,
						}), false);
					},
					_ => yield terminal(Err(Fault::Synthesis), false),
				},
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_v1::<ReflectParams, ReflectPayload>(from, call)
	}

	fn prompt(&self, view: Result<&ReflectPayload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => payload.answer.clone(),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

impl Tool for RetainTool {
	type Fault = Fault;
	type Params = RetainParams;
	type Payload = RetainPayload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, RetainPayload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<RetainParams>().await {
				Ok(value) => value,
				Err(error) => { yield param_event(error); return; },
			};
			let aggregate_bytes = params.items.iter().try_fold(0usize, |total, item| {
				total
					.checked_add(item.content.len())
					.and_then(|bytes| bytes.checked_add(item.context.as_ref().map_or(0, Str::len)))
			});
			if params.items.is_empty()
				|| params.items.len() > MAX_RETAIN_ITEMS
				|| params.items.iter().any(|item| {
					item.content.trim().is_empty()
						|| item.content.len() > MAX_MEMORY_CONTENT_BYTES
						|| item.context.as_ref().is_some_and(|context| context.len() > MAX_MEMORY_CONTEXT_BYTES)
				})
				|| aggregate_bytes.is_none_or(|bytes| bytes > MAX_MEMORY_BATCH_BYTES)
			{
				yield terminal(Err(Fault::InvalidInput), true);
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let requests = params
				.items
				.iter()
				.map(|item| SaveRequest {
					content: item.content.as_str(),
					context: item.context.as_deref(),
				})
				.collect::<Vec<_>>();
			match self.runtime.save_batch(&requests, "coding-agent-retain", 0.75) {
				Ok(outcome) if outcome.message.is_some() => {
					yield terminal(Err(Fault::Unavailable), false);
				},
				Ok(outcome) => yield terminal(Ok(RetainPayload { ids: outcome.ids }), false),
				Err(omp_memory::Error::InputTooLarge | omp_memory::Error::InvalidIdentifier) => {
					yield terminal(Err(Fault::InvalidInput), true);
				},
				Err(_) => yield terminal(Err(Fault::Operation), false),
			}
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_v1::<RetainParams, RetainPayload>(from, call)
	}

	fn prompt(&self, view: Result<&RetainPayload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(payload) => sf!(
					"{} {} stored.",
					payload.ids.len(),
					if payload.ids.len() == 1 {
						"memory"
					} else {
						"memories"
					}
				),
				Err(fault) => Str::new(fault.to_string()),
			},
		}]
	}
}

fn memory_spec<P: JsonSchema>(name: &'static str, description: &'static str) -> ToolSpec {
	ToolSpec {
		name:            Str::new_static(name),
		rev:             Rev { family: Str::default(), n: 2 },
		description:     Str::new_static(description),
		schema:          omp_tool::schema::<P>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::empty(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("memory.rs"),
		)
		.into(),
	}
}

fn lift_v1<P, O>(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall>
where
	P: DeserializeOwned,
	O: DeserializeOwned,
{
	if !from.family.is_empty() || from.n != 1 {
		return None;
	}
	let mut raw_args = serde_json::from_slice::<serde_json::Value>(call.raw_args).ok()?;
	let object = raw_args.as_object_mut()?;
	object.remove("i");
	object.remove("notrunc");
	serde_json::from_value::<P>(raw_args).ok()?;
	serde_json::from_slice::<CallOutcome<O, Fault>>(call.verdict).ok()?;
	Some(LiftedCall {
		raw_args: Bytes::copy_from_slice(call.raw_args),
		verdict:  Bytes::copy_from_slice(call.verdict),
	})
}

fn render_reflection_evidence(memories: &[RecallResult]) -> Str {
	let mut output = StrMut::new("Based on recalled memories:\n\n");
	use std::fmt::Write as _;
	for item in memories {
		let source = item.memory.source.as_deref().unwrap_or("unknown");
		let date = item
			.memory
			.timestamp
			.get(..10)
			.unwrap_or(item.memory.timestamp.as_str());
		let _ =
			writeln!(output, "- {} [{source}] ({date}, c:{:.2})", item.memory.content, item.score);
	}
	output.freeze()
}

fn render_recall(payload: &RecallPayload) -> Str {
	if payload.items.is_empty() {
		return sf!("No relevant memories found.");
	}
	let mut output = StrMut::new("");
	use std::fmt::Write as _;
	let _ = writeln!(output, "Found {} relevant memories:\n", payload.items.len());
	for item in &payload.items {
		let source = item.memory.source.as_deref().unwrap_or("unknown");
		let date = item
			.memory
			.timestamp
			.get(..10)
			.unwrap_or(item.memory.timestamp.as_str());
		let _ = writeln!(
			output,
			"- [{}] {} (memory://{}) [{source}] ({date}, c:{:.2})",
			item.memory.bank, item.memory.content, item.memory.id, item.score,
		);
	}
	output.freeze()
}

const fn terminal<U, P>(result: Result<P, Fault>, useless: bool) -> Ev<U, P, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless })
}

fn param_event<U, P>(error: ParamError) -> Ev<U, P, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(omp_tool::Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event<U, P>(error: CommitError) -> Ev<U, P, Fault> {
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

const RECALL_DESCRIPTION: &str = "Search long-term memory for raw relevance-ranked entries. Use \
                                  before questions about prior conversations, preferences, or \
                                  project decisions. Read a full memory:// id before updating it.";
const REFLECT_DESCRIPTION: &str = "Synthesize a coherent answer across relevant long-term \
                                   memories. Use for open-ended questions spanning many stored \
                                   facts; optional context focuses the synthesis.";
const RETAIN_DESCRIPTION: &str = "Store one or more specific, self-contained durable facts in \
                                  long-term memory. Do not retain ephemeral task state.";
