//! `glob@1` schema, traversal, and model-facing output contracts.

use std::{
	future,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use futures::{StreamExt, executor::block_on};
use omp_core::{Str, sf};
use omp_tool::{
	Abort, CapsBase, Diag, DiagKind, Ev, IncomingParams, Interrupt, ModelClass, Omitted, Part,
	PromptCaps, Severity, Tool, ToolTerminal, Unit,
};
use omp_tools::{glob, grep};
use parking_lot::Mutex;
use serde_json::json;

#[derive(Clone)]
struct FakeWorkspace {
	result:            Result<glob::WalkResult, glob::Fault>,
	seen:              Arc<Mutex<Vec<glob::WalkRequest>>>,
	stopped_on_cancel: Option<Arc<AtomicBool>>,
}

impl grep::WorkspaceSearch for FakeWorkspace {
	fn search(
		&self,
		_request: grep::SearchRequest,
	) -> impl Future<Output = Result<grep::SearchResult, grep::Fault>> + Send + '_ {
		future::ready(Err(grep::Fault::Workspace { message: sf!("unused fake search boundary") }))
	}

	fn stage_snapshots(&self, _snapshots: Vec<grep::SearchSnapshot>) -> Result<(), grep::Fault> {
		Err(grep::Fault::Workspace { message: sf!("unused fake snapshot boundary") })
	}

	fn record_snapshots(&self, _records: Vec<grep::SnapshotRecord>) -> Result<(), grep::Fault> {
		Err(grep::Fault::Workspace { message: sf!("unused fake snapshot boundary") })
	}

	fn glob(
		&self,
		request: glob::WalkRequest,
		cancellation: tokio_util::sync::CancellationToken,
	) -> impl Future<Output = Result<glob::WalkResult, glob::Fault>> + Send + '_ {
		let result = self.result.clone();
		let seen = Arc::clone(&self.seen);
		let stopped_on_cancel = self.stopped_on_cancel.clone();
		async move {
			seen.lock().push(request);
			if let Some(stopped) = stopped_on_cancel {
				cancellation.cancelled().await;
				stopped.store(true, Ordering::Release);
				return Err(glob::Fault::Cancelled { reason: sf!("cancelled by test") });
			}
			result
		}
	}
}

struct Invocation {
	result:  Result<glob::Payload, glob::Fault>,
	useless: bool,
	text:    String,
	diags:   Vec<Diag>,
}

fn fake(result: glob::WalkResult) -> FakeWorkspace {
	FakeWorkspace {
		result:            Ok(result),
		seen:              Arc::new(Mutex::new(Vec::new())),
		stopped_on_cancel: None,
	}
}

fn faulty(fault: glob::Fault) -> FakeWorkspace {
	FakeWorkspace {
		result:            Err(fault),
		seen:              Arc::new(Mutex::new(Vec::new())),
		stopped_on_cancel: None,
	}
}

const fn walk(matches: Vec<glob::WalkMatch>) -> glob::WalkResult {
	glob::WalkResult { matches, missing_paths: Vec::new(), timed_out: false, truncated: false }
}

const fn matched(path: &'static str, modified_ms: u64) -> glob::WalkMatch {
	glob::WalkMatch { path: sf!(path), modified_ms, is_dir: false }
}

const fn directory(path: &'static str, modified_ms: u64) -> glob::WalkMatch {
	glob::WalkMatch { path: sf!(path), modified_ms, is_dir: true }
}

fn invoke(workspace: FakeWorkspace, raw: &str) -> Invocation {
	let tool = glob::tool(workspace);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new(raw))
		.expect("invocation consumer remains live");
	let events = block_on(tool.call(params).collect::<Vec<_>>());
	let mut diags = Vec::new();
	let mut terminal = None;
	for event in events {
		match event {
			Ev::Diag(diag) => diags.push(diag),
			Ev::Done(ToolTerminal::Done { result, useless }) => {
				terminal = Some((result, useless));
			},
			other => panic!("unexpected glob event: {other:?}"),
		}
	}
	let (result, useless) = terminal.expect("glob emits one terminal outcome");
	let parts = tool.prompt(
		result.as_ref(),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      1,
				maximum_text_bytes: u32::MAX,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&tool.spec().rev,
		),
	);
	let text = parts
		.into_iter()
		.map(|part| match part {
			Part::Text { text } => text.to_string(),
			Part::Json { .. } => panic!("glob must project text only"),
			Part::Blob { .. } => panic!("glob must never project blobs"),
		})
		.collect();
	Invocation { result, useless, text, diags }
}

