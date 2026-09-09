//! Rendering contracts for the typed tool cards against the recorded TS
//! renderers: identity dispatch, settled-payload variants, `@expanded` bounds,
//! and the user-authored text a card must never drop.

use omp_chat::cards::{CardRegistry, CardStatus, CardView};
use omp_core::Str;
use omp_dom::{KnownTag, Node, PropId, Tag, Value as DomValue};
use omp_tui::{Ui, UiContext, frame_text};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn node(tag: KnownTag, content: &str) -> Node {
	Node {
		tag:     Tag::Known(tag),
		props:   Default::default(),
		kids:    Vec::new(),
		content: Some(Str::new(content)),
	}
}

/// A settled `<result>` carrying the journaled `CallOutcome::Ok` envelope of
/// a typed payload plus the bounded projection dispatch stores beside it.
fn result_node<T: DeserializeOwned + Serialize>(payload: Value) -> Node {
	let typed: T = serde_json::from_value(payload).expect("typed payload fixture deserializes");
	let encoded = serde_json::to_value(&typed).expect("typed payload serializes");
	let mut result = node(KnownTag::Result, "");
	result.props.push((
		PropId::Outcome.into(),
		DomValue::Json(
			serde_json::value::to_raw_value(&json!({"kind": "ok", "value": encoded}))
				.expect("outcome JSON"),
		),
	));
	result.props.push((
		PropId::Data.into(),
		DomValue::Json(
			serde_json::value::to_raw_value(&json!([{"kind": "text", "text": "projection"}]))
				.expect("projection JSON"),
		),
	));
	result
}

fn fault_node(message: &str) -> Node {
	let mut diag = node(KnownTag::Diag, message);
	diag.props.push((
		PropId::Fault.into(),
		DomValue::Json(
			serde_json::value::to_raw_value(
				&json!({"kind": "faulted", "value": {"message": message}}),
			)
			.expect("fault JSON"),
		),
	));
	diag
}

fn render(
	tool: &str,
	input: &Node,
	result: Option<&Node>,
	diag: Option<&Node>,
	status: CardStatus,
	expanded: bool,
) -> String {
	let view = CardView {
		input,
		result,
		diag,
		notices: smallvec::SmallVec::new(),
		usage: None,
		status,
		output: None,
		started: None,
	};
	let registry = CardRegistry::standard();
	let ui = UiContext::default();
	let component = registry.render(tool, &view, expanded, &ui);
	let rendered = Ui::from_root(component, 100, ui);
	frame_text(rendered.frame())
}

#[test]
fn bounded_output_notice_is_informational_and_links_the_artifact() {
	let input = node(KnownTag::Input, r#"{"i":"Reading large log"}"#);
	let result = result_node::<serde_json::Value>(json!({"output":"bounded body"}));
	let mut notice = node(KnownTag::Diag, r#"{"kind":"output_bounded"}"#);
	notice
		.props
		.push((PropId::Severity.into(), DomValue::Str(Str::new_static("info"))));
	notice
		.props
		.push((PropId::Kind.into(), DomValue::Str(Str::new_static("output_bounded"))));
	notice.props.push((
		PropId::Recovery.into(),
		DomValue::Str(Str::new_static("artifact://sha256/0123456789abcdef")),
	));
	notice
		.props
		.push((PropId::Omitted.into(), DomValue::Int(3)));
	notice
		.props
		.push((PropId::Unit.into(), DomValue::Str(Str::new_static("lines"))));
	notice.props.push((
		PropId::Data.into(),
		DomValue::Json(
			serde_json::value::to_raw_value(&json!({
				"kind": "output_bounded",
				"severity": "info"
			}))
			.expect("diagnostic JSON"),
		),
	));
	let view = CardView {
		input:   &input,
		result:  Some(&result),
		diag:    None,
		notices: smallvec::smallvec![&notice],
		usage:   None,
		status:  CardStatus::Done,
		output:  None,
		started: None,
	};
	let ui = UiContext::default();
	let rendered =
		Ui::from_root(CardRegistry::standard().render("custom", &view, false, &ui), 100, ui);
	let text = frame_text(rendered.frame());
	assert!(text.contains("Output was bounded (3 lines not shown)"), "{text}");
	assert!(text.contains("Read artifact://sha256/0123456789abcdef for full output"), "{text}");
	assert!(!text.contains("output_bounded") && !text.contains("{\""), "{text}");
}

fn render_done<T: DeserializeOwned + Serialize>(
	tool: &str,
	args: &str,
	payload: Value,
	expanded: bool,
) -> String {
	let input = node(KnownTag::Input, args);
	let result = result_node::<T>(payload);
	render(tool, &input, Some(&result), None, CardStatus::Done, expanded)
}

#[test]
fn task_card_lists_detached_jobs_instead_of_failing() {
	let text = render_done::<omp_tools::task::Payload>(
		"task",
		"{}",
		json!({"jobs":[
			{"id":"AuthLoader","agent":"scout","session_path":"sessions/AuthLoader.oms","status":"running"},
			{"id":"RateLimiter","agent":"task","session_path":"sessions/RateLimiter.oms","status":"pending"}
		]}),
		false,
	);
	assert!(text.contains("Task 2 agents"), "{text}");
	assert!(text.contains("AuthLoader:"), "{text}");
	assert!(text.contains("⟨scout⟩"), "{text}");
	assert!(text.contains("⟨running⟩"), "{text}");
	assert!(text.contains("RateLimiter:"), "{text}");
	assert!(text.contains("⟨pending⟩"), "{text}");
	assert!(text.contains("2 started"), "{text}");
	assert!(!text.contains("operation failed"), "{text}");
	assert!(!text.contains("failed"), "{text}");
}

fn section(path: &str, op: &str, move_dest: Option<&str>, diff: &str) -> Value {
	json!({
		"path": path, "canonical_path": path, "op": op, "move_dest": move_dest,
		"old_revision": "r1", "new_revision": "r2", "applied_ops": [], "resolved_edits": [],
		"rebased": false, "before": [], "after": [], "header": null, "diff": diff,
		"preview": "", "first_changed_line": null, "block_resolutions": [], "warnings": [],
		"diagnostics": [], "diagnostics_complete": true
	})
}

#[test]
fn edit_card_renders_every_section_of_a_transaction() {
	let text = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[
			section("src/a.rs", "update", None, "@@ -1,1 +1,1 @@\n-alpha\n+ALPHA"),
			section("src/b.rs", "delete", None, ""),
			section("src/c.rs", "move", Some("src/d.rs"), ""),
			section("src/e.rs", "update", None, "@@ -1,1 +1,1 @@\n-echo\n+ECHO"),
		]}),
		false,
	);
	for expected in ["src/a.rs", "src/b.rs", "src/c.rs", "src/d.rs", "src/e.rs"] {
		assert!(text.contains(expected), "missing {expected} in {text}");
	}
	assert!(text.contains("ALPHA"), "{text}");
	assert!(text.contains("ECHO"), "{text}");
	assert!(text.contains("Delete:"), "{text}");
	assert!(text.contains("Move:"), "{text}");
	assert_eq!(text.matches("⟨+1 -1⟩").count(), 2, "{text}");
}

