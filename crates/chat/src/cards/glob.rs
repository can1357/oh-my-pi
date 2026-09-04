//! Typed card for workspace glob searches.

use omp_core::{Str, sf};
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, path_language_icon, typed_fault,
	typed_input, typed_result,
};

/// Card for `glob` calls.
pub struct GlobCard;

impl Card for GlobCard {
	fn tool(&self) -> &'static str {
		"glob"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::glob::Params>(view).unwrap_or(Value::Null);
		let query = string_at(&args, "path")
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "path"))
			.unwrap_or("*");
		match view.status {
			CardStatus::StreamingArgs | CardStatus::InProgress => {
				let limit = args
					.get("limit")
					.and_then(Value::as_f64)
					.map(|value| value as u64);
				dom! {
					<row gap=1 pad-x=1>
						<i:pending fg=output/><text>{"Glob:"}</text><text fg=output>{query}</text>
						if let Some(limit) = limit { <text fg=muted>{sf!("limit:{limit}")}</text> }
						if let Some(badge) = elapsed_badge(view) { {badge} }
					</row>
				}
				.into_component()
			},
			CardStatus::Done => render_done(view, query, expanded),
			CardStatus::Failed => render_failed(view),
		}
	}
}

/// Files listed before a collapsed card folds the rest into one
/// `… N more files` row.
const COLLAPSED_FILES: usize = 8;

fn render_done(view: &CardView<'_>, query: &str, expanded: bool) -> Component {
	let result = typed_result::<omp_tools::glob::Payload>(view).unwrap_or(Value::Null);
	let files = result
		.get("files")
		.or_else(|| result.get("matches"))
		.and_then(Value::as_array)
		.cloned()
		.unwrap_or_default();
	let count = files.len() as u64;
	let count_label = if count == 1 { "file" } else { "files" };
	let scope = glob_scope(query);
	let timed_out = result
		.get("timed_out")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let truncated = timed_out
		|| result
			.get("truncated")
			.and_then(Value::as_bool)
			.unwrap_or(false);
	let missing_paths = result
		.get("missing_paths")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
		.collect::<Vec<_>>();
	let missing_note =
		(!missing_paths.is_empty()).then(|| sf!("skipped missing: {}", missing_paths.join(", ")));
	let limit_note = result
		.get("result_limit_reached")
		.and_then(Value::as_u64)
		.map(|limit| sf!("truncated: limit {limit} results"));
	let shown = if expanded {
		files.len()
	} else {
		files.len().min(COLLAPSED_FILES)
	};
	let hidden = files.len() - shown;
	let more = sf!("… {hidden} more file{}", if hidden == 1 { "" } else { "s" });
	dom! {
		<col pad-x=1>
			<row gap=1>
				if truncated { <i:warning fg=warn/> } else { <i:search fg=default/> }
				<text>{"Glob:"}</text><text fg=output>{query}</text>
				<text fg=muted>{sf!("{count} {count_label} · in {scope}")}</text>
				if truncated { <text fg=warn>{"truncated"}</text> }
			</row>
			if files.is_empty() {
				<text fg=muted>{if timed_out { "No matches before timeout (scan incomplete)" } else { "No files found" }}</text>
			} else {
				<col>
					for (index, file) in files.iter().take(shown).enumerate() {
						<row gap=1>
							if index + 1 == shown && hidden == 0 { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
							<icon name={path_language_icon(file_path(file))} fg=output/><text fg=output href={super::file_link(file_path(file))}>{file_path(file)}</text>
						</row>
					}
					if hidden > 0 {
						<row gap=1><i:tree-last fg=muted/><text fg=muted>{more}</text></row>
					}
				</col>
			}
			if timed_out {
				<row gap=1 fg=warn><i:warning/><text>{"timed out; results are incomplete"}</text></row>
			}
			if let Some(note) = limit_note {
				<row gap=1 fg=warn><i:warning/><text>{note}</text></row>
			}
			if let Some(note) = missing_note {
				<row gap=1 fg=warn><i:warning/><text>{note}</text></row>
			}
		</col>
	}
	.into_component()
}

fn render_failed(view: &CardView<'_>) -> Component {
	let fault = typed_fault::<omp_tools::glob::Fault>(view)
		.or_else(|| diag_text(view.diag))
		.unwrap_or_else(|| Str::new_static("glob failed"));
	dom! { <row gap=1 pad-x=1 fg=err><i:error/><text>{sf!("Error: {fault}")}</text></row> }
		.into_component()
}

fn glob_scope(pattern: &str) -> &str {
	if pattern.contains(';') {
		return ".";
	}
	let prefix = pattern
		.find(['*', '?', '[', '{'])
		.map_or(pattern, |wildcard| &pattern[..wildcard]);
	let prefix = prefix.trim_end_matches('/');
	if prefix.len() == pattern.len() {
		if prefix.is_empty() { "." } else { prefix }
	} else if prefix.is_empty() {
		"."
	} else {
		prefix
	}
}

fn file_path(value: &Value) -> &str {
	value
		.as_str()
		.or_else(|| string_at(value, "path"))
		.unwrap_or_default()
}

fn string_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value.get(key).and_then(Value::as_str)
}

fn partial_string<'a>(json: &'a str, key: &str) -> Option<&'a str> {
	let marker = sf!("\"{key}\":\"");
	let rest = json.get(json.find(marker.as_str())? + marker.len()..)?;
	Some(rest.split('"').next().unwrap_or(rest))
}

fn diag_text(node: Option<&Node>) -> Option<Str> {
	let raw = node.and_then(|node| {
		node.content.as_deref().or_else(|| {
			node
				.prop(&PropId::Text.into())
				.and_then(omp_dom::Value::as_str)
		})
	})?;
	let value: Value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.into()));
	value
		.as_str()
		.or_else(|| string_at(&value, "message"))
		.map(Str::new)
}
