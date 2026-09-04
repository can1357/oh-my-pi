//! Typed card for `eval@1`.
//!
//! A framed code cell titled `<lang icon> <status>
//! <title> · (<duration>ms)`, the cell's stdout under an `Output` rule, and —
//! after a blank row — every `display()` value as a JSON tree. Helper status
//! events retain their
//! live action rows, while workpool status and snapshot values retain typed
//! aggregate/worker/item presentation instead of degrading into an
//! indistinguishable JSON tree. A Python exception is not a tool
//! fault: the cell settles `Ok(Payload)` with `CellOutcome::Error` and the
//! traceback in `CellStatus::exception`, and paints as failed.

use omp_tools::eval::{CellOutcome, CellStatus, DisplayOutput, Params, Payload};
use omp_tui::{IntoComponent as _, UiContext, components::hr::truncate_to_width, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, typed_fault, typed_input, workpool,
};

/// Persistent Python-kernel cell card.
pub struct EvalCard;

/// Maximum JSON-tree depths for collapsed and expanded cards.
const TREE_DEPTH: (usize, usize) = (2, 6);
/// Maximum JSON-tree lines for collapsed and expanded cards.
const TREE_LINES: (usize, usize) = (6, 200);
/// Maximum JSON scalar lengths for collapsed and expanded cards.
const TREE_SCALAR: (usize, usize) = (60, 2000);

impl Card for EvalCard {
	fn tool(&self) -> &'static str {
		"eval"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = typed_input::<Params>(view);
		let payload = view.result::<Payload>();
		let code = args
			.as_ref()
			.and_then(|value| value.get("code"))
			.and_then(Value::as_str)
			.map(str::to_owned)
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "code"))
			.or_else(|| payload.as_ref().map(|payload| payload.code.to_string()))
			.unwrap_or_default();
		let title = args
			.as_ref()
			.and_then(|value| value.get("title"))
			.and_then(Value::as_str)
			.map(str::to_owned)
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "title"))
			.or_else(|| {
				payload
					.as_ref()
					.and_then(|payload| payload.title.as_ref().map(ToString::to_string))
			})
			.unwrap_or_default();
		let live = matches!(view.status, CardStatus::StreamingArgs | CardStatus::InProgress);
		// stdout is streamed on the `<result>` text (never retained in the
		// payload): the open stream while running, the settled text after.
		let status = payload.as_ref().map(|payload| &payload.status);
		let had_output = payload.as_ref().is_none_or(|payload| payload.had_output);
		let stdout = view
			.output
			.or_else(|| had_output.then(|| view.result_text()).flatten())
			.map(str::to_owned)
			.unwrap_or_default();
		let failed = view.status == CardStatus::Failed
			|| status.is_some_and(|status| status.outcome != CellOutcome::Complete);
		let mut output = output_preview(&stdout, expanded);
		if let Some(text) = status.and_then(exception_text) {
			if !output.is_empty() {
				output.push('\n');
			}
			output.push_str(&text);
		}
		if let Some(fault) = typed_fault::<omp_tools::eval::Fault>(view) {
			if !output.is_empty() {
				output.push('\n');
			}
			output.push_str(&fault);
		}
		let duration = status.map(|status| format!("({}ms)", status.duration_ms));
		let workpool_cards = payload
			.as_ref()
			.map(|payload| workpool::render(&payload.display_outputs, expanded))
			.unwrap_or_default();
		let status_cards = payload
			.as_ref()
			.map(|payload| status_components(&payload.display_outputs, expanded))
			.unwrap_or_default();
		let tree = payload
			.as_ref()
			.filter(|_| !failed)
			.map(|payload| display_tree(&payload.display_outputs, expanded, ui))
			.unwrap_or_default();
		dom! {
			<col>
				<box border=round bc={if failed { "err" } else if live { "accent" } else { "muted" }} bg={if failed { "error_surface" } else { "panel" }} bleed pad-x=1 title_pad=3>
					<row kind=title gap=1>
						<i:python fg=python/>
						if live { <spinner kind=status/><text fg=output>{"running"}</text> }
						else if failed { <i:error fg=err/> }
						else { <text fg=ok>{"•"}</text> }
						if !title.is_empty() { <text>{title}</text> }
						if let Some(duration) = duration { <text>{"·"}</text><text fg=muted>{duration}</text> }
						if let Some(badge) = elapsed_badge(view) { {badge} }
					</row>
					if !code.is_empty() {
						<pre path="cell.py">{code}</pre>
					}
					if !output.is_empty() {
						<hr title="Output" title_pad=3 bc={if failed { "err" } else { "muted" }}/>
						<pre fg={if failed { "err" } else { "output" }}>{output}</pre>
					}
				</box>
				if !status_cards.is_empty() {
					<spacer h=1/>
					<col gap=1>{status_cards}</col>
				}
				if !workpool_cards.is_empty() {
					<spacer h=1/>
					<col gap=1>{workpool_cards}</col>
				}
				if !tree.is_empty() {
					<spacer h=1/>
					<col>
						for line in tree { <text>{line}</text> }
					</col>
				}
			</col>
		}
		.into_component()
	}
}

