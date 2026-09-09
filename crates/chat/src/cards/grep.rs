//! Typed card for grouped text search matches.

use std::collections::BTreeMap;

use omp_core::{Str, sf};
use omp_dom::{Node, PropId};
use omp_tui::{IntoComponent as _, UiContext, dom};
use serde_json::Value;

use super::{
	Card, CardStatus, CardView, Component, elapsed_badge, typed_fault, typed_input, typed_result,
};

/// Card for `grep` calls.
pub struct GrepCard;

impl Card for GrepCard {
	fn tool(&self) -> &'static str {
		"grep"
	}

	fn render(&self, view: &CardView<'_>, expanded: bool, ui: &UiContext) -> Component {
		let args = typed_input::<omp_tools::grep::Params>(view).unwrap_or(Value::Null);
		let query = string_at(&args, "pattern")
			.or_else(|| partial_string(view.args_text().unwrap_or_default(), "pattern"))
			.unwrap_or_default();
		let path = string_at(&args, "path");
		match view.status {
			CardStatus::StreamingArgs | CardStatus::InProgress => dom! {
				<row gap=1 pad-x=1>
					<i:pending fg=output/><text>{"Grep:"}</text><text fg=output>{query}</text>
					if let Some(path) = path { <text fg=muted>{format!("in {path}")}</text> }
					if let Some(badge) = elapsed_badge(view) { {badge} }
				</row>
			}
			.into_component(),
			CardStatus::Done => render_done(view, query, path, expanded, ui),
			CardStatus::Failed => render_failed(view),
		}
	}
}

fn render_done(
	view: &CardView<'_>,
	query: &str,
	path: Option<&str>,
	expanded: bool,
	ui: &UiContext,
) -> Component {
	let result = typed_result::<omp_tools::grep::Payload>(view).unwrap_or(Value::Null);
	let groups = normalize_groups(&result);
	let match_count = result
		.get("total")
		.and_then(Value::as_u64)
		.unwrap_or_else(|| {
			groups
				.iter()
				.flat_map(|group| &group.files)
				.flat_map(|file| &file.rows)
				.filter(|row| row.matched)
				.count() as u64
		});
	let file_count = groups
		.iter()
		.map(|group| group.files.len() as u64)
		.sum::<u64>();
	let truncated = ["total_files_lower_bound", "file_limit_reached", "per_file_limit_reached"]
		.into_iter()
		.any(|field| result.get(field).and_then(Value::as_bool).unwrap_or(false));
	let scope = path.unwrap_or(".");
	if match_count == 0 {
		return dom! {
			<col pad-x=1 w="100%">
				<row gap=1>
					<i:warning fg=warn/><text>{"Grep:"}</text><text fg=output>{query}</text>
					<text fg=muted>{format!("0 matches · in {scope}")}</text>
				</row>
				<text fg=muted>{"No matches found"}</text>
			</col>
		}
		.into_component();
	}
	let plan = plan_rows(&groups, expanded);
	let mut shown_matches = 0_u64;
	let mut shown_rows = 0_u64;
	for (group_index, files_shown) in plan.iter().enumerate() {
		let Some(group) = groups.get(group_index) else {
			continue;
		};
		for (file_index, rows_shown) in files_shown.iter().enumerate() {
			let Some(file) = group.files.get(file_index) else {
				continue;
			};
			let visible = display_rows(file, expanded).take(*rows_shown);
			for row in visible {
				shown_rows = shown_rows.saturating_add(1);
				if row.matched {
					shown_matches = shown_matches.saturating_add(1);
				}
			}
		}
	}
	let total_rows = groups
		.iter()
		.flat_map(|group| &group.files)
		.map(|file| display_rows(file, expanded).count() as u64)
		.sum::<u64>();
	let hidden_matches = match_count.saturating_sub(shown_matches);
	let hidden_rows = total_rows.saturating_sub(shown_rows);
	let hidden = if hidden_matches > 0 {
		hidden_matches
	} else {
		hidden_rows
	};
	dom! {
		<col pad-x=1 w="100%">
			<row gap=1>
				if truncated { <i:warning fg=warn/> } else { <i:search fg=default/> }
				<text>{"Grep:"}</text><text fg=output>{query}</text>
				<text fg=muted>{format!("{match_count} matches · {file_count} files · in")}</text>
				<text fg=muted href={super::file_link(scope)}>{scope}</text>
				if truncated { <text fg=warn>{"truncated"}</text> }
			</row>
			<col>
				for (group_index, files_shown) in plan.iter().enumerate() {
					if let Some(group) = groups.get(group_index) {
						<row gap=1>
							if group_index + 1 == plan.len() && hidden == 0 { <i:tree-last fg=muted/> } else { <i:tree-branch fg=muted/> }
							<text fg=accent href={super::file_link(&group.dir)}>{format!("# {}", group.dir)}</text>
						</row>
						for (file_index, matches_shown) in files_shown.iter().enumerate() {
							if let Some(file) = group.files.get(file_index) {
								if group_index + 1 == plan.len() && hidden == 0 {
									<text pad-x=3 fg=muted href={super::file_link(&format!("{}/{}", group.dir, file.name))}>{sf!("## {}", file.name)}</text>
								} else {
									<text fg=muted href={super::file_link(&format!("{}/{}", group.dir, file.name))}>{sf!("{}  ## {}", icon(ui, "tree-vertical"), file.name)}</text>
								}
								for row in display_rows(file, expanded).take(*matches_shown) {
									if group_index + 1 == plan.len() && hidden == 0 {
										<text fg=output href={super::file_link(&format!("{}/{}", group.dir, file.name))} pad_x={3_u16.saturating_add(line_padding(file, row))} w="100%">
											{compact_match_line(row)}
										</text>
									} else {
										<text fg=output href={super::file_link(&format!("{}/{}", group.dir, file.name))} w="100%">{match_line(file, row, icon(ui, "tree-vertical"))}</text>
									}
								}
							}
						}
					}
				}
				if hidden > 0 {
					<row gap=1><i:tree-last fg=muted/><text fg=output>{"…"}</text><text fg=muted>{&hidden}</text><text fg=muted>{
						if hidden_matches > 0 {
							if hidden == 1 { "more match" } else { "more matches" }
						} else if hidden == 1 {
							"more line"
						} else {
							"more lines"
						}
					}</text></row>
				}
			</col>
		</col>
	}
	.into_component()
}

