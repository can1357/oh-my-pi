//! Typed card for `browser@3`.

use omp_core::Str;
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, preview_lines, result_image, typed_input,
	typed_result,
};

/// Script and output lines a collapsed cell shows; `@expanded` lifts both
/// caps.
const PREVIEW_LINES: usize = 10;

/// Browser automation code-cell card.
pub struct BrowserCard;

impl Card for BrowserCard {
	fn tool(&self) -> &'static str {
		"browser"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::browser::Params>(view);
		let result = typed_result::<omp_tools::browser::Payload>(view);
		let fault_value = view
			.fault::<omp_tools::browser::Fault>()
			.and_then(|fault| serde_json::to_value(fault).ok());
		let name = result
			.as_ref()
			.or(fault_value.as_ref())
			.and_then(|value| value.get("name"))
			.and_then(Value::as_str)
			.or_else(|| args.as_ref()?.get("name")?.as_str())
			.unwrap_or("main")
			.to_owned();
		let code = args
			.as_ref()
			.and_then(|value| value.get("code"))
			.and_then(Value::as_str)
			.map(str::to_owned)
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "code"))
			.unwrap_or_default();
		let url = result
			.as_ref()
			.or(fault_value.as_ref())
			.and_then(|value| value.get("url"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		// The backend mode follows the URL in the title; payloads journaled
		// before the field existed show nothing.
		let kind = result
			.as_ref()
			.or(fault_value.as_ref())
			.and_then(|value| value.get("browser"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let artifact_values = result
			.as_ref()
			.and_then(|value| value.get("artifacts"))
			.and_then(Value::as_array)
			.cloned()
			.unwrap_or_default();
		let artifacts = artifact_values
			.iter()
			.filter(|artifact| {
				artifact.get("kind").and_then(Value::as_str) == Some("screenshot")
					&& artifact
						.get("visible")
						.and_then(Value::as_bool)
						.unwrap_or(true)
			})
			.filter_map(|artifact| {
				Some(result_image(
					&Str::new(artifact.get("uri")?.as_str()?),
					artifact
						.get("mime")
						.and_then(Value::as_str)
						.unwrap_or("image/png"),
					None,
					ui,
				))
			})
			.collect::<Vec<_>>();
		let downloads = artifact_values
			.iter()
			.filter(|artifact| {
				artifact.get("kind").and_then(Value::as_str) == Some("download")
					&& artifact
						.get("visible")
						.and_then(Value::as_bool)
						.unwrap_or(true)
			})
			.filter_map(|artifact| artifact.get("uri").and_then(Value::as_str))
			.map(Str::new)
			.collect::<Vec<_>>();
		let artifact_count = artifact_values.len();
		let code = if expanded {
			Str::new(code)
		} else {
			preview_lines(&code, PREVIEW_LINES)
		};
		let displayed = result
			.as_ref()
			.and_then(|value| value.get("display"))
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.map(display_value)
			.map(|text| {
				if expanded {
					Str::new(text)
				} else {
					preview_lines(&text, PREVIEW_LINES)
				}
			})
			.collect::<Vec<_>>();
		let returned = result
			.as_ref()
			.and_then(|value| value.get("result"))
			.map(display_value)
			.map(|text| {
				if expanded {
					Str::new(text)
				} else {
					preview_lines(&text, PREVIEW_LINES)
				}
			});
		let fault = diag_text(view).or_else(|| {
			result
				.as_ref()
				.and_then(|value| value.get("error"))
				.and_then(Value::as_str)
				.map(str::to_owned)
		});
		let live = matches!(view.status, CardStatus::StreamingArgs | CardStatus::InProgress);
		dom! {
			<box border=round bc={if view.status == CardStatus::Failed { "err" } else if live { "accent" } else { "muted" }} bg={if view.status == CardStatus::Failed { "error_surface" } else { "panel" }} bleed pad-x=1 title_pad=3>
				<row kind=title gap=1>
					if live { <spinner kind=status/><text fg=output>{"running"}</text><text>{format!("tab \"{name}\"")}</text> }
					else if view.status == CardStatus::Done { <text fg=ok>{icon(ui, "done")}</text><text>{format!("tab \"{name}\"")}</text> }
					else { <text fg=err>{icon(ui, "error")}</text><text>{format!("tab \"{name}\"")}</text> }
					if !url.is_empty() { <text>{"·"}</text><text fg=muted>{url}</text> }
					if !kind.is_empty() { <text>{"·"}</text><text fg=muted>{kind}</text> }
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if !code.is_empty() { <pre path="cell.js">{code}</pre> }
				if matches!(view.status, CardStatus::Done | CardStatus::Failed) {
					<hr title="Output" title_pad=3 bc={if view.status == CardStatus::Failed { "err" } else { "muted" }}/>
					if let Some(fault) = fault {
						<pre fg=output>{fault}</pre>
					} else {
						for displayed in displayed { <pre fg=ok>{displayed}</pre> }
						if let Some(returned) = returned { <pre fg=output>{returned}</pre> }
						if artifact_count > 0 {
							if expanded {
								{artifacts}
								for download in downloads { <a href={download.clone()}>{format!("download: {download}")}</a> }
							}
							else { <text fg=muted>{format!("{artifact_count} retained artifact{}", if artifact_count == 1 { "" } else { "s" })}</text> }
						}
					}
				}
			</box>
		}
		.into_component()
	}
}

fn icon<'a>(ui: &'a UiContext, name: &'a str) -> &'a str {
	ui.charset.icon_named(name).unwrap_or(name)
}

fn display_value(value: &Value) -> String {
	match value {
		Value::String(text) => format!("\"{text}\""),
		Value::Object(fields) => {
			let body = fields
				.iter()
				.map(|(key, value)| format!("{key}: {}", display_value(value)))
				.collect::<Vec<_>>()
				.join(", ");
			format!("{{ {body} }}")
		},
		_ => value.to_string(),
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

fn diag_text(view: &CardView<'_>) -> Option<String> {
	view.diag.and_then(|node| {
		node
			.content
			.as_deref()
			.or_else(|| {
				node
					.prop(&omp_dom::PropId::Text.into())
					.and_then(omp_dom::Value::as_str)
			})
			.filter(|text| !text.is_empty())
			.map(str::to_owned)
	})
}
