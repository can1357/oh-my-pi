//! Exact Python-only eval schema and rendering goldens.

use std::{
	future,
	future::{Future, ready},
	sync::{Arc, LazyLock},
	time,
};

use bytes::Bytes;
use futures::StreamExt as _;
use omp_core::{Duration, DurationUnit, Str, sf};
use omp_tool::{
	BlobRef, CapsBase, Ev, IncomingParams, Interrupt, JobOwner, ModelClass, Part, PromptCaps, Tool,
	ToolTerminal,
};
use omp_tools::{
	auto_background::DetachedJob,
	eval::{
		self, CellOutcome, CellStatus, CellValue, DisplayOutput, EvalExec, EvalRun, Fault, Language,
		Payload, RunEvent, RunRequest, Session, kernel::EmbeddedPython,
	},
};
use serde_json::json;

const TEST_INTERRUPT_GRACE: Duration = Duration::new(1, DurationUnit::Milliseconds);

#[derive(Clone)]
struct UnusedExec;

struct UnusedRun;

impl EvalRun for UnusedRun {
	fn reset(&self) -> bool {
		false
	}

	fn next_event(&mut self) -> impl Future<Output = Result<Option<RunEvent>, Fault>> + Send + '_ {
		ready(Ok(None))
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		ready(Ok(()))
	}
}

impl EvalExec for UnusedExec {
	type Run = UnusedRun;

	fn open_session(&self) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		ready(Err(Fault::SessionLost { message: "unused".into() }))
	}

	fn run<'a>(
		&'a self,
		_session: &'a Session,
		_request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		ready(Err(Fault::SessionLost { message: "unused".into() }))
	}
}

#[derive(Clone)]
struct DetachingExec;

struct DetachingRun;

impl EvalRun for DetachingRun {
	fn reset(&self) -> bool {
		false
	}

	async fn next_event(&mut self) -> Result<Option<RunEvent>, Fault> {
		future::pending().await
	}

	fn cancel(&self) -> impl Future<Output = Result<(), Fault>> + Send + '_ {
		ready(Ok(()))
	}

	fn detach(&self, name: Str) -> impl Future<Output = Result<DetachedJob, Fault>> + Send + '_ {
		ready(Ok(DetachedJob {
			id:    sf!("eval:{name}:1"),
			owner: JobOwner::NamedProcess { name, generation: 1 },
		}))
	}
}

impl EvalExec for DetachingExec {
	type Run = DetachingRun;

	fn open_session(&self) -> impl Future<Output = Result<Session, Fault>> + Send + '_ {
		ready(Ok(Session { id: Bytes::from_static(b"eval-session") }))
	}

	fn run<'a>(
		&'a self,
		_session: &'a Session,
		_request: RunRequest,
	) -> impl Future<Output = Result<Self::Run, Fault>> + Send + 'a {
		ready(Ok(DetachingRun))
	}
}

fn tool() -> impl Tool<Payload = Payload, Fault = Fault> {
	eval::eval(UnusedExec)
}

static PYTHON: LazyLock<Arc<omp_py::Engine>> = LazyLock::new(|| {
	Arc::new(
		omp_py::Engine::builder()
			.init()
			.expect("initialize embedded Python for eval test"),
	)
});

async fn execute(tool: &eval::EvalTool<EmbeddedPython>, code: &str) -> Payload {
	execute_params(tool, IncomingParams::channel(), code).await
}

async fn execute_owned(tool: &eval::EvalTool<EmbeddedPython>, owner: &str, code: &str) -> Payload {
	execute_params(tool, IncomingParams::owned_channel(Str::new(owner)), code).await
}

