//! Workpool projections embedded in `eval@1` display outputs.
//!
//! The Python helper reports ordered status events while a cell is live and
//! returns ordinary JSON snapshots from `status()` / `peek()`. This renderer
//! recognizes only those closed shapes; unrelated `display()` values continue
//! through the generic JSON-tree renderer.

use std::fmt::Write as _;

use omp_core::{Str, sf};
use omp_tools::eval::DisplayOutput;
use omp_tui::{IntoComponent as _, dom};
use serde_json::Value;

use super::Component;

const COLLAPSED_EVENTS: usize = 3;
const COLLAPSED_WORKERS: usize = 3;
const COLLAPSED_BATCHES: usize = 3;
const COLLAPSED_OUTPUT_LINES: usize = 3;

/// Whether a JSON display value is one of the workpool helper's aggregate
/// snapshots.
pub(super) fn is_snapshot(value: &Value) -> bool {
	is_status(value) || is_peek(value)
}

/// Renders ordered workpool status events and aggregate snapshots retained by
/// the eval result.
pub(super) fn render(outputs: &[DisplayOutput], expanded: bool) -> Vec<Component> {
	let events = outputs
		.iter()
		.filter_map(|output| match output {
			DisplayOutput::Status { event }
				if event.get("op").and_then(Value::as_str) == Some("workpool") =>
			{
				Some(event)
			},
			_ => None,
		})
		.collect::<Vec<_>>();
	let mut components = Vec::new();
	if !events.is_empty() {
		components.push(render_events(&events, expanded));
	}
	components.extend(outputs.iter().filter_map(|output| match output {
		DisplayOutput::Json { data } if is_status(data) => Some(render_status(data, expanded)),
		DisplayOutput::Json { data } if is_peek(data) => Some(render_peek(data, expanded)),
		_ => None,
	}));
	components
}

fn is_status(value: &Value) -> bool {
	value.get("name").and_then(Value::as_str).is_some()
		&& value.get("agents").is_some_and(Value::is_array)
		&& value.get("items").is_some_and(Value::is_object)
		&& value.get("batches").and_then(Value::as_u64).is_some()
}

fn is_peek(value: &Value) -> bool {
	value.get("batches").is_some_and(Value::is_array)
		&& value.get("pending").and_then(Value::as_u64).is_some()
}

fn render_events(events: &[&Value], expanded: bool) -> Component {
	let shown = if expanded {
		events.len()
	} else {
		events.len().min(COLLAPSED_EVENTS)
	};
	let hidden = events.len().saturating_sub(shown);
	let mut rows = Vec::with_capacity(shown + usize::from(hidden > 0));
	if hidden > 0 {
		rows.push(
			dom! { <row gap=1><i:tree-branch fg=muted/><text fg=muted>{sf!("… {hidden} earlier updates")}</text></row> }
				.into_component(),
		);
	}
	for (index, event) in events.iter().skip(hidden).enumerate() {
		let action = event
			.get("action")
			.and_then(Value::as_str)
			.unwrap_or("update");
		let pool = event.get("pool").and_then(Value::as_str).unwrap_or("pool");
		let count = event.get("count").and_then(Value::as_u64);
		let badge = event
			.get("model")
			.or_else(|| event.get("agent"))
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.map(|value| sf!("⟨{value}⟩"));
		let error = event.get("error").and_then(Value::as_str).map(Str::new);
		let last = index + 1 == shown;
		let count_label = count.map(|count| {
			let noun = match action {
				"create" => {
					if count == 1 {
						"agent"
					} else {
						"agents"
					}
				},
				_ => {
					if count == 1 {
						"item"
					} else {
						"items"
					}
				},
			};
			sf!("{count} {noun}")
		});
		rows.push(
			dom! {
				<row gap=1>
					if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
					if error.is_some() { <i:error fg=err/> }
					else if action == "close" || action == "cancel" { <i:cancelled fg=warn/> }
					else if action == "status" || action == "peek" { <i:done fg=ok/> }
					else { <i:package fg=accent/> }
					<text fg=muted>{action}</text><text fg=accent>{pool}</text>
					if let Some(count_label) = count_label { <text fg=muted>{count_label}</text> }
					if let Some(badge) = badge { <text fg=muted>{badge}</text> }
					if let Some(error) = error { <text fg=err>{error}</text> }
				</row>
			}
			.into_component(),
		);
	}
	dom! {
		<col pad-x=1>
			<row gap=1><i:package fg=accent/><text fg=accent>{"Workpool"}</text><text fg=muted>{"updates"}</text></row>
			{rows}
		</col>
	}
	.into_component()
}

