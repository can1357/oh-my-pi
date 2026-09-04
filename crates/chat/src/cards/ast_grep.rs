//! Typed card for `ast_grep@3`.

use std::collections::{BTreeMap, BTreeSet};

use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{Card, CardStatus, CardView, Component, elapsed_badge, typed_input, typed_result};

/// Structural-search card.
pub struct AstGrepCard;

impl Card for AstGrepCard {
	fn tool(&self) -> &'static str {
		"ast_grep"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, _ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::ast_grep::Params>(view);
		let pattern = args
			.as_ref()
			.and_then(|value| value.get("pat"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let path = args
			.as_ref()
			.and_then(|value| value.get("path"))
			.and_then(Value::as_str)
			.unwrap_or_default()
			.to_owned();
		let result = typed_result::<omp_tools::ast_grep::Payload>(view);
		let matches = result
			.as_ref()
			.and_then(|value| value.get("matches"))
			.and_then(Value::as_array)
			.cloned()
			.unwrap_or_default();
		let match_count = result
			.as_ref()
			.and_then(|value| value.get("total"))
			.and_then(Value::as_u64)
			.unwrap_or(matches.len() as u64);
		let file_count = result
			.as_ref()
			.and_then(|value| value.get("files_with_matches"))
			.and_then(Value::as_u64)
			.map_or_else(
				|| {
					matches
						.iter()
						.filter_map(|entry| entry.get("path").and_then(Value::as_str))
						.collect::<BTreeSet<_>>()
						.len() as u64
				},
				|count| count,
			);
		// `files_searched` is `0` for lifted `ast_grep@1` calls that never
		// recorded it; show the metadata only when a count exists.
		let searched = result
			.as_ref()
			.and_then(|value| value.get("files_searched"))
			.and_then(Value::as_u64)
			.filter(|count| *count > 0);
		let scope = if path.is_empty() {
			".".to_owned()
		} else {
			path.clone()
		};
		let limit_reached = result
			.as_ref()
			.and_then(|value| value.get("limit_reached"))
			.and_then(Value::as_bool)
			.unwrap_or(false);
		let next_skip = result
			.as_ref()
			.and_then(|value| value.get("next_skip"))
			.and_then(Value::as_u64);
		let notices = ast_notices(result.as_ref(), next_skip);
		let fault = diag_text(view);
		let groups = directory_groups(&matches);
		let shown = if expanded {
			groups.len()
		} else {
			fitting_groups(&groups)
		};
		let hidden = groups.len() - shown;
		dom! {
			<col>
				match view.status {
					CardStatus::StreamingArgs | CardStatus::InProgress => {
						<row kind=title gap=0>
							<i:pending fg=output/><text>{" "}</text>
							<text fg=accent>{"AST Grep"}</text><text>{":"}</text>
							<text fg=output wrap=pre>{format!(" {pattern}")}</text>
							if !path.is_empty() {
								<text fg=muted wrap=pre>{format!(" in {path}")}</text>
							}
							if let Some(badge) = elapsed_badge(view) { {badge} }
						</row>
					},
					CardStatus::Done => {
						<row kind=title gap=0>
							if limit_reached { <i:warning fg=warn/> } else { <i:search fg=accent/> }
							<text>{" "}</text>
							<text fg=accent>{"AST Grep"}</text><text>{":"}</text><text fg=output wrap=pre>{format!(" {pattern}")}</text>
							<text fg=muted wrap=pre>{format!(" {match_count} matches · {file_count} files · in {scope}")}</text>
							if let Some(searched) = searched {
								<text fg=muted wrap=pre>{format!(" · searched {searched}")}</text>
							}
						</row>
						for (group_index, (dir, entries)) in groups.iter().take(shown).enumerate() {
							<col>
								<row gap=1>
									if hidden == 0 && group_index + 1 == shown { <i:tree-last/> } else { <i:tree-branch/> }
									<text>{format!("# {dir}")}</text>
								</row>
								for (index, entry) in entries.iter().enumerate() {
									if index == 0 || entries[index - 1].get("path") != entry.get("path") {
										<text pad-x=3>{format!("## {}", file_name(entry))}</text>
									}
									<text pad-x=3>{match_line(entry)}</text>
									if let Some(binding) = binding_text(entry) {
										<text pad-x=5>{format!("meta: {binding}")}</text>
									}
								}
							</col>
						}
						if hidden > 0 {
							<row gap=1 fg=muted><i:tree-last/><text fg=output>{format!("… {hidden} more {}", if hidden == 1 { "group" } else { "groups" })}</text></row>
						}
						for notice in &notices {
							<row gap=1 fg=warn><i:warning/><text wrap=word>{notice}</text></row>
						}
					},
					CardStatus::Failed => {
						<row kind=title gap=1 fg=err><i:error/><text>{format!("Error: {}", fault.unwrap_or_default())}</text></row>
					},
				}
			</col>
		}
		.into_component()
	}
}

/// Collapsed previews spend at most this many rows on match groups.
const COLLAPSED_MATCH_LINES: usize = 6;

/// Matches grouped by directory in path order: `# dir/`, then `## file`
/// and its matches.
fn directory_groups(matches: &[Value]) -> Vec<(String, Vec<&Value>)> {
	let mut groups: BTreeMap<String, Vec<&Value>> = BTreeMap::new();
	for entry in matches {
		let path = entry
			.get("path")
			.and_then(Value::as_str)
			.unwrap_or_default();
		let dir = path.rsplit_once('/').map_or(".", |(dir, _)| dir);
		groups.entry(format!("{dir}/")).or_default().push(entry);
	}
	groups.into_iter().collect()
}

/// Rows one directory group paints: its header, each file header, each
/// match line, and each binding row.
fn group_rows(entries: &[&Value]) -> usize {
	let mut rows = 1;
	for (index, entry) in entries.iter().enumerate() {
		let new_file = index == 0 || entries[index - 1].get("path") != entry.get("path");
		rows += usize::from(new_file) + 1 + usize::from(binding_text(entry).is_some());
	}
	rows
}

/// Leading groups that fit the collapsed row budget whole: a group is shown
/// only when
/// its rows plus the summary row reserved for any group after it fit.
fn fitting_groups(groups: &[(String, Vec<&Value>)]) -> usize {
	let mut fitted = 0;
	let mut shown = 0;
	for (index, (_, entries)) in groups.iter().enumerate() {
		let reserved = usize::from(index + 1 < groups.len());
		let rows = group_rows(entries);
		if fitted + rows + reserved > COLLAPSED_MATCH_LINES {
			break;
		}
		fitted += rows;
		shown = index + 1;
	}
	shown
}

fn file_name(entry: &Value) -> String {
	entry
		.get("path")
		.and_then(Value::as_str)
		.and_then(|path| path.rsplit('/').next())
		.unwrap_or_default()
		.to_owned()
}

fn match_line(entry: &Value) -> String {
	let line = entry
		.get("line")
		.and_then(Value::as_u64)
		.unwrap_or_default();
	let text = entry
		.get("text")
		.and_then(Value::as_str)
		.unwrap_or_default();
	format!("*{line}│{text}")
}

fn binding_text(entry: &Value) -> Option<String> {
	if let Some(text) = entry.get("bindings").and_then(Value::as_str) {
		return (!text.is_empty()).then(|| text.to_owned());
	}
	let (key, value) = entry.get("bindings")?.as_object()?.iter().next()?;
	let value = value
		.as_str()
		.map(str::to_owned)
		.unwrap_or_else(|| value.to_string());
	Some(format!("${key}={value}"))
}

fn ast_notices(result: Option<&Value>, next_skip: Option<u64>) -> Vec<String> {
	let Some(result) = result else {
		return Vec::new();
	};
	let mut notices = Vec::new();
	if let Some(skip) = next_skip {
		notices.push(format!("Result limit reached; continue with skip {skip}"));
	}
	if let Some(advisories) = result.get("advisories").and_then(Value::as_array) {
		notices.extend(advisories.iter().filter_map(|advisory| {
			let path = advisory.get("path")?.as_str()?;
			let message = advisory.get("message")?.as_str()?;
			Some(format!("{path}: {message}"))
		}));
	}
	if let Some(errors) = result.get("parse_errors").and_then(Value::as_array) {
		notices.extend(
			errors
				.iter()
				.filter_map(Value::as_str)
				.map(|error| format!("Parse issue: {error}")),
		);
	}
	notices
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
