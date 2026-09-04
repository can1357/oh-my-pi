//! Central dispatch, projection, and cancellation contracts.

use std::{path::PathBuf, sync::Arc, time::Duration};

use omp_agent::{
	CancelTree, DispatchOptions, DispatchPolicy, DispatchRequest, Dispatcher, ExternalDispatchEvent,
	ExternalDispatchRequest, ExternalDispatchStream, ExternalToolExecutor, SessionTool,
	SessionToolCx, SessionToolFuture, ToolCancellation,
};
use omp_core::Str;
use omp_journal::blob::BlobStore;
use omp_proto::thread::v1::{item, part};
use omp_session::project_thread;
use omp_tool::{
	CallOutcome, Claims, Part, Precedence, Presentation, PromptCaps, Rev, ToolIdentity, ToolRoute,
	ToolSpec,
};
use parking_lot::Mutex;

mod support;
use support::{
	Fault, Payload, assert_journal_cause, call, journal_entries, registry, request, result_text,
	session, spec, tool_spec,
};

struct SessionEcho(ToolSpec);

impl SessionTool for SessionEcho {
	fn spec(&self) -> &ToolSpec {
		&self.0
	}

	fn call<'a>(
		&'a self,
		cx: SessionToolCx<'a>,
		_args: Box<serde_json::value::RawValue>,
	) -> SessionToolFuture<'a> {
		Box::pin(async move {
			assert!(cx.session.dom().get(cx.call).is_some());
			Ok(CallOutcome::Ok(serde_json::value::to_raw_value("session-owned").expect("raw payload")))
		})
	}
}

#[tokio::test]
async fn session_tools_route_before_registry_invocation() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = registry([spec("session_echo", 1, "wrong registry route")]);
	let identity = tools.resolved_identity("session_echo").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	)
	.with_session_tool(Arc::new(SessionEcho(tool_spec("session_echo", 1))));
	let mut active = session(&directory.path().join("session-tool.oms"));
	let (entry, args) = call(&mut active, &identity, "session-tool");
	dispatcher
		.dispatch(
			&mut active,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(CancelTree::new().begin_turn().read_only_tool()),
				false,
			),
		)
		.await
		.expect("session tool dispatch");
	assert_eq!(result_text(&active, "session-tool"), ["\"session-owned\""]);
}

#[tokio::test]
async fn central_truncation_spills_and_notrunc_explicitly_opts_out() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = registry([spec("echo", 1, "abcdefghij")]);
	let identity = tools.resolved_identity("echo").expect("identity");
	let policy = DispatchPolicy::new(
		BlobStore::open(directory.path().join("launch")).expect("launch blob store"),
	)
	.with_limits(5, usize::MAX, Duration::from_secs(5));
	let dispatcher = Dispatcher::new(Arc::clone(&tools), policy);
	let tree = CancelTree::new();
	let active = directory.path().join("active");
	std::fs::create_dir_all(&active).expect("active session directory");
	let mut bounded = session(&active.join("bounded.oms"));
	let (entry, args) = call(&mut bounded, &identity, "bounded");
	let report = dispatcher
		.dispatch(
			&mut bounded,
			request(
				entry,
				identity.clone(),
				args,
				ToolCancellation::ReadOnly(tree.begin_turn().read_only_tool()),
				false,
			),
		)
		.await
		.expect("bounded dispatch");
	let spilled = report.spilled.expect("full output spills");
	assert_eq!(
		bounded
			.blobs()
			.get(&spilled)
			.expect("artifact reads from active session CAS")
			.as_ref(),
		b"abcdefghij"
	);
	assert!(
		!dispatcher.policy().spill.has(&spilled),
		"the launch-session CAS is never a fallback after navigation"
	);
	assert_eq!(result_text(&bounded, "bounded"), ["abcde"]);
	let projected = project_thread(bounded.dom())
		.into_iter()
		.find_map(|item| match item.kind? {
			item::Kind::ToolResult(result) if result.call_id == "bounded" => Some(result),
			_ => None,
		})
		.expect("bounded result projects");
	let parts = projected
		.parts
		.into_iter()
		.filter_map(|part| match part.kind? {
			part::Kind::Text(text) => Some(text),
			_ => None,
		})
		.collect::<Vec<_>>();
	let address = format!("artifact://sha256/{}", spilled.to_hex());
	assert_eq!(parts, vec![
		"abcde".to_owned(),
		format!(
			"<diag severity=\"info\" kind=\"output_bounded\" artifact=\"{address}\">output exceeded \
			 inline limits</diag>"
		),
	]);
	assert_journal_cause(&bounded, entry);

	let mut unlimited = session(&active.join("unlimited.oms"));
	let (entry, args) = call(&mut unlimited, &identity, "unlimited");
	let report = dispatcher
		.dispatch(
			&mut unlimited,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(tree.begin_turn().read_only_tool()),
				true,
			),
		)
		.await
		.expect("unbounded dispatch");
	assert!(report.spilled.is_none());
	assert_eq!(result_text(&unlimited, "unlimited"), ["abcdefghij"]);
}

