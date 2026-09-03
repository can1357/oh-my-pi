//! Jupyter notebook (`.ipynb`) codec: projects cells onto an editable text
//! form (`# %% [type] cell:N` markers) and serializes edits back to JSON
//! with `JSON.stringify(nb, null, 1)`-identical bytes.
//!
//! Port of `packages/coding-agent/src/edit/notebook.ts`.

use std::{collections::HashSet, fmt::Write as _, path::Path, sync::LazyLock};

use regex::Regex;
use serde_json::{Map, Value};

/// Notebook decode/encode failure. `Display` is the exact model-facing text.
#[derive(Debug, thiserror::Error)]
pub enum NotebookError {
	#[error("Invalid JSON in notebook: {display}")]
	InvalidJson { display: String },
	#[error("Invalid notebook structure (expected object): {display}")]
	NotObject { display: String },
	#[error("Invalid notebook structure (missing cells array): {display}")]
	MissingCells { display: String },
	#[error("Invalid notebook cell {index} in {display}")]
	InvalidCell { index: usize, display: String },
	#[error(
		"Invalid notebook editable representation for {display}: expected first line to be \"# %% \
		 [code] cell:0\", \"# %% [markdown] cell:0\", or \"# %% [raw] cell:0\"."
	)]
	InvalidEditableText { display: String },
}

/// A cell type supported by the editable notebook projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotebookCellType {
	/// An executable code cell.
	Code,
	/// A Markdown cell.
	Markdown,
	/// A raw-text cell.
	Raw,
}

impl NotebookCellType {
	fn parse(value: &str) -> Option<Self> {
		match value {
			"code" => Some(Self::Code),
			"markdown" => Some(Self::Markdown),
			"raw" => Some(Self::Raw),
			_ => None,
		}
	}

	const fn as_str(self) -> &'static str {
		match self {
			Self::Code => "code",
			Self::Markdown => "markdown",
			Self::Raw => "raw",
		}
	}
}

/// One cell parsed from the editable notebook projection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParsedVirtualCell {
	/// Parsed cell kind.
	pub cell_type:  NotebookCellType,
	/// Original cell index, when the marker named one.
	pub cell_index: Option<usize>,
	/// Unescaped cell source.
	pub source:     String,
}

static CELL_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^# %% \[(code|markdown|raw)\](?: cell:(\d+))?$")
		.expect("valid notebook cell marker regex")
});
static ESCAPABLE_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^# %%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$")
		.expect("valid notebook escape regex")
});
static ESCAPED_MARKER_RE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"^# %%%+ \[(?:code|markdown|raw)\](?: cell:\d+)?$")
		.expect("valid notebook unescape regex")
});

fn escape_marker_like_source_lines(source: &str) -> String {
	if !source.contains("# %%") {
		return source.to_owned();
	}
	source
		.split('\n')
		.map(|line| {
			if ESCAPABLE_MARKER_RE.is_match(line) {
				line.replacen("# %", "# %%", 1)
			} else {
				line.to_owned()
			}
		})
		.collect::<Vec<_>>()
		.join("\n")
}

fn unescape_marker_like_line(line: &str) -> String {
	if ESCAPED_MARKER_RE.is_match(line) {
		line.replacen("# %%", "# %", 1)
	} else {
		line.to_owned()
	}
}

/// True when the extension is `.ipynb` (case-insensitive).
pub fn is_notebook_path(path: &Path) -> bool {
	path
		.extension()
		.is_some_and(|extension| extension.eq_ignore_ascii_case("ipynb"))
}

/// Split notebook source text into nbformat `source` lines (each keeps its
/// trailing `\n`; a final unterminated line is kept as-is).
pub fn split_notebook_source(content: &str) -> Vec<String> {
	if content.is_empty() {
		Vec::new()
	} else {
		content.split_inclusive('\n').map(str::to_owned).collect()
	}
}

fn source_to_text(source: Option<&Value>) -> String {
	match source {
		None => String::new(),
		Some(Value::String(source)) => source.clone(),
		Some(Value::Array(lines)) => lines.iter().filter_map(Value::as_str).collect(),
		Some(_) => String::new(),
	}
}

