//! Typed card for whole-file writes.

use omp_core::{Str, sf};
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, file_link, path_language_icon,
	typed_fault, typed_input, typed_result,
};

/// Card for `write` calls.
pub struct WriteCard;

impl Card for WriteCard {
	fn tool(&self) -> &'static str {
		"write"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::write::Params>(view).unwrap_or(Value::Null);
		let path = string_at(&args, "path")
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "path"))
			.unwrap_or_default();
		let content = string_at(&args, "content").unwrap_or_default();
		match view.status {
			CardStatus::StreamingArgs => render_streaming(path, content, expanded, ui),
			CardStatus::InProgress => render_progress(view, path, content, expanded, ui),
			CardStatus::Done => render_done(view, path, content, expanded, ui),
			CardStatus::Failed => render_failed(view, path, ui),
		}
	}
}

/// Collapsed streaming previews follow the edge with a bounded tail window;
/// `@expanded` lifts the cap.
const STREAMING_PREVIEW_LINES: usize = 12;

/// Numbers every segment of streamed content: a trailing newline yields a
/// numbered empty row, and the gutter keeps counting past the fixture's two
/// lines.
fn render_streaming(path: &str, content: &str, expanded: bool, _ui: &UiContext) -> Component {
	let total = content.split('\n').count();
	let start = if expanded {
		0
	} else {
		total.saturating_sub(STREAMING_PREVIEW_LINES)
	};
	let mut body = String::new();
	if start > 0 {
		let noun = if start == 1 { "line" } else { "lines" };
		use std::fmt::Write as _;
		let _ = writeln!(body, "… ({start} earlier {noun})");
	}
	if !content.is_empty() {
		body.push_str(&number_segments(content.split('\n').skip(start), start + 1));
	}
	let href = file_link(path);
	dom! {
		<box border=round bc=border bg=panel bleed title_pad=3>
			<row kind=title gap=0><text fg=accent>{"Write"}</text><text>{":"}</text><text>{" "}</text>
				<icon name={path_language_icon(path)} fg=output/><text>{" "}</text><text fg=accent href={href} wrap=pre>{path}</text><text>{" "}</text>
			</row>
			if !body.is_empty() { <pre pad-x=1 path={path}>{body}</pre> }
			<row pad-x=1 gap=1>
				<spinner kind=status/>
				<text fg=muted>{"… (streaming)"}</text>
			</row>
		</box>
	}
	.into_component()
}

fn render_progress(
	view: &CardView<'_>,
	path: &str,
	content: &str,
	expanded: bool,
	_ui: &UiContext,
) -> Component {
	let lines = segments(content);
	let full = Str::new(number_segments(lines.iter().copied(), 1));
	let skipped = lines.len().saturating_sub(12);
	let middle = Str::new(number_segments(lines.iter().skip(skipped).copied(), skipped + 1));
	let href = file_link(path);
	dom! {
		<box border=round bc=border bg=panel bleed title_pad=3>
			<row kind=title gap=0>
				<text fg=accent>{"Write"}</text><text>{":"}</text><text>{" "}</text>
				<icon name={path_language_icon(path)} fg=output/><text>{" "}</text><text fg=accent href={href} wrap=pre>{path}</text>
				if let Some(badge) = elapsed_badge(view) { {badge} }
				<text>{" "}</text>
			</row>
			if expanded {
				<pre pad-x=1 path={path}>{full}</pre>
			} else {
				if skipped > 0 { <row pad-x=1><text fg=muted>{sf!("… ({skipped} earlier lines)")}</text></row> }
				<pre pad-x=1 path={path}>{middle}</pre>
			}
			<row pad-x=1><text fg=muted>{"… (streaming)"}</text></row>
		</box>
	}
	.into_component()
}

fn render_done(
	view: &CardView<'_>,
	path: &str,
	content: &str,
	expanded: bool,
	_ui: &UiContext,
) -> Component {
	let _result = typed_result::<omp_tools::write::Payload>(view).unwrap_or(Value::Null);
	let lines = segments(content);
	let line_count = lines.len();
	let full = Str::new(number_segments(lines.iter().copied(), 1));
	let head = Str::new(number_segments(lines.iter().take(6).copied(), 1));
	let href = file_link(path);
	dom! {
		<box border=round bc=border bg=panel bleed title_pad=3>
			<row kind=title gap=0><i:write fg=accent/><text>{" "}</text><text fg=accent>{"Write"}</text><text>{":"}</text><text>{" "}</text>
				<icon name={path_language_icon(path)} fg=output/><text>{" "}</text><text fg=accent href={href} wrap=pre>{path}</text>
				<text fg=muted wrap=pre>{sf!(" · {line_count} lines")}</text><text>{" "}</text>
			</row>
			if expanded {
				<pre pad-x=1 path={path}>{full}</pre>
			} else {
				<pre pad-x=1 path={path}>{head}</pre>
				if line_count > 6 {
					<row pad-x=1><text fg=muted>{sf!("… {} more lines ⟨Ctrl+O: Expand⟩", line_count - 6)}</text></row>
				}
			}
		</box>
	}
	.into_component()
}

fn render_failed(view: &CardView<'_>, path: &str, _ui: &UiContext) -> Component {
	let fault = typed_fault::<omp_tools::write::Fault>(view)
		.or_else(|| diag_text(view.diag))
		.unwrap_or_else(|| Str::new_static("write failed"));
	let href = file_link(path);
	dom! {
		<box border=round bc=err bg=error_surface bleed title_pad=3>
			<row kind=title gap=0><i:error fg=err/><text>{" "}</text><text fg=accent>{"Write"}</text><text>{":"}</text><text>{" "}</text>
				<icon name={path_language_icon(path)} fg=output/><text>{" "}</text><text fg=accent href={href} wrap=pre>{path}</text><text>{" "}</text>
			</row>
			<text pad-x=3 fg=err wrap=word>{fault}</text>
		</box>
	}
	.into_component()
}

/// Every newline-delimited segment, so a trailing newline yields a final empty
/// numbered row and counts as a line; empty content has none.
fn segments(content: &str) -> Vec<&str> {
	if content.is_empty() {
		return Vec::new();
	}
	content.split('\n').collect()
}

fn number_segments<'a>(lines: impl Iterator<Item = &'a str>, start: usize) -> String {
	let mut out = String::new();
	for (offset, line) in lines.enumerate() {
		if offset > 0 {
			out.push('\n');
		}
		use std::fmt::Write as _;
		let _ = write!(out, "{:>3} {}", start + offset, line.replace('\t', "   "));
	}
	out
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
