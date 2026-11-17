//! Joined production lifecycle-hook integration over one real kernel tool turn.

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_agent::{
	ApprovalBook, ApprovalDecision, ApprovalScope, ApprovalSource, ApprovalSpec, DispatchPolicy,
	GateDecision, GateError, GateEvent, GateOutcome, HookDecision, HookGate, HookPatch, HookPhase,
	Kernel, KernelEvent, LifecycleHooks, OnFailure, RunControl, SourceRef, StaticPrompt,
	TicketState, ToolAdmission, ToolAdmissionVerdict, TurnInput, TurnStop, Up, When,
};
use omp_core::{Str, sf};
use omp_journal::{blob::BlobStore, kind};
use omp_proto::toolhost::v1::HookEventId;
use omp_tool::{
	Claims, Confinement, Constraint, Effects, Ev, ExecEffects, HostToolExecutor, HostToolInvocation,
	HostToolResult, HostToolSpec, HostToolUpdateSink, IncomingParams, InvocationPins, Part,
	Precedence, Presentation, PromptCaps, Registry, ResolutionPin, Rev, Tool, ToolSpec,
	ToolTerminal,
};
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

mod support;

use support::{ScriptedInference, fresh_session, journal_entries, text_script, tool_script};

struct CaptureTool {
	spec: ToolSpec,
	seen: Arc<Mutex<Option<Value>>>,
}

impl Tool for CaptureTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let args = params.whole::<Value>().await.expect("transformed args decode");
			*self.seen.lock() = Some(args.clone());
			yield Ev::Update(serde_json::json!({"stage": "running"}));
			yield Ev::Done(ToolTerminal::Done { result: Ok(args), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Value, &Value>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Json {
			json: Bytes::from(serde_json::to_vec(view.unwrap_or_else(|fault| fault)).expect("JSON")),
		}]
	}
}

fn capture_registry(seen: Arc<Mutex<Option<Value>>>) -> Arc<Registry> {
	let mut registry = Registry::new();
	registry
		.register(
			CaptureTool {
				spec: ToolSpec {
					name: sf!("capture"),
					rev: Rev { family: sf!("test"), n: 1 },
					description: sf!("capture transformed arguments"),
					schema: Bytes::from_static(
						br#"{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}"#,
					),
					constraint: Constraint::None,
					effects: Effects::empty(),
					confinement: Confinement::Host,
					projection_code: [7; 32],
				},
				seen,
			},
			Presentation::Slot,
			Claims {
				precedence: Precedence::CORE,
				claimant: sf!("omp/core"),
				replaces: None,
			},
		)
		.expect("capture tool registers");
	Arc::new(registry)
}

fn approval_spec(title: &'static str, body: &'static str) -> ApprovalSpec {
	ApprovalSpec {
		title:         sf!(title),
		body:          sf!(body),
		subject:       sf!("capture"),
		kind:          sf!("exec"),
		scopes:        vec![sf!("once")],
		default:       Some(false),
		route:         sf!("user"),
		approver:      None,
		timeout_ms:    1_000,
		unreachable:   sf!("fail_closed"),
		require_human: true,
		pattern:       None,
		evidence:      vec![sf!("host_generation=7"), sf!("session_generation=3")],
	}
}

struct PromptAdmission;

impl ToolAdmission for PromptAdmission {
	fn admit(
		&self,
		_name: &str,
		_effects: &Effects,
		_confinement: Confinement,
		_args: &serde_json::value::RawValue,
		_fetch_locators: &[Str],
	) -> ToolAdmissionVerdict {
		ToolAdmissionVerdict::Prompt(vec![approval_spec(
			"Native capability approval",
			"native admission policy",
		)])
	}
}

fn subscription(id: u32, event: HookEventId, phase: HookPhase) -> omp_agent::hooks::Subscription {
	omp_agent::hooks::Subscription {
		host: sf!("test"),
		source: SourceRef {
			layer:        0,
			publisher:    sf!("test"),
			extension_id: sf!("lifecycle"),
		},
		id,
		event,
		phase,
		order: 0,
		on_failure: OnFailure::Deny,
		when: When::default(),
	}
}

#[test]
fn every_phase_has_a_closed_typed_decision_vocabulary() {
	let expected = [
		(HookPhase::Precheck, [false, true, false, true, false]),
		(HookPhase::Transform, [false, false, true, true, false]),
		(HookPhase::Review, [true, true, false, true, false]),
		(HookPhase::Approval, [true, true, false, true, true]),
		(HookPhase::Observe, [false, false, false, true, false]),
	];
	for (phase, legal) in expected {
		for (decision, expected) in HookDecision::ALL.into_iter().zip(legal) {
			assert_eq!(decision.is_legal_in(phase), expected, "{phase:?} {decision:?}");
		}
	}
}

#[tokio::test]
async fn timeout_obeys_each_subscription_failure_policy() {
	for (policy, denied) in [(OnFailure::Defer, false), (OnFailure::Deny, true)] {
		let (gate, _receiver) = HookGate::channel_with_timeout(Duration::from_millis(1));
		let mut row = subscription(17, HookEventId::HookEventToolCall, HookPhase::Review);
		row.on_failure = policy;
		gate.subscribe("test", [row]).expect("subscription");
		let outcome = gate
			.gate(
				HookEventId::HookEventToolCall,
				GateEvent::new(sf!("bash"), Bytes::from_static(b"{}")),
			)
			.await;
		assert_eq!(matches!(outcome, GateOutcome::Deny { .. }), denied);
	}
}

