//! Typed card for `computer@3`.

use omp_core::Str;
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, preview_lines, result_image, typed_fault,
	typed_input, typed_result,
};

/// Native-desktop status card.
pub struct ComputerCard;

/// Script lines a collapsed card shows; expanded shows the whole script.
const CODE_COLLAPSED: usize = 10;
/// Output lines shown collapsed and expanded.
const OUTPUT_COLLAPSED: usize = 3;
const OUTPUT_EXPANDED: usize = 10;

impl Card for ComputerCard {
	fn tool(&self) -> &'static str {
		"computer"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let input = typed_input::<omp_tools::computer::Params>(view);
		let result = typed_result::<omp_tools::computer::Payload>(view);
		let action = result
			.as_ref()
			.and_then(|value| value.get("action"))
			.and_then(Value::as_str)
			.or_else(|| input.as_ref()?.get("action")?.as_str())
			.unwrap_or("run");
		let code = result
			.as_ref()
			.and_then(|value| value.get("code"))
			.and_then(Value::as_str)
			.or_else(|| input.as_ref()?.get("code")?.as_str())
			.unwrap_or_default();
		let output = result
			.as_ref()
			.and_then(|value| {
				value
					.get("results")
					.filter(|results| !results.as_array().is_some_and(Vec::is_empty))
					.or_else(|| {
						value
							.get("capabilities")
							.filter(|capabilities| !capabilities.is_null())
					})
			})
			.map(|value| serde_json::to_string_pretty(value).unwrap_or_default());
		let artifacts = result
			.as_ref()
			.and_then(|value| value.get("artifacts"))
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter(|artifact| {
				artifact
					.get("visible")
					.and_then(Value::as_bool)
					.unwrap_or(true)
			})
			.filter_map(|artifact| {
				let uri = artifact
					.as_str()
					.or_else(|| artifact.get("uri").and_then(Value::as_str))?;
				let mime = artifact
					.get("mime")
					.and_then(Value::as_str)
					.unwrap_or("image/png");
				Some(result_image(&Str::new(uri), mime, None, ui))
			})
			.collect::<Vec<_>>();
		let fault = typed_fault::<omp_tools::computer::Fault>(view).or_else(|| {
			view
				.diag
				.and_then(|node| {
					node.content.clone().or_else(|| {
						node
							.prop(&omp_dom::PropId::Text.into())
							.and_then(omp_dom::Value::as_str)
							.map(Str::new)
					})
				})
				.map(|raw| {
					serde_json::from_str::<String>(raw.as_str())
						.map(Str::new)
						.unwrap_or(raw)
				})
		});
		// The header names the error state.
		let failed = view.status == CardStatus::Failed;
		// Both states use bounded script and output previews; only the bounds
		// change with `@expanded`.
		let code = (!code.is_empty()).then(|| {
			if expanded {
				Str::new(code)
			} else {
				preview_lines(code, CODE_COLLAPSED)
			}
		});
		let output = output.map(|output| {
			preview_lines(
				output.as_str(),
				if expanded {
					OUTPUT_EXPANDED
				} else {
					OUTPUT_COLLAPSED
				},
			)
		});
		let action_suffix = match action {
			"capabilities" => Some(": capabilities"),
			"close" => Some(": closed"),
			_ => None,
		};
		dom! {
			<col>
				<row gap=1 kind=title>
					match view.status {
						CardStatus::StreamingArgs | CardStatus::InProgress => <i:pending/>,
						CardStatus::Done => <i:success/>,
						CardStatus::Failed => <i:error/>,
					}
					<row>
						<text fg=accent>{"Computer"}</text>
						if failed {
							<text fg=output>{": error"}</text>
						} else if let Some(suffix) = action_suffix {
							<text fg=muted>{suffix}</text>
						}
					</row>
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
				if let Some(code) = code {
					<text pad-x=2 fg=muted>{"Code"}</text>
					<pre pad-x=2>{code}</pre>
				}
				if let Some(output) = output {
					<text pad-x=2 fg=muted>{"Output"}</text>
					<pre pad-x=2>{output}</pre>
				}
				if expanded { {artifacts} }
				if let Some(fault) = fault { <text pad-x=2 fg=err>{fault}</text> }
			</col>
		}
		.into_component()
	}
}