#[tokio::test]
async fn artifact_projection_keeps_configured_head_and_tail() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = registry([spec("echo", 1, "aa\nbb\ncc\ndd")]);
	let identity = tools.resolved_identity("echo").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store"))
			.with_limits(8, usize::MAX, Duration::from_secs(5))
			.with_artifact_projection(3, 3, 1),
	);
	let mut active = session(&directory.path().join("head-tail.oms"));
	let (entry, args) = call(&mut active, &identity, "head-tail");
	let report = dispatcher
		.dispatch(
			&mut active,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(CancelTree::new().begin_turn().read_only_tool()),
				false,
			),
		)
		.await
		.expect("bounded dispatch");

	assert_eq!(result_text(&active, "head-tail")[0], "aa\n…\ndd");
	let artifact = report.spilled.expect("complete output is artifact-backed");
	assert_eq!(
		active
			.blobs()
			.get(&artifact)
			.expect("artifact reads")
			.as_ref(),
		b"aa\nbb\ncc\ndd"
	);
}

#[tokio::test]
async fn central_projection_receipt_authorizes_only_complete_visible_source_rows() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let receipts = Arc::new(Mutex::new(Vec::new()));
	let output = "alpha\nbravo\ncharlie";
	let tools = registry([spec("visible", 1, output).visibility_probe(Arc::clone(&receipts))]);
	let identity = tools.resolved_identity("visible").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")).with_limits(
			10,
			usize::MAX,
			Duration::from_secs(5),
		),
	);
	let mut session = session(&directory.path().join("visibility.oms"));
	let (entry, args) = call(&mut session, &identity, "visible");
	let report = dispatcher
		.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(CancelTree::new().begin_turn().read_only_tool()),
				false,
			),
		)
		.await
		.expect("visibility dispatch");

	assert_eq!(result_text(&session, "visible")[0], "alpha\nbrav");
	let receipt = receipts.lock();
	assert_eq!(receipt.len(), 1);
	assert_eq!(receipt[0].source_key, "test-source");
	assert_eq!(receipt[0].line, 1);
	let artifact = report.spilled.expect("complete output is artifact-backed");
	assert_eq!(
		dispatcher
			.policy()
			.spill
			.get(&artifact)
			.expect("artifact reads")
			.as_ref(),
		output.as_bytes()
	);
}