fn render_status(value: &Value, expanded: bool) -> Component {
	let name = Str::new(value.get("name").and_then(Value::as_str).unwrap_or("pool"));
	let agent = value
		.get("model")
		.or_else(|| value.get("resolvedModel"))
		.or_else(|| value.get("agent"))
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map(|value| sf!("⟨{value}⟩"));
	let closed = value
		.get("closed")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let batches = value
		.get("batches")
		.and_then(Value::as_u64)
		.unwrap_or_default();
	let agents = value
		.get("agents")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let shown = if expanded {
		agents.len()
	} else {
		agents.len().min(COLLAPSED_WORKERS)
	};
	let hidden = agents.len().saturating_sub(shown);
	let mut worker_rows = Vec::with_capacity(shown + usize::from(hidden > 0));
	for (index, worker) in agents.iter().take(shown).enumerate() {
		let id = Str::new(worker.get("id").and_then(Value::as_str).unwrap_or("worker"));
		let state = worker
			.get("state")
			.and_then(Value::as_str)
			.unwrap_or("running");
		let queued = worker
			.get("queued")
			.and_then(Value::as_u64)
			.unwrap_or_default();
		let turns = worker
			.get("turns")
			.and_then(Value::as_u64)
			.unwrap_or_default();
		let current = worker.get("current").and_then(Value::as_str).map(Str::new);
		let model = worker
			.get("model")
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.map(|value| sf!("⟨{value}⟩"));
		let last = index + 1 == shown && hidden == 0;
		worker_rows.push(
			dom! {
				<col>
					<row gap=1>
						if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
						if state == "idle" { <i:done fg=ok/> } else if state == "dead" { <i:error fg=err/> } else { <i:pending fg=output/> }
						<text fg=accent>{id}</text><text fg={if state == "dead" { "err" } else { "muted" }}>{sf!("⟨{state}⟩")}</text>
						if let Some(model) = model { <text fg=muted>{model}</text> }
						<text fg=muted>{sf!("{turns} turns · {queued} queued")}</text>
					</row>
					if let Some(current) = current { <row gap=1 pad-x=3><i:tree-vertical fg=muted/><text fg=muted>{"batch"}</text><text fg=output>{current}</text></row> }
				</col>
			}
			.into_component(),
		);
	}
	if hidden > 0 {
		worker_rows.push(
			dom! { <row gap=1><i:tree-last fg=muted/><text fg=muted>{sf!("… {hidden} more workers")}</text></row> }
				.into_component(),
		);
	}
	let item_rows = value
		.get("items")
		.and_then(Value::as_object)
		.into_iter()
		.flat_map(|items| {
			["queued", "running", "completed", "failed", "cancelled"]
				.into_iter()
				.filter_map(move |state| {
					let count = items.get(state).and_then(Value::as_u64).unwrap_or_default();
					(count > 0).then(|| item_count_row(state, count))
				})
		})
		.collect::<Vec<_>>();
	let summary = sf!("{batches} {}", if batches == 1 { "batch" } else { "batches" });
	dom! {
		<box border=round bc={if closed { "muted" } else { "accent" }} bg=panel bleed pad-x=1 title_pad=3>
			<row kind=title gap=1>
				if closed { <i:done fg=ok/> } else { <i:pending fg=output/> }
				<text fg=accent>{"Pool"}</text><text bold>{name}</text>
				if let Some(agent) = agent { <text fg=muted>{agent}</text> }
				<text fg=muted>{summary}</text>
			</row>
			if !item_rows.is_empty() { <row gap=2 pad-x=1>{item_rows}</row> }
			if !worker_rows.is_empty() { <hr title="Workers" title_pad=3/>{worker_rows} }
		</box>
	}
	.into_component()
}