#[tokio::test]
async fn delegated_host_loss_uses_the_published_failure_class() {
	for (event, denied) in
		[(HookEventId::HookEventSessionStart, false), (HookEventId::HookEventToolCall, true)]
	{
		let (gate, receiver) = HookGate::delegated_channel();
		let bit = 1_u128 << (event as u32);
		gate.replace_masks(bit, denied.then_some(bit).unwrap_or(0));
		drop(receiver);
		let outcome = gate
			.gate(event, GateEvent::new(sf!("target"), Bytes::from_static(b"{}")))
			.await;
		assert_eq!(matches!(outcome, GateOutcome::Deny { .. }), denied);
	}
}

#[tokio::test]
async fn cancelling_a_gate_removes_its_pending_reply_slot() {
	let (gate, receiver) = HookGate::channel();
	let mut row = subscription(18, HookEventId::HookEventToolCall, HookPhase::Review);
	row.on_failure = OnFailure::Deny;
	gate.subscribe("test", [row]).expect("subscription");
	let gate = Arc::new(gate);
	let worker = {
		let gate = Arc::clone(&gate);
		tokio::spawn(async move {
			gate
				.gate(
					HookEventId::HookEventToolCall,
					GateEvent::new(sf!("bash"), Bytes::from_static(b"{}")),
				)
				.await
		})
	};
	let dispatch = receiver.recv_async().await.expect("dispatch");
	worker.abort();
	let _ = worker.await;
	assert_eq!(
		gate.answer(dispatch.dispatch_id, vec![(18, GateDecision::Allow)]),
		Err(GateError::UnknownDispatch),
	);
}

#[tokio::test]
async fn approval_phase_collects_every_requirement_in_dispatch_order() {
	let (gate, receiver) = HookGate::channel();
	gate
		.subscribe("test", [
			subscription(1, HookEventId::HookEventToolCall, HookPhase::Approval),
			subscription(2, HookEventId::HookEventToolCall, HookPhase::Approval),
		])
		.expect("subscriptions");
	let gate = Arc::new(gate);
	let hooks = LifecycleHooks::new(Arc::clone(&gate));
	let work = hooks.evaluate(
		HookEventId::HookEventToolCall,
		serde_json::json!({"target": {"name": "bash"}, "args": {}}),
	);
	let driver = async {
		for (id, subject) in [(1, "first"), (2, "second")] {
			let dispatch = receiver.recv_async().await.expect("approval phase");
			let mut spec = approval_spec("Approve", "Approval required");
			spec.subject = subject.into();
			gate
				.answer(dispatch.dispatch_id, vec![(id, GateDecision::RequireApproval(spec))])
				.expect("approval requirement");
		}
	};
	let (outcome, ()) = tokio::join!(work, driver);
	let outcome = outcome.expect("typed lifecycle admission");
	assert_eq!(
		outcome
			.approvals
			.iter()
			.map(|spec| spec.subject.as_str())
			.collect::<Vec<_>>(),
		["first", "second"],
	);
}