fn icon<'a>(ui: &'a UiContext, name: &'a str) -> &'a str {
	ui.charset.icon_named(name).unwrap_or(name)
}

fn output_preview(output: &str, expanded: bool) -> String {
	let output = output.trim_end();
	if expanded {
		return output.to_owned();
	}
	let lines = output.lines().collect::<Vec<_>>();
	let skipped = lines.len().saturating_sub(10);
	let tail = lines
		.into_iter()
		.skip(skipped)
		.collect::<Vec<_>>()
		.join("\n");
	if skipped == 0 {
		tail
	} else {
		format!("… ({skipped} earlier lines)\n{tail}")
	}
}

fn status_components(outputs: &[DisplayOutput], expanded: bool) -> Vec<Component> {
	let events = outputs
		.iter()
		.filter_map(|output| match output {
			DisplayOutput::Status { event }
				if event.get("op").and_then(Value::as_str) != Some("workpool") =>
			{
				Some(event)
			},
			_ => None,
		})
		.collect::<Vec<_>>();
	let shown = if expanded {
		events.len().min(200)
	} else {
		events.len().min(3)
	};
	let hidden = events.len().saturating_sub(shown);
	let mut rows = Vec::with_capacity(shown + usize::from(hidden > 0) + 1);
	rows.push(dom! { <text fg=muted>{"Status"}</text> }.into_component());
	if hidden > 0 {
		rows.push(
			dom! {
				<row gap=1>
					<i:tree-branch fg=muted/>
					<text fg=muted>{format!("… {hidden} earlier")}</text>
				</row>
			}
			.into_component(),
		);
	}
	for (index, event) in events.iter().skip(hidden).enumerate() {
		let last = index + 1 == shown;
		let summary = status_summary(event);
		rows.push(
			dom! {
				<row gap=1>
					if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
					<text fg={if event.get("error").is_some() { "warn" } else { "muted" }}>{summary}</text>
				</row>
			}
			.into_component(),
		);
	}
	rows
}

fn status_summary(event: &Value) -> String {
	let op = event.get("op").and_then(Value::as_str).unwrap_or("status");
	if let Some(error) = event.get("error").and_then(Value::as_str) {
		return format!("{op}: {error}");
	}
	if op == "agent" {
		let id = event.get("id").and_then(Value::as_str).unwrap_or("agent");
		let status = event
			.get("status")
			.and_then(Value::as_str)
			.unwrap_or("running");
		let detail = event
			.get("currentTool")
			.or_else(|| event.get("lastIntent"))
			.or_else(|| event.get("taskPreview"))
			.and_then(Value::as_str);
		return detail.map_or_else(
			|| format!("{id} · {status}"),
			|detail| format!("{id} · {status} · {detail}"),
		);
	}
	let detail = match op {
		"read" => status_path_count(event, "from", "chars"),
		"write" => status_path_count(event, "to", "chars"),
		"env" => event.get("key").and_then(Value::as_str).map(|key| {
			let value = event.get("value").map(display_scalar).unwrap_or_default();
			format!("{key}={value}")
		}),
		"completion" => event
			.get("model")
			.and_then(Value::as_str)
			.map(str::to_owned),
		"log" => event
			.get("message")
			.and_then(Value::as_str)
			.map(str::to_owned),
		"phase" => event
			.get("title")
			.and_then(Value::as_str)
			.map(str::to_owned),
		"tool_define" => event.get("name").and_then(Value::as_str).map(str::to_owned),
		"output" => event.get("id").and_then(Value::as_str).map(str::to_owned),
		_ => event
			.get("path")
			.or_else(|| event.get("count"))
			.map(display_scalar),
	};
	detail.map_or_else(|| op.to_owned(), |detail| format!("{op} · {detail}"))
}

fn status_path_count(event: &Value, preposition: &str, count_key: &str) -> Option<String> {
	let path = event.get("path").and_then(Value::as_str);
	let count = event.get(count_key).and_then(Value::as_u64);
	match (count, path) {
		(Some(count), Some(path)) => Some(format!("{count} chars {preposition} {path}")),
		(Some(count), None) => Some(format!("{count} chars")),
		(None, Some(path)) => Some(path.to_owned()),
		(None, None) => None,
	}
}