/// Collapsed row budget for the match tree, including directory and file
/// header rows; one row is reserved for the `… N more matches` summary
/// whenever the tree overflows.
const COLLAPSED_ROWS: usize = 6;

/// Expanded previews remain bounded.
const EXPANDED_ROWS: usize = 24;

/// Rows to paint per group and file: `plan[group][file]` is the number of
/// source rows shown for that file, and only the leading groups/files that fit
/// the budget appear. Collapsed mode omits context; expanded mode includes it.
fn plan_rows(groups: &[Group], expanded: bool) -> Vec<Vec<usize>> {
	let row_limit = if expanded {
		EXPANDED_ROWS
	} else {
		COLLAPSED_ROWS
	};
	let total_rows: usize = groups
		.iter()
		.map(|group| {
			1 + group
				.files
				.iter()
				.map(|file| 1 + display_rows(file, expanded).count())
				.sum::<usize>()
		})
		.sum();
	let mut budget = if total_rows > row_limit {
		row_limit - 1
	} else {
		row_limit
	};
	let mut plan = Vec::with_capacity(groups.len());
	for group in groups {
		if budget == 0 {
			break;
		}
		budget -= 1;
		let mut files = Vec::with_capacity(group.files.len());
		for file in &group.files {
			if budget == 0 {
				break;
			}
			budget -= 1;
			let shown = display_rows(file, expanded).count().min(budget);
			budget -= shown;
			files.push(shown);
		}
		plan.push(files);
	}
	plan
}

fn icon<'a>(ui: &'a UiContext, name: &str) -> &'a str {
	ui.charset.icon_named(name).unwrap_or_default()
}

fn display_rows(file: &FileMatches, expanded: bool) -> impl Iterator<Item = &Match> {
	file.rows.iter().filter(move |row| expanded || row.matched)
}

fn line_padding(file: &FileMatches, row: &Match) -> u16 {
	let padding = file
		.rows
		.iter()
		.filter(|row| row.line > 0)
		.map(|row| decimal_width(row.line))
		.max()
		.unwrap_or(1)
		.saturating_sub(decimal_width(row.line.max(1)));
	u16::try_from(padding).unwrap_or(u16::MAX)
}

