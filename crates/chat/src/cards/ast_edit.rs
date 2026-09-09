//! Typed card for `ast_edit@2`.

use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_input, typed_result};

/// Structural-rewrite proposal card.
pub struct AstEditCard;

impl Card for AstEditCard {
	fn tool(&self) -> &'static str {
		"ast_edit"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::ast_edit::Params>(view);
		let pattern = args
			.as_ref()
			.and_then(|value| value.pointer("/ops/0/pat"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let target = args
			.as_ref()
			.and_then(|value| value.get("paths"))
			.and_then(Value::as_array)
			.and_then(|paths| paths.first())
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let result = typed_result::<omp_tools::ast_edit::Payload>(view);
		let files = result
			.as_ref()
			.and_then(|value| value.get("files"))
			.and_then(Value::as_array)
			.cloned()
			.unwrap_or_default();
		let replacements = result
			.as_ref()
			.and_then(|value| value.get("total_replacements"))
			.and_then(Value::as_u64)
			.unwrap_or_else(|| {
				files
					.iter()
					.filter_map(|file| file.get("replacements")?.as_u64())
					.sum()
			});
		let file_count = result
			.as_ref()
			.and_then(|value| value.get("files_touched"))
			.and_then(Value::as_u64)
			.unwrap_or(files.len() as u64);
		let state = result.as_ref().map(|value| {
			if value
				.get("recovery_root")
				.is_some_and(|root| !root.is_null())
				|| value.get("applied").and_then(Value::as_bool) == Some(true)
			{
				"applied"
			} else if value
				.get("pending_proposal")
				.is_some_and(|proposal| !proposal.is_null())
			{
				"proposed"
			} else {
				"no changes"
			}
		});
		let scope = result
			.as_ref()
			.and_then(|value| value.get("scope_path"))
			.and_then(Value::as_str)
			.unwrap_or_else(|| target.trim_end_matches("/**/*.ts"))
			.to_owned();
		let notices = ast_edit_notices(result.as_ref());
		let fault = diag_text(view).unwrap_or_default();
		let proposal = state.unwrap_or("proposed");
		let summary = format!("{replacements} replacements · {file_count} files · in {scope}");
		dom! {
			<col>
				match view.status {
				CardStatus::StreamingArgs | CardStatus::InProgress => {
					<row kind=title gap=0><i:pending fg=output/><text>{" "}</text><text fg=accent>{"AST Edit"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {pattern}")}</text><text fg=muted wrap=pre>{format!(" in {target}")}</text>
						if let Some(badge) = elapsed_badge(view) { {badge} }
					</row>
				},
				CardStatus::Done => {
					<box border=round bc=border bg=panel bleed pad-x=1 title_pad=3>
						<row kind=title gap=0>
							if notices.is_empty() { <i:success fg=ok/> } else { <i:warning fg=warn/> }
							<text>{" "}</text><text fg=accent>{"AST Edit"}</text><text>{":"}</text>
							<text fg=output wrap=pre>{format!(" {pattern}")}</text><text>{" "}</text><text fg=warn>{format!("⟨{proposal}⟩")}</text>
							<text fg=muted grow truncate>{format!(" {summary}")}</text><text>{" "}</text>
						</row>
						<col>
							for (index, file) in files.iter().enumerate() {
								if expanded || index == 0 {
									if expanded && index > 0 {
										<text>{""}</text>
									}
									<row gap=1 fg=accent href={super::file_link(file_path(file))}><text>{"#"}</text><text>{format!("{}/", parent_dir(file))}</text></row>
									<row gap=1 fg=muted href={super::file_link(file_path(file))}><text>{"##"}</text><text>{file_name(file)}</text><text>{replacement_label(file)}</text></row>
									for line in diff_lines(file) {
										<pre fg={if line.starts_with('-') { "err" } else if line.starts_with('+') { "info" } else { "output" }}>{line}</pre>
									}
								}
							}
							if !expanded && file_count > 1 {
								<row gap=1 fg=muted><text>{"…"}</text><text>{(file_count - 1).to_string()}</text><text>{"more"}</text><text>{"change"}</text></row>
							}
							for notice in &notices {
								<row gap=1 fg=warn><i:warning/><text wrap=word>{notice}</text></row>
							}
						</col>
					</box>
				},
				CardStatus::Failed => {
					<box border=round bc=err bg=error_surface bleed pad-x=1 title_pad=3>
						<row kind=title gap=1><i:error fg=err/><text fg=accent>{"AST Edit"}</text></row>
						<text pad-x=2 fg=err wrap=word>{fault}</text>
					</box>
				},
				}
			</col>
		}
		.into_component()
	}
}

fn ast_edit_notices(result: Option<&Value>) -> Vec<String> {
	let Some(result) = result else {
		return Vec::new();
	};
	let mut notices = Vec::new();
	for advisory in result
		.get("advisories")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
	{
		let path = advisory
			.get("path")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let message = advisory
			.get("message")
			.and_then(Value::as_str)
			.unwrap_or_default();
		notices.push(format!("{path}: {message}"));
	}
	for diagnostic in result
		.get("parse_errors")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
	{
		notices.push(diagnostic.to_owned());
	}
	let visible_advisories = result
		.get("advisories")
		.and_then(Value::as_array)
		.map_or(0, Vec::len) as u64;
	let visible_parse_errors = result
		.get("parse_errors")
		.and_then(Value::as_array)
		.map_or(0, Vec::len) as u64;
	let advisory_count = result
		.get("advisories_total")
		.and_then(Value::as_u64)
		.unwrap_or(visible_advisories);
	let parse_count = result
		.get("parse_errors_total")
		.and_then(Value::as_u64)
		.unwrap_or(visible_parse_errors);
	let visible_count = visible_advisories + visible_parse_errors;
	let total_count = advisory_count.saturating_add(parse_count);
	if total_count > visible_count {
		notices.push(format!("{} additional diagnostics omitted", total_count - visible_count));
	}
	if let Some(id) = result.get("pending_proposal").and_then(Value::as_str) {
		notices.push(format!("Pending proposal {id}; resolve or reject this exact id"));
	}
	notices
}

fn file_path(file: &Value) -> &str {
	file.get("path").and_then(Value::as_str).unwrap_or_default()
}

fn parent_dir(file: &Value) -> &str {
	file_path(file)
		.rsplit_once('/')
		.map_or("", |(parent, _)| parent)
}

fn file_name(file: &Value) -> &str {
	file_path(file).rsplit('/').next().unwrap_or_default()
}

fn replacement_label(file: &Value) -> String {
	let count = file
		.get("replacements")
		.and_then(Value::as_u64)
		.unwrap_or_default();
	format!("({count} replacement{})", if count == 1 { "" } else { "s" })
}

fn diff_lines(file: &Value) -> Vec<String> {
	let Some(diff) = file.get("diff") else {
		return Vec::new();
	};
	if let Some(text) = diff.as_str() {
		return text.lines().map(str::to_owned).collect();
	}
	diff
		.as_array()
		.into_iter()
		.flatten()
		.map(|line| {
			let kind = line.get("kind").and_then(Value::as_str).unwrap_or_default();
			let marker = if kind == "add" {
				'+'
			} else if kind == "del" {
				'-'
			} else {
				' '
			};
			let number = line.get("line").and_then(Value::as_u64).unwrap_or_default();
			let raw = line.get("text").and_then(Value::as_str).unwrap_or_default();
			let tabs = raw.bytes().take_while(|byte| *byte == b'\t').count();
			let leading = if tabs == 1 { 1 } else { tabs.saturating_mul(2) };
			format!("{marker}{number}   {}{}", " ".repeat(leading), raw.trim_start_matches('\t'))
		})
		.collect()
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

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::ast_edit_notices;

	#[test]
	fn notices_preserve_parse_diagnostics_and_exact_proposal_identity() {
		let result = json!({
			"advisories": [{"path": "src/unknown", "message": "language unavailable"}],
			"advisories_total": 2,
			"parse_errors": ["src/broken.ts: parse error"],
			"parse_errors_total": 3,
			"pending_proposal": "pending-action:ast_edit:7"
		});
		let notices = ast_edit_notices(Some(&result));
		assert!(notices.iter().any(|notice| notice.contains("src/unknown")));
		assert!(
			notices
				.iter()
				.any(|notice| notice.contains("src/broken.ts"))
		);
		assert!(
			notices
				.iter()
				.any(|notice| notice == "3 additional diagnostics omitted")
		);
		assert!(
			notices
				.iter()
				.any(|notice| notice.contains("pending-action:ast_edit:7"))
		);
	}
}