#[tokio::test]
async fn central_line_clamp_never_authorizes_a_partially_visible_source_row() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let receipts = Arc::new(Mutex::new(Vec::new()));
	let output = "abcdefghijk\nok";
	let tools = registry([spec("visible-lines", 1, output).visibility_probe(Arc::clone(&receipts))]);
	let identity = tools.resolved_identity("visible-lines").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")).with_limits(
			64 * 1024,
			5,
			Duration::from_secs(5),
		),
	);
	let mut session = session(&directory.path().join("line-visibility.oms"));
	let (entry, args) = call(&mut session, &identity, "visible-lines");
	let report = dispatcher
		.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(CancelTree::new().begin_turn().read_only_tool()),
				false,
			),
		)
		.await
		.expect("line visibility dispatch");

	assert_eq!(result_text(&session, "visible-lines")[0], "abcde…\nok");
	let receipt = receipts.lock();
	assert_eq!(receipt.len(), 1);
	assert_eq!(receipt[0].line, 2);
	let artifact = report
		.spilled
		.expect("line-clamped complete output is artifact-backed");
	assert_eq!(
		dispatcher
			.policy()
			.spill
			.get(&artifact)
			.expect("artifact reads")
			.as_ref(),
		output.as_bytes()
	);
}

#[tokio::test]
async fn typed_batches_publish_before_streaming_tool_settles() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools =
		registry([spec("stream", 1, "settled").streaming("first", Duration::from_millis(300))]);
	let identity = tools.resolved_identity("stream").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	);
	let mut session = session(&directory.path().join("stream.oms"));
	let (entry, args) = call(&mut session, &identity, "streaming");
	let (_, patches) = session.subscribe();
	let cancellation = CancelTree::new().begin_turn();
	let dispatch = dispatcher.dispatch(
		&mut session,
		request(
			entry,
			identity,
			args,
			ToolCancellation::ReadOnly(cancellation.read_only_tool()),
			false,
		),
	);
	tokio::pin!(dispatch);
	tokio::select! {
		patch = patches.recv_async() => assert!(patch.is_ok(), "update patch publishes"),
		result = &mut dispatch => panic!("dispatch settled before update: {result:?}"),
		() = tokio::time::sleep(Duration::from_millis(150)) => panic!("update was not published"),
	}
	let report = dispatch.await.expect("streaming dispatch settles");
	assert!(!report.is_error);
}

#[tokio::test]
async fn cancelled_task_projects_cancelled_error_never_completed() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = registry([spec("slow", 1, "never").streaming("started", Duration::from_secs(60))]);
	let identity = tools.resolved_identity("slow").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	);
	let mut session = session(&directory.path().join("cancelled.oms"));
	let (entry, args) = call(&mut session, &identity, "cancelled");
	let cancellation = CancelTree::new().begin_turn().read_only_tool();
	cancellation.cancel_tool();
	let report = dispatcher
		.dispatch(
			&mut session,
			request(entry, identity, args, ToolCancellation::ReadOnly(cancellation), false),
		)
		.await
		.expect("cancellation journals terminal");
	assert!(report.is_error);
	let items = project_thread(session.dom());
	let result = items
		.into_iter()
		.find_map(|item| match item.kind? {
			item::Kind::ToolResult(result) if result.call_id == "cancelled" => Some(result),
			_ => None,
		})
		.expect("cancelled result projects");
	assert!(result.is_error);
	assert!(
		result_text(&session, "cancelled")
			.join("")
			.contains("cancel")
	);
	assert_journal_cause(&session, entry);
}

#[test]
fn registry_keeps_historical_revisions_and_identity_caches_normalized_schema() {
	let tools = registry([spec("versioned", 1, "old"), spec("versioned", 2, "new")]);
	let live = tools.resolved_identity("versioned").expect("live identity");
	assert_eq!(live.rev.n, 2);
	let historical = ToolIdentity {
		name: Str::new_static("versioned"),
		rev:  Rev { family: Str::new_static("test"), n: 1 },
	};
	let verdict = serde_json::to_vec(&omp_tool::CallOutcome::<Payload, Fault>::Ok(Payload {
		text: Str::new_static("old"),
	}))
	.expect("verdict serializes");
	let caps = PromptCaps::for_tool(
		omp_tool::CapsBase {
			maximum_parts:      8,
			maximum_text_bytes: 1024,
			media:              false,
			model_class:        omp_tool::ModelClass::Standard,
		},
		&historical.rev,
	);
	let first = tools
		.project_verdict(&historical, &verdict, false, &caps)
		.expect("historical projects");
	let second = tools
		.project_verdict(&historical, &verdict, false, &caps)
		.expect("cached projects");
	assert!(Arc::ptr_eq(&first, &second));
}