#[tokio::test]
async fn lifecycle_tool_call_transform_reaches_executor_and_observations_are_complete() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	let observed = Arc::new(Mutex::new(Vec::new()));
	let events = [
		HookEventId::HookEventAgentStart,
		HookEventId::HookEventTurnStart,
		HookEventId::HookEventMessageStart,
		HookEventId::HookEventMessageUpdate,
		HookEventId::HookEventMessageEnd,
		HookEventId::HookEventCallOpen,
		HookEventId::HookEventToolExecutionStart,
		HookEventId::HookEventToolUpdate,
		HookEventId::HookEventToolExecutionEnd,
		HookEventId::HookEventToolResult,
		HookEventId::HookEventTurnEnd,
		HookEventId::HookEventAgentEnd,
	];
	let mut subscriptions =
		vec![subscription(1, HookEventId::HookEventToolCall, HookPhase::Transform)];
	subscriptions.extend(events.into_iter().enumerate().map(|(index, event)| {
		subscription(u32::try_from(index).expect("small") + 2, event, HookPhase::Observe)
	}));
	gate
		.subscribe("test", subscriptions)
		.expect("subscriptions");
	let responder = {
		let gate = Arc::clone(&gate);
		let observed = Arc::clone(&observed);
		tokio::spawn(async move {
			while let Ok(dispatch) = receiver.recv_async().await {
				let payload: Value = serde_json::from_slice(&dispatch.payload).expect("hook payload");
				observed.lock().push((dispatch.event, payload.clone()));
				if dispatch.event == HookEventId::HookEventToolCall {
					let mut transformed = payload;
					transformed["args"] = serde_json::json!({"value": 2});
					transformed["target"]["args"] = serde_json::json!({"value": 2});
					gate
						.answer(dispatch.dispatch_id, vec![(
							1,
							GateDecision::Modify(HookPatch {
								target: None,
								args:   Some(Bytes::from(
									serde_json::to_vec(&transformed).expect("transform"),
								)),
							}),
						)])
						.expect("hook answer");
				}
			}
		})
	};
	let seen = Arc::new(Mutex::new(None));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("capture-1", "capture", serde_json::json!({"value": 1})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		capture_registry(Arc::clone(&seen)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(Arc::clone(&gate));
	let mut session = fresh_session(&temp.path().join("hooks.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	assert_eq!(*seen.lock(), Some(serde_json::json!({"value": 2})));
	tokio::time::sleep(Duration::from_millis(20)).await;
	for event in events {
		assert!(observed.lock().iter().any(|(actual, _)| *actual == event), "missing {event:?}");
	}
	let tool_call = observed
		.lock()
		.iter()
		.find(|(event, _)| *event == HookEventId::HookEventToolCall)
		.map(|(_, payload)| payload.clone())
		.expect("tool-call payload");
	for key in [
		"call_id",
		"invocation_id",
		"target",
		"kind",
		"args",
		"raw_args",
		"repaired",
		"turn_id",
		"session_id",
		"cwd",
		"origin",
		"batch",
		"deadline",
		"bash",
	] {
		assert!(tool_call.get(key).is_some(), "missing strict ToolCall key {key}");
	}
	drop(kernel);
	responder.abort();
}

#[tokio::test]
async fn lifecycle_and_native_approval_share_one_durable_ticket_and_replay() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [subscription(1, HookEventId::HookEventToolCall, HookPhase::Approval)])
		.expect("approval subscription");
	let responder = {
		let gate = Arc::clone(&gate);
		tokio::spawn(async move {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("tool-call approval phase");
			gate
				.answer(dispatch.dispatch_id, vec![(
					1,
					GateDecision::RequireApproval(approval_spec(
						"Extension approval",
						"extension policy",
					)),
				)])
				.expect("approval requirement");
		})
	};
	let seen = Arc::new(Mutex::new(None));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("capture-approval", "capture", serde_json::json!({"value": 1})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		capture_registry(Arc::clone(&seen)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate)
	.with_tool_admission(Arc::new(PromptAdmission));
	let events = kernel.subscribe();
	let mailbox = kernel.mailbox();
	let path = temp.path().join("approval.oms");
	let mut session = fresh_session(&path);
	let host = tokio::spawn(async move {
		while let Ok(event) = events.recv_async().await {
			if let KernelEvent::ApprovalRequested(ticket) = event {
				assert_eq!(ticket.reasons.len(), 2, "one ticket merges both authorities");
				assert_eq!(ticket.reasons[0].title, "Extension approval");
				assert_eq!(ticket.reasons[1].title, "Native capability approval");
				assert_eq!(ticket.reasons[0].evidence, [
					sf!("host_generation=7"),
					sf!("session_generation=3")
				],);
				mailbox
					.send(Up::approve_local(ticket.ticket_id, ApprovalDecision {
						approved:   true,
						scope:      ApprovalScope::Once,
						source:     ApprovalSource::User,
						decided_by: Some(sf!("tester")),
						reason:     None,
						audited:    true,
					}))
					.expect("approve merged ticket");
				break;
			}
		}
	});
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	host.await.expect("approval host");
	responder.await.expect("hook responder");
	assert_eq!(*seen.lock(), Some(serde_json::json!({"value": 1})));
	let live = session.dom().snapshot();
	drop(session);
	let replayed =
		omp_session::Session::open(&path, omp_session::ComponentRegistry::default()).expect("replay");
	assert_eq!(replayed.dom().snapshot(), live);
}

/// What the dispatcher handed native admission for one call: its name,
/// envelope, confinement and fetch locators.
type Admitted = (String, Effects, Confinement, Vec<Str>);

/// Records what the dispatcher hands native admission, and allows.
struct RecordingAdmission(Arc<Mutex<Vec<Admitted>>>);

impl ToolAdmission for RecordingAdmission {
	fn admit(
		&self,
		name: &str,
		effects: &Effects,
		confinement: Confinement,
		_args: &serde_json::value::RawValue,
		fetch_locators: &[Str],
	) -> ToolAdmissionVerdict {
		self
			.0
			.lock()
			.push((name.to_owned(), effects.clone(), confinement, fetch_locators.to_vec()));
		ToolAdmissionVerdict::Allow
	}
}

/// An RPC host tool that answers every call.
struct AnsweringHost;

impl HostToolExecutor for AnsweringHost {
	fn execute(
		&self,
		_invocation: HostToolInvocation,
		_updates: HostToolUpdateSink,
		_cancellation: CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<HostToolResult, Str>> + Send + 'static>> {
		Box::pin(std::future::ready(Ok(HostToolResult {
			result:   serde_json::json!({"ok": true}),
			is_error: false,
		})))
	}
}

/// Native admission reads the called revision's live spec: its effects and
/// the confinement its host asserted. An RPC host tool has no native live
/// spec: it is admitted as `Host` with the envelope its host declared, and
/// one that declared none gets the unknown ceiling, never an empty envelope.
#[tokio::test]
async fn native_admission_receives_the_live_spec_confinement() {
	let network = Effects {
		exec: Some(ExecEffects { commands: Arc::from([]), network: true }),
		..Effects::empty()
	};
	let read = Effects {
		documents: Some(omp_tool::DocEffects { read: true, write_globs: Arc::from([]) }),
		..Effects::empty()
	};
	let mut registry = Registry::new();
	registry
		.register(
			CaptureTool {
				spec: ToolSpec {
					name: sf!("capture"),
					rev: Rev { family: sf!("test"), n: 1 },
					description: sf!("capture arguments inside the sandbox"),
					schema: Bytes::from_static(
						br#"{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}"#,
					),
					constraint: Constraint::None,
					effects: network.clone(),
					confinement: Confinement::ExecSandbox,
					projection_code: [7; 32],
				},
				seen: Arc::new(Mutex::new(None)),
			},
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
		)
		.expect("capture tool registers");
	registry
		.replace_host_tools(
			sf!("rpc/client"),
			1,
			vec![
				HostToolSpec {
					name:        sf!("fetch_ticket"),
					description: sf!("Fetch a ticket"),
					parameters:  serde_json::json!({"type": "object"}),
					rev:         None,
					effects:     None,
				},
				HostToolSpec {
					name:        sf!("list_tickets"),
					description: sf!("List tickets"),
					parameters:  serde_json::json!({"type": "object"}),
					rev:         None,
					effects:     Some(read.clone()),
				},
			],
			Arc::new(AnsweringHost),
		)
		.expect("host roster installs");
	let admitted = Arc::new(Mutex::new(Vec::new()));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("capture-1", "capture", serde_json::json!({"value": 1})),
		tool_script("ticket-1", "fetch_ticket", serde_json::json!({})),
		tool_script("tickets-1", "list_tickets", serde_json::json!({})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(registry),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_tool_admission(Arc::new(RecordingAdmission(Arc::clone(&admitted))));
	let mut session = fresh_session(&temp.path().join("confinement.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	assert_eq!(*admitted.lock(), [
		(String::from("capture"), network, Confinement::ExecSandbox, Vec::new()),
		(String::from("fetch_ticket"), Effects::unknown(), Confinement::Host, Vec::new()),
		(String::from("list_tickets"), read, Confinement::Host, Vec::new()),
	]);
}

/// Arguments of [`ScopedTool`].
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ScopedParams {
	value: i64,
}

/// A tool judging each call by `value`: `0` only reads documents, `1` keeps
/// the declared maximum, `3` reads and fetches `https://docs.rs/serde`, and
/// anything else claims more than that maximum.
struct ScopedTool {
	spec: ToolSpec,
	runs: Arc<Mutex<Vec<i64>>>,
}

impl Tool for ScopedTool {
	type Fault = Value;
	type Params = ScopedParams;
	type Payload = Value;
	type Update = Value;

	const ARGUMENT_SCOPED_EFFECTS: bool = true;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn invocation_effects(&self, params: &ScopedParams) -> Option<Effects> {
		match params.value {
			0 => Some(read_documents()),
			1 => None,
			3 => Some(Effects {
				fetch: Some(omp_tool::FetchEffects { credentials: false }),
				..read_documents()
			}),
			_ => Some(Effects { subagents: 1, ..Effects::empty() }),
		}
	}

	/// Asked only for a call whose envelope fetches: the maximum's fetch names
	/// a host no call of `3` reaches.
	fn fetch_locators(&self, params: &ScopedParams) -> Vec<Str> {
		match params.value {
			3 => vec![sf!("https://docs.rs/serde")],
			_ => vec![sf!("https://maximum.example/")],
		}
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let args = params.whole::<Value>().await.expect("scoped args decode");
			self.runs.lock().push(args["value"].as_i64().expect("an integer value"));
			yield Ev::Done(ToolTerminal::Done { result: Ok(args), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Value, &Value>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Json {
			json: Bytes::from(serde_json::to_vec(view.unwrap_or_else(|fault| fault)).expect("JSON")),
		}]
	}
}

fn read_documents() -> Effects {
	Effects {
		documents: Some(omp_tool::DocEffects { read: true, write_globs: Arc::from([]) }),
		..Effects::empty()
	}
}

/// Native admission judges each call by its arguments: a call the tool
/// narrows is admitted on that envelope, one it does not keeps the declared
/// maximum, and one judged beyond the maximum is refused before admission is
/// asked and never runs. A call whose envelope fetches hands admission the
/// URLs it fetches, and only such a call asks the tool for them.
#[tokio::test]
async fn native_admission_judges_each_call_by_its_arguments() {
	let maximum = Effects {
		exec: Some(ExecEffects { commands: Arc::from([]), network: true }),
		fetch: Some(omp_tool::FetchEffects { credentials: false }),
		..read_documents()
	};
	let runs = Arc::new(Mutex::new(Vec::new()));
	let mut registry = Registry::new();
	registry
		.register(
			ScopedTool {
				spec: ToolSpec {
					name: sf!("scoped"),
					rev: Rev { family: sf!("test"), n: 1 },
					description: sf!("judge each call by its value"),
					schema: Bytes::from_static(
						br#"{"type":"object","properties":{"value":{"type":"integer"}},"required":["value"],"additionalProperties":false}"#,
					),
					constraint: Constraint::None,
					effects: maximum.clone(),
					confinement: Confinement::Host,
					projection_code: [9; 32],
				},
				runs: Arc::clone(&runs),
			},
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
		)
		.expect("scoped tool registers");
	let admitted = Arc::new(Mutex::new(Vec::new()));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("narrow", "scoped", serde_json::json!({"value": 0})),
		tool_script("maximum", "scoped", serde_json::json!({"value": 1})),
		tool_script("widened", "scoped", serde_json::json!({"value": 2})),
		tool_script("fetching", "scoped", serde_json::json!({"value": 3})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(registry),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_tool_admission(Arc::new(RecordingAdmission(Arc::clone(&admitted))));
	let mut session = fresh_session(&temp.path().join("scoped.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("scope"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	let fetching =
		Effects { fetch: Some(omp_tool::FetchEffects { credentials: false }), ..read_documents() };
	assert_eq!(*admitted.lock(), [
		(String::from("scoped"), read_documents(), Confinement::Host, Vec::new()),
		(String::from("scoped"), maximum, Confinement::Host, vec![sf!("https://maximum.example/")]),
		(String::from("scoped"), fetching, Confinement::Host, vec![sf!("https://docs.rs/serde")]),
	]);
	let mut ran = runs.lock().clone();
	ran.sort_unstable();
	assert_eq!(ran, [0, 1, 3], "the call judged beyond the maximum never ran");
}

/// What one [`PinningTool`] call's executor found pinned, beside what the live
/// state named by the time it ran.
type PinnedRun = (Option<ResolutionPin>, Str);

/// A tool whose judgment reads live state, as `read` reads which MCP server
/// advertises a resource: judging a call pins the target `live` names then.
/// Its executor records what it finds pinned beside what `live` names by the
/// time it runs.
struct PinningTool {
	spec: ToolSpec,
	live: Arc<Mutex<Str>>,
	ran:  Arc<Mutex<Vec<PinnedRun>>>,
}

impl Tool for PinningTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	const ARGUMENT_SCOPED_EFFECTS: bool = true;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn invocation_effects(&self, _params: &Value) -> Option<Effects> {
		InvocationPins::pin("probe", "target", || ResolutionPin {
			target: Some(self.live.lock().clone()),
			fetch:  None,
		});
		Some(read_documents())
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let args = params.whole::<Value>().await.expect("pinning args decode");
			let pinned = InvocationPins::pinned("probe", "target");
			self.ran.lock().push((pinned, self.live.lock().clone()));
			yield Ev::Done(ToolTerminal::Done { result: Ok(args), useless: false });
		}
	}

	fn prompt(&self, view: Result<&Value, &Value>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Json {
			json: Bytes::from(serde_json::to_vec(view.unwrap_or_else(|fault| fault)).expect("JSON")),
		}]
	}
}

/// Records what each call's judgment pinned as admission sees it, then
/// allows the call once the live state has moved on, as it may while the
/// user is asked.
struct MovingAdmission {
	live: Arc<Mutex<Str>>,
	seen: Arc<Mutex<Vec<Option<ResolutionPin>>>>,
}

impl ToolAdmission for MovingAdmission {
	fn admit(
		&self,
		_name: &str,
		_effects: &Effects,
		_confinement: Confinement,
		_args: &serde_json::value::RawValue,
		_fetch_locators: &[Str],
	) -> ToolAdmissionVerdict {
		self
			.seen
			.lock()
			.push(InvocationPins::pinned("probe", "target"));
		*self.live.lock() = sf!("moved");
		ToolAdmissionVerdict::Allow
	}
}

/// A native call is judged, admitted and run inside one set of pins: what
/// its judgment resolved from live state is what admission names and what
/// its executor reaches, though that state moved before it ran. Each call
/// judges afresh.
#[tokio::test]
async fn a_native_call_runs_inside_the_pins_its_judgment_fixed() {
	let live = Arc::new(Mutex::new(sf!("judged")));
	let ran = Arc::new(Mutex::new(Vec::new()));
	let seen = Arc::new(Mutex::new(Vec::new()));
	let mut registry = Registry::new();
	registry
		.register(
			PinningTool {
				spec: ToolSpec {
					name:            sf!("pinning"),
					rev:             Rev { family: sf!("test"), n: 1 },
					description:     sf!("judge each call by live state"),
					schema:          Bytes::from_static(br#"{"type":"object"}"#),
					constraint:      Constraint::None,
					effects:         read_documents(),
					confinement:     Confinement::Host,
					projection_code: [11; 32],
				},
				live: Arc::clone(&live),
				ran:  Arc::clone(&ran),
			},
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
		)
		.expect("pinning tool registers");
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("first", "pinning", serde_json::json!({})),
		tool_script("second", "pinning", serde_json::json!({})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		Arc::new(registry),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_tool_admission(Arc::new(MovingAdmission {
		live: Arc::clone(&live),
		seen: Arc::clone(&seen),
	}));
	let mut session = fresh_session(&temp.path().join("pinning.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("pin"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	let judged =
		|target: &'static str| ResolutionPin { target: Some(Str::new_static(target)), fetch: None };
	assert_eq!(*seen.lock(), [Some(judged("judged")), Some(judged("moved"))]);
	assert_eq!(*ran.lock(), [
		(Some(judged("judged")), sf!("moved")),
		(Some(judged("moved")), sf!("moved")),
	]);
}

#[tokio::test]
async fn lifecycle_approval_timeout_denies_before_execution_and_replays() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [subscription(1, HookEventId::HookEventToolCall, HookPhase::Approval)])
		.expect("approval subscription");
	let responder = {
		let gate = Arc::clone(&gate);
		tokio::spawn(async move {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("tool-call approval phase");
			let mut spec = approval_spec("Extension approval", "extension policy");
			spec.timeout_ms = 1;
			gate
				.answer(dispatch.dispatch_id, vec![(1, GateDecision::RequireApproval(spec))])
				.expect("approval requirement");
		})
	};
	let seen = Arc::new(Mutex::new(None));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("capture-timeout", "capture", serde_json::json!({"value": 1})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		capture_registry(Arc::clone(&seen)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate);
	let events = kernel.subscribe();
	let path = temp.path().join("approval-timeout.oms");
	let mut session = fresh_session(&path);
	let ticket_id = Arc::new(Mutex::new(None));
	let capture_id = Arc::clone(&ticket_id);
	let host = tokio::spawn(async move {
		while let Ok(event) = events.recv_async().await {
			if let KernelEvent::ApprovalRequested(ticket) = event {
				*capture_id.lock() = Some(ticket.ticket_id);
				break;
			}
		}
	});
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	host.await.expect("approval host");
	responder.await.expect("hook responder");
	assert!(seen.lock().is_none(), "timed-out approval never executes");
	let ticket_id = ticket_id.lock().clone().expect("ticket id");
	let ticket = ApprovalBook::new()
		.ticket(&session, ticket_id.as_str())
		.expect("durable ticket");
	assert_eq!(ticket.state, TicketState::Decided);
	assert_eq!(
		ticket.decision.as_ref().map(|decision| decision.source),
		Some(ApprovalSource::Timeout),
	);
	let live = session.dom().snapshot();
	drop(session);
	let replayed =
		omp_session::Session::open(&path, omp_session::ComponentRegistry::default()).expect("replay");
	assert_eq!(replayed.dom().snapshot(), live);
}

#[tokio::test]
async fn cancellation_withdraws_lifecycle_approval_and_never_starts_the_tool() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [subscription(1, HookEventId::HookEventToolCall, HookPhase::Approval)])
		.expect("approval subscription");
	let responder = {
		let gate = Arc::clone(&gate);
		tokio::spawn(async move {
			let dispatch = receiver
				.recv_async()
				.await
				.expect("tool-call approval phase");
			let mut spec = approval_spec("Extension approval", "extension policy");
			spec.timeout_ms = 0;
			gate
				.answer(dispatch.dispatch_id, vec![(1, GateDecision::RequireApproval(spec))])
				.expect("approval requirement");
		})
	};
	let seen = Arc::new(Mutex::new(None));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([tool_script(
		"capture-cancel",
		"capture",
		serde_json::json!({"value": 1}),
	)]);
	let mut kernel = Kernel::new(
		inference,
		capture_registry(Arc::clone(&seen)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate);
	let events = kernel.subscribe();
	let cancellation = tokio_util::sync::CancellationToken::new();
	let cancel = cancellation.clone();
	let ticket_id = Arc::new(Mutex::new(None));
	let capture_id = Arc::clone(&ticket_id);
	let host = tokio::spawn(async move {
		while let Ok(event) = events.recv_async().await {
			if let KernelEvent::ApprovalRequested(ticket) = event {
				*capture_id.lock() = Some(ticket.ticket_id);
				cancel.cancel();
				break;
			}
		}
	});
	let mut session = fresh_session(&temp.path().join("approval-cancel.oms"));
	let outcome = kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::new(cancellation, None),
		)
		.await
		.expect("cancelled turn settles");
	host.await.expect("approval host");
	responder.await.expect("hook responder");
	assert_eq!(outcome.stop, TurnStop::Cancelled);
	assert!(seen.lock().is_none(), "cancelled approval never executes");
	let ticket_id = ticket_id.lock().clone().expect("ticket id");
	let ticket = ApprovalBook::new()
		.ticket(&session, ticket_id.as_str())
		.expect("withdrawn ticket remains durable");
	assert_eq!(ticket.state, TicketState::Withdrawn);
}

#[tokio::test]
async fn lifecycle_tool_call_denial_skips_executor_and_journals_abort() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [subscription(1, HookEventId::HookEventToolCall, HookPhase::Precheck)])
		.expect("subscription");
	let responder = {
		let gate = Arc::clone(&gate);
		tokio::spawn(async move {
			let dispatch = receiver.recv_async().await.expect("tool call gate");
			gate
				.answer(dispatch.dispatch_id, vec![(1, GateDecision::Deny(sf!("blocked")))])
				.expect("deny");
		})
	};
	let seen = Arc::new(Mutex::new(None));
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new([
		tool_script("capture-1", "capture", serde_json::json!({"value": 1})),
		text_script("done"),
	]);
	let mut kernel = Kernel::new(
		inference,
		capture_registry(Arc::clone(&seen)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate);
	let path = temp.path().join("deny.oms");
	let mut session = fresh_session(&path);
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("capture"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn");
	assert!(seen.lock().is_none(), "denied tool never executes");
	let entries = journal_entries(&path);
	let call = entries
		.iter()
		.find(|entry| entry.kind.name.as_str() == kind::TOOL_CALL)
		.expect("call");
	assert!(
		entries
			.iter()
			.any(|entry| entry.kind.name.as_str() == kind::TOOL_RESULT && entry.by == Some(call.id))
	);
	responder.await.expect("responder");
}

/// An in-process host that never answers `session_shutdown`.
struct HangingHost {
	asked: Arc<Mutex<Option<Value>>>,
}

impl omp_agent::NativeHookHost for HangingHost {
	fn decide<'a>(
		&'a self,
		_: HookEventId,
		payload: &'a Value,
	) -> omp_agent::BoxFut<'a, omp_agent::NativeReply> {
		*self.asked.lock() = Some(payload.clone());
		Box::pin(std::future::pending())
	}
}

#[tokio::test]
async fn a_session_end_waits_on_native_hosts_only_within_the_budget_then_notifies_observers() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate
		.subscribe("test", [subscription(
			1,
			HookEventId::HookEventSessionShutdown,
			HookPhase::Observe,
		)])
		.expect("observer subscription");
	let asked = Arc::new(Mutex::new(None));
	gate.attach_native(Arc::new(HangingHost { asked: Arc::clone(&asked) }), &[
		HookEventId::HookEventSessionShutdown,
	]);
	let hooks = LifecycleHooks::new(Arc::clone(&gate));
	let directory = tempfile::tempdir().expect("temporary directory");
	let session = fresh_session(&directory.path().join("ending.oms"));
	let next = fresh_session(&directory.path().join("next.oms"));

	let started = std::time::Instant::now();
	hooks
		.session_shutdown(&omp_agent::SessionShutdown::switching(
			&session,
			&next,
			omp_agent::SwitchReason::New,
		))
		.await;
	let waited = started.elapsed();
	assert!(
		waited >= omp_agent::SESSION_SHUTDOWN_BUDGET
			&& waited < omp_agent::SESSION_SHUTDOWN_BUDGET + Duration::from_secs(1),
		"a host that never answers holds the end exactly one budget: {waited:?}"
	);
	let native = asked.lock().clone().expect("the native host was asked");
	let dispatch = receiver.try_recv().expect("the observation still goes out");
	assert_eq!(dispatch.event, HookEventId::HookEventSessionShutdown);
	let observed: Value = serde_json::from_slice(&dispatch.payload).expect("payload");
	assert_eq!(observed, native, "observers and native hosts read one payload");
	assert_eq!(observed["session_id"], "ending.oms");
	assert_eq!(observed["reason"], "switch");
	assert_eq!(observed["budget"], "1500ms");
	assert_eq!(observed["target_session"], "next.oms");
	assert_eq!(observed["switch_reason"], "new");
	assert!(
		observed["target_transcript_path"]
			.as_str()
			.is_some_and(|path| path.ends_with("next.oms"))
	);
	assert_eq!(
		"1500ms"
			.parse::<omp_core::time::Duration>()
			.expect("budget text")
			.to_std()
			.expect("std duration"),
		omp_agent::SESSION_SHUTDOWN_BUDGET,
		"the payload's budget is the budget"
	);
}

/// Records every `session_start` it is asked about; denies when told to.
struct StartHost {
	asked: Arc<Mutex<Vec<Value>>>,
	deny:  bool,
}

impl omp_agent::NativeHookHost for StartHost {
	fn decide<'a>(
		&'a self,
		event: HookEventId,
		payload: &'a Value,
	) -> omp_agent::BoxFut<'a, omp_agent::NativeReply> {
		assert_eq!(event, HookEventId::HookEventSessionStart);
		self.asked.lock().push(payload.clone());
		let verdict = if self.deny {
			omp_agent::NativeVerdict::Deny(sf!("not this one"))
		} else {
			omp_agent::NativeVerdict::Defer
		};
		Box::pin(std::future::ready(omp_agent::NativeReply { verdict, context: Vec::new() }))
	}
}

