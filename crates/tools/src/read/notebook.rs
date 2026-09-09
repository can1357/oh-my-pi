//! Jupyter notebook conversion into editable virtual text.

use std::{borrow::Cow, collections::HashSet};

use omp_core::{IntoStr, Str};
use serde_json::Value;

/// A supported Jupyter notebook cell kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotebookCellType {
	/// An executable code cell.
	Code,
	/// A Markdown cell.
	Markdown,
	/// A raw cell.
	Raw,
}

impl NotebookCellType {
	const fn marker_name(self) -> &'static str {
		match self {
			Self::Code => "code",
			Self::Markdown => "markdown",
			Self::Raw => "raw",
		}
	}

	fn parse(value: &Value) -> Option<Self> {
		match value.as_str()? {
			"code" => Some(Self::Code),
			"markdown" => Some(Self::Markdown),
			"raw" => Some(Self::Raw),
			_ => None,
		}
	}
}

/// The virtual-text location of one original notebook cell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotebookCellMapping {
	/// Zero-based index of the cell in the notebook JSON.
	pub original_index: usize,
	/// Cell kind encoded in the marker.
	pub cell_type:      NotebookCellType,
	/// One-based line containing the cell marker.
	pub marker_line:    u64,
	/// Inclusive one-based source-line bounds, absent for an empty cell.
	pub source_lines:   Option<(u64, u64)>,
}

/// Editable notebook text and its original-cell locations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedNotebook {
	/// Virtual cell-marked text consumed by the standard read formatter.
	pub text:  String,
	/// Original cell indices and their locations in `text`.
	pub cells: Vec<NotebookCellMapping>,
}

/// A malformed notebook error with model-facing text.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{0}")]
pub struct NotebookError(Str);

impl NotebookError {
	fn new(message: impl IntoStr) -> Self {
		Self(message.into_str())
	}

	/// Model-facing error text.
	pub fn message(&self) -> &str {
		self.0.as_ref()
	}
}

struct PreparedCell<'a> {
	cell_type: NotebookCellType,
	source:    Cow<'a, str>,
}

/// Parse notebook JSON bytes and render the editable cell-marked text.
///
/// Notebook and cell metadata, execution counts, and outputs are intentionally
/// not projected into the virtual text. Cell markers retain the original index
/// so notebook-aware edits can preserve those fields when writing JSON back.
pub fn render(bytes: &[u8], display_path: &str) -> Result<RenderedNotebook, NotebookError> {
	let notebook: Value = serde_json::from_slice(bytes)
		.map_err(|_| NotebookError::new(format!("Invalid JSON in notebook: {display_path}")))?;
	let object = notebook.as_object().ok_or_else(|| {
		NotebookError::new(format!("Invalid notebook structure (expected object): {display_path}"))
	})?;
	let cells = object
		.get("cells")
		.and_then(Value::as_array)
		.ok_or_else(|| {
			NotebookError::new(format!(
				"Invalid notebook structure (missing cells array): {display_path}"
			))
		})?;

	let mut prepared = Vec::with_capacity(cells.len());
	let mut text_capacity = 0usize;
	for (index, value) in cells.iter().enumerate() {
		let Some(cell) = value.as_object() else {
			return Err(invalid_cell(index, display_path));
		};
		let Some(cell_type) = cell.get("cell_type").and_then(NotebookCellType::parse) else {
			return Err(invalid_cell(index, display_path));
		};
		let source = match cell.get("source") {
			None => Cow::Borrowed(""),
			Some(Value::String(source)) => Cow::Borrowed(source.as_str()),
			Some(Value::Array(lines)) => {
				let mut length = 0usize;
				for line in lines {
					let Some(line) = line.as_str() else {
						return Err(invalid_cell(index, display_path));
					};
					length = length.saturating_add(line.len());
				}
				let mut source = String::with_capacity(length);
				for line in lines {
					source.push_str(line.as_str().expect("source entries were validated"));
				}
				Cow::Owned(source)
			},
			Some(_) => return Err(invalid_cell(index, display_path)),
		};
		text_capacity = text_capacity
			.saturating_add(24)
			.saturating_add(decimal_digits(index))
			.saturating_add(source.len());
		prepared.push(PreparedCell { cell_type, source });
	}
	text_capacity = text_capacity.saturating_add(prepared.len().saturating_sub(1));

	let mut text = String::with_capacity(text_capacity);
	let mut mappings = Vec::with_capacity(prepared.len());
	let mut marker_line = 1u64;
	for (index, cell) in prepared.into_iter().enumerate() {
		if index != 0 {
			text.push('\n');
		}
		use std::fmt::Write as _;
		write!(text, "# %% [{}] cell:{index}", cell.cell_type.marker_name())
			.expect("writing to a String cannot fail");

		let source_lines = if cell.source.is_empty() {
			None
		} else {
			text.push('\n');
			push_escaped_source(&mut text, &cell.source);
			let count = cell.source.bytes().filter(|byte| *byte == b'\n').count() as u64 + 1;
			Some((marker_line + 1, marker_line.saturating_add(count)))
		};
		mappings.push(NotebookCellMapping {
			original_index: index,
			cell_type: cell.cell_type,
			marker_line,
			source_lines,
		});
		marker_line = marker_line
			.saturating_add(cell.source.bytes().filter(|byte| *byte == b'\n').count() as u64)
			.saturating_add(u64::from(!cell.source.is_empty()))
			.saturating_add(1);
	}

	Ok(RenderedNotebook { text, cells: mappings })
}

