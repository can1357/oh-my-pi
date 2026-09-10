//! Excel Open XML to deterministic Markdown conversion.

use std::{
	collections::{BTreeMap, HashMap, btree_map::Entry},
	fmt::Display,
};

use omp_core::{IntoStr, Str};
use quick_xml::events::Event;

use super::{
	MarkitError,
	ooxml::{
		Archive, attribute, decode_reference, decode_text, decode_xml_bytes, local_name,
		render_markdown_table, xml_reader,
	},
};

const FORMAT: &str = "xlsx";
const MAX_ROWS: usize = 1_048_576;
const MAX_COLUMNS: usize = 16_384;
const MAX_RENDERED_CELLS: usize = 1_000_000;
const MAX_MERGE_OPERATIONS: usize = 1_000_000;

#[derive(Debug)]
struct Sheet {
	name:            String,
	relationship_id: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum DateSystem {
	#[default]
	Excel1900,
	Excel1904,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum NumberKind {
	#[default]
	General,
	Date,
	Time,
	DateTime,
	Duration,
}

#[derive(Debug, Default)]
struct Styles {
	cell_kinds: Vec<NumberKind>,
}

#[derive(Debug, Default)]
struct Cell {
	kind:   Option<String>,
	style:  Option<usize>,
	row:    usize,
	column: usize,
	value:  String,
	inline: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CellText {
	None,
	Value,
	Inline,
}

#[derive(Clone, Copy, Debug)]
struct CellRange {
	start_row: usize,
	start_col: usize,
	end_row:   usize,
	end_col:   usize,
}

/// Converts an XLSX workbook into one Markdown table per non-empty worksheet.
pub(super) fn convert(bytes: &[u8]) -> Result<Str, MarkitError> {
	convert_inner(bytes).map(Str::new).map_err(failure)
}

fn convert_inner(bytes: &[u8]) -> Result<String, String> {
	let mut archive = Archive::open(bytes)?;
	let workbook = read_member(&mut archive, "xl/workbook.xml")?
		.ok_or_else(|| "Invalid XLSX: missing workbook.xml".to_owned())?;
	let (sheets, date_system) = parse_workbook(workbook.as_bytes())?;
	let relationships = read_member(&mut archive, "xl/_rels/workbook.xml.rels")?
		.map(|xml| parse_relationships(xml.as_bytes()))
		.transpose()?
		.unwrap_or_default();
	let shared = read_member(&mut archive, "xl/sharedStrings.xml")?
		.map(|xml| parse_shared_strings(xml.as_bytes()))
		.transpose()?
		.unwrap_or_default();
	let styles = read_member(&mut archive, "xl/styles.xml")?
		.map(|xml| parse_styles(xml.as_bytes()))
		.transpose()?
		.unwrap_or_default();

	let mut sections = Vec::new();
	let mut readable_sheets = 0usize;
	for sheet in &sheets {
		let Some(target) = relationships.get(&sheet.relationship_id) else {
			continue;
		};
		let Some(path) = resolve_workbook_target(target) else {
			continue;
		};
		let Some(xml) = read_member(&mut archive, &path)? else {
			continue;
		};
		let rows = parse_worksheet(xml.as_bytes(), &shared, &styles, date_system)?;
		readable_sheets += 1;
		if rows.is_empty() {
			continue;
		}
		let table = render_markdown_table(rows);
		sections.push(format!("## {}\n\n{table}", escape_heading(&clean_text(&sheet.name))));
	}
	if !sheets.is_empty() && readable_sheets == 0 {
		return Err("Invalid XLSX: no worksheet could be read".to_owned());
	}

	Ok(sections.join("\n\n"))
}
fn read_member(archive: &mut Archive<'_>, path: &str) -> Result<Option<String>, String> {
	let Some(bytes) = archive.read_xml(path)? else {
		return Ok(None);
	};
	decode_xml_bytes(&bytes)
		.map(Some)
		.map_err(|error| format!("{path} is not valid UTF text: {error}"))
}

fn parse_workbook(xml: &[u8]) -> Result<(Vec<Sheet>, DateSystem), String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut sheets = Vec::new();
	let mut date_system = DateSystem::Excel1900;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(start) | Event::Empty(start)
				if local_name(start.name().as_ref()) == "workbookPr" =>
			{
				if attribute(&reader, &start, b"date1904")?
					.is_some_and(|value| matches!(value.trim(), "1" | "true" | "TRUE"))
				{
					date_system = DateSystem::Excel1904;
				}
			},
			Event::Start(start) | Event::Empty(start)
				if local_name(start.name().as_ref()) == "sheet" =>
			{
				if let Some(state) = attribute(&reader, &start, b"state")?
					&& !matches!(state.as_str(), "visible" | "hidden" | "veryHidden")
				{
					return Err(format!("Invalid XLSX: unrecognized sheet visibility '{state}'"));
				}
				let name = attribute(&reader, &start, b"name")?.unwrap_or_default();
				let relationship_id = attribute(&reader, &start, b"id")?.unwrap_or_default();
				if !relationship_id.is_empty() {
					sheets.push(Sheet { name, relationship_id });
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok((sheets, date_system))
}

fn parse_relationships(xml: &[u8]) -> Result<HashMap<String, String>, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut relationships = HashMap::new();
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(start) | Event::Empty(start)
				if local_name(start.name().as_ref()) == "Relationship" =>
			{
				let external = attribute(&reader, &start, b"TargetMode")?
					.is_some_and(|mode| mode.eq_ignore_ascii_case("external"));
				if !external
					&& let (Some(id), Some(target)) =
						(attribute(&reader, &start, b"Id")?, attribute(&reader, &start, b"Target")?)
				{
					relationships.insert(id, target);
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(relationships)
}

fn resolve_workbook_target(target: &str) -> Option<String> {
	let normalized = target.trim_start_matches('/').replace('\\', "/");
	let mut parts: Vec<&str> = if target.starts_with('/') {
		Vec::new()
	} else {
		vec!["xl"]
	};
	for part in normalized.split('/') {
		match part {
			"" | "." => {},
			".." => {
				parts.pop()?;
			},
			part => parts.push(part),
		}
	}
	(!parts.is_empty()).then(|| parts.join("/"))
}

fn parse_shared_strings(xml: &[u8]) -> Result<Vec<String>, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut strings = Vec::new();
	let mut item: Option<String> = None;
	let mut in_text = false;
	let mut phonetic_depth = 0usize;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(start) if local_name(start.name().as_ref()) == "si" => {
				item = Some(String::new());
			},
			Event::End(end) if local_name(end.name().as_ref()) == "si" => {
				strings.push(item.take().unwrap_or_default());
			},
			Event::Start(start) if local_name(start.name().as_ref()) == "rPh" && item.is_some() => {
				phonetic_depth += 1;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "rPh" => {
				phonetic_depth = phonetic_depth.saturating_sub(1);
			},
			Event::Start(start)
				if local_name(start.name().as_ref()) == "t"
					&& item.is_some()
					&& phonetic_depth == 0 =>
			{
				in_text = true;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "t" => in_text = false,
			Event::Text(text) if in_text => {
				if let Some(item) = item.as_mut() {
					item.push_str(&decode_text(&text)?);
				}
			},
			Event::GeneralRef(reference) if in_text => {
				if let Some(item) = item.as_mut() {
					item.push_str(&decode_reference(&reference)?);
				}
			},
			Event::CData(text) if in_text => {
				if let Some(item) = item.as_mut() {
					item.push_str(text.as_ref());
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(strings)
}

fn parse_styles(xml: &[u8]) -> Result<Styles, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut custom = HashMap::new();
	let mut cell_kinds = Vec::new();
	let mut in_cell_xfs = false;
	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(start) if local_name(start.name().as_ref()) == "cellXfs" => {
				in_cell_xfs = true;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "cellXfs" => {
				in_cell_xfs = false;
			},
			Event::Start(start) | Event::Empty(start)
				if local_name(start.name().as_ref()) == "numFmt" =>
			{
				if let (Some(id), Some(code)) = (
					attribute(&reader, &start, b"numFmtId")?.and_then(|id| id.parse::<u32>().ok()),
					attribute(&reader, &start, b"formatCode")?,
				) {
					custom.insert(id, classify_number_format(&code));
				}
			},
			Event::Start(start) | Event::Empty(start)
				if in_cell_xfs && local_name(start.name().as_ref()) == "xf" =>
			{
				let id = attribute(&reader, &start, b"numFmtId")?
					.and_then(|id| id.parse::<u32>().ok())
					.unwrap_or(0);
				cell_kinds.push(
					custom
						.get(&id)
						.copied()
						.unwrap_or_else(|| builtin_number_kind(id)),
				);
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	Ok(Styles { cell_kinds })
}

const fn builtin_number_kind(id: u32) -> NumberKind {
	match id {
		14..=17 | 27..=36 | 50..=58 => NumberKind::Date,
		18..=21 | 45 | 47 => NumberKind::Time,
		22 => NumberKind::DateTime,
		46 => NumberKind::Duration,
		_ => NumberKind::General,
	}
}

fn classify_number_format(code: &str) -> NumberKind {
	let mut significant = String::new();
	let mut chars = code.chars();
	let mut elapsed = false;
	while let Some(character) = chars.next() {
		match character {
			';' => break,
			'"' => {
				for quoted in chars.by_ref() {
					if quoted == '"' {
						break;
					}
				}
			},
			'\\' | '_' | '*' => {
				chars.next();
			},
			'[' => {
				let bracket: String = chars
					.by_ref()
					.take_while(|character| *character != ']')
					.collect();
				let bracket = bracket.to_ascii_lowercase();
				elapsed |= matches!(bracket.as_str(), "h" | "hh" | "m" | "mm" | "s" | "ss");
			},
			character => significant.extend(character.to_lowercase()),
		}
	}
	if elapsed {
		return NumberKind::Duration;
	}
	let has_date = significant.contains('y') || significant.contains('d');
	let has_time = significant.contains('h')
		|| significant.contains('s')
		|| significant.contains(':')
		|| (!has_date && significant.contains('m'));
	match (has_date, has_time) {
		(true, true) => NumberKind::DateTime,
		(true, false) => NumberKind::Date,
		(false, true) => NumberKind::Time,
		(false, false) => NumberKind::General,
	}
}

fn parse_worksheet(
	xml: &[u8],
	shared: &[String],
	styles: &Styles,
	date_system: DateSystem,
) -> Result<Vec<Vec<String>>, String> {
	let mut reader = xml_reader(xml);
	let mut buffer = Vec::new();
	let mut cells: BTreeMap<(usize, usize), String> = BTreeMap::new();
	let mut merges = Vec::new();
	let mut cell: Option<Cell> = None;
	let mut cell_text = CellText::None;
	let mut phonetic_depth = 0usize;
	let mut current_row = 0usize;
	let mut next_row = 0usize;
	let mut next_column = 0usize;
	let mut saw_sheet_data = false;
	let mut sheet_data_complete = false;

	loop {
		match reader.read_event_into(&mut buffer).map_err(xml_error)? {
			Event::Start(start) if local_name(start.name().as_ref()) == "sheetData" => {
				saw_sheet_data = true;
			},
			Event::Empty(start) if local_name(start.name().as_ref()) == "sheetData" => {
				saw_sheet_data = true;
				sheet_data_complete = true;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "sheetData" => {
				sheet_data_complete = true;
			},
			Event::Start(start) if local_name(start.name().as_ref()) == "row" => {
				current_row =
					parse_one_based_attribute(&reader, &start, b"r", "row")?.unwrap_or(next_row);
				check_row(current_row)?;
				next_row = current_row.saturating_add(1);
				next_column = 0;
			},
			Event::Empty(start) if local_name(start.name().as_ref()) == "row" => {
				let row = parse_one_based_attribute(&reader, &start, b"r", "row")?.unwrap_or(next_row);
				check_row(row)?;
				next_row = row.saturating_add(1);
			},
			Event::Start(start) if local_name(start.name().as_ref()) == "c" => {
				let (row, column) = cell_position(&reader, &start, current_row, next_column)?;
				next_column = column.saturating_add(1);
				cell = Some(Cell {
					kind: attribute(&reader, &start, b"t")?,
					style: parse_style_attribute(&reader, &start)?,
					row,
					column,
					..Cell::default()
				});
			},
			Event::Empty(start) if local_name(start.name().as_ref()) == "c" => {
				let (row, column) = cell_position(&reader, &start, current_row, next_column)?;
				next_column = column.saturating_add(1);
				let cell = Cell {
					kind: attribute(&reader, &start, b"t")?,
					style: parse_style_attribute(&reader, &start)?,
					row,
					column,
					..Cell::default()
				};
				insert_cell(
					&mut cells,
					(row, column),
					cell_value(&cell, shared, styles, date_system)?,
				)?;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "c" => {
				if let Some(cell) = cell.take() {
					let value = cell_value(&cell, shared, styles, date_system)?;
					insert_cell(&mut cells, (cell.row, cell.column), value)?;
				}
				cell_text = CellText::None;
				phonetic_depth = 0;
			},
			Event::Start(start) if local_name(start.name().as_ref()) == "v" && cell.is_some() => {
				cell_text = CellText::Value;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "v" => cell_text = CellText::None,
			Event::Start(start) if local_name(start.name().as_ref()) == "rPh" && cell.is_some() => {
				phonetic_depth += 1;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "rPh" => {
				phonetic_depth = phonetic_depth.saturating_sub(1);
			},
			Event::Start(start)
				if local_name(start.name().as_ref()) == "t"
					&& cell
						.as_ref()
						.and_then(|cell| cell.kind.as_deref())
						.is_some_and(|kind| matches!(kind, "inlineStr" | "is"))
					&& phonetic_depth == 0 =>
			{
				cell_text = CellText::Inline;
			},
			Event::End(end) if local_name(end.name().as_ref()) == "t" => cell_text = CellText::None,
			Event::Text(text) if cell_text != CellText::None => {
				push_cell_text(cell.as_mut(), cell_text, &decode_text(&text)?);
			},
			Event::GeneralRef(reference) if cell_text != CellText::None => {
				push_cell_text(cell.as_mut(), cell_text, &decode_reference(&reference)?);
			},
			Event::CData(text) if cell_text != CellText::None => {
				push_cell_text(cell.as_mut(), cell_text, text.as_ref());
			},
			Event::Start(start) | Event::Empty(start)
				if local_name(start.name().as_ref()) == "mergeCell" =>
			{
				if let Some(reference) = attribute(&reader, &start, b"ref")? {
					merges.push(parse_cell_range(&reference)?);
				}
			},
			Event::Eof => break,
			_ => {},
		}
		buffer.clear();
	}
	if cell.is_some() {
		return Err("invalid XML: unexpected end of worksheet inside a cell".to_owned());
	}
	if !saw_sheet_data || !sheet_data_complete {
		return Err("invalid XML: missing or incomplete sheetData".to_owned());
	}
	materialize_cells(cells, &merges)
}

fn insert_cell(
	cells: &mut BTreeMap<(usize, usize), String>,
	position: (usize, usize),
	value: String,
) -> Result<(), String> {
	insert_cell_with_limit(cells, position, value, MAX_RENDERED_CELLS)
}

fn insert_cell_with_limit(
	cells: &mut BTreeMap<(usize, usize), String>,
	position: (usize, usize),
	value: String,
	limit: usize,
) -> Result<(), String> {
	let at_capacity = cells.len() >= limit;
	match cells.entry(position) {
		Entry::Occupied(mut entry) => {
			entry.insert(value);
		},
		Entry::Vacant(_) if at_capacity => {
			return Err(format!("Invalid XLSX: worksheet exceeds the explicit-cell limit of {limit}"));
		},
		Entry::Vacant(entry) => {
			entry.insert(value);
		},
	}
	Ok(())
}

fn push_cell_text(cell: Option<&mut Cell>, target: CellText, text: &str) {
	if let Some(cell) = cell {
		match target {
			CellText::Value => cell.value.push_str(text),
			CellText::Inline => cell.inline.push_str(text),
			CellText::None => {},
		}
	}
}

fn parse_style_attribute(
	reader: &quick_xml::Reader<&[u8]>,
	start: &quick_xml::events::BytesStart<'_>,
) -> Result<Option<usize>, String> {
	attribute(reader, start, b"s")?
		.map(|value| {
			value
				.parse::<usize>()
				.map_err(|_| format!("Invalid XLSX: invalid cell style index '{value}'"))
		})
		.transpose()
}

fn parse_one_based_attribute(
	reader: &quick_xml::Reader<&[u8]>,
	start: &quick_xml::events::BytesStart<'_>,
	name: &[u8],
	label: &str,
) -> Result<Option<usize>, String> {
	attribute(reader, start, name)?
		.map(|value| {
			value
				.parse::<usize>()
				.ok()
				.filter(|value| *value > 0)
				.map(|value| value - 1)
				.ok_or_else(|| format!("Invalid XLSX: invalid {label} index '{value}'"))
		})
		.transpose()
}

fn cell_position(
	reader: &quick_xml::Reader<&[u8]>,
	start: &quick_xml::events::BytesStart<'_>,
	row: usize,
	column: usize,
) -> Result<(usize, usize), String> {
	let position = attribute(reader, start, b"r")?
		.map(|reference| parse_cell_reference(&reference))
		.transpose()?
		.unwrap_or((row, column));
	check_row(position.0)?;
	if position.1 >= MAX_COLUMNS {
		return Err(format!("Invalid XLSX: cell column exceeds Excel's {MAX_COLUMNS}-column limit"));
	}
	Ok(position)
}

fn check_row(row: usize) -> Result<(), String> {
	if row >= MAX_ROWS {
		return Err(format!("Invalid XLSX: cell row exceeds Excel's {MAX_ROWS}-row limit"));
	}
	Ok(())
}

fn parse_cell_reference(reference: &str) -> Result<(usize, usize), String> {
	let reference = reference.trim();
	let invalid = || format!("Invalid XLSX: invalid cell reference '{reference}'");
	let bytes = reference.as_bytes();
	let mut index = usize::from(bytes.first() == Some(&b'$'));
	let mut column = 0usize;
	let column_start = index;
	while let Some(byte) = bytes.get(index).filter(|byte| byte.is_ascii_alphabetic()) {
		column = column
			.checked_mul(26)
			.and_then(|column| column.checked_add((byte.to_ascii_uppercase() - b'A' + 1) as usize))
			.ok_or_else(&invalid)?;
		index += 1;
	}
	if index == column_start {
		return Err(invalid());
	}
	if bytes.get(index) == Some(&b'$') {
		index += 1;
	}
	let row_start = index;
	let mut row = 0usize;
	while let Some(byte) = bytes.get(index).filter(|byte| byte.is_ascii_digit()) {
		row = row
			.checked_mul(10)
			.and_then(|row| row.checked_add((*byte - b'0') as usize))
			.ok_or_else(&invalid)?;
		index += 1;
	}
	if index == row_start || index != bytes.len() || row == 0 {
		return Err(invalid());
	}
	let position = (row - 1, column - 1);
	check_row(position.0)?;
	if position.1 >= MAX_COLUMNS {
		return Err(invalid());
	}
	Ok(position)
}

fn parse_cell_range(reference: &str) -> Result<CellRange, String> {
	let mut parts = reference.split(':');
	let start = parse_cell_reference(parts.next().unwrap_or_default())?;
	let end = parse_cell_reference(parts.next().unwrap_or(reference))?;
	if parts.next().is_some() || end.0 < start.0 || end.1 < start.1 {
		return Err(format!("Invalid XLSX: invalid merged-cell range '{reference}'"));
	}
	Ok(CellRange { start_row: start.0, start_col: start.1, end_row: end.0, end_col: end.1 })
}

fn materialize_cells(
	cells: BTreeMap<(usize, usize), String>,
	merges: &[CellRange],
) -> Result<Vec<Vec<String>>, String> {
	let Some((&(first_row, first_col), _)) = cells.first_key_value() else {
		return Ok(Vec::new());
	};
	let (mut min_row, mut min_col) = (first_row, first_col);
	let (mut max_row, mut max_col) = (first_row, first_col);
	for &(row, column) in cells.keys() {
		min_row = min_row.min(row);
		min_col = min_col.min(column);
		max_row = max_row.max(row);
		max_col = max_col.max(column);
	}
	let height = max_row - min_row + 1;
	let width = max_col - min_col + 1;
	let rendered_cells = height
		.checked_mul(width)
		.ok_or_else(|| "Invalid XLSX: worksheet dimensions overflow".to_owned())?;
	if rendered_cells > MAX_RENDERED_CELLS {
		return Err(format!(
			"Invalid XLSX: sparse worksheet would require {rendered_cells} rendered cells (limit \
			 {MAX_RENDERED_CELLS})"
		));
	}
	let mut rows = vec![vec![String::new(); width]; height];
	for ((row, column), value) in cells {
		rows[row - min_row][column - min_col] = escape_table_cell(&value);
	}
	let mut merge_operations = 0usize;
	for merge in merges {
		let row_start = merge.start_row.max(min_row);
		let row_end = merge.end_row.min(max_row);
		let col_start = merge.start_col.max(min_col);
		let col_end = merge.end_col.min(max_col);
		if row_start > row_end || col_start > col_end {
			continue;
		}
		let operations = (row_end - row_start + 1)
			.checked_mul(col_end - col_start + 1)
			.ok_or_else(|| "Invalid XLSX: merged-cell dimensions overflow".to_owned())?;
		merge_operations = merge_operations.saturating_add(operations);
		if merge_operations > MAX_MERGE_OPERATIONS {
			return Err(format!(
				"Invalid XLSX: merged cells require too much work (limit {MAX_MERGE_OPERATIONS})"
			));
		}
		for row in row_start..=row_end {
			for column in col_start..=col_end {
				if (row, column) != (row_start, col_start) {
					rows[row - min_row][column - min_col].clear();
				}
			}
		}
	}
	Ok(rows)
}

fn cell_value(
	cell: &Cell,
	shared: &[String],
	styles: &Styles,
	date_system: DateSystem,
) -> Result<String, String> {
	let value = match cell.kind.as_deref() {
		Some("s") => {
			if cell.value.trim().is_empty() {
				String::new()
			} else {
				let index = cell
					.value
					.trim()
					.parse::<usize>()
					.map_err(|_| "Invalid XLSX: invalid shared-string index".to_owned())?;
				shared.get(index).cloned().ok_or_else(|| {
					format!("Invalid XLSX: shared-string index {index} is out of bounds")
				})?
			}
		},
		Some("inlineStr" | "is") => cell.inline.clone(),
		Some("b") => match cell.value.trim() {
			"1" | "true" | "TRUE" => "TRUE".to_owned(),
			"0" | "false" | "FALSE" => "FALSE".to_owned(),
			_ => cell.value.clone(),
		},
		Some("d" | "e" | "str") => cell.value.clone(),
		Some("n") | None => {
			let kind =
				match cell.style {
					Some(style) => styles.cell_kinds.get(style).copied().ok_or_else(|| {
						format!("Invalid XLSX: cell style index {style} is out of bounds")
					})?,
					None => NumberKind::General,
				};
			format_number(&cell.value, kind, date_system)
		},
		Some(kind) => return Err(format!("Invalid XLSX: unsupported cell type '{kind}'")),
	};
	Ok(clean_text(&value))
}

fn format_number(value: &str, kind: NumberKind, date_system: DateSystem) -> String {
	let Ok(serial) = value.trim().parse::<f64>() else {
		return value.to_owned();
	};
	if !serial.is_finite() {
		return value.to_owned();
	}
	match kind {
		NumberKind::General => format_float(serial),
		NumberKind::Duration => format_duration(serial),
		NumberKind::Time => format_time(serial),
		NumberKind::Date | NumberKind::DateTime => {
			format_excel_date(serial, date_system, kind == NumberKind::DateTime)
				.unwrap_or_else(|| value.to_owned())
		},
	}
}

fn format_float(value: f64) -> String {
	match format!("{value:.14e}").parse::<f64>() {
		Ok(rounded) => rounded.to_string(),
		Err(_) => value.to_string(),
	}
}

fn format_time(serial: f64) -> String {
	let seconds = (serial.abs().fract() * 86_400.0).round() as u64 % 86_400;
	format!("{:02}:{:02}:{:02}", seconds / 3600, seconds % 3600 / 60, seconds % 60)
}

fn format_duration(serial: f64) -> String {
	let sign = if serial < 0.0 { "-" } else { "" };
	let seconds = (serial.abs() * 86_400.0).round() as u64;
	format!("{sign}{}:{:02}:{:02}", seconds / 3600, seconds % 3600 / 60, seconds % 60)
}

fn format_excel_date(serial: f64, system: DateSystem, include_time: bool) -> Option<String> {
	if !(0.0..3_000_000.0).contains(&serial) {
		return None;
	}
	let mut day = serial.floor() as i64;
	let mut seconds = ((serial - day as f64) * 86_400.0).round() as i64;
	if seconds == 86_400 {
		day += 1;
		seconds = 0;
	}
	let date = if system == DateSystem::Excel1900 && day == 60 {
		"1900-02-29".to_owned()
	} else {
		let unix_day = match system {
			DateSystem::Excel1900 => -25_568 + day - i64::from(day > 60),
			DateSystem::Excel1904 => -24_107 + day,
		};
		let (year, month, day) = civil_from_days(unix_day);
		format!("{year:04}-{month:02}-{day:02}")
	};
	if include_time {
		Some(format!("{date} {:02}:{:02}:{:02}", seconds / 3600, seconds % 3600 / 60, seconds % 60))
	} else {
		Some(date)
	}
}

// Gregorian civil date from days relative to 1970-01-01 (Howard Hinnant's
// algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
	let days = days + 719_468;
	let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
	let day_of_era = days - era * 146_097;
	let year_of_era =
		(day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
	let mut year = year_of_era + era * 400;
	let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
	let month_prime = (5 * day_of_year + 2) / 153;
	let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
	let month = month_prime + if month_prime < 10 { 3 } else { -9 };
	year += i64::from(month <= 2);
	(year, month as u32, day as u32)
}

fn clean_text(text: &str) -> String {
	let mut output = String::with_capacity(text.len());
	let mut chars = text.chars().peekable();
	while let Some(character) = chars.next() {
		match character {
			'\u{a0}' => output.push(' '),
			'\u{ad}' | '\u{200b}' | '\u{feff}' => {},
			'\r' => {
				if chars.peek() == Some(&'\n') {
					chars.next();
				}
				output.push(' ');
			},
			'\n' => output.push(' '),
			'\t' => output.push('\t'),
			character if character.is_control() => {},
			character => output.push(character),
		}
	}
	output
}

fn escape_heading(text: &str) -> String {
	escape_markdown_text(text, false)
}

fn escape_table_cell(text: &str) -> String {
	escape_markdown_text(text, true)
}

fn escape_markdown_text(text: &str, in_table: bool) -> String {
	let mut output = String::with_capacity(text.len());
	let mut index = 0usize;
	while index < text.len() {
		let Some(character) = text[index..].chars().next() else {
			break;
		};
		let markdown_syntax = matches!(character, '\\' | '`' | '*' | '_' | '~' | '[' | '<');
		if markdown_syntax || (in_table && character == '|') {
			output.push('\\');
			output.push(character);
		} else if character == '&' && entity_ahead(&text[index..]) {
			output.push_str("&amp;");
		} else {
			output.push(character);
		}
		index += character.len_utf8();
	}
	output
}

fn entity_ahead(text: &str) -> bool {
	let bytes = text.as_bytes();
	if bytes.get(1) == Some(&b'#') {
		return true;
	}
	let mut index = 1usize;
	while bytes.get(index).is_some_and(u8::is_ascii_alphanumeric) {
		index += 1;
	}
	index > 1 && bytes.get(index) == Some(&b';')
}

fn xml_error(error: impl Display) -> String {
	format!("invalid XML: {error}")
}

fn failure(error: impl IntoStr) -> MarkitError {
	MarkitError::conversion(FORMAT, error)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn explicit_cell_limit_counts_unique_coordinates() {
		let mut cells = BTreeMap::new();
		insert_cell_with_limit(&mut cells, (0, 0), "first".to_owned(), 1)
			.expect("first coordinate fits");
		insert_cell_with_limit(&mut cells, (0, 0), "replacement".to_owned(), 1)
			.expect("duplicate coordinate replaces without consuming capacity");
		let error = insert_cell_with_limit(&mut cells, (0, 1), String::new(), 1)
			.expect_err("a second coordinate exceeds the direct boundary");
		assert_eq!(error, "Invalid XLSX: worksheet exceeds the explicit-cell limit of 1");
		assert_eq!(cells.len(), 1);
		assert_eq!(cells.get(&(0, 0)).map(String::as_str), Some("replacement"));
	}

	#[test]
	fn absolute_cell_references_are_accepted() {
		assert_eq!(parse_cell_reference("$A$1"), Ok((0, 0)));
		assert_eq!(parse_cell_reference("$XFD$1048576"), Ok((1_048_575, 16_383)));
		assert!(parse_cell_reference("A$$1").is_err());
	}
	#[test]
	fn converts_utf16_encoded_workbook_member() {
		use omp_ar::zip::Writer;

		fn utf16le(text: &str) -> Vec<u8> {
			let mut bytes = vec![0xff, 0xfe];
			for unit in text.encode_utf16() {
				bytes.extend_from_slice(&unit.to_le_bytes());
			}
			bytes
		}

		fn xlsx(parts: &[(&str, &[u8])]) -> Vec<u8> {
			let mut archive = Writer::new(Vec::new());
			for (name, contents) in parts {
				archive.add_file(name, contents).unwrap();
			}
			archive.finish().unwrap()
		}

		let workbook = utf16le(
			r#"<?xml version="1.0" encoding="UTF-16"?><workbook xmlns:r="r"><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>"#,
		);
		let bytes = xlsx(&[
			("xl/workbook.xml", &workbook),
			(
				"xl/_rels/workbook.xml.rels",
				br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>"#,
			),
			(
				"xl/worksheets/sheet1.xml",
				r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Héllo</t></is></c></row></sheetData></worksheet>"#.as_bytes(),
			),
		]);

		let markdown = convert(&bytes).expect("UTF-16 XLSX should convert");
		assert_eq!(markdown.as_str(), "## Data\n\n| Héllo |\n| --- |");
	}
}