#[tokio::test]
async fn closed_progress_channel_does_not_starve_immediate_terminal_join() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = registry([spec("immediate", 1, "failed").faulting()]);
	let identity = tools.resolved_identity("immediate").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")),
	);
	let mut session = session(&directory.path().join("immediate.oms"));
	let (entry, args) = call(&mut session, &identity, "immediate");
	let cancellation = CancelTree::new().begin_turn();
	let report = tokio::time::timeout(
		Duration::from_millis(250),
		dispatcher.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(cancellation.read_only_tool()),
				false,
			),
		),
	)
	.await
	.expect("terminal join is not starved")
	.expect("fault projects");
	assert!(report.is_error);
}

#[tokio::test]
async fn central_per_line_clamp_bounds_long_lines_and_records_the_count() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let output = "0123456789abcdef\nshort\n0123456789abcdef";
	let tools = registry([spec("lines", 1, output)]);
	let identity = tools.resolved_identity("lines").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")).with_limits(
			64 * 1024,
			8,
			Duration::from_secs(5),
		),
	);
	let mut session = session(&directory.path().join("lines.oms"));
	let (entry, args) = call(&mut session, &identity, "lines");
	let cancellation = CancelTree::new().begin_turn();
	let report = dispatcher
		.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(cancellation.read_only_tool()),
				false,
			),
		)
		.await
		.expect("line dispatch");
	assert_eq!(report.lines_clamped, 2);
	assert_eq!(result_text(&session, "lines")[0], "01234567…\nshort\n01234567…");
	let artifact = report.spilled.expect("clamped output spills");
	assert_eq!(
		dispatcher
			.policy()
			.spill
			.get(&artifact)
			.expect("artifact reads"),
		output.as_bytes()
	);
	let projected = project_thread(session.dom())
		.into_iter()
		.find_map(|item| match item.kind? {
			item::Kind::ToolResult(result) if result.call_id == "lines" => Some(result),
			_ => None,
		})
		.expect("line-clamped result projects");
	let diag = projected
		.parts
		.into_iter()
		.filter_map(|part| match part.kind? {
			part::Kind::Text(text) if text.starts_with("<diag ") => Some(text),
			_ => None,
		})
		.next()
		.expect("output bound diagnostic projects");
	let address = format!("artifact://sha256/{}", artifact.to_hex());
	assert_eq!(
		diag,
		format!(
			"<diag severity=\"info\" kind=\"output_bounded\" artifact=\"{address}\" omitted=\"2 \
			 lines\">output exceeded inline limits</diag>"
		)
	);
}

#[tokio::test]
async fn notrunc_disables_the_per_line_clamp() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let output = "0123456789abcdef";
	let tools = registry([spec("lines", 1, output)]);
	let identity = tools.resolved_identity("lines").expect("identity");
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")).with_limits(
			64 * 1024,
			8,
			Duration::from_secs(5),
		),
	);
	let mut session = session(&directory.path().join("notrunc.oms"));
	let (entry, args) = call(&mut session, &identity, "lines");
	let cancellation = CancelTree::new().begin_turn();
	let report = dispatcher
		.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(cancellation.read_only_tool()),
				true,
			),
		)
		.await
		.expect("notrunc dispatch");
	assert_eq!(report.lines_clamped, 0);
	assert!(report.spilled.is_none());
	assert_eq!(result_text(&session, "lines"), [output]);
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ExternalObserved {
	session_id: Str,
	blobs:      PathBuf,
	call_id:    Str,
	args:       Str,
	route:      ToolRoute,
}