#[test]
fn schema_and_defaults_are_exact() {
	let workspace = fake(walk(Vec::new()));
	let seen = Arc::clone(&workspace.seen);
	let tool = glob::tool(workspace.clone());
	let actual: serde_json::Value =
		serde_json::from_slice(&tool.spec().schema).expect("glob schema is JSON");
	assert_eq!(tool.spec().name, "glob");
	assert!(tool.spec().rev.family.is_empty());
	assert_eq!(tool.spec().rev.n, 1);
	assert_eq!(
		tool.spec().schema.as_ref(),
		omp_tool::schema::<glob::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		actual,
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i"],
			"properties": {
				"path": {
					"type": "string",
					"description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"
				},
				"hidden": {
					"type": "boolean",
					"description": "include hidden files"
				},
				"gitignore": {
					"type": "boolean",
					"description": "respect gitignore"
				},
				"limit": {
					"type": "number",
					"description": "max results"
				},
				"i": {
					"type": "string",
					"description": "Short present-participle intent for this call."
				},
				"notrunc": {
					"type": "boolean",
					"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
				}
			}
		})
	);
	assert!(
		serde_json::from_value::<glob::Params>(json!({"patterns": ["**/*.rs"]})).is_err(),
		"glob params must reject the legacy patterns field"
	);

	let invocation = invoke(workspace, "{}");
	assert_eq!(invocation.text, "No files found matching pattern");
	assert!(invocation.useless);
	let requests = seen.lock();
	let [request] = requests.as_slice() else {
		panic!("default invocation must issue one walk: {requests:?}");
	};
	assert_eq!(request.path, ".");
	assert!(request.hidden);
	assert!(request.gitignore);
	assert_eq!(request.limit, 200);
	assert_eq!(request.timeout_ms, 5_000);
}

#[test]
fn newest_first_matches_are_prefix_grouped_and_directories_keep_their_slash() {
	let workspace = fake(walk(vec![
		matched("src/old.rs", 10),
		directory("fixtures/generated", 20),
		matched("src/new.rs", 30),
	]));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"**/*.rs","hidden":false,"gitignore":false}"#);
	assert_eq!(invocation.text, "# src/\nnew.rs\nold.rs\n# fixtures/generated/");
	assert!(!invocation.useless);
	let payload = invocation.result.expect("glob succeeds");
	assert_eq!(payload.matches, vec![
		matched("src/new.rs", 30),
		directory("fixtures/generated/", 20),
		matched("src/old.rs", 10),
	]);
	let requests = seen.lock();
	assert_eq!(requests[0].path, "**/*.rs");
	assert!(!requests[0].hidden);
	assert!(!requests[0].gitignore);
}

#[test]
fn limit_one_keeps_only_the_newest_match_and_records_truncation_truth() {
	let workspace = fake(walk(vec![matched("old.rs", 1), matched("new.rs", 2)]));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"*.rs","limit":1}"#);
	assert_eq!(invocation.text, "new.rs");
	assert!(!invocation.useless);
	assert_eq!(invocation.diags.len(), 1);
	let diag = &invocation.diags[0];
	assert_eq!(diag.native_kind(), Some(DiagKind::LimitReached));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some("limit=2"));
	assert_eq!(diag.omitted, Some(Omitted { count: 1, unit: Unit::Files }));
	let payload = invocation.result.expect("glob succeeds");
	assert_eq!(payload.matches, vec![matched("new.rs", 2)]);
	assert!(payload.truncated);
	assert_eq!(payload.result_limit_reached, Some(1));
	assert_eq!(seen.lock()[0].limit, 1);
}

#[test]
fn root_search_is_rejected_before_workspace_traversal() {
	let workspace = fake(walk(Vec::new()));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"/"}"#);
	assert!(invocation.result.is_err());
	assert_eq!(invocation.text, "Searching from root directory '/' is not allowed");
	assert!(!invocation.useless);
	assert!(seen.lock().is_empty());
}