fn display_scalar(value: &Value) -> String {
	match value {
		Value::String(value) => value.clone(),
		_ => value.to_string(),
	}
}

/// The traceback the eval resource retained for a raised exception, in
/// Python order; `Name: message` when the resource kept no frames.
fn exception_text(status: &CellStatus) -> Option<String> {
	let exception = status.exception.as_ref()?;
	Some(if exception.traceback.is_empty() {
		format!("{}: {}", exception.name, exception.message)
	} else {
		exception
			.traceback
			.iter()
			.map(|line| line.trim_end())
			.collect::<Vec<_>>()
			.join("\n")
	})
}

/// Renders every `display()` JSON value as a tree, labelled `display[N]`
/// when there is more than one.
fn display_tree(outputs: &[DisplayOutput], expanded: bool, ui: &UiContext) -> Vec<String> {
	let values = outputs
		.iter()
		.filter_map(|output| match output {
			DisplayOutput::Json { data } if !workpool::is_snapshot(data) => Some(data),
			_ => None,
		})
		.collect::<Vec<_>>();
	let labelled = values.len() > 1;
	let mut lines = Vec::new();
	for (index, value) in values.into_iter().enumerate() {
		if labelled {
			lines.push(format!("display[{}]", index + 1));
		}
		let mut tree = JsonTree::new(expanded, ui);
		tree.render_root(value);
		if tree.truncated {
			tree.lines.push("…".to_owned());
		}
		lines.extend(tree.lines);
	}
	lines
}

/// JSON-tree line renderer.
struct JsonTree<'a> {
	lines:      Vec<String>,
	truncated:  bool,
	max_depth:  usize,
	max_lines:  usize,
	max_scalar: usize,
	ui:         &'a UiContext,
}

impl<'a> JsonTree<'a> {
	fn new(expanded: bool, ui: &'a UiContext) -> Self {
		let pick = |pair: (usize, usize)| if expanded { pair.1 } else { pair.0 };
		Self {
			lines: Vec::new(),
			truncated: false,
			max_depth: pick(TREE_DEPTH),
			max_lines: pick(TREE_LINES),
			max_scalar: pick(TREE_SCALAR),
			ui,
		}
	}

	fn push(&mut self, line: String) -> bool {
		if self.lines.len() >= self.max_lines {
			self.truncated = true;
			return false;
		}
		self.lines.push(line);
		true
	}

	fn render_root(&mut self, value: &Value) {
		match value {
			Value::Object(map) => {
				let keys = map
					.keys()
					.filter(|key| key.as_str() != "i")
					.collect::<Vec<_>>();
				for key in keys {
					self.render_node(&map[key], Some(key.as_str()), &mut Vec::new(), true, 1);
					if self.lines.len() >= self.max_lines {
						self.truncated = true;
						break;
					}
				}
			},
			Value::Array(items) => {
				for (index, item) in items.iter().enumerate() {
					self.render_node(
						item,
						Some(&format!("[{index}]")),
						&mut Vec::new(),
						index + 1 == items.len(),
						1,
					);
					if self.lines.len() >= self.max_lines {
						self.truncated = true;
						break;
					}
				}
			},
			_ => self.render_node(value, None, &mut Vec::new(), true, 0),
		}
	}

	fn prefix(&self, ancestors: &[bool]) -> String {
		let vertical = icon(self.ui, "tree-vertical");
		ancestors
			.iter()
			.map(|has_next| {
				if *has_next {
					format!("{vertical}  ")
				} else {
					"   ".to_owned()
				}
			})
			.collect()
	}

