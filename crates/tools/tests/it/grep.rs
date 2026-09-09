//! Model-facing behavioral contracts for `grep@1`.

use std::{future, future::Future, sync::Arc};

use bytes::Bytes;
use futures::{StreamExt, executor::block_on};
use omp_core::{Str, sf};
use omp_tool::{
	CallOutcome, CapsBase, Diag, DiagKind, Ev, IncomingParams, ModelClass, Omitted, Part,
	PromptCaps, Severity, Tool, ToolTerminal, Unit, VisibilityReceipt, VisibleSourceLine,
};
use omp_tools::{glob, grep};
use parking_lot::Mutex;
use serde_json::json;

#[derive(Clone)]
struct FakeWorkspace {
	result:   Result<grep::SearchResult, grep::Fault>,
	recorded: Arc<Mutex<Vec<grep::SnapshotRecord>>>,
	requests: Arc<Mutex<Vec<grep::SearchRequest>>>,
}

impl grep::WorkspaceSearch for FakeWorkspace {
	fn search(
		&self,
		request: grep::SearchRequest,
	) -> impl Future<Output = Result<grep::SearchResult, grep::Fault>> + Send + '_ {
		let mut result = self.result.clone();
		if let Ok(result) = &mut result {
			let context_before = usize::try_from(request.context_before).unwrap_or(usize::MAX);
			let context_after = usize::try_from(request.context_after).unwrap_or(usize::MAX);
			for matched in &mut result.matches {
				let first_before = matched.context_before.len().saturating_sub(context_before);
				matched.context_before.drain(..first_before);
				matched.context_after.truncate(context_after);
			}
		}
		self.requests.lock().push(request);
		async move { result }
	}

	fn stage_snapshots(&self, _snapshots: Vec<grep::SearchSnapshot>) -> Result<(), grep::Fault> {
		Ok(())
	}

	fn record_snapshots(&self, records: Vec<grep::SnapshotRecord>) -> Result<(), grep::Fault> {
		self.recorded.lock().extend(records);
		Ok(())
	}

	fn glob(
		&self,
		_request: glob::WalkRequest,
		_cancellation: tokio_util::sync::CancellationToken,
	) -> impl Future<Output = Result<glob::WalkResult, glob::Fault>> + Send + '_ {
		future::ready(Err(glob::Fault::Workspace { message: sf!("unused fake glob boundary") }))
	}
}

struct Invocation {
	outcome: CallOutcome<grep::Payload, grep::Fault>,
	useless: bool,
	diags:   Vec<Diag>,
}

fn fake(result: grep::SearchResult) -> FakeWorkspace {
	FakeWorkspace { result: Ok(result), recorded: Arc::default(), requests: Arc::default() }
}

fn failed(fault: grep::Fault) -> FakeWorkspace {
	FakeWorkspace { result: Err(fault), recorded: Arc::default(), requests: Arc::default() }
}

fn matched(path: &str, line_number: u32, line: &str, tag: Option<&str>) -> grep::SearchMatch {
	grep::SearchMatch {
		source_key: Str::new(path),
		path: Str::new(path),
		root_index: 0,
		line_number,
		line: Str::new(line),
		truncated: false,
		context_before: Vec::new(),
		context_after: Vec::new(),
		snapshot_tag: tag.map(Str::new),
	}
}

fn context(line_number: u32, line: &str) -> grep::ContextLine {
	grep::ContextLine { line_number, line: Str::new(line) }
}

fn invoke_with_context(
	workspace: &FakeWorkspace,
	raw: &str,
	context_before: u32,
	context_after: u32,
) -> Invocation {
	let tool = grep::tool(workspace.clone(), context_before, context_after);
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
				let outcome = match result {
					Ok(payload) => CallOutcome::Ok(payload),
					Err(fault) => CallOutcome::Faulted(fault),
				};
				terminal = Some((outcome, useless));
			},
			other => panic!("unexpected grep event: {other:?}"),
		}
	}
	let (outcome, useless) = terminal.expect("grep emits one terminal outcome");
	Invocation { outcome, useless, diags }
}

fn invoke(workspace: &FakeWorkspace, raw: &str) -> Invocation {
	invoke_with_context(workspace, raw, 2, 2)
}

fn prompt(workspace: &FakeWorkspace, outcome: &CallOutcome<grep::Payload, grep::Fault>) -> String {
	let tool = grep::tool(workspace.clone(), 2, 2);
	let caps = PromptCaps::for_tool(
		CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: u32::MAX,
			media:              false,
			model_class:        ModelClass::Standard,
		},
		&tool.spec().rev,
	);
	let parts = match outcome {
		CallOutcome::Ok(payload) => tool.prompt(Ok(payload), &caps),
		CallOutcome::Faulted(fault) => tool.prompt(Err(fault), &caps),
		other => panic!("expected a projectable grep outcome, got {other:?}"),
	};
	match parts.as_slice() {
		[] => String::new(),
		[Part::Text { text }] => text.to_string(),
		_ => panic!("grep must project at most one text part: {parts:?}"),
	}
}

