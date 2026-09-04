//! The kernel-bound approval route: a policy prompt filed while a tool runs
//! is journaled under `<queues><prompts>`, surfaced as
//! `KernelEvent::ApprovalRequested`, and answered by `Up::Approve` — the
//! decision reaches the waiting policy only after the journal recorded it.

use std::{sync::Arc, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_agent::{
	ApprovalDecision, ApprovalRoute, ApprovalScope, ApprovalSource, ApprovalSpec, DispatchPolicy,
	Kernel, KernelEvent, RunControl, StaticPrompt, TicketState, TurnInput, Up,
};
use omp_core::{Str, sf};
use omp_journal::blob::BlobStore;
use omp_session::Session;
use omp_tool::{
	Claims, Constraint, Effects, Ev, IncomingParams, Part, Precedence, Presentation, PromptCaps,
	Registry, Rev, Tool, ToolSpec, ToolTerminal,
};
use parking_lot::Mutex;
use serde_json::Value;

mod support;

use support::{ScriptedInference, fresh_session, text_script, tool_script};

/// A tool that asks the session's approval authority before acting, exactly
/// as the environment executor does for an admission query.
struct GatedTool {
	spec:  ToolSpec,
	route: Arc<Mutex<Option<ApprovalRoute>>>,
}

fn spec(subject: &str) -> ApprovalSpec {
	ApprovalSpec {
		title:         sf!("Run bash"),
		body:          sf!("$ {subject}"),
		subject:       Str::new(subject),
		kind:          sf!("exec"),
		scopes:        vec![sf!("once"), sf!("session")],
		default:       Some(false),
		route:         sf!("user"),
		approver:      None,
		timeout_ms:    0,
		unreachable:   sf!("deny"),
		require_human: true,
		pattern:       None,
		evidence:      Vec::new(),
	}
}

impl Tool for GatedTool {
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
			let args = params.whole::<Value>().await.expect("args");
			let command = args["command"].as_str().unwrap_or("").to_owned();
			let route = self.route.lock().clone().expect("route bound before the turn");
			let ticket = route.request(Some(sf!("gated-1")), vec![spec(&command)], 1).await;
			let decision = ticket.decision.expect("route returns a decided ticket");
			if decision.approved {
				yield Ev::Done(ToolTerminal::Done {
					result: Ok(serde_json::json!({"ran": command, "scope": decision.scope.as_str()})),
					useless: false,
				});
			} else {
				yield Ev::Done(ToolTerminal::Done {
					result: Err(serde_json::json!({"denied": decision.reason})),
					useless: false,
				});
			}
		}
	}

	fn prompt(&self, view: Result<&Value, &Value>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Json {
			json: Bytes::from(serde_json::to_vec(view.unwrap_or_else(|fault| fault)).expect("JSON")),
		}]
	}
}

fn gated_registry(route: Arc<Mutex<Option<ApprovalRoute>>>) -> Arc<Registry> {
	let mut registry = Registry::new();
	registry
		.register(
			GatedTool {
				spec: ToolSpec {
					name: sf!("gated"),
					rev: Rev { family: sf!("test"), n: 1 },
					description: sf!("asks before acting"),
					schema: Bytes::from_static(
						br#"{"type":"object","properties":{"command":{"type":"string"}},"required":["command"],"additionalProperties":false}"#,
					),
					constraint: Constraint::None,
					effects: Effects::empty(),
					projection_code: [9; 32],
				},
				route,
			},
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
		)
		.expect("gated tool registers");
	Arc::new(registry)
}

fn decision(approved: bool, scope: ApprovalScope) -> ApprovalDecision {
	ApprovalDecision {
		approved,
		scope,
		source: ApprovalSource::User,
		decided_by: None,
		reason: (!approved).then(|| sf!("denied by user")),
		audited: false,
	}
}

fn prompts(session: &Session) -> Vec<omp_agent::ApprovalTicket> {
	let dom = session.dom();
	let prompts = omp_session::components::prompts::prompts_handle(dom).expect("prompts");
	dom.children(prompts)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter_map(|node| {
			node
				.prop(&omp_dom::PropKey::Custom(Str::new_static("ticket")))
				.and_then(omp_dom::Value::as_str)
		})
		.map(|encoded| serde_json::from_str(encoded).expect("ticket JSON"))
		.collect()
}

/// Every projected tool-result part (text or JSON) as a string.
fn results(session: &Session) -> Vec<String> {
	use omp_proto::thread::v1::{item, part};
	omp_session::project_thread(session.dom())
		.into_iter()
		.filter_map(|item| match item.kind? {
			item::Kind::ToolResult(result) => Some(result.parts),
			_ => None,
		})
		.flatten()
		.filter_map(|part| match part.kind? {
			part::Kind::Text(text) => Some(text),
			part::Kind::Blob(blob) => Some(String::from_utf8_lossy(&blob.inline).into_owned()),
			_ => None,
		})
		.collect()
}

struct Harness {
	kernel:  Kernel<ScriptedInference>,
	session: Session,
	events:  flume::Receiver<KernelEvent>,
	_temp:   tempfile::TempDir,
}

