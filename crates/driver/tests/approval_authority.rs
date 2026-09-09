//! Production approval composition: a real project environment under
//! `--approval-mode always-ask`, the kernel-bound approval route, and a
//! `write` call whose admission prompt is journaled and answered by the host
//! with `Up::Approve` (deny → skipped, allow → the file lands).

use std::{future::ready, sync::Arc, time::Duration};

use futures::stream;
use omp_agent::{
	ApprovalDecision, ApprovalScope, ApprovalSource, DispatchPolicy, Inference, Kernel, KernelEvent,
	RunControl, StaticPrompt, TicketState, TurnInput, Up,
};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
	RequestId, ResponseMeta, ToolCall, ToolCallId, Usage,
};
use omp_catalog::{ProviderId, RouteId};
use omp_core::Str;
use omp_driver::headless::kernel::{EnvToolExecutor, SettingsAdmission};
use omp_envd::{AttachOptions, ProjectEnvironment, RegistryBridges, tool_settings::ApprovalMode};
use omp_journal::kind;
use omp_session::{ComponentRegistry, Session};

/// One `write` call, then a closing text turn. `write` declares document
/// write effects, so its tier is `write` and always-ask prompts before it
/// starts (`bash` declares no effects by design: its exact spawn/fs effects
/// are admitted at the environment boundary through the same bound route).
struct WriteThenText {
	path:  String,
	turns: usize,
}

impl Inference for WriteThenText {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.turns += 1;
		let meta = ResponseMeta {
			request_id:          RequestId::from("approval-test"),
			provider:            ProviderId::from("test"),
			route:               RouteId::from("test/route"),
			model:               None,
			provider_request_id: None,
			created_at:          std::time::SystemTime::UNIX_EPOCH,
		};
		let events = if self.turns == 1 {
			let arguments = serde_json::json!({
				"path": self.path,
				"content": "approved content\n",
				"i": "Proving approval routing",
			});
			let call = ToolCall {
				id:        ToolCallId::from("write-1"),
				name:      Str::new_static("write"),
				arguments: omp_ai::OpaqueJson::new(arguments.clone()),
			};
			vec![
				ChatEvent::Started(meta),
				ChatEvent::ToolCallStarted {
					index: 0,
					id:    call.id.clone(),
					name:  call.name.clone(),
				},
				ChatEvent::ToolArgumentsDelta {
					index: 0,
					bytes: bytes::Bytes::from(serde_json::to_vec(&arguments).expect("args")),
				},
				ChatEvent::ToolCallReady { index: 0, call },
				ChatEvent::Completed(Completion {
					reason:  FinishReason::ToolCalls,
					blocks:  1,
					usage:   Usage::default(),
					receipt: ExecutionReceipt::default().into(),
				}),
			]
		} else {
			vec![
				ChatEvent::Started(meta),
				ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
				ChatEvent::TextDelta { index: 0, text: Str::new_static("done") },
				ChatEvent::Completed(Completion {
					reason:  FinishReason::Stop,
					blocks:  1,
					usage:   Usage::default(),
					receipt: ExecutionReceipt::default().into(),
				}),
			]
		};
		ready(Ok(ChatStream::ordinary(Box::pin(stream::iter(events.into_iter().map(Ok))))))
	}
}

