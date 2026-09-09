//! Joined production lifecycle-hook integration over one real kernel tool turn.

use std::{sync::Arc, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_agent::{
	ApprovalBook, ApprovalDecision, ApprovalScope, ApprovalSource, ApprovalSpec, DispatchPolicy,
	GateDecision, GateError, GateEvent, GateOutcome, HookDecision, HookGate, HookPatch, HookPhase,
	Kernel, KernelEvent, LifecycleHooks, OnFailure, RunControl, SourceRef, StaticPrompt,
	TicketState, ToolAdmission, ToolAdmissionVerdict, TurnInput, TurnStop, Up, When,
};
use omp_core::sf;
use omp_journal::{blob::BlobStore, kind};
use omp_proto::toolhost::v1::HookEventId;
use omp_tool::{
	Claims, Constraint, Effects, Ev, IncomingParams, Part, Precedence, Presentation, PromptCaps,
	Registry, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use serde_json::Value;

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
		_args: &serde_json::value::RawValue,
	) -> ToolAdmissionVerdict {
		ToolAdmissionVerdict::Prompt(approval_spec(
			"Native capability approval",
			"native admission policy",
		))
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
					.send(Up::Approve {
						id:       ticket.ticket_id,
						decision: ApprovalDecision {
							approved:   true,
							scope:      ApprovalScope::Once,
							source:     ApprovalSource::User,
							decided_by: Some(sf!("tester")),
							reason:     None,
							audited:    true,
						},
					})
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
