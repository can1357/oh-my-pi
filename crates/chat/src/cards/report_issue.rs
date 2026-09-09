//! Typed report-tool-issue card.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{Border, IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardView, Component, elapsed_badge};

/// Renders issue-report arguments and the recording outcome.
pub struct ReportIssueCard;

impl Card for ReportIssueCard {
	fn tool(&self) -> &'static str {
		"report_issue"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = parse_node(view.input)
			.unwrap_or_else(|| partial_args(node_text(view.input).unwrap_or_default().as_str()));
		let fields: Vec<(&str, &str)> = ["tool", "report"]
			.into_iter()
			.filter_map(|key| {
				args
					.get(key)
					.and_then(Value::as_str)
					.map(|value| (key, value))
			})
			.collect();
		let icon = match view.status.as_str() {
			"ok" => Some("done"),
			"error" => Some("error"),
			_ => None,
		};
		let icon = icon.map(|icon| ui.charset.icon_named(icon).unwrap_or_default());
		let (_, last, _) = ui.charset.guides(Border::Square);
		let summary = fields
			.iter()
			.map(|(key, value)| format!("{key}=\"{value}\""))
			.collect::<Vec<_>>()
			.join(", ");
		let terminal = match view.status.as_str() {
			"ok" => result_text(view),
			"error" => Some(failure(view)),
			_ => None,
		};
		dom! {
			<col pad-x=1>
				<row gap=1 bg={if view.status.as_str() == "error" { "error_surface" } else { "panel" }}>
					if let Some(icon) = icon {
						<text fg={if view.status.as_str() == "error" { "err" } else { "ok" }}>{icon}</text>
					} else { <spinner kind=status/> }
					<text fg=accent>{"Report Tool Issue"}</text>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if expanded {
					<spacer h=1/>
					<text>{"Args"}</text>
					for (key, value) in &fields {
						<text>{format!("{last} {} {key}: \"{value}\"", ui.charset.icon_named("file").unwrap_or_default())}</text>
					}
					<spacer h=1/>
				} else if !summary.is_empty() {
					<text pad-x=1 fg=muted bg={if view.status.as_str() == "error" { "error_surface" } else { "panel" }}>{format!("{last} {summary}")}</text>
				}
				if let Some(text) = terminal { <text fg=output bg={if view.status.as_str() == "error" { "error_surface" } else { "panel" }}>{text}</text> }
				if !expanded && matches!(view.status.as_str(), "ok" | "error") {
					<text fg=muted bg={if view.status.as_str() == "error" { "error_surface" } else { "panel" }}>{"⟨Ctrl+O: Expand⟩"}</text>
				}
			</col>
		}.into_component()
	}
}

fn result_text(view: &CardView<'_>) -> Option<Str> {
	let raw = view.result.and_then(node_text)?;
	let value: Value = serde_json::from_str(raw.as_str()).ok()?;
	value
		.get("note")
		.or_else(|| value.get("text"))
		.and_then(Value::as_str)
		.map(Str::new)
		.or_else(|| value.as_str().map(Str::new))
}
fn parse_node(node: &Node) -> Option<Value> {
	serde_json::from_str(node_text(node)?.as_str()).ok()
}
fn partial_args(raw: &str) -> Value {
	let mut map = serde_json::Map::new();
	for key in ["tool", "report"] {
		let marker = format!("\"{key}\":\"");
		if let Some(rest) = raw.split_once(&marker).map(|(_, rest)| rest) {
			map.insert(key.into(), Value::String(rest.split('"').next().unwrap_or(rest).to_owned()));
		}
	}
	Value::Object(map)
}
fn failure(view: &CardView<'_>) -> Str {
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