fn validate_notebook<'a>(
	value: &'a Value,
	display: &str,
) -> Result<&'a Map<String, Value>, NotebookError> {
	let object = value
		.as_object()
		.ok_or_else(|| NotebookError::NotObject { display: display.to_owned() })?;
	let cells = object
		.get("cells")
		.and_then(Value::as_array)
		.ok_or_else(|| NotebookError::MissingCells { display: display.to_owned() })?;
	for (index, cell) in cells.iter().enumerate() {
		let valid = cell
			.as_object()
			.and_then(|cell| cell.get("cell_type"))
			.and_then(Value::as_str)
			.and_then(NotebookCellType::parse)
			.is_some();
		if !valid {
			return Err(NotebookError::InvalidCell { index, display: display.to_owned() });
		}
	}
	Ok(object)
}

/// Decode notebook JSON into the editable text form.
pub fn notebook_to_editable_text(json: &str, display: &str) -> Result<String, NotebookError> {
	let json = json.strip_prefix('\u{feff}').unwrap_or(json);
	let notebook: Value = serde_json::from_str(json)
		.map_err(|_| NotebookError::InvalidJson { display: display.to_owned() })?;
	let object = validate_notebook(&notebook, display)?;
	let cells = object
		.get("cells")
		.and_then(Value::as_array)
		.expect("validated cells");
	Ok(cells
		.iter()
		.enumerate()
		.map(|(index, cell)| {
			let cell = cell.as_object().expect("validated cell");
			let cell_type = cell
				.get("cell_type")
				.and_then(Value::as_str)
				.expect("validated cell type");
			let source = escape_marker_like_source_lines(&source_to_text(cell.get("source")));
			if source.is_empty() {
				format!("# %% [{cell_type}] cell:{index}")
			} else {
				format!("# %% [{cell_type}] cell:{index}\n{source}")
			}
		})
		.collect::<Vec<_>>()
		.join("\n"))
}

/// Parse an editable notebook projection into virtual cells.
pub fn parse_notebook_editable_text(
	text: &str,
	display: &str,
) -> Result<Vec<ParsedVirtualCell>, NotebookError> {
	let mut cells = Vec::new();
	let mut current: Option<(NotebookCellType, Option<usize>, Vec<String>)> = None;
	let lines: Vec<&str> = if text.is_empty() {
		Vec::new()
	} else {
		text.split('\n').collect()
	};

	for line in lines {
		if let Some(captures) = CELL_MARKER_RE.captures(line) {
			if let Some((cell_type, cell_index, source_lines)) = current.take() {
				cells.push(ParsedVirtualCell {
					cell_type,
					cell_index,
					source: source_lines.join("\n"),
				});
			}
			let cell_type =
				NotebookCellType::parse(captures.get(1).expect("cell type capture").as_str())
					.expect("validated marker type");
			let cell_index = captures
				.get(2)
				.and_then(|value| value.as_str().parse().ok());
			current = Some((cell_type, cell_index, Vec::new()));
		} else if let Some((_, _, source_lines)) = current.as_mut() {
			source_lines.push(unescape_marker_like_line(line));
		} else {
			return Err(NotebookError::InvalidEditableText { display: display.to_owned() });
		}
	}
	if let Some((cell_type, cell_index, source_lines)) = current {
		cells.push(ParsedVirtualCell { cell_type, cell_index, source: source_lines.join("\n") });
	}
	Ok(cells)
}

/// Create a new nbformat cell with default metadata and code-cell state.
pub fn create_notebook_cell(cell_type: NotebookCellType, source: &str) -> Value {
	let mut cell = Map::new();
	cell.insert("cell_type".into(), Value::String(cell_type.as_str().into()));
	cell.insert("metadata".into(), Value::Object(Map::new()));
	cell.insert(
		"source".into(),
		Value::Array(
			split_notebook_source(source)
				.into_iter()
				.map(Value::String)
				.collect(),
		),
	);
	if cell_type == NotebookCellType::Code {
		cell.insert("execution_count".into(), Value::Null);
		cell.insert("outputs".into(), Value::Array(Vec::new()));
	}
	Value::Object(cell)
}

/// Create an empty nbformat 4.5 notebook document.
pub fn create_empty_notebook() -> Value {
	let mut notebook = Map::new();
	notebook.insert("cells".into(), Value::Array(Vec::new()));
	notebook.insert("metadata".into(), Value::Object(Map::new()));
	notebook.insert("nbformat".into(), Value::from(4));
	notebook.insert("nbformat_minor".into(), Value::from(5));
	Value::Object(notebook)
}