#[tokio::test]
async fn session_start_reports_a_launch_and_a_committed_switch_alike() {
	let (gate, receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	let asked = Arc::new(Mutex::new(Vec::new()));
	gate.attach_native(Arc::new(StartHost { asked: Arc::clone(&asked), deny: false }), &[
		HookEventId::HookEventSessionStart,
	]);
	let hooks = LifecycleHooks::new(Arc::clone(&gate));
	let directory = tempfile::tempdir().expect("temporary directory");
	let root = directory.path().join("project");
	let first = fresh_session(&directory.path().join("first.oms"));
	let next = fresh_session(&directory.path().join("next.oms"));

	hooks
		.session_start(&omp_agent::SessionStart::launch(&first, &root))
		.await
		.expect("launch starts");
	hooks
		.session_start(&omp_agent::SessionStart::switched(
			&first,
			&next,
			omp_agent::SwitchReason::New,
			&root,
		))
		.await
		.expect("the switched-to session starts");
	let asked = std::mem::take(&mut *asked.lock());
	assert_eq!(asked.len(), 2);
	let launch = &asked[0];
	assert_eq!(launch["session_id"], "first.oms");
	assert_eq!(launch["root"], root.to_str().unwrap());
	assert_eq!(launch["cwd"], root.to_str().unwrap());
	assert_eq!(launch["dirs"], serde_json::json!([]));
	assert_eq!(launch["resumed"], false);
	assert_eq!(launch["forked_from"], Value::Null);
	assert_eq!(launch["trust"], "trusted");
	assert_eq!(launch["prompt_rev"], "1");
	assert!(launch["head_event"].is_string() || launch["head_event"].is_number());
	assert_eq!(launch["previous_session"], Value::Null);
	assert_eq!(launch["switch_reason"], Value::Null);
	let switched = &asked[1];
	assert_eq!(switched["session_id"], "next.oms");
	assert_eq!(switched["previous_session"], "first.oms");
	assert_eq!(switched["switch_reason"], "new");
	assert!(receiver.try_recv().is_err(), "no extension subscribed");
}

#[tokio::test]
async fn a_refused_session_start_is_a_typed_denial() {
	let (gate, _receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	gate.attach_native(Arc::new(StartHost { asked: Arc::default(), deny: true }), &[
		HookEventId::HookEventSessionStart,
	]);
	let hooks = LifecycleHooks::new(gate);
	let directory = tempfile::tempdir().expect("temporary directory");
	let session = fresh_session(&directory.path().join("refused.oms"));
	let error = hooks
		.session_start(&omp_agent::SessionStart::launch(&session, directory.path()))
		.await
		.expect_err("the host refuses");
	assert!(matches!(
		error,
		omp_agent::LifecycleHookError::Denied { event: HookEventId::HookEventSessionStart, ref reason }
			if reason.as_str() == "not this one"
	));
	// Nothing subscribed: the start is free.
	let (bare, _receiver) = HookGate::channel();
	LifecycleHooks::new(Arc::new(bare))
		.session_start(&omp_agent::SessionStart::launch(&session, directory.path()))
		.await
		.expect("an unsubscribed start never fails");
}

/// Always answers `continue` at the settle seam and records each payload.
struct SettleHost {
	asked: Arc<Mutex<Vec<Value>>>,
}

impl omp_agent::NativeHookHost for SettleHost {
	fn decide<'a>(
		&'a self,
		event: HookEventId,
		payload: &'a Value,
	) -> omp_agent::BoxFut<'a, omp_agent::NativeReply> {
		assert_eq!(event, HookEventId::HookEventAgentSettled);
		self.asked.lock().push(payload.clone());
		Box::pin(std::future::ready(omp_agent::NativeReply {
			verdict: omp_agent::NativeVerdict::Continue,
			context: vec![omp_agent::hooks::HookContext::new(sf!("test"), sf!("keep going"))],
		}))
	}
}

