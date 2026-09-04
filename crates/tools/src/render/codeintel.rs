//! Native language-server and debugger renderers.

use std::fmt::Write as _;

use omp_core::{Str, sf};
use omp_tool::{CallOutcome, ToolIdentity, render::RenderFold};
use serde_json::Value;

use super::view::El;
use crate::{
	debug::{
		Action as DebugAction, Fault as DebugFault, Payload as DebugPayload, Update as DebugUpdate,
	},
	debug_render,
	gallery::RendererGalleryFixture,
	lsp::{Action as LspAction, Fault as LspFault, Payload as LspPayload, Update as LspUpdate},
	view,
};

const MAX_REFERENCE_ROWS: usize = 16;
const MAX_LSP_DEPTH: usize = 6;
const MAX_LSP_ROWS: usize = 16;
const MAX_LSP_CHARS: usize = 160;
const MAX_DEBUG_LINES: usize = 8;

#[derive(Default)]
pub(super) struct LspState {
	action: Option<Str>,
	file:   Option<Str>,
	line:   Option<u32>,
	symbol: Option<Str>,
}

pub(super) struct LspRenderer;

impl RenderFold for LspRenderer {
	type Outcome = CallOutcome<LspPayload, LspFault>;
	type State = LspState;
	type Update = LspUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(action) = args
			.get("action")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.action = Some(Str::new(action));
		}
		if let Some(file) = args.get("file").and_then(omp_core::slopjson::Value::as_str) {
			state.file = Some(Str::new(file));
		}
		if let Some(line) = args
			.get("line")
			.and_then(omp_core::slopjson::Value::as_u64)
			.and_then(|line| u32::try_from(line).ok())
		{
			state.line = Some(line);
		}
		if let Some(symbol) = args
			.get("symbol")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.symbol = Some(Str::new(symbol));
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_lsp_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_lsp_payload(state, payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_lsp_fault(fault).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

#[derive(Default)]
pub(super) struct DebugState {
	action:  Option<Str>,
	adapter: Option<Str>,
	program: Option<Str>,
	file:    Option<Str>,
}

pub(super) struct DebugRenderer;

impl RenderFold for DebugRenderer {
	type Outcome = CallOutcome<DebugPayload, DebugFault>;
	type State = DebugState;
	type Update = DebugUpdate;

	fn fold(&self, _state: &mut Self::State, update: Self::Update) {
		match update {}
	}

	fn fold_args(&self, state: &mut Self::State, args: &omp_core::slopjson::Value, _complete: bool) {
		if let Some(action) = args
			.get("action")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.action = Some(Str::new(action));
		}
		if let Some(adapter) = args
			.get("adapter")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.adapter = Some(Str::new(adapter));
		}
		if let Some(program) = args
			.get("program")
			.and_then(omp_core::slopjson::Value::as_str)
		{
			state.program = Some(Str::new(program));
		}
		if let Some(file) = args.get("file").and_then(omp_core::slopjson::Value::as_str) {
			state.file = Some(Str::new(file));
		}
	}

	fn view(&self, state: &Self::State, outcome: Option<&Self::Outcome>) -> Option<Str> {
		match outcome {
			None => Some(render_debug_live(state).into()),
			Some(CallOutcome::Ok(payload)) => Some(render_debug_payload(state, payload).into()),
			Some(CallOutcome::Faulted(fault)) => Some(render_debug_fault(fault).into()),
			Some(CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. }) => None,
		}
	}
}

fn render_lsp_live(state: &LspState) -> El {
	view! {
		<row gap=1>
			<spinner color=accent/>
			<row sep=" · ">
				if let Some(action) = state.action.as_deref() {
					<text bold>{action}</text>
					if let Some(file) = state.file.as_deref() {
						<text>
							{file}
							if let Some(line) = state.line {
								{sf!(":{line}")}
							}
						</text>
					}
					if let Some(symbol) = state.symbol.as_deref() {
						<text fg=muted>{symbol}</text>
					}
				} else {
					<text fg=muted>{"waiting for request"}</text>
				}
			</row>
		</row>
	}
}