struct ScriptedExternal {
	observed: Arc<Mutex<Vec<ExternalObserved>>>,
}

impl ExternalToolExecutor for ScriptedExternal {
	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream {
		self.observed.lock().push(ExternalObserved {
			session_id: request.session_id,
			blobs:      request.blobs.root().to_path_buf(),
			call_id:    request.call_id,
			args:       Str::new(request.args.get()),
			route:      request.route,
		});
		let update = serde_json::value::to_raw_value(&serde_json::json!({
			"text": "external progress"
		}))
		.expect("update serializes");
		let outcome = CallOutcome::<serde_json::Value, serde_json::Value>::Ok(
			serde_json::json!({"text": "external result"}),
		);
		Box::pin(futures::stream::iter([
			ExternalDispatchEvent::Update(update),
			ExternalDispatchEvent::Done {
				outcome,
				parts: vec![Part::Text { text: Str::new_static("external result") }],
				is_error: false,
				source_artifact: None,
			},
		]))
	}
}

/// An external unit that either settles once its cancellation token fires
/// (a shell whose process group the environment kills) or never settles at
/// all (a unit that ignores the stop request).
struct StuckExternal {
	honors_cancel: bool,
	started:       Arc<tokio::sync::Notify>,
}

impl ExternalToolExecutor for StuckExternal {
	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream {
		let honors_cancel = self.honors_cancel;
		let started = Arc::clone(&self.started);
		Box::pin(async_stream::stream! {
			started.notify_one();
			request.cancellation.cancelled().await;
			if honors_cancel {
				yield ExternalDispatchEvent::Aborted(omp_tool::Abort::Interrupted {
					reason: Str::new_static("bash command was cancelled"),
				});
			} else {
				std::future::pending::<()>().await;
			}
		})
	}
}

/// A two-call worker batch whose selected call ignores its stop request while
/// the sibling settles normally.
struct ScopedAbortExternal {
	started: Arc<tokio::sync::Barrier>,
}

impl ExternalToolExecutor for ScopedAbortExternal {
	fn invoke(&self, request: ExternalDispatchRequest) -> ExternalDispatchStream {
		let started = Arc::clone(&self.started);
		Box::pin(async_stream::stream! {
			started.wait().await;
			if request.call_id == "abort-me" {
				request.cancellation.cancelled().await;
				std::future::pending::<()>().await;
			} else {
				yield ExternalDispatchEvent::Done {
					outcome: CallOutcome::Ok(serde_json::json!({"text": "sibling result"})),
					parts: vec![Part::Text { text: Str::new_static("sibling result") }],
					is_error: false,
					source_artifact: None,
				};
			}
		})
	}
}

fn worker_registry() -> Arc<omp_tool::Registry> {
	let mut tools = omp_tool::Registry::new();
	tools
		.register_worker(tool_spec("worker", 1), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp-agent/tests"),
			replaces:   None,
		})
		.expect("worker registers");
	Arc::new(tools)
}

