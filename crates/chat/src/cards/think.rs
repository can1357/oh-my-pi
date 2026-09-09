//! Typed renderer for the model's private scratchpad tool.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardView, Component};

/// Renders `think` as the muted, italic thought stream used by the transcript.
pub struct ThinkCard;

impl Card for ThinkCard {
	fn tool(&self) -> &'static str {
		"think"
	}

	fn render(&self, view: &CardView<'_>, _expanded: bool, _ui: &UiContext) -> Component {
		let text = view.input::<omp_tools::think::Params>().map_or_else(
			|| thought(node_text(view.input).unwrap_or_default().as_str()),
			|params| params.thoughts,
		);
		dom! { <text fg=output wrap=word pad-x=1>{text}</text> }.into_component()
	}
}

fn thought(raw: &str) -> Str {
	if let Ok(value) = serde_json::from_str::<Value>(raw)
		&& let Some(text) = value.get("thoughts").and_then(Value::as_str)
	{
		return Str::new(text);
	}
	let marker = "\"thoughts\":\"";
	let Some(start) = raw.find(marker).map(|index| index + marker.len()) else {
		return Str::new(raw);
	};
	Str::new(raw[start..].trim_end_matches(['\"', '}']))
}

fn node_text(node: &Node) -> Option<Str> {
	node.content.clone().or_else(|| {
		node
			.prop(&PropId::Text.into())
			.and_then(|value| value.as_str())
			.map(Str::new)
	})
}