/// Runs `submissions` prompts against an always-continuing settle host.
async fn run_settle_submissions(submissions: usize) -> Vec<Value> {
	let (gate, _receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	let asked = Arc::new(Mutex::new(Vec::new()));
	gate.attach_native(Arc::new(SettleHost { asked: Arc::clone(&asked) }), &[
		HookEventId::HookEventAgentSettled,
	]);
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new((0..32).map(|_| text_script("done")));
	let mut kernel = Kernel::new(
		inference,
		Arc::new(Registry::new()),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate);
	let mut session = fresh_session(&temp.path().join("settle.oms"));
	for _ in 0..submissions {
		kernel
			.run_turn(
				&mut session,
				TurnInput { text: sf!("go"), attachments: Vec::new() },
				RunControl::default(),
			)
			.await
			.expect("turn settles");
	}
	let asked = std::mem::take(&mut *asked.lock());
	asked
}

#[tokio::test]
async fn settle_cap_stops_continuation_after_eight() {
	// Eight accepted Continues, then one more ask that the kernel refuses.
	assert_eq!(run_settle_submissions(1).await.len(), 9);
}

#[tokio::test]
async fn continuations_used_counts_up_from_zero() {
	let used: Vec<u64> = run_settle_submissions(1)
		.await
		.iter()
		.map(|payload| payload["continuations_used"].as_u64().expect("count"))
		.collect();
	assert_eq!(used, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
}

#[tokio::test]
async fn a_new_submission_starts_the_count_again() {
	let asked = run_settle_submissions(2).await;
	assert_eq!(asked.len(), 18);
	assert_eq!(asked[9]["continuations_used"], 0);
}

/// Returns scripted Continues then Settle; records nothing.
struct FieldedSettleHost {
	replies: Mutex<Vec<omp_agent::NativeReply>>,
}

impl omp_agent::NativeHookHost for FieldedSettleHost {
	fn decide<'a>(
		&'a self,
		event: HookEventId,
		_payload: &'a Value,
	) -> omp_agent::BoxFut<'a, omp_agent::NativeReply> {
		assert_eq!(event, HookEventId::HookEventAgentSettled);
		let reply = self.replies.lock().pop().unwrap_or_default();
		Box::pin(std::future::ready(reply))
	}
}