async fn execute_params(
	tool: &eval::EvalTool<EmbeddedPython>,
	(feed, params): (omp_tool::InvocationFeed, IncomingParams<'static>),
	code: &str,
) -> Payload {
	let raw = json!({"language":"py","code":code}).to_string();
	feed
		.args_committed(Str::new(raw))
		.expect("eval invocation remains live");
	let mut events = Box::pin(tool.call(params));
	while let Some(event) = events.next().await {
		match event {
			Ev::Done(ToolTerminal::Done { result: Ok(payload), .. }) => return payload,
			Ev::Done(ToolTerminal::Done { result: Err(fault), .. }) => {
				panic!("eval returned a fault: {fault:?}")
			},
			Ev::Done(ToolTerminal::Detached(_)) => panic!("eval unexpectedly detached"),
			Ev::Args(issue) => panic!("eval rejected arguments: {issue:?}"),
			Ev::Aborted(abort) => panic!("eval aborted: {abort:?}"),
			Ev::Update(_) | Ev::Diag(_) => {},
		}
	}
	panic!("eval stream ended without a terminal payload")
}

fn status(outcome: CellOutcome) -> CellStatus {
	CellStatus {
		outcome,
		exit_code: if outcome == CellOutcome::Complete {
			Some(0)
		} else {
			Some(1)
		},
		duration_ms: 12,
		exception: None,
	}
}

fn payload() -> Payload {
	Payload {
		session_id:      Bytes::from_static(b"session"),
		cell_id:         Bytes::from_static(b"cell"),
		language:        Language::Py,
		title:           Some("cell".into()),
		code:            "print('before')".into(),
		reset:           false,
		had_output:      false,
		result:          None,
		display_outputs: Vec::new(),
		status:          status(CellOutcome::Complete),
	}
}

fn project(payload: &Payload, media: bool) -> Vec<Part> {
	let tool = tool();
	tool.prompt(
		Ok(payload),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts: 8,
				maximum_text_bytes: 64 * 1024,
				media,
				model_class: ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	)
}

fn text(parts: &[Part]) -> String {
	parts
		.iter()
		.filter_map(|part| match part {
			Part::Text { text } => Some(text.as_str()),
			Part::Json { .. } | Part::Blob { .. } => None,
		})
		.collect()
}

#[test]
fn constructed_tool_spec_has_exact_python_only_schema() {
	let actual: serde_json::Value = serde_json::from_slice(&tool().spec().schema).unwrap();
	assert_eq!(
		tool().spec().schema.as_ref(),
		omp_tool::schema::<eval::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		actual,
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "language", "code"],
			"properties": {
				"language": {
					"type": "string",
					"enum": ["py"],
					"description": "runtime: \"py\" for the Python kernel"
				},
				"code": {
					"type": "string",
					"description": "code to run in this eval call, verbatim. Use top-level await freely."
				},
				"title": {
					"type": "string",
					"description": "short label shown in transcript (e.g. \"imports\", \"load config\")"
				},
				"timeout": {
					"type": "number",
					"description": "timeout for this eval call in seconds; 0 disables the cell timeout"
				},
				"reset": {
					"type": "boolean",
					"description": "wipe this language's kernel before running. Other languages are untouched."
				}
			,
							"kernel_mode": {
								"anyOf": [
									{
										"oneOf": [
											{
												"type": "string",
												"const": "persistent",
												"description": "Reuse the owner-scoped Python kernel."
											},
											{
												"type": "string",
												"const": "per-call",
												"description": "Spawn a clean Python kernel for this call and dispose it at settlement."
											}
										],
										"description": "Lifetime policy for the Python kernel."
									},
									{"type": "null"}
								],
								"description": "Select a persistent kernel or an isolated one-shot process."
							},
							"i": {
								"type": "string",
								"description": "Short present-participle intent for this call."
							},
							"notrunc": {
								"type": "boolean",
								"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
							}}
		})
	);
}