#[test]
fn resolution_cards_paint_the_action_and_the_reason() {
	let reason = "The patch would also delete the migration script.";
	let input = node(KnownTag::Input, &json!({"reason": reason}).to_string());
	let settled = node(KnownTag::Result, "{}");
	let text = render("reject", &input, Some(&settled), None, CardStatus::Done, false);
	assert!(text.contains("Discard: pending action"), "{text}");
	assert!(text.contains(reason), "{text}");
	assert!(!text.contains("Accept"), "{text}");
	assert!(!text.contains("No reason provided"), "{text}");

	let text = render("resolve", &input, Some(&settled), None, CardStatus::Done, false);
	assert!(text.contains("Accept: pending action"), "{text}");
	assert!(text.contains(reason), "{text}");

	let labelled = node(KnownTag::Result, r#"{"label":"ast_edit: rename 3 symbols"}"#);
	let text = render("resolve", &input, Some(&labelled), None, CardStatus::Done, false);
	assert!(text.contains("Accept: ast_edit: rename 3 symbols"), "{text}");

	let exact_input = node(
		KnownTag::Input,
		r#"{"proposal_id":"pending-action:ast_edit:7","reason":"Apply reviewed rewrite."}"#,
	);
	let exact_result = node(
		KnownTag::Result,
		r#"{"id":"pending-action:ast_edit:7","decision":{"resolve":{"reason":"Apply reviewed rewrite."}},"payload":{}}"#,
	);
	let text = render("resolve", &exact_input, Some(&exact_result), None, CardStatus::Done, false);
	assert!(text.contains("Accept: pending-action:ast_edit:7"), "{text}");
	assert!(text.contains("Apply reviewed rewrite."), "{text}");

	let diag = fault_node("revision changed");
	let text = render("resolve", &input, None, Some(&diag), CardStatus::Failed, false);
	assert!(text.contains("Failed: pending action"), "{text}");
	let text = render("reject", &input, None, Some(&diag), CardStatus::Failed, false);
	assert!(text.contains("Discard: pending action"), "{text}");

	let empty = node(KnownTag::Input, "{}");
	let text = render("reject", &empty, Some(&settled), None, CardStatus::Done, false);
	assert!(text.contains("No reason provided"), "{text}");
	let text = render("resolve", &input, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("⟨proposed -> resolved⟩"), "{text}");
	let text = render("reject", &input, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("⟨proposed -> rejected⟩"), "{text}");
}

fn search_payload(sources: Vec<Value>) -> Value {
	json!({"response": {"engine": "exa", "answer": "answer text", "sources": sources}})
}

#[test]
fn web_search_card_only_shows_reported_ages_and_folds_when_collapsed() {
	let text = render_done::<omp_tools::web_search::Payload>(
		"web_search",
		r#"{"query":"q"}"#,
		search_payload(vec![
			json!({"url":"https://a.example/x","title":"Undated"}),
			json!({"url":"https://b.example/y","title":"Dated","published_at":"2026-08-22"}),
		]),
		false,
	);
	assert!(!text.contains("ago"), "no age may be invented: {text}");
	assert!(text.contains("Dated (b.example) · 2026-08-22"), "{text}");
	assert!(text.contains("Undated (a.example)"), "{text}");
	assert!(!text.contains("Undated (a.example) ·"), "{text}");

	// A Unix-seconds `published_at` (the facade's encoding) becomes a real
	// relative age.
	let now = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock after epoch")
		.as_secs();
	let text = render_done::<omp_tools::web_search::Payload>(
		"web_search",
		r#"{"query":"q"}"#,
		search_payload(vec![json!({
			"url":"https://c.example/z","title":"Recent",
			"published_at": (now - 3 * 86_400).to_string()
		})]),
		false,
	);
	assert!(text.contains("Recent (c.example) · 3d ago"), "{text}");

	let many = (0..10)
		.map(
			|index| json!({"url": format!("https://s{index}.example/"), "title": format!("Source {index}")}),
		)
		.collect::<Vec<_>>();
	let collapsed = render_done::<omp_tools::web_search::Payload>(
		"web_search",
		r#"{"query":"q"}"#,
		search_payload(many.clone()),
		false,
	);
	assert!(collapsed.contains("Source 7"), "{collapsed}");
	assert!(!collapsed.contains("Source 8"), "{collapsed}");
	assert!(collapsed.contains("… 2 more sources"), "{collapsed}");
	let expanded = render_done::<omp_tools::web_search::Payload>(
		"web_search",
		r#"{"query":"q"}"#,
		search_payload(many),
		true,
	);
	assert!(expanded.contains("Source 9"), "{expanded}");
	assert!(!expanded.contains("more sources"), "{expanded}");
}

#[test]
fn ask_card_shows_custom_input_note_and_timeout() {
	let args = json!({"questions":[{
		"id":"db","question":"Which database?",
		"options":[{"label":"Postgres"},{"label":"SQLite"}]
	}]});
	let text = render_done::<omp_tools::ask::Payload>(
		"ask",
		&args.to_string(),
		json!({"answers":[{
			"id":"db","question":"Which database?","options":["Postgres","SQLite"],"multi":false,
			"selected":[],"customInput":"CockroachDB\nwith the serverless tier",
			"note":"decided with ops","timed_out":false
		}]}),
		false,
	);
	assert!(text.contains("CockroachDB"), "{text}");
	assert!(text.contains("with the serverless tier"), "{text}");
	assert!(text.contains("Note: decided with ops"), "{text}");
	assert!(!text.contains("timeout"), "{text}");

	let text = render_done::<omp_tools::ask::Payload>(
		"ask",
		&args.to_string(),
		json!({"answers":[{
			"id":"db","question":"Which database?","options":["Postgres","SQLite"],"multi":false,
			"selected":["Postgres"],"timed_out":true
		}]}),
		false,
	);
	assert!(text.contains("auto-selected after timeout"), "{text}");
}

fn glob_payload(count: usize) -> Value {
	let matches = (0..count)
		.map(
			|index| json!({"path": format!("src/file{index:02}.rs"), "modified_ms": 0, "is_dir": false}),
		)
		.collect::<Vec<_>>();
	json!({"matches": matches, "missing_paths": [], "timed_out": false, "truncated": false,
		"result_limit_reached": null, "partial_match_count": count, "timeout_ms": 0,
		"projected_text": "", "output_blob": null, "output_artifact_uri": null,
		"output_shown_lines": count, "output_total_lines": count})
}

#[test]
fn glob_card_folds_the_listing_when_collapsed() {
	let collapsed = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"src/**/*.rs"}"#,
		glob_payload(12),
		false,
	);
	assert!(collapsed.contains("file07.rs"), "{collapsed}");
	assert!(!collapsed.contains("file08.rs"), "{collapsed}");
	assert!(collapsed.contains("… 4 more files"), "{collapsed}");
	assert!(collapsed.contains("12 files"), "{collapsed}");
	let expanded = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"src/**/*.rs"}"#,
		glob_payload(12),
		true,
	);
	assert!(expanded.contains("file11.rs"), "{expanded}");
	assert!(!expanded.contains("more files"), "{expanded}");
	let small = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"src/**/*.rs"}"#,
		glob_payload(8),
		false,
	);
	assert!(!small.contains("more files"), "{small}");
}