fn invalid_cell(index: usize, display_path: &str) -> NotebookError {
	NotebookError::new(format!("Invalid notebook cell {index} in {display_path}"))
}

const fn decimal_digits(mut value: usize) -> usize {
	let mut digits = 1;
	while value >= 10 {
		value /= 10;
		digits += 1;
	}
	digits
}

fn push_escaped_source(output: &mut String, source: &str) {
	if !source.contains("# %%") {
		output.push_str(source);
		return;
	}
	for segment in source.split_inclusive('\n') {
		if let Some(line) = segment.strip_suffix('\n') {
			push_escaped_line(output, line);
			output.push('\n');
		} else {
			push_escaped_line(output, segment);
		}
	}
}

fn push_escaped_line(output: &mut String, line: &str) {
	if is_marker_like_source_line(line) {
		output.push_str("# %%");
		output.push_str(&line[3..]);
	} else {
		output.push_str(line);
	}
}

fn is_marker_like_source_line(line: &str) -> bool {
	let Some(after_prefix) = line.strip_prefix("# ") else {
		return false;
	};
	let percent_count = after_prefix
		.bytes()
		.take_while(|byte| *byte == b'%')
		.count();
	if percent_count < 2 {
		return false;
	}
	let suffix = &after_prefix[percent_count..];
	for marker in [" [code]", " [markdown]", " [raw]"] {
		if suffix == marker {
			return true;
		}
		if let Some(index) = suffix
			.strip_prefix(marker)
			.and_then(|rest| rest.strip_prefix(" cell:"))
		{
			return !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit());
		}
	}
	false
}

/// Applies edited virtual cell text to an original notebook JSON document.
///
/// Indexed markers retain that original cell's metadata, code outputs, and
/// execution count. Cells may be reordered, removed, or added with an
/// unindexed `# %% [type]` marker; only the first use of an original index
/// inherits its metadata.
pub fn round_trip(original: &[u8], virtual_text: &str) -> Result<Vec<u8>, NotebookError> {
	let mut notebook: Value = serde_json::from_slice(original)
		.map_err(|_| NotebookError::new("Invalid JSON in original notebook"))?;
	let original_cells = notebook
		.as_object()
		.and_then(|object| object.get("cells"))
		.and_then(Value::as_array)
		.ok_or_else(|| NotebookError::new("Invalid notebook structure (missing cells array)"))?
		.clone();
	let projected = parse_virtual_cells(virtual_text)?;
	let mut used = HashSet::new();
	let mut cells = Vec::with_capacity(projected.len());
	for (cell_type, original_index, source) in projected {
		let original = original_index
			.filter(|index| *index < original_cells.len() && used.insert(*index))
			.and_then(|index| original_cells.get(index))
			.and_then(Value::as_object);
		let mut cell = original.cloned().unwrap_or_default();
		let prior_array =
			original.is_none_or(|original| matches!(original.get("source"), Some(Value::Array(_))));
		cell.insert("cell_type".to_owned(), Value::String(cell_type.marker_name().to_owned()));
		cell.insert(
			"source".to_owned(),
			if prior_array {
				Value::Array(
					split_source_lines(&source)
						.into_iter()
						.map(Value::String)
						.collect(),
				)
			} else {
				Value::String(source)
			},
		);
		if cell_type == NotebookCellType::Code {
			cell
				.entry("execution_count".to_owned())
				.or_insert(Value::Null);
			cell
				.entry("outputs".to_owned())
				.or_insert_with(|| Value::Array(Vec::new()));
		} else {
			cell.remove("execution_count");
			cell.remove("outputs");
		}
		cell
			.entry("metadata".to_owned())
			.or_insert_with(|| Value::Object(serde_json::Map::new()));
		cells.push(Value::Object(cell));
	}
	notebook
		.as_object_mut()
		.expect("notebook object was validated")
		.insert("cells".to_owned(), Value::Array(cells));
	let mut encoded = serde_json::to_vec_pretty(&notebook)
		.map_err(|error| NotebookError::new(format!("Could not encode notebook: {error}")))?;
	encoded.push(b'\n');
	Ok(encoded)
}

fn parse_virtual_cells(
	virtual_text: &str,
) -> Result<Vec<(NotebookCellType, Option<usize>, String)>, NotebookError> {
	let mut cells = Vec::new();
	let mut current: Option<(NotebookCellType, Option<usize>, String)> = None;
	for segment in virtual_text.split_inclusive('\n') {
		let line = segment.strip_suffix('\n').unwrap_or(segment);
		if let Some((cell_type, index)) = parse_marker(line) {
			if let Some((prior_type, prior_index, source)) = current.take() {
				cells.push((prior_type, prior_index, strip_separator(source)));
			}
			current = Some((cell_type, index, String::new()));
			continue;
		}
		let Some((_, _, source)) = current.as_mut() else {
			return Err(NotebookError::new(
				"Notebook virtual text must begin with a '# %% [type]' marker",
			));
		};
		push_unescaped_source(source, segment);
	}
	if let Some(cell) = current {
		cells.push(cell);
	}
	Ok(cells)
}