#[test]
fn python_model_description_is_exact_and_has_no_javascript_branch() {
	let expected = r#"Run one step of code in a persistent Python kernel. State persists across calls.
Eval `agent()` children use independent kernels.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Cells exceeding the configured foreground wait threshold continue as managed jobs; their results are delivered automatically.
`timeout: 0` disables the cell deadline; otherwise `timeout` sets it without extending foreground waiting.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

Top-level `await` works; `asyncio.run(…)` raises error.

On error, fix and re-run only the failing step.

<prelude>
Sync; kwargs.
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query=None, offset=None, limit=None) → str | dict | list[dict]
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default"|"smol"|"slow", system=None, schema=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" fast | "default" session | "slow" most capable. `schema` (JSON-Schema) → parsed object.
agent(prompt, agent?="task", name=None, outputSchema=None, schemaMode?="permissive", isolated=None, apply=None, merge=None, handle=False) → str | dict
    Run a subagent → final output. `agent` selects a discovered agent; omit it to use `task`. `outputSchema` overrides agent/session schemas; `schemaMode`/`schemaMode`: "permissive" | "strict". Effective schemas return parsed data. `isolated` requests a worktree; `apply`/`merge` control its changes. Background via `local://` files named in the prompt. `handle` → { text, output, handle: "agent://<id>", id, agent }, parsed `data` when structured.
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → `budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`; ceiling `+Nk` advisory, `+Nk!` hard.
```
</prelude>
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>"#;
	assert!(tool().spec().description.starts_with(expected));
	assert!(!tool().spec().description.contains("JavaScript"));
	assert!(!tool().spec().description.contains("Bun"));
}
#[tokio::test]
async fn eval_auto_backgrounds_through_the_managed_job_contract() {
	let tool = eval::eval(DetachingExec).with_auto_background_threshold(time::Duration::ZERO);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"language":"py","code":"slow()"}}"#))
		.expect("eval invocation remains live");
	let event = Box::pin(tool.call(params))
		.next()
		.await
		.expect("detached terminal");
	let Ev::Done(ToolTerminal::Detached(job)) = event else {
		panic!("zero-threshold eval did not detach");
	};
	assert_eq!(job.id, "eval:eval-bg-1:1");
	assert_eq!(job.owner, JobOwner::NamedProcess { name: sf!("eval-bg-1"), generation: 1 },);
}

#[tokio::test]
async fn steering_detaches_eval_instead_of_cancelling_the_cell() {
	let tool = eval::eval(DetachingExec);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(sf!(r#"{{"language":"py","code":"slow()"}}"#))
		.expect("eval invocation remains live");
	feed
		.interrupt(Interrupt { class: sf!(Interrupt::STEERING), reason: sf!("new direction") })
		.expect("steering remains live");
	let event = Box::pin(tool.call(params))
		.next()
		.await
		.expect("detached terminal");
	assert!(matches!(event, Ev::Done(ToolTerminal::Detached(_))));
}

#[test]
fn streamed_output_is_not_reprojected_with_terminal_values() {
	let mut value = payload();
	value.had_output = true;
	value.result = Some(CellValue { text: "42".into(), json: Some(json!(42)) });
	value.display_outputs =
		vec![DisplayOutput::Json { data: json!({"exit_code": 0, "stdout": "hi"}) }];
	assert_eq!(
		text(&project(&value, false)),
		"42\n\ndisplay[1]:\n{\n  \"exit_code\": 0,\n  \"stdout\": \"hi\"\n}"
	);

	value.result = None;
	value.display_outputs.clear();
	assert!(project(&value, false).is_empty());
}

#[test]
fn no_output_and_python_error_projection_are_exact() {
	assert_eq!(text(&project(&payload(), false)), "(no output)");

	let mut value = payload();
	value.status = CellStatus {
		outcome:     CellOutcome::Error,
		exit_code:   Some(1),
		duration_ms: 4,
		exception:   Some(eval::PythonException {
			name:      "ValueError".into(),
			message:   "bad value".into(),
			traceback: vec![
				"Traceback (most recent call last):".into(),
				"ValueError: bad value".into(),
			],
		}),
	};
	assert_eq!(
		text(&project(&value, false)),
		"Traceback (most recent call last):\nValueError: bad value\n\nCommand exited with code 1"
	);
}

#[test]
fn large_display_json_projection_is_complete() {
	let mut value = payload();
	let expected = "x".repeat(9_000);
	value.display_outputs = vec![DisplayOutput::Json { data: json!({"payload": expected}) }];
	let rendered = text(&project(&value, false));
	assert!(rendered.contains(&expected));
	assert!(!rendered.contains("elided"));
	assert!(!rendered.contains("truncated"));
}

#[test]
fn image_display_projects_blob_without_base64_text() {
	let mut value = payload();
	value.display_outputs = vec![DisplayOutput::Image {
		blob:        BlobRef {
			hash:       sf!("sha256:image"),
			media_type: sf!("image/png"),
			byte_len:   68,
		},
		mime_type:   sf!("image/png"),
		description: sf!("PNG image, 1×1."),
	}];
	let parts = project(&value, true);
	assert_eq!(text(&parts), "PNG image, 1×1.");
	assert!(matches!(
		parts.as_slice(),
		[Part::Text { .. }, Part::Blob { blob, alt: Some(alt) }]
			if blob.hash == "sha256:image" && alt == "PNG image, 1×1."
	));
}

#[test]
fn invalid_timeout_fault_projection_is_exact() {
	let tool = tool();
	let parts = tool.prompt(
		Err(&Fault::InvalidTimeout),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: 1024,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	assert_eq!(text(&parts), "eval timeout must be a finite non-negative number");
}

#[tokio::test]
async fn external_session_reset_separates_chat_state_and_preserves_the_new_session() {
	let runtime = EmbeddedPython::new(Arc::clone(&PYTHON), TEST_INTERRUPT_GRACE)
		.expect("test interrupt grace is representable");
	let (tool, control) = eval::eval_controlled(runtime);

	let session_a = execute(&tool, "session_value = 'A'\nsession_value").await;
	assert_eq!(session_a.result, Some(CellValue { text: sf!("'A'"), json: Some(json!("A")) }));
	let persisted_a = execute(&tool, "session_value").await;
	assert_eq!(persisted_a.result, Some(CellValue { text: sf!("'A'"), json: Some(json!("A")) }));

	control.request_reset();
	let session_b = execute(&tool, "'session_value' in globals()").await;
	assert!(session_b.reset, "session-owner reset was not consumed by the next cell");
	assert_eq!(session_b.result, Some(CellValue { text: sf!("False"), json: Some(json!(false)) }));

	execute(&tool, "session_value = 'B'").await;
	let persisted_b = execute(&tool, "session_value").await;
	assert!(!persisted_b.reset, "external reset leaked into later session-B cells");
	assert_eq!(persisted_b.result, Some(CellValue { text: sf!("'B'"), json: Some(json!("B")) }));
}

#[tokio::test]
async fn authenticated_owners_have_isolated_persistent_namespaces() {
	let runtime = EmbeddedPython::new(Arc::clone(&PYTHON), TEST_INTERRUPT_GRACE)
		.expect("test interrupt grace is representable");
	let tool = eval::eval(runtime);

	execute_owned(&tool, "chat-a", "private_value = 'A'").await;
	let absent_from_b = execute_owned(&tool, "chat-b", "'private_value' in globals()").await;
	assert_eq!(
		absent_from_b.result,
		Some(CellValue { text: sf!("False"), json: Some(json!(false)) })
	);
	let persisted_in_a = execute_owned(&tool, "chat-a", "private_value").await;
	assert_eq!(persisted_in_a.result, Some(CellValue { text: sf!("'A'"), json: Some(json!("A")) }));
}
