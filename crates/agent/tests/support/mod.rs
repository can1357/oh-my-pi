//! Shared fixtures for agent integration-test targets.

#![allow(dead_code, reason = "each integration-test target exercises a subset of these fixtures")]

use std::{
	collections::VecDeque,
	future::{Future, ready},
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime},
};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_agent::{DispatchOptions, DispatchRequest, Inference, ToolCancellation};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
	ProviderId, RequestId, ResponseMeta, RouteId, ToolCall, Usage, call::OpaqueJson,
};
use omp_core::Str;
use omp_journal::{Entry, EntryId, Journal, kind};
use omp_proto::thread::v1::{item, part};
use omp_session::{ComponentRegistry, Session, project_thread};
use omp_tool::{
	Claims, Constraint, Effects, Ev, IncomingParams, Part, Precedence, Presentation,
	ProjectionAuthorizationError, ProjectionSpan, PromptCaps, PromptProjection, Registry, Rev, Tool,
	ToolIdentity, ToolSpec, ToolTerminal, VisibilityReceipt, VisibleSourceLine,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	pub text: Str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Fault {
	pub message: Str,
}

pub struct TestTool {
	spec:       ToolSpec,
	output:     Str,
	update:     Option<Str>,
	delay:      Duration,
	barrier:    Option<Arc<tokio::sync::Barrier>>,
	started:    Option<Arc<AtomicUsize>>,
	visibility: Option<Arc<Mutex<Vec<VisibleSourceLine>>>>,
	fault:      bool,
}

pub fn tool_spec(name: &str, revision: u16) -> ToolSpec {
	ToolSpec {
		name:            Str::new(name),
		rev:             Rev { family: Str::new_static("test"), n: revision },
		description:     Str::new_static("test tool"),
		schema:          Bytes::from_static(br#"{"type":"object","additionalProperties":false}"#),
		constraint:      Constraint::None,
		effects:         Effects::empty(),
		projection_code: [revision as u8; 32],
	}
}

pub fn spec(name: &str, revision: u16, output: &str) -> TestTool {
	spec_family(name, "test", revision, output)
}

pub fn spec_family(name: &str, family: &str, revision: u16, output: &str) -> TestTool {
	let mut tool = tool_spec(name, revision);
	tool.rev.family = Str::new(family);
	TestTool {
		spec:       tool,
		output:     Str::new(output),
		update:     None,
		delay:      Duration::ZERO,
		barrier:    None,
		started:    None,
		visibility: None,
		fault:      false,
	}
}

impl TestTool {
	pub fn streaming(mut self, update: &str, delay: Duration) -> Self {
		self.update = Some(Str::new(update));
		self.delay = delay;
		self
	}

	pub fn concurrency_probe(
		mut self,
		started: Arc<AtomicUsize>,
		barrier: Arc<tokio::sync::Barrier>,
	) -> Self {
		self.started = Some(started);
		self.barrier = Some(barrier);
		self
	}

	pub const fn faulting(mut self) -> Self {
		self.fault = true;
		self
	}

	pub fn visibility_probe(mut self, receipts: Arc<Mutex<Vec<VisibleSourceLine>>>) -> Self {
		self.visibility = Some(receipts);
		self
	}
}

impl Tool for TestTool {
	type Fault = Fault;
	type Params = serde_json::Value;
	type Payload = Payload;
	type Update = Str;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let _ = params.committed().await;
			if let Some(update) = self.update.clone() {
				yield Ev::Update(update);
			}
			if let Some(started) = &self.started {
				started.fetch_add(1, Ordering::SeqCst);
			}
			if let Some(barrier) = &self.barrier {
				barrier.wait().await;
			}
			if !self.delay.is_zero() {
				tokio::time::sleep(self.delay).await;
			}
			if self.fault {
				yield Ev::Done(ToolTerminal::Done {
					result: Err(Fault { message: self.output.clone() }),
					useless: false,
				});
			} else {
				yield Ev::Done(ToolTerminal::Done {
					result: Ok(Payload { text: self.output.clone() }),
					useless: false,
				});
			}
		}
	}

	fn prompt(&self, view: Result<&Self::Payload, &Self::Fault>, _caps: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Ok(payload) => payload.text.clone(),
			Err(fault) => fault.message.clone(),
		};
		vec![Part::Text { text }]
	}

	fn projection(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &PromptCaps,
	) -> PromptProjection {
		let parts = self.prompt(view, caps);
		let visibility = if self.visibility.is_some()
			&& let [Part::Text { text }] = parts.as_slice()
		{
			let mut offset = 0;
			text
				.split_inclusive('\n')
				.enumerate()
				.map(|(index, row)| {
					let content_len = row
						.strip_suffix('\n')
						.map_or(row.len(), |content| content.len());
					let span = ProjectionSpan {
						part:       0,
						start_byte: offset,
						end_byte:   offset.saturating_add(content_len),
						source_key: Str::new_static("test-source"),
						line:       index.saturating_add(1),
					};
					offset = offset.saturating_add(row.len());
					span
				})
				.collect()
		} else {
			Vec::new()
		};
		PromptProjection { parts, visibility }
	}

	fn authorize_visibility(
		&self,
		_view: Result<&Self::Payload, &Self::Fault>,
		receipt: &VisibilityReceipt,
	) -> Result<(), ProjectionAuthorizationError> {
		if let Some(receipts) = &self.visibility {
			receipts.lock().extend(receipt.lines.iter().cloned());
		}
		Ok(())
	}
}