	fn render_node(
		&mut self,
		value: &Value,
		key: Option<&str>,
		ancestors: &mut Vec<bool>,
		is_last: bool,
		depth: usize,
	) {
		if self.lines.len() >= self.max_lines {
			self.truncated = true;
			return;
		}
		let connector = icon(self.ui, if is_last { "tree-last" } else { "tree-branch" });
		let prefix = format!("{}{connector} ", self.prefix(ancestors));
		ancestors.push(!is_last);
		match value {
			Value::Array(items) => {
				let header = key.unwrap_or("array");
				self.push(format!("{prefix}{} {header}", icon(self.ui, "package")));
				if items.is_empty() {
					self.push(format!("{}{} []", self.prefix(ancestors), icon(self.ui, "tree-last")));
				} else if depth >= self.max_depth {
					self.push(format!("{}{} …", self.prefix(ancestors), icon(self.ui, "tree-last")));
				} else {
					for (index, item) in items.iter().enumerate() {
						self.render_node(
							item,
							Some(&format!("[{index}]")),
							ancestors,
							index + 1 == items.len(),
							depth + 1,
						);
						if self.lines.len() >= self.max_lines {
							self.truncated = true;
							break;
						}
					}
				}
			},
			Value::Object(map) => {
				let header = key.unwrap_or("object");
				self.push(format!("{prefix}{} {header}", icon(self.ui, "folder")));
				if depth >= self.max_depth {
					self.push(format!("{}{} …", self.prefix(ancestors), icon(self.ui, "tree-last")));
				} else if map.is_empty() {
					self.push(format!("{}{} {{}}", self.prefix(ancestors), icon(self.ui, "tree-last")));
				} else {
					let count = map.len();
					for (index, (child_key, child)) in map.iter().enumerate() {
						self.render_node(
							child,
							Some(child_key),
							ancestors,
							index + 1 == count,
							depth + 1,
						);
						if self.lines.len() >= self.max_lines {
							self.truncated = true;
							break;
						}
					}
				}
			},
			_ => {
				let label = key.unwrap_or("value");
				let scalar_icon = icon(self.ui, "file");
				match value.as_str().filter(|text| text.contains('\n')) {
					Some(text) => {
						let rows = text.split('\n').collect::<Vec<_>>();
						let budget = self.max_lines.saturating_sub(self.lines.len() + 1).max(1);
						let shown = rows.len().min(budget);
						let continue_prefix = self.prefix(ancestors);
						self.push(format!(
							"{prefix}{scalar_icon} {label}: \"{}",
							clip(rows[0], self.max_scalar)
						));
						for row in rows.iter().take(shown).skip(1) {
							if !self.push(format!("{continue_prefix}    {}", clip(row, self.max_scalar))) {
								break;
							}
						}
						if rows.len() > shown {
							self.truncated = true;
							self.push(format!(
								"{continue_prefix}    …({} more lines)\"",
								rows.len() - shown
							));
						} else if let Some(last) = self.lines.last_mut() {
							last.push('"');
						}
					},
					None => {
						self.push(format!(
							"{prefix}{scalar_icon} {label}: {}",
							format_scalar(value, self.max_scalar)
						));
					},
				}
			},
		}
		ancestors.pop();
	}
}

/// Formats a JSON scalar for the tree.
fn format_scalar(value: &Value, max_len: usize) -> String {
	match value {
		Value::Null => "null".to_owned(),
		Value::Bool(flag) => flag.to_string(),
		Value::Number(number) => number.to_string(),
		Value::String(text) => {
			format!("\"{}\"", clip(&text.replace('\n', "\\n").replace('\t', "\\t"), max_len))
		},
		Value::Array(items) => format!("[{} items]", items.len()),
		Value::Object(map) => format!("{{{} keys}}", map.len()),
	}
}

/// Clips a scalar to the first `max` columns with an ellipsis.
fn clip(text: &str, max: usize) -> String {
	let clipped = truncate_to_width(text, u16::try_from(max).unwrap_or(u16::MAX));
	if clipped.ellipsis {
		format!("{}…", clipped.text)
	} else {
		clipped.text.to_owned()
	}
}

fn partial_string(raw: &str, key: &str) -> Option<String> {
	let start = raw.find(&format!("\"{key}\""))?;
	let value = raw[start..].find(':')? + start + 1;
	let quote = raw[value..].find('"')? + value + 1;
	let bytes = raw.as_bytes();
	let mut escaped = false;
	for index in quote..bytes.len() {
		match (bytes[index], escaped) {
			(b'"', false) => return serde_json::from_str(&raw[quote - 1..=index]).ok(),
			(b'\\', false) => escaped = true,
			_ => escaped = false,
		}
	}
	Some(raw[quote..].replace("\\n", "\n").replace("\\\"", "\""))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn helper_status_summaries_keep_agent_and_resource_details() {
		assert_eq!(
			status_summary(&serde_json::json!({
				"op": "agent",
				"id": "Scout",
				"status": "running",
				"currentTool": "read"
			})),
			"Scout · running · read"
		);
		assert_eq!(
			status_summary(&serde_json::json!({
				"op": "read",
				"chars": 12,
				"path": "agent://child"
			})),
			"read · 12 chars from agent://child"
		);
		assert_eq!(
			status_summary(&serde_json::json!({
				"op": "output",
				"error": "job is unavailable"
			})),
			"output: job is unavailable"
		);
	}

	#[test]
	fn collapsed_output_uses_the_pi_ten_line_tail() {
		let output = (1..=12)
			.map(|line| line.to_string())
			.collect::<Vec<_>>()
			.join("\n");
		let preview = output_preview(&output, false);
		assert!(preview.starts_with("… (2 earlier lines)\n3\n"));
		assert!(preview.ends_with("\n12"));
	}
}