#[test]
fn glob_card_distinguishes_empty_from_incomplete_and_surfaces_warnings() {
	let timed_out = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"cache/**/*.bin"}"#,
		json!({
			"matches": [],
			"missing_paths": ["gone"],
			"timed_out": true,
			"truncated": true,
			"result_limit_reached": null,
			"partial_match_count": 0,
			"timeout_ms": 5000
		}),
		false,
	);
	assert!(timed_out.contains("No matches before timeout (scan incomplete)"), "{timed_out}");
	assert!(timed_out.contains("timed out; results are incomplete"), "{timed_out}");
	assert!(timed_out.contains("skipped missing: gone"), "{timed_out}");
	assert!(!timed_out.contains("No files found"), "{timed_out}");

	let empty = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"src/*.zig"}"#,
		json!({
			"matches": [],
			"missing_paths": [],
			"timed_out": false,
			"truncated": false,
			"result_limit_reached": null,
			"partial_match_count": 0,
			"timeout_ms": 5000
		}),
		false,
	);
	assert!(empty.contains("No files found"), "{empty}");
	assert!(!empty.contains("incomplete"), "{empty}");

	let limited = render_done::<omp_tools::glob::Payload>(
		"glob",
		r#"{"path":"src/*.rs","limit":1}"#,
		json!({
			"matches": [{"path":"src/lib.rs","modified_ms":1,"is_dir":false}],
			"missing_paths": [],
			"timed_out": false,
			"truncated": true,
			"result_limit_reached": 1,
			"partial_match_count": 2,
			"timeout_ms": 5000
		}),
		false,
	);
	assert!(limited.contains("1 file · in src"), "{limited}");
	assert!(limited.contains("truncated: limit 1 results"), "{limited}");
	assert!(!limited.contains("2 files"), "{limited}");
}

