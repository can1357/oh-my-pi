//! Generic card for tools without a specialized renderer.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, result_image};

/// Fallback renderer that presents every standard child of a tool element.
pub struct GenericCard;

impl GenericCard {
	pub(super) fn render_named(
		&self,
		tool: &str,
		view: &CardView<'_>,
		expanded: bool,
		_ui: &UiContext,
	) -> Component {
		let title = Str::new(tool);
		let args = parsed_args(view.args_text().unwrap_or_default());
		let detail = compact_args(args.as_ref());
		let result = display_result(view.output.or_else(|| view.result_text()), expanded);
		let images = view
			.outcome_json()
			.as_ref()
			.and_then(|value| value.get("artifacts").or_else(|| value.get("images")))
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter_map(Value::as_str)
			.map(|artifact| result_image(&Str::new(artifact), "image/*", None, _ui))
			.collect::<Vec<_>>();
		let fault = view
			.fault_json()
			.as_ref()
			.and_then(human_fault)
			.or_else(|| {
				view
					.diag
					.and_then(node_text)
					.filter(|text| !text.is_empty() && !text.trim_start().starts_with(['{', '[']))
					.map(Str::new)
			});
		dom! {
			<col pad="1 0">
				<row pad-x=1 gap=1 bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }}>
					match view.status {
						CardStatus::Failed => <i:error fg=err/>,
						CardStatus::Done => <i:done fg=ok/>,
						CardStatus::StreamingArgs | CardStatus::InProgress => <spinner kind=status/>,
					}
					<text fg=accent>{title}</text>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if expanded {
					<row><i:space/></row>
					if let Some(Value::Object(fields)) = args.as_ref() {
						<text pad-x=1>{"Args"}</text>
						for (name, value) in fields {
							<row pad="0 1" gap=1><i:tree-last/><i:file/><text>{format!("{name}:")}</text><text>{json_text(value)}</text></row>
						}
						<row><i:space/></row>
					}
				} else if let Some(detail) = detail {
					<row pad-x=2 gap=1 bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }}>
						<text fg=muted>{"└─"}</text><text fg=muted>{detail}</text>
					</row>
				}
				if let Some(result) = result { <pre pad-x=1 fg=output bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }}>{result}</pre> }
				if expanded { {images} }
				if let Some(fault) = fault { <text pad-x=1 fg=output bg=error_surface>{fault}</text> }
				if !expanded && matches!(view.status, CardStatus::Done | CardStatus::Failed) {
					<text pad-x=1 fg=muted bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }}>{"⟨Ctrl+O: Expand⟩"}</text>
				}
			</col>
		}
		.into_component()
	}
}

impl Card for GenericCard {
	fn tool(&self) -> &'static str {
		"*"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		self.render_named("tool", view, expanded, ui)
	}
}

fn parsed_args(text: &str) -> Option<Value> {
	serde_json::from_str(text).ok().or_else(|| {
		let mut repaired = String::with_capacity(text.len() + 2);
		repaired.push_str(text);
		if repaired.matches('"').count() % 2 == 1 {
			repaired.push('"');
		}
		if !repaired.trim_end().ends_with('}') {
			repaired.push('}');
		}
		serde_json::from_str(&repaired).ok()
	})
}

fn compact_args(args: Option<&Value>) -> Option<Str> {
	let Value::Object(fields) = args? else {
		return None;
	};
	let mut text = String::new();
	for (name, value) in fields {
		if !text.is_empty() {
			text.push_str(", ");
		}
		text.push_str(name);
		text.push('=');
		text.push_str(&json_text(value));
	}
	(!text.is_empty()).then(|| Str::new(text))
}

fn display_result(text: Option<&str>, expanded: bool) -> Option<Str> {
	let text = text?.trim();
	if text.is_empty() {
		return None;
	}
	let display = serde_json::from_str::<Value>(text).ok().map_or_else(
		|| text.to_owned(),
		|value| match &value {
			Value::Object(fields) if fields.len() == 1 => fields
				.values()
				.next()
				.and_then(Value::as_str)
				.map_or_else(|| value.to_string(), str::to_owned),
			Value::String(text) => text.clone(),
			other => other.to_string(),
		},
	);
	let lines = display.lines().collect::<Vec<_>>();
	let limit = if expanded { 12 } else { 4 };
	let shown = lines.len().min(limit);
	let mut bounded = lines[..shown].join("\n");
	if shown < lines.len() {
		bounded.push_str(&format!("\n… {} more lines", lines.len() - shown));
	}
	Some(Str::new(bounded))
}

fn json_text(value: &Value) -> String {
	serde_json::to_string(value).unwrap_or_else(|_| "null".to_owned())
}

fn human_fault(value: &Value) -> Option<Str> {
	value
		.get("message")
		.or_else(|| value.get("error"))
		.and_then(Value::as_str)
		.filter(|text| !text.is_empty())
		.map(Str::new)
		.or_else(|| {
			value
				.get("kind")
				.or_else(|| value.get("code"))
				.and_then(Value::as_str)
				.filter(|kind| !kind.is_empty())
				.map(|kind| Str::new(kind.replace(['_', '-'], " ")))
		})
		.or_else(|| value.as_str().filter(|text| !text.is_empty()).map(Str::new))
}

fn node_text(node: &Node) -> Option<&str> {
	node.content.as_deref().or_else(|| {
		node
			.prop(&PropId::Text.into())
			.and_then(|value| value.as_str())
	})
}