fn item_count_row(state: &'static str, count: u64) -> Component {
	let color = match state {
		"completed" => "ok",
		"failed" => "err",
		"cancelled" => "warn",
		_ => "muted",
	};
	dom! { <row gap=1><text fg={color}>{sf!("{count} {state}")}</text></row> }.into_component()
}

fn render_peek(value: &Value, expanded: bool) -> Component {
	let pending = value
		.get("pending")
		.and_then(Value::as_u64)
		.unwrap_or_default();
	let batches = value
		.get("batches")
		.and_then(Value::as_array)
		.map(Vec::as_slice)
		.unwrap_or_default();
	let shown = if expanded {
		batches.len()
	} else {
		batches.len().min(COLLAPSED_BATCHES)
	};
	let hidden = batches.len().saturating_sub(shown);
	let mut rows = Vec::with_capacity(shown + usize::from(hidden > 0));
	for (index, batch) in batches.iter().take(shown).enumerate() {
		let id = Str::new(batch.get("id").and_then(Value::as_str).unwrap_or("batch"));
		let worker = batch.get("agent").and_then(Value::as_str).map(Str::new);
		let status = batch
			.get("status")
			.and_then(Value::as_str)
			.unwrap_or("running");
		let item_count = batch
			.get("items")
			.and_then(Value::as_array)
			.map_or(0, Vec::len);
		let output = batch
			.get("output")
			.and_then(Value::as_str)
			.filter(|text| !text.is_empty())
			.map(|text| preview(text, expanded));
		let failed = status == "failed" || status == "cancelled";
		let last = index + 1 == shown && hidden == 0;
		rows.push(
			dom! {
				<col>
					<row gap=1>
						if last { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
						if status == "completed" { <i:done fg=ok/> } else if failed { <i:error fg=err/> } else { <i:pending fg=output/> }
						<text fg=accent>{id}</text><text fg={if failed { "err" } else { "muted" }}>{sf!("⟨{status}⟩")}</text>
						if let Some(worker) = worker { <text fg=muted>{sf!("⟨{worker}⟩")}</text> }
						<text fg=muted>{sf!("{item_count} {}", if item_count == 1 { "item" } else { "items" })}</text>
					</row>
					if let Some(output) = output { <pre pad-x=3 fg={if failed { "err" } else { "output" }}>{output}</pre> }
				</col>
			}
			.into_component(),
		);
	}
	if hidden > 0 {
		rows.push(
			dom! { <row gap=1><i:tree-last fg=muted/><text fg=muted>{sf!("… {hidden} more batches")}</text></row> }
				.into_component(),
		);
	}
	dom! {
		<box border=round bc={if pending > 0 { "accent" } else { "muted" }} bg=panel bleed pad-x=1 title_pad=3>
			<row kind=title gap=1><i:package fg=accent/><text fg=accent>{"Workpool results"}</text><text fg=muted>{sf!("{pending} pending")}</text></row>
			{rows}
		</box>
	}
	.into_component()
}

fn preview(text: &str, expanded: bool) -> Str {
	if expanded {
		return Str::new(text.trim_end());
	}
	let lines = text.lines().collect::<Vec<_>>();
	let shown = lines.len().min(COLLAPSED_OUTPUT_LINES);
	let hidden = lines.len().saturating_sub(shown);
	let mut output = lines.into_iter().take(shown).collect::<Vec<_>>().join("\n");
	if hidden > 0 {
		let _ = write!(output, "\n… {hidden} more lines");
	}
	Str::new(output)
}