/// Apply editable text to a validated notebook while preserving document and
/// reused-cell fields and their insertion order.
pub fn apply_notebook_editable_text(
	notebook: &Value,
	text: &str,
	display: &str,
) -> Result<Value, NotebookError> {
	let object = validate_notebook(notebook, display)?;
	let original_cells = object
		.get("cells")
		.and_then(Value::as_array)
		.expect("validated cells");
	let parsed_cells = parse_notebook_editable_text(text, display)?;
	let mut used_original_cells = HashSet::new();
	let mut next_cells = Vec::with_capacity(parsed_cells.len());

	for parsed in parsed_cells {
		let original = parsed
			.cell_index
			.filter(|index| *index < original_cells.len() && used_original_cells.insert(*index))
			.map(|index| &original_cells[index]);
		if let Some(original) = original {
			let mut cell = original.as_object().expect("validated cell").clone();
			cell.insert("cell_type".into(), Value::String(parsed.cell_type.as_str().into()));
			cell.insert(
				"source".into(),
				Value::Array(
					split_notebook_source(&parsed.source)
						.into_iter()
						.map(Value::String)
						.collect(),
				),
			);
			if parsed.cell_type == NotebookCellType::Code {
				if cell.get("execution_count").is_none_or(Value::is_null) {
					cell.insert("execution_count".into(), Value::Null);
				}
				if cell.get("outputs").is_none_or(Value::is_null) {
					cell.insert("outputs".into(), Value::Array(Vec::new()));
				}
			} else {
				cell.remove("execution_count");
				cell.remove("outputs");
			}
			next_cells.push(Value::Object(cell));
		} else {
			next_cells.push(create_notebook_cell(parsed.cell_type, &parsed.source));
		}
	}

	let mut next_notebook = object.clone();
	next_notebook.insert("cells".into(), Value::Array(next_cells));
	Ok(Value::Object(next_notebook))
}

/// Apply edited text back onto the original notebook JSON (`None` = the
/// notebook did not exist; an empty nbformat 4.5 document is used) and
/// serialize with 1-space indentation.
pub fn serialize_edited_notebook_text(
	original_json: Option<&str>,
	text: &str,
	display: &str,
) -> Result<String, NotebookError> {
	let notebook = match original_json {
		Some(json) => {
			let json = json.strip_prefix('\u{feff}').unwrap_or(json);
			serde_json::from_str(json)
				.map_err(|_| NotebookError::InvalidJson { display: display.to_owned() })?
		},
		None => create_empty_notebook(),
	};
	let next_notebook = apply_notebook_editable_text(&notebook, text, display)?;
	Ok(stringify_indent1(&next_notebook))
}

fn js_number_to_string(number: &serde_json::Number) -> String {
	if let Some(value) = number.as_i64() {
		return value.to_string();
	}
	if let Some(value) = number.as_u64() {
		return value.to_string();
	}
	let value = number.as_f64().expect("JSON numbers are finite");
	if value == 0.0 {
		return "0".into();
	}
	let rendered = value.abs().to_string();
	let (mantissa, explicit_exponent) = rendered
		.split_once(['e', 'E'])
		.map_or((rendered.as_str(), 0), |(mantissa, exponent)| {
			(mantissa, exponent.parse::<i32>().expect("valid float exponent"))
		});
	let decimal = mantissa.find('.').unwrap_or(mantissa.len());
	let mut digits = mantissa
		.chars()
		.filter(|character| *character != '.')
		.collect::<String>();
	let leading_zeros = digits.len() - digits.trim_start_matches('0').len();
	let mut decimal_position = i32::try_from(decimal).expect("short float mantissa")
		- i32::try_from(leading_zeros).expect("short float mantissa")
		+ explicit_exponent;
	digits.drain(..leading_zeros);
	while digits.len() > 1 && digits.ends_with('0') {
		digits.pop();
	}
	if digits.is_empty() {
		digits.push('0');
		decimal_position = 1;
	}
	let scientific_exponent = decimal_position - 1;
	let mut output = String::new();
	if value.is_sign_negative() {
		output.push('-');
	}
	if decimal_position > 0 && decimal_position <= 21 {
		let position = usize::try_from(decimal_position).expect("positive decimal position");
		if position >= digits.len() {
			output.push_str(&digits);
			output.extend(std::iter::repeat_n('0', position - digits.len()));
		} else {
			output.push_str(&digits[..position]);
			output.push('.');
			output.push_str(&digits[position..]);
		}
	} else if decimal_position <= 0 && decimal_position > -6 {
		output.push_str("0.");
		output.extend(std::iter::repeat_n(
			'0',
			usize::try_from(-decimal_position).expect("nonnegative zero count"),
		));
		output.push_str(&digits);
	} else {
		output.push(digits.as_bytes()[0] as char);
		if digits.len() > 1 {
			output.push('.');
			output.push_str(&digits[1..]);
		}
		output.push('e');
		if scientific_exponent >= 0 {
			output.push('+');
		}
		write!(output, "{scientific_exponent}").expect("writing to String cannot fail");
	}
	output
}