pub fn registry(tools: impl IntoIterator<Item = TestTool>) -> Arc<Registry> {
	let mut registry = Registry::new();
	for tool in tools {
		registry
			.register(tool, Presentation::Slot, Claims {
				precedence: Precedence::CORE,
				claimant:   Str::new_static("omp-agent/tests"),
				replaces:   None,
			})
			.expect("tool registers");
	}
	Arc::new(registry)
}

pub fn raw(value: serde_json::Value) -> Box<RawValue> {
	serde_json::value::to_raw_value(&value).expect("test JSON serializes")
}

pub fn session(path: &Path) -> Session {
	let mut session = Session::create(path, ComponentRegistry::default()).expect("session creates");
	session.begin_turn().expect("turn starts");
	session.user("test", Vec::new()).expect("user appends");
	session
}

pub fn fresh_session(path: &Path) -> Session {
	Session::create(path, ComponentRegistry::default()).expect("session creates")
}

pub fn call(session: &mut Session, identity: &ToolIdentity, id: &str) -> (EntryId, Box<RawValue>) {
	let args = raw(serde_json::json!({}));
	let call = session
		.call(identity.name.clone(), u32::from(identity.rev.n), id, None, Some(args.clone()), None)
		.expect("call journals");
	(call, args)
}

pub fn request(
	call: EntryId,
	identity: ToolIdentity,
	args: Box<RawValue>,
	cancellation: ToolCancellation,
	notrunc: bool,
) -> DispatchRequest {
	DispatchRequest {
		identity,
		call_id: Str::new(call.to_string()),
		call,
		args,
		options: DispatchOptions { notrunc },
		cancellation,
	}
}

pub fn result_text(session: &Session, call_id: &str) -> Vec<String> {
	project_thread(session.dom())
		.into_iter()
		.find_map(|item| match item.kind? {
			item::Kind::ToolResult(result) if result.call_id == call_id => Some(
				result
					.parts
					.into_iter()
					.filter_map(|part| match part.kind? {
						part::Kind::Text(text) => Some(text),
						_ => None,
					})
					.collect(),
			),
			_ => None,
		})
		.expect("tool result projects")
}

pub fn assert_journal_cause(session: &Session, call: EntryId) {
	let journal = std::fs::read_to_string(session.journal_path()).expect("journal reads");
	assert!(journal.contains("event: tool.call@1"));
	assert!(journal.contains("event: tool.result@1"));
	assert!(journal.contains(&format!("by: {call}")));
}

pub fn journal_entries(path: &Path) -> Vec<Entry> {
	Journal::scan(path).expect("journal scans")
}

pub fn assert_all_entries_caused(entries: &[Entry]) {
	for entry in entries {
		if entry.kind.name.as_str() == kind::JOURNAL {
			assert!(entry.by.is_none(), "genesis has no cause");
		} else {
			assert!(entry.by.is_some(), "{} must carry by:", entry.kind.name);
		}
	}
}

pub type Requests = Arc<Mutex<Vec<ChatRequest>>>;

pub struct ScriptedInference {
	scripts:  VecDeque<Vec<ChatEvent>>,
	requests: Requests,
}

impl ScriptedInference {
	pub fn new(scripts: impl IntoIterator<Item = Vec<ChatEvent>>) -> (Self, Requests) {
		let requests = Arc::new(Mutex::new(Vec::new()));
		(Self { scripts: scripts.into_iter().collect(), requests: Arc::clone(&requests) }, requests)
	}
}

impl Inference for ScriptedInference {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.requests.lock().push(request);
		let events = self
			.scripts
			.pop_front()
			.expect("one script per inference request");
		ready(Ok(streaming(events)))
	}
}

pub fn streaming(events: Vec<ChatEvent>) -> ChatStream {
	let events = std::iter::once(ChatEvent::Started(ResponseMeta {
		request_id:          RequestId::from("scripted-request"),
		provider:            ProviderId::from("scripted"),
		route:               RouteId::from("scripted/test"),
		model:               None,
		provider_request_id: None,
		created_at:          SystemTime::UNIX_EPOCH,
	}))
	.chain(events)
	.map(Ok);
	ChatStream::ordinary(Box::pin(futures::stream::iter(events)))
}

pub fn completed(reason: FinishReason, blocks: u32) -> ChatEvent {
	ChatEvent::Completed(Completion {
		reason,
		blocks,
		usage: Usage::default(),
		receipt: ExecutionReceipt::default().into(),
	})
}

pub fn text_script(text: &str) -> Vec<ChatEvent> {
	vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
		ChatEvent::TextDelta { index: 0, text: Str::new(text) },
		completed(FinishReason::Stop, 1),
	]
}

pub fn empty_script() -> Vec<ChatEvent> {
	vec![completed(FinishReason::Stop, 0)]
}

pub fn tool_script(id: &str, name: &str, arguments: serde_json::Value) -> Vec<ChatEvent> {
	let call = ToolCall {
		id:        id.into(),
		name:      Str::new(name),
		arguments: OpaqueJson::new(arguments.clone()),
	};
	vec![
		ChatEvent::ToolCallStarted { index: 0, id: call.id.clone(), name: call.name.clone() },
		ChatEvent::ToolArgumentsDelta {
			index: 0,
			bytes: Bytes::from(serde_json::to_vec(&arguments).expect("tool args encode")),
		},
		ChatEvent::ToolCallReady { index: 0, call },
		completed(FinishReason::ToolCalls, 1),
	]
}