fn render_lsp_payload(state: &LspState, payload: &LspPayload) -> El {
	let action = payload.action.to_string();
	let response = (payload.action != LspAction::References)
		.then(|| serde_json::to_string(&payload.data).unwrap_or_default());
	let reference_count = payload.data.as_array().map_or(0, Vec::len);
	view! {
		<col gap=1>
			<row gap=1>
				<i:lsp/>
				<row sep=" · ">
					<text bold>{action}</text>
					if !payload.servers.is_empty() {
						<text fg=muted>
							for (index, server) in payload.servers.iter().enumerate() {
								if index > 0 { {", "} }
								{server}
							}
						</text>
					}
				</row>
			</row>
			if let Some(file) = state.file.as_deref() {
				{fact("File", file)}
			}
			if let Some(line) = state.line {
				{integer_fact("Line", u64::from(line))}
			}
			if let Some(symbol) = state.symbol.as_deref() {
				{fact("Symbol", symbol)}
			}
			<text bold fg=accent>{"Response"}</text>
			if payload.action == LspAction::References {
				{compact_number_fact("References", reference_count as u64)}
				{render_references(&payload.data)}
			} else if let Some(response) = response {
				<json max-depth={MAX_LSP_DEPTH} max-rows={MAX_LSP_ROWS} max-chars={MAX_LSP_CHARS}>
					{response}
				</json>
			}
		</col>
	}
}

#[derive(Clone, Copy)]
struct ReferenceLocation<'a> {
	path:   &'a str,
	line:   u64,
	column: u64,
}

fn render_references(data: &Value) -> El {
	let values = data.as_array().map(Vec::as_slice).unwrap_or_default();
	let mut locations = Vec::with_capacity(values.len());
	for value in values {
		let Some(path) = value.get("uri").and_then(Value::as_str) else {
			continue;
		};
		let Some(line) = value.pointer("/range/start/line").and_then(Value::as_u64) else {
			continue;
		};
		let column = value
			.pointer("/range/start/character")
			.and_then(Value::as_u64)
			.unwrap_or_default();
		locations.push(ReferenceLocation {
			path:   path.strip_prefix("file://").unwrap_or(path),
			line:   line + 1,
			column: column + 1,
		});
	}

	view! {
		<tree guides=round max-rows={MAX_REFERENCE_ROWS} overflow="references">
			for (index, location) in locations.iter().enumerate() {
				if !locations[..index].iter().any(|prior| prior.path == location.path) {
					<node
						label={location.path}
						annotation={reference_annotation(&locations, location.path)}
					>
						for candidate in locations
							.iter()
							.filter(|candidate| candidate.path == location.path)
						{
							<node label={sf!("{}:{}", candidate.line, candidate.column)}/>
						}
					</node>
				}
			}
		</tree>
	}
}