fn invoke_prompt(workspace: &FakeWorkspace, raw: &str) -> (String, bool) {
	let invocation = invoke(workspace, raw);
	(prompt(workspace, &invocation.outcome), invocation.useless)
}

#[test]
fn schema_is_exactly_the_native_grep_schema() {
	let tool = grep::tool(fake(grep::SearchResult::default()), 2, 2);
	let actual: serde_json::Value =
		serde_json::from_slice(&tool.spec().schema).expect("grep schema is JSON");
	assert_eq!(
		tool.spec().schema.as_ref(),
		omp_tool::schema::<grep::Params>().as_ref(),
		"tool schema must be generated directly from Params",
	);
	assert_eq!(
		actual,
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "pattern"],
			"properties": {
				"pattern": {"type": "string", "description": "regex pattern"},
				"path": {
					"type": "string",
					"description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"
				},
				"case": {"type": "boolean", "description": "case-sensitive search"},
				"gitignore": {"type": "boolean", "description": "respect gitignore"},
				"skip": {
					"type": ["number", "null"],
					"description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"
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
	for legacy in [
		json!({"pattern": "needle", "patterns": ["needle"]}),
		json!({"pattern": "needle", "include": "*.rs"}),
		json!({"pattern": "needle", "exclude": "target/**"}),
		json!({"pattern": "needle", "mode": "files"}),
		json!({"pattern": "needle", "limit": 20}),
	] {
		assert!(
			serde_json::from_value::<grep::Params>(legacy).is_err(),
			"grep params must reject legacy fields"
		);
	}
}

#[test]
fn grouped_matches_have_folded_headers_tags_and_hashline_match_rows() {
	let workspace = fake(grep::SearchResult {
		matches: vec![
			matched("dir/alpha.rs", 2, "let needle = 1;", Some("A1B2")),
			matched("dir/beta.rs", 7, "// needle", Some("C3D4")),
		],
		multi_scope: true,
		..grep::SearchResult::default()
	});
	let (text, useless) = invoke_prompt(&workspace, r#"{"pattern":"needle","path":"dir"}"#);
	assert_eq!(text, "# dir/\n## alpha.rs#A1B2\n*2:let needle = 1;\n## beta.rs#C3D4\n*7:// needle");
	assert!(!useless);
}

#[test]
fn single_file_match_has_hashline_header_and_no_group_heading() {
	let workspace = fake(grep::SearchResult {
		matches: vec![matched("src/one.rs", 4, "needle();", Some("BEEF"))],
		multi_scope: false,
		..grep::SearchResult::default()
	});
	let (text, useless) = invoke_prompt(&workspace, r#"{"pattern":"needle","path":"src/one.rs"}"#);
	assert_eq!(text, "[src/one.rs#BEEF]\n*4:needle();");
	assert!(!useless);
}

#[test]
fn asymmetric_and_zero_context_are_request_scoped_and_preserve_source_order() {
	let mut found = matched("src/context.rs", 4, "needle", Some("C0DE"));
	found.context_before =
		vec![context(1, "before 1"), context(2, "before 2"), context(3, "before 3")];
	found.context_after = vec![
		context(5, "after 1"),
		context(6, "after 2"),
		context(7, "after 3"),
		context(8, "after 4"),
	];
	let workspace = fake(grep::SearchResult {
		matches: vec![found],
		multi_scope: false,
		..grep::SearchResult::default()
	});

	let asymmetric =
		invoke_with_context(&workspace, r#"{"pattern":"needle","path":"src/context.rs"}"#, 1, 3);
	assert_eq!(
		prompt(&workspace, &asymmetric.outcome),
		"[src/context.rs#C0DE]\n 3:before 3\n*4:needle\n 5:after 1\n 6:after 2\n 7:after 3"
	);

	let zero =
		invoke_with_context(&workspace, r#"{"pattern":"needle","path":"src/context.rs"}"#, 0, 0);
	assert_eq!(prompt(&workspace, &zero.outcome), "[src/context.rs#C0DE]\n*4:needle");

	let requests = workspace.requests.lock();
	assert_eq!(
		requests
			.iter()
			.map(|request| (request.context_before, request.context_after))
			.collect::<Vec<_>>(),
		vec![(1, 3), (0, 0)]
	);
}

#[test]
fn twenty_file_window_emits_pagination_diag_and_skip_twenty_returns_next_page() {
	let matches = (1..=21)
		.map(|index| {
			let path = format!("page/file-{index:02}.rs");
			matched(&path, 1, "needle", Some("CAFE"))
		})
		.collect();
	let workspace =
		fake(grep::SearchResult { matches, multi_scope: true, ..grep::SearchResult::default() });

	let first = invoke(&workspace, r#"{"pattern":"needle","path":"page"}"#);
	let first_text = prompt(&workspace, &first.outcome);
	let expected_files = (1..=20)
		.map(|index| format!("## file-{index:02}.rs#CAFE\n*1:needle"))
		.collect::<Vec<_>>()
		.join("\n");
	assert_eq!(first_text, format!("# page/\n{expected_files}"));
	assert!(!first.useless);
	assert_eq!(first.diags.len(), 1);
	let diag = &first.diags[0];
	assert_eq!(diag.native_kind(), Some(DiagKind::Pagination));
	assert_eq!(diag.severity, Severity::Info);
	assert_eq!(diag.continuation.as_deref(), Some("skip=20"));
	assert_eq!(diag.omitted, Some(Omitted { count: 1, unit: Unit::Files }));

	let (second, second_useless) =
		invoke_prompt(&workspace, r#"{"pattern":"needle","path":"page","skip":20}"#);
	assert_eq!(second, "# page/\n## file-21.rs#CAFE\n*1:needle");
	assert!(!second_useless);
}

#[test]
fn skip_past_the_last_matching_file_has_empty_data_and_range_diag() {
	let workspace = fake(grep::SearchResult {
		matches: vec![
			matched("page/one.rs", 1, "needle", None),
			matched("page/two.rs", 1, "needle", None),
		],
		multi_scope: true,
		..grep::SearchResult::default()
	});
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"page","skip":2}"#);
	assert_eq!(prompt(&workspace, &invocation.outcome), "");
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::RangeOutOfBounds));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
}

#[test]
fn no_matches_projects_the_pi_message_and_is_useless() {
	let workspace = fake(grep::SearchResult { multi_scope: true, ..grep::SearchResult::default() });
	let (text, useless) = invoke_prompt(&workspace, r#"{"pattern":"absent","path":"src"}"#);
	assert_eq!(text, "No matches found");
	assert!(useless);
}

#[test]
fn invalid_regex_is_mapped_to_the_pi_fault_text() {
	let workspace = failed(grep::Fault::InvalidRegex { message: sf!("unclosed group") });
	let (text, useless) = invoke_prompt(&workspace, r#"{"pattern":"(","path":"src"}"#);
	assert_eq!(text, "Invalid regex: unclosed group");
	assert!(!useless);
}

#[test]
fn line_selector_filters_matches_before_projection() {
	let workspace = fake(grep::SearchResult {
		matches: vec![
			matched("src/range.rs", 2, "needle before", Some("F00D")),
			matched("src/range.rs", 3, "needle in range", Some("F00D")),
			matched("src/range.rs", 5, "needle after", Some("F00D")),
		],
		multi_scope: false,
		..grep::SearchResult::default()
	});
	let (text, useless) =
		invoke_prompt(&workspace, r#"{"pattern":"needle","path":"src/range.rs:3-4"}"#);
	assert_eq!(text, "[src/range.rs#F00D]\n*3:needle in range");
	assert!(!useless);
}

#[test]
fn central_visibility_receipt_authorizes_only_dispatcher_retained_rows() {
	let mut matches = (1..500)
		.map(|line_number| matched("src/range.rs", line_number, "needle before range", Some("F00D")))
		.collect::<Vec<_>>();
	matches.extend((500..=600).map(|line_number| {
		matched("src/range.rs", line_number, &format!("needle {}", "x".repeat(505)), Some("F00D"))
	}));
	let workspace = fake(grep::SearchResult {
		matches,
		snapshots: vec![grep::SearchSnapshot {
			source_key: sf!("src/range.rs"),
			revision:   Bytes::from_static(b"range-revision"),
			bytes:      Bytes::from(vec![b'x'; 80 * 1024]),
		}],
		multi_scope: false,
		..grep::SearchResult::default()
	});
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"src/range.rs:500-600"}"#);
	let CallOutcome::Ok(payload) = &invocation.outcome else {
		panic!("grep must succeed: {:?}", invocation.outcome);
	};
	assert!(
		workspace.recorded.lock().is_empty(),
		"the tool must not authorize source lines before central bounding"
	);
	let tool = grep::tool(workspace.clone(), 2, 2);
	let caps = PromptCaps::for_tool(
		CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: u32::MAX,
			media:              false,
			model_class:        ModelClass::Standard,
		},
		&tool.spec().rev,
	);
	let projection = tool.projection(Ok(payload), &caps);
	let [Part::Text { text }] = projection.parts.as_slice() else {
		panic!("grep must project exactly one text part: {:?}", projection.parts);
	};
	let centrally_retained = 32 * 1024;
	let receipt = VisibilityReceipt {
		lines: projection
			.visibility
			.iter()
			.filter(|span| span.end_byte <= centrally_retained)
			.map(|span| VisibleSourceLine {
				source_key: span.source_key.clone(),
				line:       span.line,
			})
			.collect(),
	};
	tool
		.authorize_visibility(Ok(payload), &receipt)
		.expect("document authority accepts central receipt");
	let recorded = workspace.recorded.lock();
	let [record] = recorded.as_slice() else {
		panic!("one visible file snapshot must be recorded: {recorded:?}");
	};

	assert!(text.starts_with("[src/range.rs#F00D]\n*500:needle "));
	assert!(!text.contains("[truncated:"), "tool-local truncation prose is prohibited");
	assert!(text.contains("*600:needle "), "complete projection reaches the dispatcher");
	assert!(!record.seen_lines.is_empty());
	assert!(
		record
			.seen_lines
			.iter()
			.all(|line| (500..=600).contains(line))
	);
	assert!(!record.seen_lines.contains(&600), "central receipt must omit tail matches");
	assert_eq!(
		record.seen_lines,
		receipt
			.lines
			.iter()
			.map(|line| line.line)
			.collect::<Vec<_>>()
	);
}

#[test]
fn explicit_oversized_file_emits_partial_scan_diag() {
	let workspace = fake(grep::SearchResult {
		matches: vec![matched("large.log", 1, "needle", None)],
		multi_scope: false,
		oversized_files: vec![sf!("large.log")],
		..grep::SearchResult::default()
	});
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"large.log"}"#);
	assert_eq!(prompt(&workspace, &invocation.outcome), "*1:needle");
	assert!(!invocation.useless);
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::PartialScan));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
}

#[test]
fn skipped_inputs_emit_structured_diags_without_changing_result_data() {
	let workspace = fake(grep::SearchResult {
		matches: vec![matched("src/lib.rs", 1, "needle", None)],
		multi_scope: true,
		missing_paths: vec![sf!("missing")],
		archive_unreadable: vec![sf!("archive.zip:binary.bin")],
		oversized_files: vec![sf!("large.log")],
		..grep::SearchResult::default()
	});
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"src; missing"}"#);
	assert_eq!(prompt(&workspace, &invocation.outcome), "# src/\n## lib.rs\n*1:needle");
	assert_eq!(
		invocation
			.diags
			.iter()
			.map(Diag::native_kind)
			.collect::<Vec<_>>(),
		[Some(DiagKind::MissingPaths), Some(DiagKind::Skipped), Some(DiagKind::PartialScan),]
	);
	assert!(
		invocation
			.diags
			.iter()
			.all(|diag| diag.severity == Severity::Warn)
	);
}

#[test]
fn unnamed_unreadable_large_files_emit_skipped_diag() {
	let workspace = fake(grep::SearchResult {
		matches: vec![matched("src/lib.rs", 1, "needle", None)],
		skipped_oversized: 2,
		..grep::SearchResult::default()
	});
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"src/lib.rs"}"#);
	assert_eq!(prompt(&workspace, &invocation.outcome), "*1:needle");
	assert_eq!(invocation.diags.len(), 1);
	assert_eq!(invocation.diags[0].native_kind(), Some(DiagKind::Skipped));
	assert_eq!(invocation.diags[0].severity, Severity::Warn);
}

#[test]
fn injected_timeout_projects_the_fixed_thirty_second_mapping() {
	let workspace = failed(grep::Fault::TimedOut);
	let (text, useless) = invoke_prompt(&workspace, r#"{"pattern":"needle","path":"src"}"#);
	assert_eq!(
		text,
		"Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first"
	);
	assert!(!useless);
}

#[test]
fn oversized_projection_remains_complete_for_central_dispatch() {
	let matches = (1..=200)
		.map(|line_number| {
			matched("large.rs", line_number, &format!("needle {}", "x".repeat(400)), Some("B10B"))
		})
		.collect();
	let workspace =
		fake(grep::SearchResult { matches, multi_scope: false, ..grep::SearchResult::default() });
	let invocation = invoke(&workspace, r#"{"pattern":"needle","path":"large.rs"}"#);
	let text = prompt(&workspace, &invocation.outcome);
	let CallOutcome::Ok(payload) = &invocation.outcome else {
		panic!("large grep output must succeed");
	};
	assert!(text.starts_with("[large.rs#B10B]\n*1:needle "));
	let expected_tail = format!("*200:needle {}", "x".repeat(400));
	assert!(text.ends_with(expected_tail.as_str()));
	assert!(!text.contains("[truncated"));
	assert_eq!(payload.files[0].matches.len(), 200);

	let zero_tool = grep::tool(workspace, 2, 2);
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