fn write_json_string(output: &mut String, value: &str) {
	output.push('"');
	for character in value.chars() {
		match character {
			'"' => output.push_str("\\\""),
			'\\' => output.push_str("\\\\"),
			'\u{0008}' => output.push_str("\\b"),
			'\u{000c}' => output.push_str("\\f"),
			'\n' => output.push_str("\\n"),
			'\r' => output.push_str("\\r"),
			'\t' => output.push_str("\\t"),
			'\u{0000}'..='\u{001f}' => write!(output, "\\u{:04x}", u32::from(character))
				.expect("writing to String cannot fail"),
			_ => output.push(character),
		}
	}
	output.push('"');
}

fn write_indent(output: &mut String, depth: usize) {
	output.extend(std::iter::repeat_n(' ', depth));
}

fn write_json_value(output: &mut String, value: &Value, depth: usize) {
	match value {
		Value::Null => output.push_str("null"),
		Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
		Value::Number(value) => output.push_str(&js_number_to_string(value)),
		Value::String(value) => write_json_string(output, value),
		Value::Array(values) => {
			if values.is_empty() {
				output.push_str("[]");
				return;
			}
			output.push_str("[\n");
			for (index, value) in values.iter().enumerate() {
				write_indent(output, depth + 1);
				write_json_value(output, value, depth + 1);
				if index + 1 != values.len() {
					output.push(',');
				}
				output.push('\n');
			}
			write_indent(output, depth);
			output.push(']');
		},
		Value::Object(values) => {
			if values.is_empty() {
				output.push_str("{}");
				return;
			}
			output.push_str("{\n");
			for (index, (key, value)) in values.iter().enumerate() {
				write_indent(output, depth + 1);
				write_json_string(output, key);
				output.push_str(": ");
				write_json_value(output, value, depth + 1);
				if index + 1 != values.len() {
					output.push(',');
				}
				output.push('\n');
			}
			write_indent(output, depth);
			output.push('}');
		},
	}
}

/// `JSON.stringify(value, null, 1)`-identical serialization.
pub fn stringify_indent1(value: &Value) -> String {
	let mut output = String::new();
	write_json_value(&mut output, value, 0);
	output
}

#[cfg(test)]
mod tests {
	use super::*;

	const MIXED_FIXTURE: &str = include_str!("../tests/fixtures/notebooks/mixed.ipynb");
	const MIXED_GOLDEN: &str = include_str!("../tests/fixtures/notebooks/mixed.ipynb.golden.json");
	const EMPTY_FIXTURE: &str = include_str!("../tests/fixtures/notebooks/empty.ipynb");
	const EMPTY_GOLDEN: &str = include_str!("../tests/fixtures/notebooks/empty.ipynb.golden.json");

	#[test]
	fn detects_notebook_paths_case_insensitively() {
		assert!(is_notebook_path(Path::new("work/Book.IPYNB")));
		assert!(!is_notebook_path(Path::new("work/Book.json")));
	}

	#[test]
	fn splits_source_preserving_line_endings() {
		assert_eq!(split_notebook_source(""), Vec::<String>::new());
		assert_eq!(split_notebook_source("a\nb\n"), ["a\n", "b\n"]);
		assert_eq!(split_notebook_source("a\nb"), ["a\n", "b"]);
	}

	#[test]
	fn serializes_floats_like_javascript() {
		let values = serde_json::json!([0.1, 1e21, 1.5e-7, 123_456_789_012_345_680_000_f64, -0.0]);
		assert_eq!(
			stringify_indent1(&values),
			"[\n 0.1,\n 1e+21,\n 1.5e-7,\n 123456789012345680000,\n 0\n]"
		);
	}

	#[test]
	fn golden_json_serialization_matches_bun() {
		for (fixture, golden) in [(MIXED_FIXTURE, MIXED_GOLDEN), (EMPTY_FIXTURE, EMPTY_GOLDEN)] {
			let value: Value = serde_json::from_str(fixture).unwrap();
			assert_eq!(stringify_indent1(&value), golden);
		}
	}