fn reference_annotation(locations: &[ReferenceLocation<'_>], path: &str) -> Str {
	let count = locations
		.iter()
		.filter(|candidate| candidate.path == path)
		.count();
	if count == 1 {
		sf!("{count} reference")
	} else {
		sf!("{count} references")
	}
}

fn render_lsp_fault(fault: &LspFault) -> El {
	let message = if matches!(fault, LspFault::Unavailable) {
		"No language server found for this file"
	} else {
		return render_fault(&fault.to_string());
	};
	render_fault(message)
}

fn render_debug_live(state: &DebugState) -> El {
	view! {
		<row gap=1>
			<spinner color=accent/>
			<row sep=" · ">
				if let Some(action) = state.action.as_deref() {
					<text bold>{action}</text>
					if let Some(target) = state.program.as_deref().or(state.file.as_deref()) {
						<text fg=muted>{target}</text>
					}
				} else {
					<text fg=muted>{"waiting for request"}</text>
				}
			</row>
		</row>
	}
}

fn render_debug_payload(state: &DebugState, payload: &DebugPayload) -> El {
	let snapshot = payload.data.get("session").unwrap_or(&payload.data);
	let first_frame = payload
		.data
		.get("stackFrames")
		.and_then(Value::as_array)
		.and_then(|frames| frames.first());
	let rendered = (payload.action != DebugAction::StackTrace)
		.then(|| debug_render::render(payload.action, &payload.data).text);
	view! {
		<col gap=1>
			<text bold fg=accent>{"Session"}</text>
			if let Some(session) = snapshot
				.get("id")
				.and_then(Value::as_str)
				.or(payload.session.as_deref())
			{
				{fact("Session", session)}
			}
			if let Some(revision) = payload.revision {
				{integer_fact("Revision", revision)}
			}
			if let Some(adapter) =
				string_field(snapshot, "adapter", "adapter").or(state.adapter.as_deref())
			{
				{fact("Adapter", adapter)}
			}
			if let Some(status) = string_field(snapshot, "status", "state") {
				<fact label="Status"><state status={status}/></fact>
			}
			if let Some(program) = snapshot
				.get("program")
				.and_then(Value::as_str)
				.or(state.program.as_deref())
			{
				{fact("Program", program)}
			}
			if let Some(pid) = snapshot
				.get("pid")
				.or_else(|| snapshot.get("processId"))
				.and_then(Value::as_u64)
			{
				{integer_fact("Process", pid)}
			}
			if let Some(reason) = payload
				.data
				.get("reason")
				.and_then(Value::as_str)
				.or_else(|| snapshot.pointer("/stop/reason").and_then(Value::as_str))
			{
				{fact("Stop reason", reason)}
			}
			if let Some(frame) = snapshot
				.pointer("/frame/name")
				.or_else(|| snapshot.pointer("/stop/frame/name"))
				.and_then(Value::as_str)
				.or_else(|| {
					first_frame
						.and_then(|frame| frame.get("name"))
						.and_then(Value::as_str)
				})
			{
				{fact("Frame", frame)}
			}
			if let Some(location) = render_debug_location(snapshot, first_frame) {
				{location}
			}
			<text bold fg=accent>{"Output"}</text>
			if payload.action == DebugAction::StackTrace {
				{render_stack_output(&payload.data)}
			} else if let Some(rendered) = rendered {
				<pre>{rendered}</pre>
			}
		</col>
	}
}

fn render_debug_location(snapshot: &Value, first_frame: Option<&Value>) -> Option<El> {
	let stopped_frame = snapshot
		.get("frame")
		.or_else(|| snapshot.pointer("/stop/frame"));
	let source = stopped_frame
		.and_then(|frame| frame.get("source"))
		.and_then(|source| source.get("path"))
		.and_then(Value::as_str)
		.or_else(|| {
			first_frame
				.and_then(|frame| frame.get("source"))
				.and_then(|source| source.get("path"))
				.and_then(Value::as_str)
		});
	let line = stopped_frame
		.and_then(|frame| frame.get("line"))
		.and_then(Value::as_u64)
		.or_else(|| {
			first_frame
				.and_then(|frame| frame.get("line"))
				.and_then(Value::as_u64)
		});
	let column = stopped_frame
		.and_then(|frame| frame.get("column"))
		.and_then(Value::as_u64)
		.or_else(|| {
			first_frame
				.and_then(|frame| frame.get("column"))
				.and_then(Value::as_u64)
		});
	let (source, line) = (source?, line?);
	let location =
		column.map_or_else(|| sf!("{source}:{line}"), |column| sf!("{source}:{line}:{column}"));
	Some(fact("Location", &location))
}

fn render_stack_output(data: &Value) -> El {
	let frames = data
		.get("stackFrames")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let mut output = String::new();
	for (index, frame) in frames.iter().enumerate() {
		if index > 0 {
			output.push('\n');
		}
		output.push('#');
		write!(output, "{}", frame.get("id").and_then(Value::as_i64).unwrap_or_default())
			.expect("writing to String cannot fail");
		output.push(' ');
		output.push_str(
			frame
				.get("name")
				.and_then(Value::as_str)
				.unwrap_or_default(),
		);
		output.push_str(" @ ");
		output.push_str(
			frame
				.get("source")
				.and_then(|source| source.get("path"))
				.and_then(Value::as_str)
				.unwrap_or("<unknown>"),
		);
		write!(
			output,
			":{}:{}",
			frame
				.get("line")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			frame
				.get("column")
				.and_then(Value::as_u64)
				.unwrap_or_default(),
		)
		.expect("writing to String cannot fail");
	}
	view! {
		<pre max-rows={MAX_DEBUG_LINES} overflow="frames">{output}</pre>
	}
}

fn string_field<'a>(value: &'a Value, primary: &str, fallback: &str) -> Option<&'a str> {
	value
		.get(primary)
		.or_else(|| value.get(fallback))
		.and_then(Value::as_str)
}

fn fact(label: &str, value: &str) -> El {
	view! { <fact label={label}>{value}</fact> }
}

