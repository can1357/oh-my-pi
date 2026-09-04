//! Typed cards for the recall, reflect, and retain memory tools.

use omp_core::Str;
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, components::hr::truncate_to_width, dom};
use serde_json::Value;

use super::{Card, CardView, Component, elapsed_badge, typed_fault, typed_input, typed_result};

/// Renders scored memory-search results.
pub struct RecallCard;
/// Renders a synthesis over recalled memories.
pub struct ReflectCard;
/// Renders memory items being retained.
pub struct RetainCard;

impl Card for RecallCard {
	fn tool(&self) -> &'static str {
		"recall"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		render_recall(view, expanded)
	}
}
impl Card for ReflectCard {
	fn tool(&self) -> &'static str {
		"reflect"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		render_reflect(view, expanded)
	}
}
impl Card for RetainCard {
	fn tool(&self) -> &'static str {
		"retain"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		render_retain(view, expanded)
	}
}

fn render_recall(view: &CardView<'_>, expanded: bool) -> Component {
	let args =
		typed_input::<omp_tools::memory::RecallParams>(view).unwrap_or_else(|| partial_input(view));
	let query = clip(&field(&args, "query").unwrap_or_default(), QUERY_PREVIEW_WIDTH);
	if failed(view) {
		let message = failure(view);
		return dom! { <row gap=1 fg=err><i:error/><text>{format!("Error: {message}")}</text></row> }
			.into_component();
	}
	let Some(result) = typed_result::<omp_tools::memory::RecallPayload>(view) else {
		return dom! {
			<row gap=0><i:pending fg=output/><text>{" "}</text><text fg=accent>{"Recall"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {query}")}</text>
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
		}
		.into_component();
	};
	let items = result
		.get("items")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let result_query = field(&result, "query").unwrap_or(query);
	// The collapsed view is the header alone with the expand hint; zero
	// matches is a warning header and nothing else;
	// expanded bodies stop at `PREVIEW_LIMITS.OUTPUT_EXPANDED`.
	let found = items.len();
	let hidden = found.saturating_sub(RECALL_EXPANDED_ITEMS);
	let summary = if found == 0 {
		"no matches".to_owned()
	} else {
		format!("{found} found")
	};
	dom! {
		<col>
			<row gap=0>
				if found == 0 { <i:warning-status fg=warn/> } else { <icon name="memory-tool" fg=accent/> }
				<text>{" "}</text><text fg=accent>{"Recall"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {result_query}")}</text><text fg=muted wrap=pre>{format!(" {summary}")}</text>
			</row>
			if found > 0 {
				if expanded {
					for (index, item) in items.iter().take(RECALL_EXPANDED_ITEMS).enumerate() {
						<text pad-x=2>{format!("{}. [{:.2}] {}", index + 1, item.get("score").and_then(Value::as_f64).unwrap_or_default(), clip(item.pointer("/memory/content").and_then(Value::as_str).unwrap_or_default(), ITEM_PREVIEW_WIDTH))}</text>
						<text pad-x=5 fg=muted>{format!("memory://{} · {} · {} · {}", item.pointer("/memory/id").and_then(Value::as_str).unwrap_or("?"), item.pointer("/memory/bank").and_then(Value::as_str).unwrap_or("?"), item.pointer("/memory/timestamp").and_then(Value::as_str).and_then(|stamp| stamp.get(..10)).unwrap_or("?"), item.pointer("/memory/source").and_then(Value::as_str).unwrap_or("unknown"))}</text>
						if let Some(context) = item.pointer("/memory/metadata/context").and_then(Value::as_str) {
							<text pad-x=5 fg=muted>{format!("({})", clip(context, ITEM_PREVIEW_WIDTH))}</text>
						}
					}
					if hidden > 0 {
						<text pad-x=2 fg=muted>{format!("… {hidden} more {}", if hidden == 1 { "memory" } else { "memories" })}</text>
					}
				} else {
					<text pad-x=2 fg=muted>{"⟨Ctrl+O: Expand⟩"}</text>
				}
			}
		</col>
	}.into_component()
}

/// Expanded recall bodies show this many memories.
const RECALL_EXPANDED_ITEMS: usize = 10;

fn render_reflect(view: &CardView<'_>, expanded: bool) -> Component {
	let query = clip(
		&field(
			&typed_input::<omp_tools::memory::ReflectParams>(view)
				.unwrap_or_else(|| partial_input(view)),
			"query",
		)
		.unwrap_or_default(),
		QUERY_PREVIEW_WIDTH,
	);
	if failed(view) {
		let message = failure(view);
		return dom! { <row gap=1 fg=err><i:error/><text>{format!("Error: {message}")}</text></row> }
			.into_component();
	}
	let Some(result) = typed_result::<omp_tools::memory::ReflectPayload>(view) else {
		return dom! {
			<row gap=0><i:pending fg=output/><text>{" "}</text><text fg=accent>{"Reflect"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {query}")}</text>
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
		}
		.into_component();
	};
	let answer = result
		.get("answer")
		.and_then(Value::as_str)
		.unwrap_or_default();
	let line_count = answer
		.lines()
		.filter(|line| !line.trim().is_empty())
		.count();
	let shown = if expanded {
		line_count.min(REFLECT_EXPANDED_LINES)
	} else {
		line_count.min(REFLECT_COLLAPSED_LINES)
	};
	dom! {
		<col>
			<row gap=0><icon name="memory-tool" fg=accent/><text>{" "}</text><text fg=accent>{"Reflect"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {query}")}</text></row>
			for line in answer.lines().filter(|line| !line.trim().is_empty()).take(shown) { <text pad-x=2 fg=output>{clip(line, ITEM_PREVIEW_WIDTH)}</text> }
			if shown < line_count {
				<text pad-x=2 fg=muted>{format!("… {} more lines ⟨Ctrl+O: Expand⟩", line_count - shown)}</text>
			}
		</col>
	}
	.into_component()
}

fn render_retain(view: &CardView<'_>, expanded: bool) -> Component {
	let args =
		typed_input::<omp_tools::memory::RetainParams>(view).unwrap_or_else(|| partial_input(view));
	if failed(view) {
		let message = failure(view);
		return dom! { <row gap=1 fg=err><i:error/><text>{format!("Error: {message}")}</text></row> }
			.into_component();
	}
	let items = args
		.get("items")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let settled = view.result::<omp_tools::memory::RetainPayload>().is_some();
	let summary = settled.then(|| {
		format!(
			"{} {} stored",
			items.len(),
			if items.len() == 1 {
				"memory"
			} else {
				"memories"
			}
		)
	});
	let shown = if expanded {
		items.len().min(RETAIN_EXPANDED_ITEMS)
	} else {
		items.len().min(RETAIN_COLLAPSED_ITEMS)
	};
	let hidden = items.len().saturating_sub(shown);
	dom! {
		<col>
			<row gap=1>
				if settled { <icon name="memory-tool" fg=accent/> } else { <i:pending fg=output/> }
				<text fg=accent>{"Retain"}</text>
				if let Some(summary) = summary { <text fg=muted>{summary}</text> }
				if let Some(badge) = elapsed_badge(view) { {badge} }
			</row>
			for item in items.iter().take(shown) {
				<row gap=1 pad-x=2><i:enabled fg=output/><text fg=output>{clip(&field(item, "content").unwrap_or_default(), ITEM_PREVIEW_WIDTH)}</text></row>
			}
			if hidden > 0 {
				<text pad-x=2 fg=muted>{format!("… {hidden} more {}", if hidden == 1 { "memory" } else { "memories" })}</text>
			}
		</col>
	}
	.into_component()
}

const QUERY_PREVIEW_WIDTH: u16 = 80;
const ITEM_PREVIEW_WIDTH: u16 = 512;
const REFLECT_COLLAPSED_LINES: usize = 3;
const REFLECT_EXPANDED_LINES: usize = 10;
const RETAIN_COLLAPSED_ITEMS: usize = 8;
const RETAIN_EXPANDED_ITEMS: usize = 64;

fn clip(text: &str, width: u16) -> String {
	let normalized = text.replace('\t', "   ");
	let clipped = truncate_to_width(&normalized, width);
	if clipped.ellipsis {
		format!("{}…", clipped.text)
	} else {
		clipped.text.to_owned()
	}
}

fn partial_input(view: &CardView<'_>) -> Value {
	let raw = node_text(view.input).unwrap_or_default();
	partial_object(raw.as_str())
}
fn field(value: &Value, key: &str) -> Option<String> {
	value.get(key).and_then(Value::as_str).map(str::to_owned)
}
fn partial_object(raw: &str) -> Value {
	let mut map = serde_json::Map::new();
	for key in ["query"] {
		if let Some(value) = extract_string(raw, key) {
			map.insert(key.into(), Value::String(value));
		}
	}
	Value::Object(map)
}
fn extract_string(raw: &str, key: &str) -> Option<String> {
	let marker = format!("\"{key}\":\"");
	let rest = raw.split_once(&marker)?.1;
	Some(rest.split('"').next().unwrap_or(rest).to_owned())
}
fn failed(view: &CardView<'_>) -> bool {
	view.status.as_str() == "error"
}
fn failure(view: &CardView<'_>) -> Str {
	if let Some(fault) = typed_fault::<omp_tools::memory::Fault>(view) {
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