#[test]
fn read_card_caps_the_preview_when_collapsed() {
	let preview = (1..=20)
		.map(|line| format!("line {line}"))
		.collect::<Vec<_>>()
		.join("\n");
	let payload = json!({"parts": [{"kind": "text", "text": preview}], "artifacts": []});
	let collapsed = render_done::<omp_tools::read::Payload>(
		"read",
		r#"{"path":"notes.txt"}"#,
		payload.clone(),
		false,
	);
	assert!(collapsed.contains("line 12"), "{collapsed}");
	assert!(!collapsed.contains("line 13"), "{collapsed}");
	assert!(collapsed.contains("… 8 more lines ⟨Ctrl+O: Expand⟩"), "{collapsed}");
	let expanded =
		render_done::<omp_tools::read::Payload>("read", r#"{"path":"notes.txt"}"#, payload, true);
	assert!(expanded.contains("line 20"), "{expanded}");
	assert!(!expanded.contains("more lines"), "{expanded}");
}

#[test]
fn computer_card_previews_code_and_output_when_collapsed() {
	let code = (1..=14)
		.map(|line| format!("await desktop.step({line});"))
		.collect::<Vec<_>>()
		.join("\n");
	let results = (1..=5)
		.map(|index| json!({"step": index}))
		.collect::<Vec<_>>();
	let payload = json!({"code": code, "results": results, "artifacts": []});
	let collapsed = render_done::<omp_tools::computer::Payload>(
		"computer",
		r#"{"action":"run","code":"x"}"#,
		payload.clone(),
		false,
	);
	assert!(collapsed.contains("Code"), "{collapsed}");
	assert!(collapsed.contains("desktop.step(10)"), "{collapsed}");
	assert!(!collapsed.contains("desktop.step(11)"), "{collapsed}");
	assert!(collapsed.contains("… 4 more lines"), "{collapsed}");
	assert!(collapsed.contains("Output"), "{collapsed}");
	let expanded = render_done::<omp_tools::computer::Payload>(
		"computer",
		r#"{"action":"run","code":"x"}"#,
		payload,
		true,
	);
	assert!(expanded.contains("desktop.step(14)"), "{expanded}");
	assert!(!expanded.contains("… 4 more lines"), "{expanded}");
	// Output stays bounded even when expanded: the
	// 17-line pretty JSON shows ten rows and folds the rest.
	assert!(expanded.contains("… 7 more lines"), "{expanded}");
	assert!(collapsed.contains("… 14 more lines"), "{collapsed}");

	// No script (an old persisted call): the bare header, nothing invented.
	let bare = render_done::<omp_tools::computer::Payload>(
		"computer",
		"{}",
		json!({"code": "", "results": [], "artifacts": []}),
		false,
	);
	assert!(bare.contains("Computer"), "{bare}");
	assert!(!bare.contains("Code"), "{bare}");

	// A failed script names the error state in the header and shows the
	// fault beneath the script.
	let input = node(KnownTag::Input, r#"{"action":"run","code":"await desktop.click(1, 2)"}"#);
	let diag = fault_node("input permission denied");
	let failed = render("computer", &input, None, Some(&diag), CardStatus::Failed, false);
	assert!(failed.contains("Computer: error"), "{failed}");
	assert!(failed.contains("desktop.click(1, 2)"), "{failed}");
	assert!(failed.contains("input permission denied"), "{failed}");
}

#[test]
fn hub_cancel_is_a_job_card_not_the_generic_fallback() {
	// Pending jobs render as `cancel <id>`.
	let input = node(KnownTag::Input, r#"{"op":"cancel","ids":["bash_a1b2c3"]}"#);
	let pending = render("hub", &input, None, None, CardStatus::InProgress, false);
	assert!(pending.contains("cancel bash_a1b2c3"), "{pending}");
	assert!(!pending.contains("poll"), "{pending}");

	// Settled: the backend's `{cancelled: N}` receipt names the count and
	// the requested ids; nothing reads as the unformatted "Hub" card.
	let settled = render_done::<omp_tools::hub::Response>(
		"hub",
		r#"{"op":"cancel","ids":["bash_a1b2c3","AuthLoader"]}"#,
		json!({"text": "{\"cancelled\":2}", "useless": false}),
		false,
	);
	assert!(settled.contains("cancel 2 jobs"), "{settled}");
	assert!(settled.contains("2 cancelled"), "{settled}");
	assert!(settled.contains("bash_a1b2c3"), "{settled}");
	assert!(settled.contains("AuthLoader"), "{settled}");
	assert!(!settled.contains("Hub"), "{settled}");

	// A partial receipt says how many ids matched nothing.
	let partial = render_done::<omp_tools::hub::Response>(
		"hub",
		r#"{"op":"cancel","ids":["bash_a1b2c3","gone"]}"#,
		json!({"text": "{\"cancelled\":1}", "useless": false}),
		false,
	);
	assert!(partial.contains("1 cancelled"), "{partial}");
	assert!(partial.contains("1 not found"), "{partial}");
}

/// Whether any rendered row, trimmed of padding and box borders, equals
/// `needle` exactly.
fn has_bare_row(text: &str, needle: &str) -> bool {
	text
		.lines()
		.any(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '│') == needle)
}

#[test]
fn write_card_numbers_every_streamed_line_sequentially() {
	let one = node(KnownTag::Input, r#"{"path":"a.ts","content":"const a = 1;\n"}"#);
	let text = render("write", &one, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("  1 const a = 1;"), "{text}");
	assert!(has_bare_row(&text, "2"), "the trailing newline yields an empty row 2: {text}");
	assert!(!has_bare_row(&text, "3"), "never a literal row 3: {text}");

	let body = (1..=10)
		.map(|line| format!("line{line}();"))
		.collect::<Vec<_>>()
		.join("\n");
	let ten = node(KnownTag::Input, &json!({"path": "a.ts", "content": body}).to_string());
	let text = render("write", &ten, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("  3 line3();"), "{text}");
	assert!(text.contains(" 10 line10();"), "{text}");
	assert!(!has_bare_row(&text, "3"), "{text}");
	assert!(!text.contains("11"), "{text}");

	// Collapsed streaming follows the edge with a 12-row tail window.
	let body = (1..=20)
		.map(|line| format!("line{line}();"))
		.collect::<Vec<_>>()
		.join("\n");
	let long = node(KnownTag::Input, &json!({"path": "a.ts", "content": body}).to_string());
	let collapsed = render("write", &long, None, None, CardStatus::StreamingArgs, false);
	assert!(collapsed.contains("… (8 earlier lines)"), "{collapsed}");
	assert!(collapsed.contains("  9 line9();"), "{collapsed}");
	assert!(!collapsed.contains("  8 line8();"), "{collapsed}");
	assert!(collapsed.contains(" 20 line20();"), "{collapsed}");
	let expanded = render("write", &long, None, None, CardStatus::StreamingArgs, true);
	assert!(expanded.contains("  1 line1();"), "{expanded}");
	assert!(!expanded.contains("earlier lines"), "{expanded}");
}

#[test]
fn lsp_card_shows_the_output_projection_when_there_are_no_references() {
	let hover = render_done::<omp_tools::lsp::Payload>(
		"lsp",
		r#"{"action":"hover","file":"src/lib.rs","line":4}"#,
		json!({"action": "hover", "servers": ["rust-analyzer"],
			"output": "```rust\npub fn parse(input: &str) -> Result<Ast, Error>\n```\nParses one expression.",
			"data": {"contents": "…"}}),
		false,
	);
	assert!(hover.contains("Response"), "{hover}");
	assert!(hover.contains("```rust"), "{hover}");
	assert!(hover.contains("pub fn parse"), "{hover}");
	assert!(hover.contains("⟨Ctrl+O: Expand⟩"), "{hover}");

	let none = render_done::<omp_tools::lsp::Payload>(
		"lsp",
		r#"{"action":"references","file":"src/lib.rs","line":4}"#,
		json!({"action": "references", "servers": ["rust-analyzer"], "output": "",
			"data": []}),
		false,
	);
	assert!(none.contains("No output"), "{none}");

	let references = render_done::<omp_tools::lsp::Payload>(
		"lsp",
		r#"{"action":"references","file":"src/lib.rs","line":4,"symbol":"parse"}"#,
		json!({"action": "references", "servers": ["rust-analyzer"],
		"output": "Found 2 references:\n  /tmp/src/lib.rs:4:8\n  /tmp/src/lib.rs:12:3",
		"data": [
			{"uri":"file:///tmp/src/lib.rs","range":{"start":{"line":3,"character":7},"end":{"line":3,"character":12}}},
			{"uri":"file:///tmp/src/lib.rs","range":{"start":{"line":11,"character":2},"end":{"line":11,"character":7}}}
		]}),
		true,
	);
	assert!(references.contains("2 found"), "{references}");
	assert!(references.contains("/tmp/src/lib.rs"), "{references}");
	assert!(references.contains("line 4, col 8"), "{references}");
	assert!(references.contains("at /tmp/src/lib.rs:12:3"), "{references}");

	let many = (1..=8)
		.map(|line| format!("row {line}"))
		.collect::<Vec<_>>()
		.join("\n");
	let symbols = render_done::<omp_tools::lsp::Payload>(
		"lsp",
		r#"{"action":"symbols","query":"Parser"}"#,
		json!({"action": "symbols", "servers": [], "output": many, "data": []}),
		false,
	);
	assert!(symbols.contains("row 1"), "{symbols}");
	assert!(symbols.contains("row 4"), "{symbols}");
	assert!(!symbols.contains("row 5"), "{symbols}");
	assert!(symbols.contains("… 4 more lines"), "{symbols}");
	let expanded = render_done::<omp_tools::lsp::Payload>(
		"lsp",
		r#"{"action":"symbols","query":"Parser"}"#,
		json!({"action": "symbols", "servers": [], "output":
			(1..=8).map(|line| format!("row {line}")).collect::<Vec<_>>().join("\n"), "data": []}),
		true,
	);
	assert!(expanded.contains("row 8"), "{expanded}");
	assert!(!expanded.contains("more lines"), "{expanded}");
}

#[test]
fn debug_card_omits_the_session_block_and_paints_command_output() {
	let evaluated = render_done::<omp_tools::debug::Payload>(
		"debug",
		r#"{"action":"evaluate","expression":"user.id"}"#,
		json!({"action": "evaluate", "session": "dbg-1", "revision": 3,
			"output": "42\nline two\nline three\nline four", "data": {"result": "42"}}),
		false,
	);
	assert!(!evaluated.contains("Session"), "{evaluated}");
	assert!(!evaluated.contains("Adapter:"), "{evaluated}");
	assert!(!evaluated.contains("Stack trace"), "{evaluated}");
	assert!(evaluated.contains("Output"), "{evaluated}");
	assert!(evaluated.contains("42"), "{evaluated}");
	assert!(evaluated.contains("line three"), "{evaluated}");
	assert!(!evaluated.contains("line four"), "{evaluated}");
	assert!(evaluated.contains("… 1 more lines ⟨Ctrl+O: Expand⟩"), "{evaluated}");

	let empty = render_done::<omp_tools::debug::Payload>(
		"debug",
		r#"{"action":"set_breakpoint","file":"src/main.c","line":42}"#,
		json!({"action": "set_breakpoint", "session": "dbg-1", "revision": 4,
			"output": "", "data": {"verified": true}}),
		false,
	);
	assert!(empty.contains("No output"), "{empty}");
	assert!(!empty.contains("Location: ::0"), "{empty}");

	// A snapshot-bearing result still paints the session block and frames.
	let stack = render_done::<omp_tools::debug::Payload>(
		"debug",
		r#"{"action":"stack_trace"}"#,
		json!({"action": "stack_trace", "session": "dbg-1", "revision": 5, "output": "frames",
			"data": {"session": {"id": "dbg-1", "adapter": "debugpy", "status": "stopped",
				"path": "app.py", "line": 4, "col": 1},
				"frames": [{"id": 1, "name": "main", "path": "app.py", "line": 4, "col": 1}]}}),
		false,
	);
	assert!(stack.contains("Session dbg-1"), "{stack}");
	assert!(stack.contains("Stack trace:"), "{stack}");
	assert!(stack.contains("#1 main @ app.py:4:1"), "{stack}");
}

#[test]
fn github_card_titles_every_operation_with_its_target() {
	let checkout = node(
		KnownTag::Input,
		r#"{"op":"pr_checkout","pr":["https://github.com/o/r/pull/42","17"],"repo":"o/r"}"#,
	);
	let text = render("github", &checkout, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub PR Checkout #42, #17 · o/r"), "{text}");

	let push = node(KnownTag::Input, r#"{"op":"pr_push","branch":"feat/x","forceWithLease":true}"#);
	let text = render("github", &push, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub PR Push feat/x"), "{text}");

	let file = node(
		KnownTag::Input,
		r#"{"op":"file_read","repo":"o/r","path":"src/lib.rs","branch":"main"}"#,
	);
	let text = render("github", &file, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub File src/lib.rs · o/r · main"), "{text}");

	let create = node(
		KnownTag::Input,
		r#"{"op":"pr_create","title":"Add cards","head":"feat/cards","base":"main"}"#,
	);
	let text = render("github", &create, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub PR Create Add cards · feat/cards -> main"), "{text}");

	let repos = node(KnownTag::Input, r#"{"op":"search_repos","query":"org:o language:rust"}"#);
	let text = render("github", &repos, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub Search Repos org:o language:rust"), "{text}");

	// The search heading is unchanged from the gallery reference.
	let prs = node(KnownTag::Input, r#"{"op":"search_prs","query":"is:open","repo":"o/r"}"#);
	let text = render("github", &prs, None, None, CardStatus::InProgress, false);
	assert!(text.contains("GitHub Search PRs is:open · o/r"), "{text}");
}

fn ast_match(path: &str, line: usize, text: &str) -> Value {
	json!({"path": path, "line": line, "column": 1, "end_line": line, "end_column": 10,
		"text": text, "bindings": ""})
}

#[test]
fn ast_grep_card_previews_directory_groups_that_fit_when_collapsed() {
	// Blank-line directory groups show whole when their rows (plus the reserved
	// summary
	// row) fit, and the summary counts hidden groups.
	let small = render_done::<omp_tools::ast_grep::Payload>(
		"ast_grep",
		r#"{"pat":"hit_$N()","path":"src"}"#,
		json!({"matches": [
			ast_match("src/a.rs", 1, "hit_1()"),
			ast_match("src/a.rs", 2, "hit_2()"),
			ast_match("src/b.rs", 3, "hit_3()"),
		], "advisories": [], "advisories_total": 0, "parse_errors": [],
			"parse_errors_total": 0, "total": 3, "files_with_matches": 2,
			"files_searched": 2, "skip": 0, "limit": 100, "limit_reached": false,
			"next_skip": null}),
		false,
	);
	assert!(small.contains("# src/"), "{small}");
	assert!(small.contains("## a.rs"), "{small}");
	assert!(small.contains("hit_1()"), "{small}");
	assert!(small.contains("hit_3()"), "{small}");
	assert!(!small.contains("more match"), "{small}");

	let payload = json!({"matches": [
		ast_match("src/a.rs", 1, "hit_1()"),
		ast_match("src/a.rs", 2, "hit_2()"),
		ast_match("lib/b.rs", 3, "hit_3()"),
		ast_match("lib/b.rs", 4, "hit_4()"),
	], "advisories": [], "advisories_total": 0, "parse_errors": [],
		"parse_errors_total": 0, "total": 4, "files_with_matches": 2,
		"files_searched": 2, "skip": 0, "limit": 100, "limit_reached": false,
		"next_skip": null});
	let collapsed = render_done::<omp_tools::ast_grep::Payload>(
		"ast_grep",
		r#"{"pat":"hit_$N()","path":"."}"#,
		payload.clone(),
		false,
	);
	// `lib/` sorts first and fits (4 rows + 1 reserved); adding `src/`
	// would take the tree to 8 rows, so it folds into the summary.
	assert!(collapsed.contains("# lib/"), "{collapsed}");
	assert!(collapsed.contains("hit_3()"), "{collapsed}");
	assert!(collapsed.contains("hit_4()"), "{collapsed}");
	assert!(!collapsed.contains("hit_1()"), "{collapsed}");
	assert!(collapsed.contains("… 1 more group"), "{collapsed}");
	let expanded = render_done::<omp_tools::ast_grep::Payload>(
		"ast_grep",
		r#"{"pat":"hit_$N()","path":"."}"#,
		payload,
		true,
	);
	assert!(expanded.contains("# src/"), "{expanded}");
	assert!(expanded.contains("hit_1()"), "{expanded}");
	assert!(!expanded.contains("more group"), "{expanded}");
}

fn grep_file(path: &str, lines: &[u32]) -> Value {
	let matches = lines
		.iter()
		.map(|line| {
			json!({"line_number": line, "line": format!("useState({line})"),
			"truncated": false, "context_before": [], "context_after": []})
		})
		.collect::<Vec<_>>();
	json!({"path": path, "source_key": path, "snapshot_tag": null, "matches": matches})
}

fn grep_payload(files: Vec<Value>) -> Value {
	json!({"files": files, "total_files": files.len(), "total_files_lower_bound": false,
		"multi_scope": true, "skip": 0, "file_limit_reached": false,
		"per_file_limit_reached": false, "notes": [], "projected_text": "",
		"output_blob": null, "output_artifact_uri": null,
		"output_shown_lines": 0, "output_total_lines": 0})
}

#[test]
fn grep_card_renders_empty_state() {
	let empty = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"absent"}"#,
		json!({"files": [], "total_files": 0, "total_files_lower_bound": false,
			"multi_scope": true, "skip": 0, "file_limit_reached": false,
			"per_file_limit_reached": false}),
		false,
	);
	assert!(empty.contains("0 matches · in ."), "{empty}");
	assert!(empty.contains("No matches found"), "{empty}");
}

#[test]
fn grep_card_hidden_count_matches_the_rows_it_paints() {
	// One hot file with 30 matches: the collapsed tree paints a bounded
	// prefix and the summary counts exactly what it hid.
	let lines = (1..=30).collect::<Vec<u32>>();
	let hot = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"useState","path":"src"}"#,
		grep_payload(vec![grep_file("src/a.tsx", &lines)]),
		false,
	);
	let painted = hot.matches("useState(").count();
	assert_eq!(painted, 3, "{hot}");
	assert!(hot.contains("… 27 more matches"), "{hot}");

	// The gallery shape: 5 matches across 3 files in 2 directories paints
	// two rows of the first file plus the next file header, then `3 more`.
	let gallery = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"useState","path":"src"}"#,
		grep_payload(vec![
			grep_file("src/components/SearchBox.tsx", &[18, 19]),
			grep_file("src/components/StatusBar.tsx", &[27]),
			grep_file("src/hooks/useDebounced.ts", &[9, 10]),
		]),
		false,
	);
	assert!(gallery.contains("useState(18)"), "{gallery}");
	assert!(gallery.contains("useState(19)"), "{gallery}");
	assert!(gallery.contains("## StatusBar.tsx"), "{gallery}");
	assert!(!gallery.contains("useState(27)"), "{gallery}");
	assert!(gallery.contains("… 3 more matches"), "{gallery}");

	let expanded = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"useState","path":"src"}"#,
		grep_payload(vec![grep_file("src/a.tsx", &lines)]),
		true,
	);
	assert_eq!(expanded.matches("useState(").count(), 21, "{expanded}");
	assert!(expanded.contains("… 9 more matches"), "{expanded}");
}

#[test]
fn grep_card_expansion_reveals_context_without_repeating_overlaps() {
	let file = json!({
		"path": "src/context.rs",
		"source_key": "src/context.rs",
		"snapshot_tag": null,
		"matches": [
			{"line_number": 3, "line": "needle one", "truncated": false,
			 "context_before": [{"line_number": 2, "line": "before"}],
			 "context_after": [{"line_number": 4, "line": "shared"}]},
			{"line_number": 5, "line": "needle two", "truncated": false,
			 "context_before": [{"line_number": 4, "line": "shared"}],
			 "context_after": [{"line_number": 8, "line": "after gap"}]}
		]
	});
	let payload = grep_payload(vec![file]);
	let collapsed = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"needle","path":"src/context.rs"}"#,
		payload.clone(),
		false,
	);
	assert!(collapsed.contains("*3│needle one"), "{collapsed}");
	assert!(collapsed.contains("*5│needle two"), "{collapsed}");
	assert!(!collapsed.contains("before"), "{collapsed}");
	assert!(!collapsed.contains("shared"), "{collapsed}");

	let expanded = render_done::<omp_tools::grep::Payload>(
		"grep",
		r#"{"pattern":"needle","path":"src/context.rs"}"#,
		payload,
		true,
	);
	assert!(expanded.contains(" 2│before"), "{expanded}");
	assert_eq!(expanded.matches(" 4│shared").count(), 1, "{expanded}");
	assert!(expanded.contains("..."), "{expanded}");
	assert!(expanded.contains(" 8│after gap"), "{expanded}");
}

fn todo_phase(name: &str, tasks: &[(&str, &str)]) -> Value {
	let tasks = tasks
		.iter()
		.map(|(content, status)| json!({"content": content, "status": status}))
		.collect::<Vec<_>>();
	json!({"name": name, "tasks": tasks})
}

#[test]
fn todo_card_folds_untouched_phases_and_caps_rows_when_collapsed() {
	let active_tasks = (1..=12)
		.map(|index| format!("Item-{index:02}"))
		.collect::<Vec<_>>();
	let active = active_tasks
		.iter()
		.enumerate()
		.map(|(index, content)| {
			let status = match index {
				0 => "completed",
				1 => "in_progress",
				_ => "pending",
			};
			(content.as_str(), status)
		})
		.collect::<Vec<_>>();
	let payload = json!({"op": "start", "phases": [
		todo_phase("Foundation", &[("Scaffold", "completed"), ("Wire", "completed")]),
		todo_phase("Build", &active),
		todo_phase("Ship", &[("Tag", "pending"), ("Publish", "pending")]),
	], "completed_tasks": []});
	let collapsed = render_done::<omp_tools::todo::Payload>(
		"todo",
		r#"{"op":"start","task":"Item-02"}"#,
		payload.clone(),
		false,
	);
	// Untouched phases fold to their heading and progress.
	assert!(collapsed.contains("I. Foundation"), "{collapsed}");
	assert!(collapsed.contains("2/2"), "{collapsed}");
	assert!(!collapsed.contains("Scaffold"), "{collapsed}");
	assert!(collapsed.contains("III. Ship"), "{collapsed}");
	assert!(!collapsed.contains("Publish"), "{collapsed}");
	// The touched phase shows the last closed row, the active row, and the
	// pending rows after it up to the cap, then the hidden count.
	assert!(collapsed.contains("Item-01"), "{collapsed}");
	assert!(collapsed.contains("Item-02"), "{collapsed}");
	assert!(collapsed.contains("Item-09"), "{collapsed}");
	assert!(!collapsed.contains("Item-10"), "{collapsed}");
	assert!(collapsed.contains("… 3 more todos"), "{collapsed}");
	assert!(collapsed.contains("Todo 16 tasks"), "{collapsed}");

	let expanded = render_done::<omp_tools::todo::Payload>(
		"todo",
		r#"{"op":"start","task":"Item-02"}"#,
		payload,
		true,
	);
	assert!(expanded.contains("Scaffold"), "{expanded}");
	assert!(expanded.contains("Item-12"), "{expanded}");
	assert!(expanded.contains("Publish"), "{expanded}");
	assert!(!expanded.contains("more todos"), "{expanded}");
}

#[test]
fn browser_card_caps_script_and_output_when_collapsed() {
	let code = (1..=14)
		.map(|line| format!("await tab.step({line});"))
		.collect::<Vec<_>>()
		.join("\n");
	let returned = (1..=14)
		.map(|line| format!("row {line}"))
		.collect::<Vec<_>>()
		.join("\n");
	let args = json!({"action": "run", "code": code}).to_string();
	let payload = json!({"action": "run", "name": "main", "url": "https://x.test/", "title": null,
		"result": returned, "artifacts": []});
	let collapsed =
		render_done::<omp_tools::browser::Payload>("browser", &args, payload.clone(), false);
	assert!(collapsed.contains("tab.step(10)"), "{collapsed}");
	assert!(!collapsed.contains("tab.step(11)"), "{collapsed}");
	assert!(collapsed.contains("row 10"), "{collapsed}");
	assert!(!collapsed.contains("row 11"), "{collapsed}");
	assert_eq!(collapsed.matches("… 4 more lines").count(), 2, "{collapsed}");
	let expanded = render_done::<omp_tools::browser::Payload>("browser", &args, payload, true);
	assert!(expanded.contains("tab.step(14)"), "{expanded}");
	assert!(expanded.contains("row 14"), "{expanded}");
	assert!(!expanded.contains("more lines"), "{expanded}");
}

#[test]
fn recall_card_is_header_only_when_collapsed_and_warns_on_no_matches() {
	let items = (1..=12)
		.map(|index| {
			json!({
				"memory": {
					"id": format!("mem-{index}"), "bank": "global", "tier": "working",
					"content": format!("memory {index}"), "source": null, "session_id": "s",
					"timestamp": "2026-01-01T00:00:00Z", "importance": 0.5, "veracity": "observed",
					"memory_type": "fact", "metadata": {}, "superseded_by": null
				},
				"score": 0.5,
				"voice_scores": {"vector": 0.0, "graph": 0.0, "episodic": 0.0, "working": 0.0},
				"broadened": false
			})
		})
		.collect::<Vec<_>>();
	let payload = json!({"query": "q", "items": items});
	let collapsed = render_done::<omp_tools::memory::RecallPayload>(
		"recall",
		r#"{"query":"q"}"#,
		payload.clone(),
		false,
	);
	assert!(collapsed.contains("12 found"), "{collapsed}");
	assert!(collapsed.contains("⟨Ctrl+O: Expand⟩"), "{collapsed}");
	assert!(
		!collapsed.contains("memory 1"),
		"the collapsed recall stays at its header: {collapsed}"
	);
	let expanded =
		render_done::<omp_tools::memory::RecallPayload>("recall", r#"{"query":"q"}"#, payload, true);
	assert!(expanded.contains("memory 10"), "{expanded}");
	assert!(!expanded.contains("memory 11"), "{expanded}");
	assert!(expanded.contains("… 2 more memories"), "{expanded}");

	let none = render_done::<omp_tools::memory::RecallPayload>(
		"recall",
		r#"{"query":"q"}"#,
		json!({"query": "q", "items": []}),
		false,
	);
	assert!(none.contains("no matches"), "{none}");
	assert!(!none.contains("Expand"), "{none}");
}

fn lang_glyph(name: &str) -> &'static str {
	UiContext::default()
		.charset
		.icon_named(name)
		.expect("catalog language icon")
}

#[test]
fn edit_card_paints_the_language_icon_of_the_edited_path() {
	// The path language picks the `lang.*` glyph, so a Rust edit never wears
	// the TypeScript badge.
	let rust = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("src/main.rs", "update", None, "@@ -1,1 +1,1 @@\n-a\n+b")]}),
		false,
	);
	assert!(rust.contains(lang_glyph("rust")), "{rust}");
	assert!(!rust.contains(lang_glyph("typescript")), "{rust}");

	let ts = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("src/app.tsx", "update", None, "@@ -1,1 +1,1 @@\n-a\n+b")]}),
		false,
	);
	assert!(ts.contains(lang_glyph("typescript")), "{ts}");

	// Delete and move rows carry the icon of the (source) path.
	let delete = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("README.md", "delete", None, "")]}),
		false,
	);
	assert!(delete.contains(lang_glyph("markdown")), "{delete}");
	let moved = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("Cargo.toml", "move", Some("Cargo.toml.bak"), "")]}),
		false,
	);
	assert!(moved.contains(lang_glyph("toml")), "{moved}");

	// Unknown extensions fall back to `"text"`; extensionless names without an
	// icon paint `lang.default`.
	let unknown = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("notes.xyz", "update", None, "@@ -1,1 +1,1 @@\n-a\n+b")]}),
		false,
	);
	assert!(unknown.contains(lang_glyph("text")), "{unknown}");
	let makefile = render_done::<omp_tools::edit::Payload>(
		"edit",
		"{}",
		json!({"sections":[section("Makefile", "update", None, "@@ -1,1 +1,1 @@\n-a\n+b")]}),
		false,
	);
	assert!(makefile.contains(lang_glyph("default")), "{makefile}");
	assert!(!makefile.contains(lang_glyph("text")), "{makefile}");

	// The streaming preview reads the path from the arguments.
	let streaming =
		node(KnownTag::Input, r#"{"path":"scripts/run.py","previewDiff":"@@ -1,1 +1,1 @@\n-a\n+b"}"#);
	let text = render("edit", &streaming, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains(lang_glyph("python")), "{text}");
}