fn integer_fact(label: &str, value: u64) -> El {
	view! { <fact label={label}>{sf!("{value}")}</fact> }
}

fn compact_number_fact(label: &str, value: u64) -> El {
	view! { <fact label={label}><num value={value} compact/></fact> }
}

fn render_debug_fault(fault: &DebugFault) -> El {
	if matches!(fault, DebugFault::Unavailable) {
		return render_fault("No active debug session. Launch or attach first.");
	}
	render_fault(&fault.to_string())
}

fn render_fault(message: &str) -> El {
	view! { <callout kind="error">{message}</callout> }
}

/// Native LSP and debugger renderer lifecycle fixtures for the visual QA
/// gallery.
pub fn gallery_fixtures(lsp: ToolIdentity, debug: ToolIdentity) -> Vec<RendererGalleryFixture> {
	vec![
		RendererGalleryFixture {
			identity: lsp,
			streaming_args: r#"{"action":"references","file":"src/server/au"#,
			args: r#"{"action":"references","file":"src/server/auth.ts","line":42,"symbol":"validateToken"}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"action":"references","servers":["typescript-language-server"],"output":"Found 6 references","data":[{"uri":"src/server/auth.ts","range":{"start":{"line":41,"character":13},"end":{"line":41,"character":26}}},{"uri":"src/server/auth.ts","range":{"start":{"line":117,"character":20},"end":{"line":117,"character":33}}},{"uri":"src/server/middleware/session.ts","range":{"start":{"line":56,"character":17},"end":{"line":56,"character":30}}},{"uri":"src/server/router.ts","range":{"start":{"line":152,"character":19},"end":{"line":152,"character":32}}},{"uri":"test/auth.test.ts","range":{"start":{"line":23,"character":8},"end":{"line":23,"character":21}}},{"uri":"test/auth.test.ts","range":{"start":{"line":40,"character":8},"end":{"line":40,"character":21}}}]}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"unavailable"}}"#,
		},
		RendererGalleryFixture {
			identity: debug,
			streaming_args: r#"{"action":"launch","program":"./app/ser"#,
			args: r#"{"action":"stack_trace","levels":20}"#,
			progress_update: None,
			success_outcome: br#"{"kind":"ok","value":{"action":"stack_trace","session":"dbg-1","revision":7,"output":"FRAME\tNAME\tSOURCE\tLINE:COLUMN","data":{"reason":"breakpoint","session":{"id":"dbg-1","adapter":"debugpy","program":"./app/server.py","status":"stopped","pid":3184,"frame":{"id":1000,"name":"validate_token","instructionPointerReference":"0x1000034a8","source":{"name":"server.py","path":"app/server.py"},"line":42,"column":14}},"stackFrames":[{"id":1000,"name":"validate_token","source":{"name":"server.py","path":"app/server.py"},"line":42,"column":14},{"id":1001,"name":"authenticate","source":{"name":"server.py","path":"app/server.py"},"line":88,"column":9},{"id":1002,"name":"handle_request","source":{"name":"router.py","path":"app/router.py"},"line":153,"column":20},{"id":1003,"name":"dispatch","source":{"name":"router.py","path":"app/router.py"},"line":97,"column":5},{"id":1004,"name":"<module>","source":{"name":"server.py","path":"app/server.py"},"line":212,"column":1}]}}}"#,
			error_outcome: br#"{"kind":"faulted","value":{"kind":"unavailable"}}"#,
		},
	]
}

#[cfg(test)]
mod tests {
	use omp_core::sf;
	use omp_tool::Rev;

	use super::*;

	fn identity(name: &'static str) -> ToolIdentity {
		ToolIdentity { name: sf!(name), rev: Rev { family: Str::default(), n: 1 } }
	}