#[test]
fn interrupt_waits_until_the_workspace_traversal_has_stopped() {
	let stopped = Arc::new(AtomicBool::new(false));
	let workspace = FakeWorkspace {
		result:            Ok(walk(Vec::new())),
		seen:              Arc::default(),
		stopped_on_cancel: Some(Arc::clone(&stopped)),
	};
	let started = Arc::clone(&workspace.seen);
	let tool = glob::tool(workspace);
	let (feed, params) = IncomingParams::channel();
	feed
		.args_committed(Str::new_static(r#"{"path":"**/*"}"#))
		.expect("invocation consumer remains live");
	let events = std::thread::scope(|scope| {
		let execution = scope.spawn(|| block_on(tool.call(params).collect::<Vec<_>>()));
		while started.lock().is_empty() {
			std::thread::yield_now();
		}
		feed
			.interrupt(Interrupt { class: sf!("user"), reason: sf!("stop glob") })
			.expect("glob invocation accepts interruption");
		execution.join().expect("glob execution thread")
	});
	assert!(
		stopped.load(Ordering::Acquire),
		"the tool must not report cancellation before its traversal has stopped"
	);
	assert!(matches!(
		events.as_slice(),
		[Ev::Aborted(Abort::Interrupted { reason })] if reason == "stop glob"
	));
}

#[test]
fn missing_paths_fault_only_when_no_target_survives() {
	let invocation = invoke(
		faulty(glob::Fault::PathNotFound { paths: vec![sf!("missing")] }),
		r#"{"path":"missing"}"#,
	);
	assert!(invocation.result.is_err());
	assert_eq!(invocation.text, "Path not found: missing");
	assert!(!invocation.useless);

	let invocation = invoke(
		faulty(glob::Fault::PathNotFound { paths: vec![sf!("one"), sf!("two")] }),
		r#"{"path":"one; two"}"#,
	);
	assert!(invocation.result.is_err());
	assert_eq!(invocation.text, "Path not found: one, two");
	assert!(!invocation.useless);
}

#[test]
fn surviving_multi_target_appends_the_missing_path_note() {
	let mut result = walk(vec![matched("src/lib.rs", 1)]);
	result.missing_paths = vec![sf!("gone"), sf!("also-gone")];
	let invocation = invoke(fake(result), r#"{"path":"src; gone; also-gone"}"#);
	assert_eq!(invocation.text, "# src/\nlib.rs");
	assert!(!invocation.useless);
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::MissingPaths));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
	assert_eq!(invocation.diags[0].text, "gone, also-gone");
	assert_eq!(
		invocation
			.result
			.expect("surviving target succeeds")
			.missing_paths
			.len(),
		2
	);
}

#[test]
fn exact_file_target_is_returned_without_a_synthetic_header() {
	let workspace = fake(walk(vec![matched("Cargo.toml", 42)]));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"Cargo.toml"}"#);
	assert_eq!(invocation.text, "Cargo.toml");
	assert!(!invocation.useless);
	assert_eq!(seen.lock()[0].path, "Cargo.toml");
}

#[test]
fn directory_star_stays_nonrecursive() {
	let workspace = fake(walk(vec![matched("dir/direct.rs", 2)]));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"dir/*"}"#);
	assert_eq!(invocation.text, "# dir/\ndirect.rs");
	assert_eq!(seen.lock()[0].path, "dir/*");
}

#[test]
fn a_leading_glob_search_can_return_nested_matches() {
	let workspace = fake(walk(vec![matched("nested/deep/match.rs", 2)]));
	let seen = Arc::clone(&workspace.seen);
	let invocation = invoke(workspace, r#"{"path":"*.rs"}"#);
	assert_eq!(invocation.text, "# nested/deep/\nmatch.rs");
	assert_eq!(seen.lock()[0].path, "*.rs");
}

#[test]
fn timeout_with_partial_matches_returns_ranked_incomplete_output() {
	let mut result = walk(vec![matched("old.rs", 1), matched("new.rs", 2)]);
	result.timed_out = true;
	let invocation = invoke(fake(result), r#"{"path":"*.rs"}"#);
	assert_eq!(invocation.text, "new.rs\nold.rs");
	assert!(!invocation.useless);
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::Timeout));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
	let payload = invocation.result.expect("partial timeout is successful");
	assert!(payload.timed_out);
	assert!(payload.truncated);
	assert_eq!(payload.partial_match_count, 2);
	assert_eq!(payload.timeout_ms, 5_000);
}

#[test]
fn timeout_without_matches_is_not_reported_as_proof_of_absence() {
	let mut result = walk(Vec::new());
	result.timed_out = true;
	let invocation = invoke(fake(result), r#"{"path":"*.rs"}"#);
	assert_eq!(invocation.text, "");
	assert!(!invocation.useless, "an incomplete traversal is useful partial truth");
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::Timeout));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
	let payload = invocation.result.expect("empty timeout is successful");
	assert!(payload.timed_out);
	assert!(payload.truncated);
	assert_eq!(payload.partial_match_count, 0);
	assert_eq!(payload.timeout_ms, 5_000);
}

#[test]
fn oversized_projection_remains_complete_for_central_dispatch() {
	let matches = (0..200)
		.map(|index| glob::WalkMatch {
			path:        sf!("dir/{index:03}-{}.rs", "x".repeat(400)),
			modified_ms: index,
			is_dir:      false,
		})
		.collect();
	let invocation = invoke(fake(walk(matches)), r#"{"path":"dir/*.rs"}"#);
	let payload = invocation
		.result
		.as_ref()
		.expect("large glob output succeeds");
	assert!(invocation.text.starts_with("# dir/\n199-"));
	assert!(invocation.text.to_ascii_lowercase().ends_with(".rs"));
	assert!(!invocation.text.contains("[truncated"));
	assert_eq!(payload.matches.len(), 200);

	let zero_tool = glob::tool(fake(walk(Vec::new())));
	let zero = zero_tool.prompt(
		Ok(payload),
		&PromptCaps::for_tool(
			CapsBase {
				maximum_parts:      0,
				maximum_text_bytes: 0,
				media:              false,
				model_class:        ModelClass::Standard,
			},
			&zero_tool.spec().rev,
		),
	);
	assert!(zero.is_empty());
}