#[test]
fn write_card_paints_the_language_icon_of_the_written_path() {
	let streaming = node(KnownTag::Input, r#"{"path":"src/lib.rs","content":"fn main() {}\n"}"#);
	let text = render("write", &streaming, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains(lang_glyph("rust")), "{text}");
	assert!(!text.contains(lang_glyph("typescript")), "{text}");

	let done = render_done::<omp_tools::write::Payload>(
		"write",
		r##"{"path":"docs/guide.md","content":"# Guide\n"}"##,
		json!({"resolved_path": "/w/docs/guide.md", "display_path": "docs/guide.md",
			"byte_len": 8, "reported_len": 8, "disposition": "created", "stripped_wrapper": false,
			"made_executable": false, "snapshot_tag": null, "operation": {"kind": "plain"}}),
		false,
	);
	assert!(done.contains(lang_glyph("markdown")), "{done}");
	assert!(!done.contains(lang_glyph("typescript")), "{done}");

	let failed = node(KnownTag::Input, r#"{"path":"config.yml","content":"a: 1\n"}"#);
	let diag = fault_node("permission denied");
	let text = render("write", &failed, None, Some(&diag), CardStatus::Failed, false);
	assert!(text.contains(lang_glyph("yaml")), "{text}");
}

#[test]
fn glob_card_paints_each_file_with_its_own_language_icon() {
	let payload = json!({"matches": [
		{"path": "src/main.rs", "modified_ms": 0, "is_dir": false},
		{"path": "web/index.html", "modified_ms": 0, "is_dir": false},
		{"path": ".gitignore", "modified_ms": 0, "is_dir": false},
	], "missing_paths": [], "timed_out": false, "truncated": false,
		"result_limit_reached": null, "partial_match_count": 3, "timeout_ms": 0,
		"projected_text": "", "output_blob": null, "output_artifact_uri": null,
		"output_shown_lines": 3, "output_total_lines": 3});
	let text = render_done::<omp_tools::glob::Payload>("glob", r#"{"path":"**/*"}"#, payload, false);
	for (path, icon) in [("src/main.rs", "rust"), ("web/index.html", "html"), (".gitignore", "conf")]
	{
		let row = text
			.lines()
			.find(|line| line.contains(path))
			.unwrap_or_else(|| panic!("missing {path} in {text}"));
		assert!(row.contains(lang_glyph(icon)), "{path} row lacks {icon}: {row}");
	}
	assert!(!text.contains(lang_glyph("typescript")), "{text}");
}

#[test]
fn card_status_spellings_round_trip_through_the_dom_vocabulary() {
	for (spelling, status) in [
		("arguments", CardStatus::StreamingArgs),
		("running", CardStatus::InProgress),
		("ok", CardStatus::Done),
		("error", CardStatus::Failed),
	] {
		assert_eq!(CardStatus::from_dom(spelling), status);
		assert_eq!(status.as_str(), spelling);
	}
	// The DOM's other terminal-failure spellings fold onto `Failed`, whose
	// canonical spelling stays `error`; unknown running states are in-progress.
	assert_eq!(CardStatus::from_dom("cancelled"), CardStatus::Failed);
	assert_eq!(CardStatus::from_dom("aborted"), CardStatus::Failed);
	assert_eq!(CardStatus::Failed.as_str(), "error");
	assert_eq!(CardStatus::from_dom("pending"), CardStatus::InProgress);
	assert_eq!(CardStatus::from_dom(""), CardStatus::InProgress);
}

#[test]
fn task_card_names_the_dispatched_agent_and_brief_while_the_call_is_live() {
	// The assignment markdown, a divider,
	// then `• <name>: <first line of task, 64 chars>` while args stream —
	// never an empty frame under a static "Task: task" title.
	let torn = node(
		KnownTag::Input,
		r#"{"agent":"task","name":"AuthLoader","task":"Read packages/server/src/auth/*.ts and summarize the session-cookie"#,
	);
	let text = render("task", &torn, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("Task: task"), "{text}");
	assert!(
		text.contains(
			"• AuthLoader: Read packages/server/src/auth/*.ts and summarize the session-co…"
		),
		"{text}"
	);
	assert!(text.contains("├"), "divider before the agent rows: {text}");
	assert!(!text.contains("⟨task⟩"), "the default agent wears no badge: {text}");

	// Complete arguments: the brief is the first line only, the non-default
	// agent gets its badge, and `isolated` lands in the header.
	let running = node(
		KnownTag::Input,
		r#"{"agent":"scout","name":"Anna.Bob","isolated":true,"task":"Map the auth flow.\n\nThen report file:line evidence."}"#,
	);
	let text = render("task", &running, None, None, CardStatus::InProgress, false);
	assert!(text.contains("Task: scout"), "{text}");
	assert!(text.contains("isolated"), "{text}");
	assert!(text.contains("• Anna>Bob: Map the auth flow."), "{text}");
	assert!(text.contains("⟨scout⟩"), "{text}");
	assert!(text.contains("Then report file:line evidence."), "the assignment section: {text}");
	assert!(
		!text.contains("Anna>Bob: Map the auth flow. Then"),
		"brief stops at the first line: {text}"
	);

	// Batch form: the shared context, then one row per item (`#N` when
	// unnamed), folded past four.
	let batch = node(
		KnownTag::Input,
		r##"{"context":"# Goal\nShip auth.","tasks":[
			{"name":"A","task":"one","agent":"scout"},{"task":"two"},{"name":"C","task":"three","isolated":true},
			{"name":"D","task":"four"},{"name":"E","task":"five"},{"name":"F","task":"six"}]}"##,
	);
	let text = render("task", &batch, None, None, CardStatus::StreamingArgs, false);
	assert!(text.contains("Ship auth."), "{text}");
	assert!(text.contains("• A: one"), "{text}");
	assert!(text.contains("⟨scout⟩"), "{text}");
	assert!(text.contains("• #2: two"), "{text}");
	assert!(text.contains("• C: three"), "{text}");
	assert!(text.contains("[isolated]"), "{text}");
	assert!(text.contains("• D: four"), "{text}");
	assert!(!text.contains("• E: five"), "{text}");
	assert!(text.contains("… 2 more agents"), "{text}");
	assert!(!text.contains("Task:"), "batch calls carry no agent in the header: {text}");

	// The settled frame keeps the assignment section above its rows; each
	// row is `name: brief ⟨agent⟩` and the child's final text follows under
	// "Output", three lines when collapsed, ten when expanded.
	let text = (1..=12)
		.map(|line| format!("finding {line}"))
		.collect::<Vec<_>>()
		.join("\n");
	let payload = json!({"children":[{"id":"AuthLoader","agent":"scout","text":text,"session_path":"s.oms",
		"tokens_in":10,"tokens_out":5,"output":null,"workspace":null,"error":null}]});
	let args = r#"{"agent":"scout","name":"AuthLoader","task":"Read the auth flow and report.\nCite lines."}"#;
	let done = render_done::<omp_tools::task::Payload>("task", args, payload.clone(), false);
	assert!(done.contains("Cite lines."), "assignment section: {done}");
	assert!(done.contains("AuthLoader: Read the auth flow and report. ⟨done⟩"), "{done}");
	assert!(done.contains("⟨scout⟩"), "{done}");
	assert!(done.contains("Output"), "{done}");
	assert!(done.contains("finding 3"), "{done}");
	assert!(!done.contains("finding 4"), "{done}");
	assert!(done.contains("… 9 more lines"), "{done}");
	let expanded = render_done::<omp_tools::task::Payload>("task", args, payload, true);
	assert!(expanded.contains("finding 10"), "{expanded}");
	assert!(!expanded.contains("finding 11"), "{expanded}");
	assert!(expanded.contains("… 2 more lines"), "{expanded}");
}