#[tokio::test]
async fn tool_scoped_abort_forces_only_the_selected_sibling_and_replays() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let journal_path = directory.path().join("scoped-abort.oms");
	let tools = worker_registry();
	let identity = tools.resolved_identity("worker").expect("worker identity");
	let started = Arc::new(tokio::sync::Barrier::new(3));
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store"))
			.with_interrupt_grace(Duration::from_millis(25)),
	)
	.with_external_executor(Arc::new(ScopedAbortExternal { started: Arc::clone(&started) }));
	let mut session = session(&journal_path);
	let (aborted_entry, aborted_args) = call(&mut session, &identity, "abort-me");
	let (sibling_entry, sibling_args) = call(&mut session, &identity, "sibling");
	let tree = CancelTree::new();
	let turn = tree.begin_turn();
	let aborted_scope = turn.read_only_tool();
	let mut aborted = dispatcher
		.prepare(
			identity.clone(),
			Str::new_static("abort-me"),
			aborted_entry,
			ToolCancellation::ReadOnly(aborted_scope.clone()),
		)
		.expect("aborted call prepares");
	aborted.commit(aborted_args);
	let mut sibling = dispatcher
		.prepare(
			identity,
			Str::new_static("sibling"),
			sibling_entry,
			ToolCancellation::ReadOnly(turn.read_only_tool()),
		)
		.expect("sibling call prepares");
	sibling.commit(sibling_args);

	let reports = {
		let drive = dispatcher.drive(&mut session, vec![aborted, sibling], None);
		tokio::pin!(drive);
		tokio::select! {
			_ = started.wait() => {},
			result = &mut drive => panic!("batch settled before both calls started: {result:?}"),
		}
		aborted_scope.cancel_tool();
		tokio::time::timeout(Duration::from_millis(250), &mut drive)
			.await
			.expect("forced cleanup is bounded")
			.expect("batch journals both terminals")
	};
	assert!(reports[0].is_error);
	assert!(!reports[1].is_error);
	assert!(!turn.is_turn_cancelled(), "tool abort must not become a turn interrupt");
	assert!(!tree.is_session_cancelled(), "tool abort must not become session cancellation");
	assert!(
		result_text(&session, "abort-me")[0].contains("effects unknown"),
		"started call that ignored cancellation records uncertainty"
	);
	assert_eq!(result_text(&session, "sibling"), ["sibling result"]);

	let entries = journal_entries(&journal_path);
	for call in [aborted_entry, sibling_entry] {
		let started_at = entries
			.iter()
			.position(|entry| {
				entry.kind.name.as_str() == omp_journal::kind::TOOL_UPDATE
					&& entry.by == Some(call)
					&& entry.data.as_str().contains(r#""kernel":"started""#)
			})
			.expect("execution start journals");
		let settled_at = entries
			.iter()
			.position(|entry| {
				entry.kind.name.as_str() == omp_journal::kind::TOOL_RESULT && entry.by == Some(call)
			})
			.expect("terminal journals");
		assert!(started_at < settled_at, "start must precede settlement");
	}

	let started_key = omp_dom::PropKey::Custom(Str::new_static("execution-started"));
	for selector in ["body turn worker[id=abort-me]", "body turn worker[id=sibling]"] {
		let call = session
			.dom()
			.select(selector)
			.expect("selector parses")
			.next()
			.expect("call materializes");
		assert_eq!(
			session
				.dom()
				.get(call)
				.and_then(|node| node.prop(&started_key)),
			Some(&omp_dom::Value::Bool(true)),
			"execution start boundary is durable"
		);
	}
	let abort_diag = session
		.dom()
		.select("body turn worker[id=abort-me] diag")
		.expect("selector parses")
		.next()
		.expect("aborted card diagnostic materializes");
	assert!(
		session
			.dom()
			.get(abort_diag)
			.and_then(|node| node.prop(&omp_dom::PropKey::from(omp_dom::PropId::Text)))
			.and_then(omp_dom::Value::as_str)
			.is_some_and(|text| text.contains("effects unknown")),
		"card projection preserves uncertainty"
	);
	let live = session.dom().snapshot();
	drop(session);
	let replayed =
		omp_session::Session::open(&journal_path, omp_session::ComponentRegistry::default())
			.expect("journal replays");
	assert_eq!(replayed.dom().snapshot(), live);
	assert!(
		result_text(&replayed, "abort-me")[0].contains("effects unknown"),
		"replayed model/card projection preserves the abort"
	);
	assert_eq!(result_text(&replayed, "sibling"), ["sibling result"]);
}

