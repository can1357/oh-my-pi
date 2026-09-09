//! P3: detached work has one durable DOM identity and one runtime kill
//! boundary.

use std::{sync::Arc, time::Duration};

use async_stream::stream;
use bytes::Bytes;
use omp_agent::{
	CancelTree, DispatchOptions, DispatchPolicy, DispatchRequest, Dispatcher, JobBoard,
	ToolCancellation,
};
use omp_core::Str;
use omp_journal::blob::BlobStore;
use omp_session::{
	ComponentRegistry, Session,
	components::jobs::{self, JobSpec},
};
use omp_tool::{
	Claims, Constraint, Effects, Ev, IncomingParams, Part, Precedence, Presentation, PromptCaps,
	Registry, Rev, Tool, ToolSpec, ToolTerminal,
};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

struct SlowTool(ToolSpec);

impl SlowTool {
	fn new() -> Self {
		Self(ToolSpec {
			name:            Str::new_static("slow"),
			rev:             Rev { family: Str::new_static("e2e"), n: 1 },
			description:     Str::new_static("detaches after the blocking budget"),
			schema:          Bytes::from_static(br#"{"type":"object","additionalProperties":false}"#),
			constraint:      Constraint::None,
			effects:         Effects::empty(),
			projection_code: [1; 32],
		})
	}
}

impl Tool for SlowTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.0
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl futures::Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			let _ = params.committed().await;
			tokio::time::sleep(Duration::from_secs(1)).await;
			yield Ev::Done(ToolTerminal::Done { result: Ok(serde_json::json!({"done": true})), useless: false });
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

fn registry() -> Arc<Registry> {
	let mut registry = Registry::new();
	registry
		.register(SlowTool::new(), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   Str::new_static("omp-e2e"),
			replaces:   None,
		})
		.expect("slow tool registers");
	Arc::new(registry)
}

#[tokio::test]
async fn p3_dispatcher_detaches_work_after_the_central_blocking_limit() {
	let temp = tempfile::tempdir().expect("P3 scratch");
	let tools = registry();
	let identity = tools.resolved_identity("slow").expect("identity");
	let policy =
		DispatchPolicy::new(BlobStore::open(temp.path().join("blobs")).expect("blob store"))
			.with_limits(64 * 1024, 512, Duration::from_millis(10));
	let dispatcher = Dispatcher::new(Arc::clone(&tools), policy);
	let path = temp.path().join("detached.oms");
	let mut session = Session::create(&path, ComponentRegistry::standard()).expect("session");
	session.begin_turn().expect("turn");
	session.user("detach", Vec::new()).expect("user");
	let args = serde_json::value::to_raw_value(&serde_json::json!({})).expect("args");
	let call = session
		.call("slow", 1, "slow-1", None, Some(args.clone()), None)
		.expect("call");
	let report = dispatcher
		.dispatch(&mut session, DispatchRequest {
			identity,
			call_id: Str::new_static("slow-1"),
			call,
			args,
			options: DispatchOptions { notrunc: false },
			cancellation: ToolCancellation::Background(
				CancelTree::new().begin_turn().background_tool(),
			),
		})
		.await
		.expect("dispatch");
	let detached = report.detached.expect("detached job reference");
	assert!(!detached.id.is_empty());
	let job = session
		.dom()
		.select("meta jobs job")
		.expect("selector")
		.next()
		.expect("detached result projects into meta jobs");
	assert_eq!(
		session
			.dom()
			.get(job)
			.and_then(|node| node.prop(&omp_dom::PropKey::from(omp_dom::PropId::Id)))
			.and_then(omp_dom::Value::as_str),
		Some(detached.id.as_str()),
	);
	let journal = std::fs::read_to_string(path).expect("journal");
	assert!(journal.contains("event: tool.result@1"));
	assert!(journal.contains("\"kind\":\"detached\""));
}

#[tokio::test]
async fn p3_job_board_rebuilds_from_meta_jobs_and_rewind_terminates_runtime() {
	let temp = tempfile::tempdir().expect("P3 scratch");
	let mut session = Session::create(temp.path().join("jobs.oms"), ComponentRegistry::standard())
		.expect("session");
	let before = session.head().expect("genesis");
	let txn = jobs::insert(session.dom(), before, JobSpec {
		id:      Str::new_static("job-1"),
		kind:    Str::new_static("tool"),
		owner:   Str::new_static("Main"),
		started: Str::new_static("1"),
		agent:   None,
	})
	.expect("jobs root");
	session.patch(txn).expect("insert job");
	let handle = session
		.dom()
		.select("jobs job[id=job-1]")
		.expect("selector")
		.next()
		.expect("job element");
	let cancel = CancellationToken::new();
	let board = JobBoard::new();
	assert!(board.attach(session.dom(), handle, cancel.clone()));
	assert_eq!(board.list().len(), 1);
	let work = session.rewind(before).expect("rewind");
	board.apply_lifecycle(&session, &work).await;
	assert!(cancel.is_cancelled());
	assert!(board.list().is_empty());
}
