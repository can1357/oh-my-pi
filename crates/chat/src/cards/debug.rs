//! Typed debugger session and stack-trace card.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardView, Component, elapsed_badge, typed_fault, typed_input, typed_result};

/// Command-output rows shown while collapsed.
const OUTPUT_COLLAPSED_LINES: usize = 3;
/// Command-output rows shown when expanded.
const OUTPUT_EXPANDED_LINES: usize = 12;

/// Renders debugger session state and stack frames.
pub struct DebugCard;

impl Card for DebugCard {
	fn tool(&self) -> &'static str {
		"debug"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let raw_args = node_text(view.input).unwrap_or_default();
		let args = typed_input::<omp_tools::debug::Params>(view).unwrap_or(Value::Null);
		let action = args
			.get("action")
			.and_then(Value::as_str)
			.map(str::to_owned)
			.or_else(|| extract_string(raw_args.as_str(), "action"))
			.unwrap_or_default()
			.replace('_', " ");
		if view.status.as_str() == "error" {
			let fault = failure(view);
			return dom! {
				<box border=round bc=err title_pad=3 pad="0 1">
					<row kind=title gap=1><i:error fg=err/><text>{format!("Debug {action}")}</text></row>
					<col><hr title="Output" title_pad=3 bc=err/><text>{fault}</text></col>
				</box>
			}
			.into_component();
		}
		let Some(result) = typed_result::<omp_tools::debug::Payload>(view) else {
			return dom! {
				<row gap=0><i:pending fg=output/><text>{" "}</text><text fg=accent>{"Debug"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {action}")}</text>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
			}
			.into_component();
		};
		let data = result.get("data").unwrap_or(&Value::Null);
		let session = data.get("session").unwrap_or(&Value::Null);
		// Render the Session block only for a snapshot-bearing result and
		// always render the command output; breakpoints, evaluations, and
		// variable reads carry neither a session snapshot nor frames.
		let has_session = session.is_object();
		let frames = data
			.get("stackFrames")
			.or_else(|| data.get("frames"))
			.and_then(Value::as_array)
			.cloned()
			.unwrap_or_default();
		let shown = if expanded {
			frames.len()
		} else {
			frames.len().min(2)
		};
		let output_lines = result
			.get("output")
			.and_then(Value::as_str)
			.map(str::trim_end)
			.filter(|text| !text.is_empty())
			.map_or_else(
				|| vec!["No output".to_owned()],
				|text| {
					text
						.lines()
						.map(|line| line.replace('\t', "   "))
						.collect::<Vec<_>>()
				},
			);
		let output_shown = if expanded {
			OUTPUT_EXPANDED_LINES
		} else {
			OUTPUT_COLLAPSED_LINES
		}
		.min(output_lines.len());
		let output_hidden = output_lines.len() - output_shown;
		let frame = session.get("frame").unwrap_or(&Value::Null);
		let source = frame.get("source").unwrap_or(&Value::Null);
		let location = format!(
			"{}:{}:{}",
			source
				.get("path")
				.and_then(Value::as_str)
				.or_else(|| session.get("path").and_then(Value::as_str))
				.unwrap_or_default(),
			frame
				.get("line")
				.or_else(|| session.get("line"))
				.and_then(Value::as_u64)
				.unwrap_or_default(),
			frame
				.get("column")
				.or_else(|| session.get("col"))
				.and_then(Value::as_u64)
				.unwrap_or_default(),
		);
		dom! {
			<box border=round bc=muted title_pad=3 pad="0 1">
				<row kind=title gap=1><i:debug fg=accent/><text>{format!("Debug {action}")}</text></row>
				<col>
					if has_session {
						<hr title="Session" title_pad=3 bc=muted/>
						<text>{format!("Session {}", str_field(session, "id"))}</text>
						<text>{format!("Adapter: {}", str_field(session, "adapter"))}</text>
						<text>{format!("Status: {}", str_field(session, "status"))}</text>
						<text>{format!("CWD: {}", str_field(session, "cwd"))}</text>
						<text>{format!("Program: {}", str_field(session, "program"))}</text>
						<text>{format!("PID: {}", session.get("pid").and_then(Value::as_u64).map_or_else(|| "-".to_owned(), |pid| pid.to_string()))}</text>
						<text>{format!("Stop reason: {}", str_field(data, "reason"))}</text>
						<text>{format!("Frame: {}", str_field(frame, "name"))}</text>
						<text>{format!("Instruction pointer: {}", str_field(frame, "instructionPointerReference"))}</text>
						<text>{format!("Location: {location}")}</text>
					}
					<hr title="Output" title_pad=3 bc=muted/>
					if frames.is_empty() {
						for line in output_lines.iter().take(output_shown) {
							<text>{line.as_str()}</text>
						}
						if output_hidden > 0 { <text fg=muted>{format!("… {output_hidden} more lines ⟨Ctrl+O: Expand⟩")}</text> }
					} else {
						<text>{"Stack trace:"}</text>
						for frame in frames.iter().take(shown) {
							<text>{format!("- #{} {} @ {}:{}:{}", frame.get("id").and_then(Value::as_u64).unwrap_or_default(), str_field(frame, "name"), frame.get("source").map_or_else(|| str_field(frame, "path"), |source| str_field(source, "path")), frame.get("line").and_then(Value::as_u64).unwrap_or_default(), frame.get("column").or_else(|| frame.get("col")).and_then(Value::as_u64).unwrap_or_default())}</text>
						}
						if shown < frames.len() { <text fg=muted>{format!("… {} more lines ⟨Ctrl+O: Expand⟩", frames.len() - shown)}</text> }
					}
				</col>
			</box>
		}.into_component()
	}
}

fn str_field(value: &Value, key: &str) -> String {
	value
		.get(key)
		.and_then(Value::as_str)
		.unwrap_or_default()
		.to_owned()
}
fn extract_string(raw: &str, key: &str) -> Option<String> {
	let marker = format!("\"{key}\":\"");
	let rest = raw.split_once(&marker)?.1;
	Some(rest.split('"').next().unwrap_or(rest).to_owned())
}
fn failure(view: &CardView<'_>) -> Str {
	if let Some(fault) = typed_fault::<omp_tools::debug::Fault>(view) {
		return fault;
	}
	let raw = view.diag.and_then(node_text).unwrap_or_default();
	serde_json::from_str::<String>(raw.as_str())
		.map(Str::new)
		.unwrap_or(raw)
}
fn node_text(node: &Node) -> Option<Str> {
	node.content.clone().or_else(|| {
		node
			.prop(&PropId::Text.into())
			.and_then(|value| value.as_str())
			.map(Str::new)
	})
}