#[tokio::test]
async fn dispatch_timed_out_call_remains_observable_as_an_adopted_job() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = worker_registry();
	let identity = tools.resolved_identity("worker").expect("worker identity");
	let started = Arc::new(tokio::sync::Notify::new());
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store")).with_limits(
			64 * 1024,
			512,
			Duration::from_millis(20),
		),
	)
	.with_external_executor(Arc::new(StuckExternal { honors_cancel: true, started }));
	let mut session = session(&directory.path().join("detached.oms"));
	let (entry, args) = call(&mut session, &identity, "detached-1");
	let report = tokio::time::timeout(
		Duration::from_secs(1),
		dispatcher.dispatch(
			&mut session,
			request(
				entry,
				identity,
				args,
				ToolCancellation::ReadOnly(CancelTree::new().begin_turn().read_only_tool()),
				false,
			),
		),
	)
	.await
	.expect("blocking limit detaches promptly")
	.expect("detachment journals a terminal");
	let detached = report.detached.expect("call returns a job reference");
	let jobs = dispatcher.jobs().list();
	assert_eq!(jobs.len(), 1);
	assert_eq!(jobs[0].id, detached.id);
	assert!(
		dispatcher
			.jobs()
			.terminate(&mut session, jobs[0].handle)
			.await
			.expect("cancel journals")
	);
	assert_eq!(dispatcher.jobs().list()[0].status, "cancelled");
}

/// The journaled `tool.result@1` abort kind for `call_id`, after proving the
/// aborted result projects to the model.
fn abort_kind(session: &omp_session::Session, call_id: &str) -> String {
	let projected = project_thread(session.dom())
		.into_iter()
		.find_map(|item| match item.kind? {
			item::Kind::ToolResult(result) if result.call_id == call_id => Some(result),
			_ => None,
		})
		.expect("aborted result projects");
	assert!(projected.is_error);
	let journal = std::fs::read_to_string(session.journal_path()).expect("journal reads");
	let line = journal
		.lines()
		.skip_while(|line| *line != "event: tool.result@1")
		.find(|line| line.starts_with("data: "))
		.expect("tool.result@1 data");
	let data: serde_json::Value =
		serde_json::from_str(&line["data: ".len()..]).expect("tool.result@1 json");
	data["fault"]["value"]["abort"]["kind"]
		.as_str()
		.unwrap_or_else(|| panic!("abort kind missing: {data}"))
		.to_owned()
}

#[tokio::test]
async fn interrupt_kills_a_running_shell_tool_and_settles_aborted() {
	// A mutating tool's commit token is session-only, but ctrl+c (turn
	// interrupt) must still stop it: the executor receives the stop request
	// and its own verdict settles the call within a tick.
	let directory = tempfile::tempdir().expect("temporary directory");
	let tools = worker_registry();
	let identity = tools.resolved_identity("worker").expect("worker identity");
	let started = Arc::new(tokio::sync::Notify::new());
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store"))
			.with_interrupt_grace(Duration::from_millis(300)),
	)
	.with_external_executor(Arc::new(StuckExternal {
		honors_cancel: true,
		started:       Arc::clone(&started),
	}));
	let mut session = session(&directory.path().join("killed.oms"));
	let (entry, args) = call(&mut session, &identity, "shell-1");
	let turn = CancelTree::new().begin_turn();
	let cancellation = turn.foreground_mutation();
	let report = {
		let dispatch = dispatcher.dispatch(
			&mut session,
			request(entry, identity.clone(), args, ToolCancellation::Foreground(cancellation), false),
		);
		tokio::pin!(dispatch);
		tokio::select! {
			() = started.notified() => {},
			result = &mut dispatch => panic!("dispatch settled before the unit started: {result:?}"),
		}
		turn.cancel_turn();
		tokio::time::timeout(Duration::from_millis(200), &mut dispatch)
			.await
			.expect("interrupted shell settles within a tick")
			.expect("abort journals a terminal")
	};
	assert!(report.is_error);
	assert!(report.detached.is_none());
	assert_eq!(abort_kind(&session, "shell-1"), "interrupted");
	assert_journal_cause(&session, entry);

	// A unit that ignores the stop request is forced closed after the bounded
	// grace and recorded as uncertainty, never left hanging (ADR 0011).
	let started = Arc::new(tokio::sync::Notify::new());
	let dispatcher = Dispatcher::new(
		Arc::clone(&tools),
		DispatchPolicy::new(BlobStore::open(directory.path()).expect("blob store"))
			.with_interrupt_grace(Duration::from_millis(300)),
	)
	.with_external_executor(Arc::new(StuckExternal {
		honors_cancel: false,
		started:       Arc::clone(&started),
	}));
	let mut stuck = support::session(&directory.path().join("stuck.oms"));
	let (entry, args) = call(&mut stuck, &identity, "shell-2");
	let turn = CancelTree::new().begin_turn();
	let interrupted_at;
	let report = {
		let dispatch = dispatcher.dispatch(
			&mut stuck,
			request(
				entry,
				identity,
				args,
				ToolCancellation::Foreground(turn.foreground_mutation()),
				false,
			),
		);
		tokio::pin!(dispatch);
		tokio::select! {
			() = started.notified() => {},
			result = &mut dispatch => panic!("dispatch settled before the unit started: {result:?}"),
		}
		interrupted_at = std::time::Instant::now();
		turn.cancel_turn();
		tokio::time::timeout(Duration::from_secs(2), &mut dispatch)
			.await
			.expect("stuck unit is forced closed within the grace")
			.expect("forced abort journals a terminal")
	};
	let elapsed = interrupted_at.elapsed();
	assert!(
		elapsed >= Duration::from_millis(250),
		"forced termination waited for the grace: {elapsed:?}"
	);
	assert!(report.is_error);
	assert_eq!(abort_kind(&stuck, "shell-2"), "effects_unknown");
	assert_journal_cause(&stuck, entry);
}