	#[test]
	fn fixtures_decode_and_render_rich_results() {
		let fixtures = gallery_fixtures(identity("lsp"), identity("debug"));
		let mut lsp_state = LspState::default();
		LspRenderer.fold_args(
			&mut lsp_state,
			&omp_core::slopjson::parse_streaming(fixtures[0].streaming_args),
			false,
		);
		let lsp_live = LspRenderer.view(&lsp_state, None).unwrap();
		assert!(lsp_live.contains("src/server/au"));
		LspRenderer.fold_args(
			&mut lsp_state,
			&omp_core::slopjson::parse_streaming(fixtures[0].args),
			true,
		);
		let lsp_outcome: CallOutcome<LspPayload, LspFault> =
			serde_json::from_slice(fixtures[0].success_outcome).unwrap();
		let lsp_view = LspRenderer.view(&lsp_state, Some(&lsp_outcome)).unwrap();
		assert!(lsp_view.contains("<ico:lsp/>"));
		assert!(lsp_view.contains("<fact label=File>src/server/auth.ts</fact>"));
		assert!(lsp_view.contains("<fact label=Line>42</fact>"));
		assert!(lsp_view.contains("<fact label=Symbol>validateToken</fact>"));
		assert!(lsp_view.contains("<fact label=References><num value=6 compact/></fact>"));
		assert!(lsp_view.contains("<tree guides=round max-rows=16 overflow=references>"));
		assert!(lsp_view.contains("src/server/auth.ts"));
		assert!(lsp_view.contains("42:14"));
		assert!(!lsp_view.contains("ctrl+o"));

		let mut debug_state = DebugState::default();
		DebugRenderer.fold_args(
			&mut debug_state,
			&omp_core::slopjson::parse_streaming(fixtures[1].streaming_args),
			false,
		);
		let debug_live = DebugRenderer.view(&debug_state, None).unwrap();
		assert!(debug_live.contains("./app/ser"));
		DebugRenderer.fold_args(
			&mut debug_state,
			&omp_core::slopjson::parse_streaming(fixtures[1].args),
			true,
		);
		let debug_outcome: CallOutcome<DebugPayload, DebugFault> =
			serde_json::from_slice(fixtures[1].success_outcome).unwrap();
		let debug_view = DebugRenderer
			.view(&debug_state, Some(&debug_outcome))
			.unwrap();
		assert!(debug_view.contains("<fact label=Adapter>debugpy</fact>"));
		assert!(debug_view.contains("<fact label=Status><state status=stopped/></fact>"));
		assert!(debug_view.contains("<fact label=Process>3184</fact>"));
		assert!(debug_view.contains("<fact label=Location>app/server.py:42:14</fact>"));
		assert!(debug_view.contains("<pre max-rows=8 overflow=frames>"));
		assert!(debug_view.contains("#1000 validate_token @ app/server.py:42:14"));
		assert!(!debug_view.contains("ctrl+o"));
	}

	#[test]
	fn structured_results_and_faults_use_semantic_components() {
		let payload = LspPayload {
			action:  LspAction::Hover,
			servers: vec![],
			output:  Str::default(),
			data:    serde_json::json!({
				"contents": {
					"kind": "markdown",
					"value": "<Type> & details",
				},
				"range": {
					"start": { "line": 3, "character": 4 },
					"end": { "line": 3, "character": 8 },
				},
			}),
		};
		let view = render_lsp_payload(&LspState::default(), &payload).to_tml();
		assert!(view.contains("<json max-depth=6 max-rows=16 max-chars=160>"));
		assert!(view.contains("&lt;Type&gt; &amp; details"));
		assert!(view.contains("\"range\""));

		let lsp_fault = render_lsp_fault(&LspFault::Unavailable).to_tml();
		assert_eq!(
			lsp_fault.as_str(),
			"<callout kind=error>No language server found for this file</callout>"
		);
		let debug_fault = render_debug_fault(&DebugFault::Unavailable).to_tml();
		assert_eq!(
			debug_fault.as_str(),
			"<callout kind=error>No active debug session. Launch or attach first.</callout>"
		);
	}

	#[test]
	fn stack_bounds_visual_rows_without_dropping_frames() {
		let frames = (0..12)
			.map(|index| {
				serde_json::json!({
					"id": index,
					"name": format!("frame_{index}"),
					"source": { "path": format!("src/{index}.rs") },
					"line": index + 1,
					"column": index + 2,
				})
			})
			.collect::<Vec<_>>();
		let output = render_stack_output(&serde_json::json!({ "stackFrames": frames })).to_tml();

		assert!(output.starts_with("<pre max-rows=8 overflow=frames>"));
		assert!(output.contains("#0 frame_0 @ src/0.rs:1:2"));
		assert!(output.contains("#11 frame_11 @ src/11.rs:12:13"));
		assert!(!output.contains("ctrl+o"));
	}
}
