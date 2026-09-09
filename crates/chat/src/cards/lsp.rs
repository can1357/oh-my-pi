//! Typed card for `lsp@3`.

use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_input, typed_result};

/// Collapsed generic responses show the first line plus this many more.
const GENERIC_PREVIEW_LINES: usize = 3;

/// Language-server request and reference-result card.
pub struct LspCard;

impl Card for LspCard {
	fn tool(&self) -> &'static str {
		"lsp"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::lsp::Params>(view);
		let result = typed_result::<omp_tools::lsp::Payload>(view);
		// A settled typed payload is authoritative. Arguments remain the
		// action source only while the call is still in progress.
		let action = result
			.as_ref()
			.and_then(|value| value.get("action"))
			.and_then(Value::as_str)
			.or_else(|| {
				args
					.as_ref()
					.and_then(|value| value.get("action"))
					.and_then(Value::as_str)
			})
			.unwrap_or_default()
			.to_owned();
		let path = args
			.as_ref()
			.and_then(|value| value.get("file"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let line = args
			.as_ref()
			.and_then(|value| value.get("line"))
			.and_then(Value::as_u64);
		let symbol = args
			.as_ref()
			.and_then(|value| value.get("symbol"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let files = if action == "references" {
			result
				.as_ref()
				.and_then(|value| value.get("data"))
				.map(|data| {
					data
						.get("references")
						.and_then(|references| serde_json::from_value(references.clone()).ok())
						.unwrap_or_else(|| omp_tools::lsp::navigation::group_locations(data))
				})
				.unwrap_or_default()
		} else {
			Vec::new()
		};
		let count: usize = files.iter().map(|file| file.locations.len()).sum();
		// Hover text, symbol tables, diagnostics, and "OK" all ride the
		// bounded `output` projection; a zero-reference search never leaves
		// the Response empty.
		let output_lines = result
			.as_ref()
			.and_then(|value| value.get("output"))
			.and_then(Value::as_str)
			.map(str::trim_end)
			.filter(|text| !text.is_empty())
			.map(|text| text.lines().map(str::to_owned).collect::<Vec<_>>())
			.unwrap_or_default();
		let output_first = output_lines
			.first()
			.map_or_else(|| "No output".to_owned(), |line| line.trim().to_owned());
		let output_preview = output_lines
			.iter()
			.skip(1)
			.take(GENERIC_PREVIEW_LINES)
			.map(|line| line.trim().to_owned())
			.collect::<Vec<_>>();
		let output_hidden = output_lines.len().saturating_sub(1 + GENERIC_PREVIEW_LINES);
		let fault = diag_text(view).unwrap_or_default();
		dom! {
			<col>
				match view.status {
				CardStatus::StreamingArgs | CardStatus::InProgress => {
					<row gap=0>
						<i:pending fg=output/><text>{" "}</text><text fg=accent>{"LSP"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {action}")}</text>
						if !path.is_empty() {
							<text fg=output wrap=pre>{if let Some(line) = line { format!(" {path}:{line}") } else { format!(" {path}") }}</text>
						}
						if !symbol.is_empty() {
							<text fg=output wrap=pre>{format!(" ({symbol})")}</text>
						}
						if let Some(badge) = elapsed_badge(view) { {badge} }
					</row>
				},
				CardStatus::Done | CardStatus::Failed => {
					<box border=round pad-x=1 title_pad=3 bc=muted>
						<row kind=title gap=1>
							if view.status == CardStatus::Failed { <i:error fg=err/> } else { <i:lsp fg=accent/> }
							<text>{format!("LSP {action}")}</text>
						</row>
						if !path.is_empty() { <text fg=output>{path}</text> }
						if let Some(line) = line { <text fg=muted>{format!("line {line}")}</text> }
						if !symbol.is_empty() { <text fg=muted>{format!("symbol: {symbol}")}</text> }
						<hr title="Response" title_pad=3 bc=muted/>
						if view.status == CardStatus::Failed {
							if expanded {
								<row gap=1><i:info-status/><text>{"Output"}</text></row>
								<row pad-x=1 gap=1><i:tree-last/><text>{fault}</text></row>
							} else {
								<row gap=1><i:info-status/><text>{fault}</text></row>
							}
						} else if count > 0 {
							<row gap=1><i:lsp fg=accent/><text fg=muted>{if expanded { format!("{count} found") } else { format!("{count} found⟨Ctrl+O: Expand⟩") }}</text></row>
							<col pad-x=1>
								for (file_index, file) in files.iter().enumerate() {
									if expanded || file_index < 3 {
										<row>
											<icon fg=muted name={if expanded && file_index + 1 == files.len() { "tree-last" } else { "tree-branch" }}/><text>{" "}</text>
											<text fg=accent>{file_path(file)}</text><text>{" "}</text><text fg=muted>{reference_label(file)}</text>
										</row>
										for (location_index, location) in locations(file).iter().enumerate() {
											if expanded || location_index == 0 {
												<row>
													if expanded && file_index + 1 == files.len() { <spacer w=2/> } else { <i:tree-vertical/><text>{"   "}</text> }
													<icon pad-x=1 name={if expanded && location_index + 1 == locations(file).len() || !expanded && locations(file).len() == 1 { "tree-last" } else { "tree-branch" }}/>
													<text fg=output>{format!("line {}", location_label(location))}</text>
												</row>
												if expanded {
													<row>
														if expanded && file_index + 1 == files.len() { <spacer w=3/> } else { <i:tree-vertical/><spacer w=2/> }
														if expanded && location_index + 1 == locations(file).len() || !expanded && locations(file).len() == 1 { <spacer w=3/> } else { <i:tree-vertical/><spacer w=2/> }
														<text>{format!("at {}", location_href(file, location))}</text>
													</row>
												}
											}
										}
										if !expanded && locations(file).len() > 1 {
											<row><i:tree-vertical/><text>{"   "}</text><icon name="tree-last" pad-x=1/><text>{format!("… {} more", locations(file).len() - 1)}</text></row>
										}
									}
								}
								if !expanded && files.len() > 3 {
									<row><i:tree-last/><text pad-x=1>{format!("… {} more file", files.len() - 3)}</text></row>
								}
							</col>
						} else if expanded {
							<row gap=1><i:info-status/><text>{"Output"}</text></row>
							for (index, line) in output_lines.iter().enumerate() {
								<row pad-x=1 gap=1>
									if index + 1 == output_lines.len() { <i:tree-last/> } else { <i:tree-branch/> }
									<text>{line.replace('\t', "   ")}</text>
								</row>
							}
						} else {
							<row gap=1><i:info-status/><text fg=muted>{output_first}</text>
								if output_lines.len() > 1 { <text fg=muted>{"⟨Ctrl+O: Expand⟩"}</text> }
							</row>
							for (index, line) in output_preview.iter().enumerate() {
								<row pad-x=1 gap=1>
									if index + 1 == output_preview.len() && output_hidden == 0 { <i:tree-last/> } else { <i:tree-branch/> }
									<text fg=muted>{line.as_str()}</text>
								</row>
							}
							if output_hidden > 0 {
								<row pad-x=1 gap=1><i:tree-last/><text fg=muted>{format!("… {output_hidden} more {}", if output_hidden == 1 { "line" } else { "lines" })}</text></row>
							}
						}
					</box>
				},
				}
			</col>
		}
		.into_component()
	}
}

fn file_path(file: &omp_tools::lsp::navigation::LocationGroup) -> String {
	file.path.to_string()
}

fn locations(
	file: &omp_tools::lsp::navigation::LocationGroup,
) -> &[omp_tools::lsp::navigation::LocationPoint] {
	&file.locations
}

fn reference_label(file: &omp_tools::lsp::navigation::LocationGroup) -> String {
	let count = locations(file).len();
	format!("{count} reference{}", if count == 1 { "" } else { "s" })
}

fn location_label(location: &omp_tools::lsp::navigation::LocationPoint) -> String {
	format!("{}, col {}", location.line, location.col)
}

fn location_href(
	file: &omp_tools::lsp::navigation::LocationGroup,
	location: &omp_tools::lsp::navigation::LocationPoint,
) -> String {
	format!("{}:{}:{}", file_path(file), location.line, location.col)
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