#[tokio::test]
async fn worker_routed_tools_use_the_injected_external_executor() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let mut tools = omp_tool::Registry::new();
	tools
		.register_worker(tool_spec("worker", 1), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp-agent/tests"),
			replaces:   None,
		})
		.expect("worker registers");
	let tools = Arc::new(tools);
	let identity = tools.resolved_identity("worker").expect("worker identity");
	let observed = Arc::new(Mutex::new(Vec::new()));
	let launch_store =
		BlobStore::open(directory.path().join("launch")).expect("launch-time blob store");
	let launch_root = launch_store.root().to_path_buf();
	let dispatcher = Dispatcher::new(Arc::clone(&tools), DispatchPolicy::new(launch_store))
		.with_external_executor(Arc::new(ScriptedExternal { observed: Arc::clone(&observed) }));
	let active = directory.path().join("active");
	std::fs::create_dir_all(&active).expect("active session directory");
	let mut session = session(&active.join("worker.oms"));
	assert_ne!(
		session.blobs().root(),
		launch_root.as_path(),
		"fixture separates launch and active CAS"
	);
	let (entry, args) = call(&mut session, &identity, "worker-1");
	let cancellation = CancelTree::new().begin_turn();

	let report = dispatcher
		.dispatch(&mut session, DispatchRequest {
			identity,
			call_id: Str::new_static("worker-1"),
			call: entry,
			args,
			options: DispatchOptions::default(),
			cancellation: ToolCancellation::ReadOnly(cancellation.read_only_tool()),
		})
		.await
		.expect("external dispatch completes");

	assert!(!report.is_error);
	assert_eq!(result_text(&session, "worker-1"), ["external result"]);
	assert_eq!(observed.lock().as_slice(), [ExternalObserved {
		session_id: {
			let path = active.join("worker.oms");
			let digest = omp_core::Hash32::sum(path.as_os_str().as_encoded_bytes()).to_hex();
			Str::new(digest.as_str())
		},
		blobs:      session.blobs().root().to_path_buf(),
		call_id:    Str::new_static("worker-1"),
		args:       Str::new_static("{}"),
		route:      ToolRoute::Worker {
			site: omp_tool::WorkerSiteKind::Env,
			name: Str::new_static("worker"),
		},
	}]);
	assert_journal_cause(&session, entry);
}