#[tokio::test]
async fn continue_visible_role_and_collapse_prior_are_honored() {
	use omp_agent::hooks::{HookContext, HookContextRole};
	use omp_dom::{PropKey, Tag, Value};
	use omp_session::custom_message::{CONTINUATION_PROP, DISPLAY_PROP};

	let (gate, _receiver) = HookGate::channel();
	let gate = Arc::new(gate);
	let replies = Mutex::new(
		[
			omp_agent::NativeReply {
				verdict: omp_agent::NativeVerdict::Continue,
				context: vec![HookContext {
					source:         sf!("goal"),
					body:           sf!("first"),
					visible:        true,
					role:           HookContextRole::System,
					collapse_prior: true,
				}],
			},
			omp_agent::NativeReply {
				verdict: omp_agent::NativeVerdict::Continue,
				context: vec![HookContext {
					source:         sf!("goal"),
					body:           sf!("second"),
					visible:        false,
					role:           HookContextRole::User,
					collapse_prior: true,
				}],
			},
			omp_agent::NativeReply::default(),
		]
		.into_iter()
		.rev()
		.collect(),
	);
	gate.attach_native(Arc::new(FieldedSettleHost { replies }), &[
		HookEventId::HookEventAgentSettled,
	]);
	let temp = tempfile::tempdir().expect("tempdir");
	let (inference, _) = ScriptedInference::new((0..8).map(|_| text_script("done")));
	let mut kernel = Kernel::new(
		inference,
		Arc::new(Registry::new()),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	)
	.with_hook_gate(gate);
	let mut session = fresh_session(&temp.path().join("fields.oms"));
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: sf!("go"), attachments: Vec::new() },
			RunControl::default(),
		)
		.await
		.expect("turn settles");

	let display_key = PropKey::Custom(Str::new_static(DISPLAY_PROP));
	let continuation_key = PropKey::Custom(Str::new_static(CONTINUATION_PROP));
	let mut continuation_nodes = Vec::new();
	for turn in session.dom().children(session.dom().body()) {
		for child in session.dom().children(*turn) {
			let Some(node) = session.dom().get(*child) else {
				continue;
			};
			if matches!(node.prop(&continuation_key), Some(Value::Bool(true))) {
				continuation_nodes.push((*child, node.tag.clone(), node.prop(&display_key).cloned()));
			}
		}
	}
	assert!(
		continuation_nodes.len() >= 2,
		"both Continuations were journaled: {continuation_nodes:?}"
	);
	let first = continuation_nodes
		.iter()
		.find(|(_, tag, _)| matches!(tag, Tag::Known(omp_dom::KnownTag::Developer)))
		.expect("system-role continuation");
	assert_eq!(first.2, Some(Value::Bool(false)), "collapse_prior hid the older system item");
	let second = continuation_nodes
		.iter()
		.find(|(_, tag, _)| matches!(tag, Tag::Known(omp_dom::KnownTag::User)))
		.expect("user-role continuation");
	assert_eq!(second.2, Some(Value::Bool(false)), "visible=false on the user continuation");
}