fn parse_marker(line: &str) -> Option<(NotebookCellType, Option<usize>)> {
	let suffix = line.strip_prefix("# %% [")?;
	let (kind, suffix) = suffix.split_once(']')?;
	let cell_type = match kind {
		"code" => NotebookCellType::Code,
		"markdown" => NotebookCellType::Markdown,
		"raw" => NotebookCellType::Raw,
		_ => return None,
	};
	let index = if suffix.is_empty() {
		None
	} else {
		let index = suffix.strip_prefix(" cell:")?;
		Some(
			index
				.parse::<usize>()
				.ok()
				.filter(|_| !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit()))?,
		)
	};
	Some((cell_type, index))
}

fn strip_separator(mut source: String) -> String {
	if source.ends_with('\n') {
		source.pop();
	}
	source
}

fn push_unescaped_source(output: &mut String, segment: &str) {
	let (line, newline) = segment
		.strip_suffix('\n')
		.map_or((segment, ""), |line| (line, "\n"));
	if let Some(rest) = line.strip_prefix("# %%%") {
		let candidate = format!("# %%{rest}");
		if is_marker_like_source_line(&candidate) {
			output.push_str(&candidate);
			output.push_str(newline);
			return;
		}
	}
	output.push_str(segment);
}

fn split_source_lines(source: &str) -> Vec<String> {
	if source.is_empty() {
		return Vec::new();
	}
	source.split_inclusive('\n').map(str::to_owned).collect()
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::{render, round_trip};

	#[test]
	fn round_trip_preserves_metadata_outputs_and_source_shape() {
		let original = serde_json::to_vec(&json!({
			"nbformat": 4,
			"nbformat_minor": 5,
			"metadata": {"kernelspec": {"name": "python3"}},
			"cells": [
				{
					"cell_type": "code",
					"execution_count": 7,
					"metadata": {"tag": "keep"},
					"outputs": [{"output_type": "stream", "text": ["old\n"]}],
					"source": ["print('old')\n"]
				},
				{"cell_type": "markdown", "metadata": {}, "source": "old heading"}
			]
		}))
		.unwrap();
		let rendered = render(&original, "demo.ipynb").unwrap();
		let edited = rendered
			.text
			.replace("print('old')", "print('new')")
			.replace("old heading", "new heading");
		let updated: Value =
			serde_json::from_slice(&round_trip(&original, &edited).unwrap()).unwrap();
		assert_eq!(updated["metadata"]["kernelspec"]["name"], "python3");
		assert_eq!(updated["cells"][0]["execution_count"], 7);
		assert_eq!(updated["cells"][0]["metadata"]["tag"], "keep");
		assert_eq!(updated["cells"][0]["outputs"][0]["text"][0], "old\n");
		assert_eq!(updated["cells"][0]["source"], json!(["print('new')\n"]));
		assert_eq!(updated["cells"][1]["source"], "new heading");
	}

	#[test]
	fn marker_like_source_round_trips_without_becoming_a_cell() {
		let original = serde_json::to_vec(&json!({
			"cells": [{
				"cell_type": "code",
				"metadata": {},
				"execution_count": null,
				"outputs": [],
				"source": "# %% [code] cell:99"
			}],
			"metadata": {},
			"nbformat": 4,
			"nbformat_minor": 5
		}))
		.unwrap();
		let rendered = render(&original, "markers.ipynb").unwrap();
		assert!(rendered.text.contains("# %%% [code] cell:99"));
		let updated: Value =
			serde_json::from_slice(&round_trip(&original, &rendered.text).unwrap()).unwrap();
		assert_eq!(updated["cells"][0]["source"], "# %% [code] cell:99");
	}

	#[test]
	fn supports_cell_add_remove_reorder_without_metadata_aliasing() {
		let original = br#"{"cells":[{"cell_type":"raw","metadata":{"id":"zero"},"source":""},{"cell_type":"raw","metadata":{"id":"one"},"source":""}]}"#;
		let edited = "# %% [raw] cell:1\nkept\n# %% [code]\nnew\n# %% [raw] cell:1\nduplicate";
		let updated: Value = serde_json::from_slice(&round_trip(original, edited).unwrap()).unwrap();
		assert_eq!(updated["cells"].as_array().unwrap().len(), 3);
		assert_eq!(updated["cells"][0]["metadata"]["id"], "one");
		assert!(
			updated["cells"][1]["metadata"]
				.as_object()
				.unwrap()
				.is_empty()
		);
		assert!(
			updated["cells"][2]["metadata"]
				.as_object()
				.unwrap()
				.is_empty()
		);
		assert_eq!(updated["cells"][1]["outputs"], json!([]));
	}
}