fn harness(scripts: Vec<Vec<omp_ai::ChatEvent>>) -> Harness {
	let temp = tempfile::tempdir().expect("tempdir");
	let route = Arc::new(Mutex::new(None));
	let (inference, _) = ScriptedInference::new(scripts);
	let mut kernel = Kernel::new(
		inference,
		gated_registry(Arc::clone(&route)),
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blobs")),
		StaticPrompt(sf!("system")),
	);
	*route.lock() = Some(kernel.approval_route());
	let events = kernel.subscribe();
	let session = fresh_session(&temp.path().join("approvals.oms"));
	Harness { kernel, session, events, _temp: temp }
}

/// Runs one turn while `answer` decides every filed prompt.
async fn run(
	harness: &mut Harness,
	answer: impl Fn(&omp_agent::ApprovalTicket) -> Option<ApprovalDecision> + Send + 'static,
) -> Vec<omp_agent::ApprovalTicket> {
	let mailbox = harness.kernel.mailbox();
	let events = harness.events.clone();
	let seen = Arc::new(Mutex::new(Vec::new()));
	let host = {
		let seen = Arc::clone(&seen);
		tokio::spawn(async move {
			while let Ok(event) = events.recv_async().await {
				if let KernelEvent::ApprovalRequested(ticket) = event {
					seen.lock().push(ticket.clone());
					if let Some(decision) = answer(&ticket) {
						let _ = mailbox.send(Up::Approve { id: ticket.ticket_id.clone(), decision });
					}
				}
			}
		})
	};
	tokio::time::timeout(
		Duration::from_secs(10),
		harness.kernel.run_turn(
			&mut harness.session,
			TurnInput { text: sf!("go"), attachments: Vec::new() },
			RunControl::default(),
		),
	)
	.await
	.expect("turn settles")
	.expect("turn");
	host.abort();
	let seen = seen.lock().clone();
	seen
}

#[tokio::test]
async fn allow_journals_the_decision_and_the_tool_runs() {
	let mut harness = harness(vec![
		tool_script("gated-1", "gated", serde_json::json!({"command": "make build"})),
		text_script("done"),
	]);
	let seen = run(&mut harness, |_| Some(decision(true, ApprovalScope::Once))).await;
	assert_eq!(seen.len(), 1);
	assert_eq!(seen[0].invocation_id.as_deref(), Some("gated-1"));
	assert_eq!(seen[0].reasons[0].subject.as_str(), "make build");
	let journaled = prompts(&harness.session);
	assert_eq!(journaled.len(), 1);
	assert_eq!(journaled[0].ticket_id, seen[0].ticket_id);
	assert_eq!(journaled[0].state, TicketState::Decided);
	assert!(
		journaled[0]
			.decision
			.as_ref()
			.is_some_and(|decision| decision.approved)
	);
	let outputs = results(&harness.session);
	assert!(
		outputs
			.iter()
			.any(|text| text.contains("\"ran\":\"make build\"")),
		"{outputs:?}"
	);
	assert!(harness.kernel.waiting_approvals().is_empty());
}

#[tokio::test]
async fn deny_journals_the_denial_and_the_tool_reports_it() {
	let mut harness = harness(vec![
		tool_script("gated-1", "gated", serde_json::json!({"command": "rm -rf /"})),
		text_script("done"),
	]);
	let seen = run(&mut harness, |_| Some(decision(false, ApprovalScope::Once))).await;
	assert_eq!(seen.len(), 1);
	let journaled = prompts(&harness.session);
	assert_eq!(journaled[0].state, TicketState::Decided);
	assert!(
		journaled[0]
			.decision
			.as_ref()
			.is_some_and(|decision| !decision.approved)
	);
	let outputs = results(&harness.session);
	assert!(outputs.iter().any(|text| text.contains("denied by user")), "{outputs:?}");
}

#[tokio::test]
async fn session_grant_answers_a_repeated_subject_from_the_tree() {
	let mut harness = harness(vec![
		tool_script("gated-1", "gated", serde_json::json!({"command": "cargo test"})),
		text_script("first"),
		tool_script("gated-2", "gated", serde_json::json!({"command": "cargo test"})),
		text_script("second"),
	]);
	let seen = run(&mut harness, |_| Some(decision(true, ApprovalScope::Session))).await;
	assert_eq!(seen.len(), 1, "the session grant prompts once");
	let again = run(&mut harness, |_| panic!("a granted subject must not prompt again")).await;
	assert!(again.is_empty());
	let journaled = prompts(&harness.session);
	assert_eq!(journaled.len(), 2, "the auto-decision is journaled too");
	let auto = &journaled[1];
	assert_eq!(auto.state, TicketState::Decided);
	assert_eq!(auto.decision.as_ref().map(|decision| decision.source), Some(ApprovalSource::Config));
	assert!(
		results(&harness.session)
			.iter()
			.filter(|text| text.contains("\"ran\""))
			.count()
			>= 2
	);
}

#[tokio::test]
async fn resumed_session_replays_the_decided_prompt() {
	let mut harness = harness(vec![
		tool_script("gated-1", "gated", serde_json::json!({"command": "ls"})),
		text_script("done"),
	]);
	let _ = run(&mut harness, |_| Some(decision(true, ApprovalScope::Once))).await;
	let path = harness.session.journal_path().to_path_buf();
	let Harness { kernel, session, events, _temp } = harness;
	drop((kernel, session, events));
	let restored = Session::open(&path, omp_session::ComponentRegistry::default()).expect("resume");
	let journaled = prompts(&restored);
	assert_eq!(journaled.len(), 1);
	assert_eq!(journaled[0].state, TicketState::Decided);
}