fn decision(approved: bool) -> ApprovalDecision {
	ApprovalDecision {
		approved,
		scope: ApprovalScope::Once,
		source: ApprovalSource::User,
		decided_by: None,
		reason: (!approved).then(|| Str::new_static("not today")),
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

/// Runs one turn writing `target` under always-ask; `approve` answers the
/// prompt the kernel journals. Returns the session, the journaled tool
/// result data, and whether the file exists afterwards.
async fn run(approve: bool) -> (Session, String, bool) {
	let scratch = tempfile::tempdir().expect("scratch");
	let root = scratch.path().join("workspace");
	let state = scratch.path().join("state");
	std::fs::create_dir_all(&root).expect("workspace");
	std::fs::create_dir_all(&state).expect("state");
	let target = root.join("approved.txt");
	let target_text = target.to_string_lossy().into_owned();
	let environment = ProjectEnvironment::attach(&root, &state, AttachOptions {
		py_eval:            false,
		approval_mode:      Some(ApprovalMode::AlwaysAsk),
		trusted_extensions: Vec::new(),
		contributed_values: Vec::new(),
		con:                Arc::new(omp_con::Ctx::new()),
		bridges:            RegistryBridges::default(),
		spawn_idle_timeout: Some(2),
	})
	.await
	.expect("environment");
	let registry = environment.registry();
	let spill = omp_journal::blob::BlobStore::open(scratch.path().join("artifacts")).expect("spill");
	let kernel = Kernel::new(
		WriteThenText { path: target_text.clone(), turns: 0 },
		registry,
		DispatchPolicy::new(spill.clone()),
		StaticPrompt(Str::new_static("test")),
	);
	let approvals = kernel.approval_route();
	environment.bind_approval_authority(
		Some(Arc::new(omp_agent::ApprovalBook::new())),
		Some(approvals.clone()),
	);
	let mut kernel = kernel
		.with_external_executor(Arc::new(EnvToolExecutor::new(
			environment.client().clone(),
			approvals,
		)))
		.with_tool_admission(Arc::new(SettingsAdmission::new(
			&omp_con::Ctx::new(),
			Some(ApprovalMode::AlwaysAsk),
		)));
	let events = kernel.subscribe();
	let mailbox = kernel.mailbox();
	let host = tokio::spawn(async move {
		while let Ok(event) = events.recv_async().await {
			if let KernelEvent::ApprovalRequested(ticket) = event {
				assert_eq!(ticket.invocation_id.as_deref(), Some("write-1"));
				assert_eq!(ticket.reasons[0].kind.as_str(), "tool");
				assert_eq!(ticket.reasons[0].subject.as_str(), "write");
				let _ = mailbox
					.send(Up::Approve { id: ticket.ticket_id, decision: decision(approve) });
			}
		}
	});
	let mut session = Session::create_with_blob_store(
		scratch.path().join("approval.oms"),
		ComponentRegistry::standard(),
		spill,
	)
	.expect("session");
	tokio::time::timeout(
		Duration::from_secs(60),
		kernel.run_turn(
			&mut session,
			TurnInput { text: Str::new_static("run it"), attachments: Vec::new() },
			RunControl::default(),
		),
	)
	.await
	.expect("turn settles")
	.expect("turn");
	host.abort();
	let journal = std::fs::read_to_string(session.journal_path()).expect("journal");
	assert!(journal.contains(&format!("event: {}", kind::TOOL_CALL)));
	assert!(journal.contains(&format!("event: {}", kind::TOOL_RESULT)));
	let result = journal
		.lines()
		.filter(|line| line.starts_with("data: "))
		.filter(|line| line.contains("outcome") || line.contains("fault"))
		.collect::<Vec<_>>()
		.join("\n");
	let written = target.exists();
	drop(kernel);
	drop(environment);
	(session, result, written)
}

#[tokio::test]
async fn approval_always_ask_write_deny_journals_a_denied_result() {
	let (session, result, written) = run(false).await;
	let tickets = prompts(&session);
	assert_eq!(tickets.len(), 1, "one journaled approval prompt: {tickets:?}");
	assert_eq!(tickets[0].state, TicketState::Decided);
	assert!(
		tickets[0]
			.decision
			.as_ref()
			.is_some_and(|decision| !decision.approved)
	);
	assert!(
		result.contains("denied by user: not today"),
		"denied bash must settle with the denial: {result}"
	);
	assert!(!written, "denied write never ran");
}

#[tokio::test]
async fn approval_always_ask_write_allow_runs_the_tool() {
	let (session, result, written) = run(true).await;
	let tickets = prompts(&session);
	assert_eq!(tickets.len(), 1);
	assert_eq!(tickets[0].state, TicketState::Decided);
	assert!(
		tickets[0]
			.decision
			.as_ref()
			.is_some_and(|decision| decision.approved)
	);
	assert!(written, "approved write ran: {result}");
	assert!(result.contains("\"kind\":\"ok\""), "approved write settled ok: {result}");
}