fn compact_match_line(row: &Match) -> Str {
	if row.line == 0 {
		Str::new_static("...")
	} else {
		let marker = if row.matched { '*' } else { ' ' };
		sf!("{marker}{}│{}", row.line, row.text)
	}
}

fn match_line(file: &FileMatches, row: &Match, rail: &str) -> Str {
	if row.line == 0 {
		return sf!("{rail}  ...");
	}
	let padding = usize::from(line_padding(file, row));
	let marker = if row.matched { '*' } else { ' ' };
	sf!("{rail}  {}{marker}{}│{}", " ".repeat(padding), row.line, row.text)
}

const fn decimal_width(mut value: u64) -> usize {
	let mut width = 1;
	while value >= 10 {
		value /= 10;
		width += 1;
	}
	width
}

fn render_failed(view: &CardView<'_>) -> Component {
	let fault = typed_fault::<omp_tools::grep::Fault>(view)
		.or_else(|| diag_text(view.diag))
		.unwrap_or_else(|| Str::new_static("grep failed"));
	dom! { <row gap=1 pad-x=1 fg=err><i:error/><text>{sf!("Error: {fault}")}</text></row> }
		.into_component()
}

struct Group {
	dir:   Str,
	files: Vec<FileMatches>,
}

struct FileMatches {
	path: Str,
	name: Str,
	rows: Vec<Match>,
}

struct Match {
	line:    u64,
	text:    Str,
	matched: bool,
}

fn normalize_groups(result: &Value) -> Vec<Group> {
	let mut by_dir: BTreeMap<String, Vec<FileMatches>> = BTreeMap::new();
	if let Some(matches) = result.get("matches").and_then(Value::as_array) {
		for row in matches {
			let path = string_at(row, "path").unwrap_or_default();
			let (dir, name) = path.rsplit_once('/').unwrap_or((".", path));
			let files = by_dir.entry(format!("{dir}/")).or_default();
			let file = if let Some(index) = files.iter().position(|file| file.path.as_str() == path) {
				&mut files[index]
			} else {
				files.push(FileMatches {
					path: Str::new(path),
					name: Str::new(name),
					rows: Vec::new(),
				});
				files.last_mut().expect("file was just inserted")
			};
			file.rows.push(Match {
				line:    row.get("line").and_then(Value::as_u64).unwrap_or_default(),
				text:    Str::new(string_at(row, "text").unwrap_or_default()),
				matched: true,
			});
		}
	} else if let Some(files) = result.get("files").and_then(Value::as_array) {
		for value in files {
			let path = string_at(value, "path").unwrap_or_default();
			let (dir, name) = path.rsplit_once('/').unwrap_or((".", path));
			let mut rows = Vec::new();
			for matched in value
				.get("matches")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
			{
				for context in matched
					.get("context_before")
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
				{
					push_source_row(
						&mut rows,
						context
							.get("line_number")
							.and_then(Value::as_u64)
							.unwrap_or_default(),
						string_at(context, "line").unwrap_or_default(),
						false,
					);
				}
				push_source_row(
					&mut rows,
					matched
						.get("line_number")
						.and_then(Value::as_u64)
						.unwrap_or_default(),
					string_at(matched, "line").unwrap_or_default(),
					true,
				);
				for context in matched
					.get("context_after")
					.and_then(Value::as_array)
					.into_iter()
					.flatten()
				{
					push_source_row(
						&mut rows,
						context
							.get("line_number")
							.and_then(Value::as_u64)
							.unwrap_or_default(),
						string_at(context, "line").unwrap_or_default(),
						false,
					);
				}
			}
			by_dir
				.entry(format!("{dir}/"))
				.or_default()
				.push(FileMatches { path: Str::new(path), name: Str::new(name), rows });
		}
	}
	by_dir
		.into_iter()
		.map(|(dir, files)| Group { dir: Str::new(dir), files })
		.collect()
}

fn push_source_row(rows: &mut Vec<Match>, line: u64, text: &str, matched: bool) {
	let previous = rows
		.iter()
		.rev()
		.find(|row| row.line > 0)
		.map(|row| row.line);
	if line == 0 || previous.is_some_and(|previous| line <= previous) {
		return;
	}
	if previous.is_some_and(|previous| line > previous.saturating_add(1)) {
		rows.push(Match { line: 0, text: Str::new_static(""), matched: false });
	}
	rows.push(Match { line, text: Str::new(text), matched });
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