	#[test]
	fn unchanged_editable_round_trip_matches_golden() {
		for (fixture, golden) in [(MIXED_FIXTURE, MIXED_GOLDEN), (EMPTY_FIXTURE, EMPTY_GOLDEN)] {
			let editable = notebook_to_editable_text(fixture, "fixture.ipynb").unwrap();
			let serialized =
				serialize_edited_notebook_text(Some(fixture), &editable, "fixture.ipynb").unwrap();
			assert_eq!(serialized, golden);
		}
	}

	#[test]
	fn marker_like_source_lines_are_escaped_and_restored() {
		let editable = notebook_to_editable_text(MIXED_FIXTURE, "mixed.ipynb").unwrap();
		assert!(editable.contains("# %%% [markdown] cell:3"));
		let serialized =
			serialize_edited_notebook_text(Some(MIXED_FIXTURE), &editable, "mixed.ipynb").unwrap();
		let restored: Value = serde_json::from_str(&serialized).unwrap();
		assert_eq!(restored["cells"][0]["source"][1], "# %% [markdown] cell:3\n");
	}

	#[test]
	fn reuses_cells_and_preserves_outputs_metadata_and_key_order() {
		let text = "# %% [markdown] cell:0\nUpdated\n# %% [code] cell:1\nprint('new')\n";
		let serialized =
			serialize_edited_notebook_text(Some(MIXED_FIXTURE), text, "mixed.ipynb").unwrap();
		let notebook: Value = serde_json::from_str(&serialized).unwrap();
		assert_eq!(notebook["cells"][0]["metadata"]["nested"]["label"], "λ");
		assert!(notebook["cells"][0].get("execution_count").is_none());
		assert!(notebook["cells"][0].get("outputs").is_none());
		assert_eq!(notebook["cells"][1]["execution_count"], Value::Null);
		assert_eq!(notebook["cells"][1]["outputs"], serde_json::json!([]));
		assert_eq!(notebook["cells"][1]["source"], serde_json::json!(["print('new')\n"]));
	}

	#[test]
	fn duplicate_or_missing_indices_create_fresh_cells() {
		let original: Value = serde_json::from_str(MIXED_FIXTURE).unwrap();
		let text = "# %% [code] cell:0\na\n# %% [raw] cell:0\nb\n# %% [markdown]\nc";
		let next = apply_notebook_editable_text(&original, text, "mixed.ipynb").unwrap();
		assert_eq!(next["cells"][0]["execution_count"], 7);
		assert_eq!(
			next["cells"][1],
			serde_json::json!({"cell_type":"raw","metadata":{},"source":["b"]})
		);
		assert_eq!(
			next["cells"][2],
			serde_json::json!({"cell_type":"markdown","metadata":{},"source":["c"]})
		);
	}

	#[test]
	fn absent_notebook_uses_empty_nbformat_45_document() {
		let serialized =
			serialize_edited_notebook_text(None, "# %% [code] cell:0\nanswer = 42", "new.ipynb")
				.unwrap();
		let notebook: Value = serde_json::from_str(&serialized).unwrap();
		assert_eq!(notebook["nbformat"], 4);
		assert_eq!(notebook["nbformat_minor"], 5);
		assert_eq!(notebook["cells"][0]["execution_count"], Value::Null);
		assert_eq!(notebook["cells"][0]["outputs"], serde_json::json!([]));
	}

	#[test]
	fn reports_validation_errors_verbatim() {
		assert_eq!(
			notebook_to_editable_text("not json", "bad.ipynb")
				.unwrap_err()
				.to_string(),
			"Invalid JSON in notebook: bad.ipynb"
		);
		assert_eq!(
			notebook_to_editable_text("[]", "bad.ipynb")
				.unwrap_err()
				.to_string(),
			"Invalid notebook structure (expected object): bad.ipynb"
		);
		assert_eq!(
			notebook_to_editable_text("{}", "bad.ipynb")
				.unwrap_err()
				.to_string(),
			"Invalid notebook structure (missing cells array): bad.ipynb"
		);
		assert_eq!(
			notebook_to_editable_text(r#"{"cells":[{"cell_type":"other"}]}"#, "bad.ipynb")
				.unwrap_err()
				.to_string(),
			"Invalid notebook cell 0 in bad.ipynb"
		);
		assert_eq!(
			parse_notebook_editable_text("preamble", "bad.ipynb")
				.unwrap_err()
				.to_string(),
			"Invalid notebook editable representation for bad.ipynb: expected first line to be \"# \
			 %% [code] cell:0\", \"# %% [markdown] cell:0\", or \"# %% [raw] cell:0\"."
		);
	}
}
