//! Per-document LSP formatting options and deterministic post-format cleanup.

use omp_core::Str;
use serde::{Deserialize, Serialize};

/// Resolved LSP formatting options.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatOptions {
	/// Indentation stride or tab display width.
	pub tab_size:                 u32,
	/// Whether indentation uses spaces.
	pub insert_spaces:            bool,
	/// Remove horizontal whitespace before line endings.
	pub trim_trailing_whitespace: bool,
	/// Ensure one final newline.
	pub insert_final_newline:     bool,
	/// Collapse multiple final newlines.
	pub trim_final_newlines:      bool,
}

impl Default for FormatOptions {
	fn default() -> Self {
		Self {
			tab_size:                 2,
			insert_spaces:            true,
			trim_trailing_whitespace: true,
			insert_final_newline:     true,
			trim_final_newlines:      true,
		}
	}
}

/// Relevant values from the nearest applicable EditorConfig section.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EditorConfigOptions {
	/// `indent_size`.
	pub indent_size:              Option<u32>,
	/// `tab_width`.
	pub tab_width:                Option<u32>,
	/// `indent_style` (`true` for spaces, `false` for tabs).
	pub insert_spaces:            Option<bool>,
	/// `trim_trailing_whitespace`.
	pub trim_trailing_whitespace: Option<bool>,
	/// `insert_final_newline`.
	pub insert_final_newline:     Option<bool>,
}

/// Parses relevant assignments from an already authority-read EditorConfig
/// section.
///
/// Section matching and ancestor precedence remain with the caller so this
/// parser never reads the ambient filesystem.
pub fn parse_editorconfig_section(section: &str) -> EditorConfigOptions {
	let mut options = EditorConfigOptions::default();
	for raw in section.lines() {
		let line = raw.trim();
		if line.is_empty() || line.starts_with(['#', ';', '[']) {
			continue;
		}
		let Some((key, value)) = line.split_once('=') else {
			continue;
		};
		let key = key.trim().to_ascii_lowercase();
		let value = value.trim().to_ascii_lowercase();
		match key.as_str() {
			"indent_style" if value == "space" => options.insert_spaces = Some(true),
			"indent_style" if value == "tab" => options.insert_spaces = Some(false),
			"indent_size" if value != "tab" => options.indent_size = positive_u32(&value),
			"tab_width" => options.tab_width = positive_u32(&value),
			"trim_trailing_whitespace" => options.trim_trailing_whitespace = boolean(&value),
			"insert_final_newline" => options.insert_final_newline = boolean(&value),
			_ => {},
		}
	}
	options
}

fn positive_u32(value: &str) -> Option<u32> {
	value.parse().ok().filter(|value| *value > 0)
}

fn boolean(value: &str) -> Option<bool> {
	match value {
		"true" => Some(true),
		"false" => Some(false),
		_ => None,
	}
}

/// Resolves EditorConfig over indentation sniffing over the two-space fallback.
pub fn resolve(content: &str, editorconfig: Option<EditorConfigOptions>) -> FormatOptions {
	let sniffed = sniff_indent(content);
	let config = editorconfig.unwrap_or_default();
	let insert_spaces = config.insert_spaces.or(sniffed.1).unwrap_or(true);
	let tab_size = config
		.indent_size
		.or(config.tab_width)
		.or(sniffed.0)
		.unwrap_or(2)
		.clamp(1, 16);
	FormatOptions {
		tab_size,
		insert_spaces,
		trim_trailing_whitespace: config.trim_trailing_whitespace.unwrap_or(true),
		insert_final_newline: config.insert_final_newline.unwrap_or(true),
		trim_final_newlines: true,
	}
}

fn sniff_indent(content: &str) -> (Option<u32>, Option<bool>) {
	let mut gcd = 0_u32;
	let mut style = None;
	for line in content.lines() {
		let bytes = line.as_bytes();
		if bytes.first() == Some(&b'\t') {
			style.get_or_insert(false);
			continue;
		}
		let spaces = bytes.iter().take_while(|byte| **byte == b' ').count() as u32;
		if spaces == 0 || spaces as usize == bytes.len() {
			continue;
		}
		style.get_or_insert(true);
		gcd = if gcd == 0 {
			spaces
		} else {
			greatest_common_divisor(gcd, spaces)
		};
	}
	((gcd > 0).then_some(gcd.clamp(1, 16)), style)
}

const fn greatest_common_divisor(mut left: u32, mut right: u32) -> u32 {
	while right != 0 {
		let remainder = left % right;
		left = right;
		right = remainder;
	}
	left
}

/// Applies resolved whitespace/newline flags after a formatter returns.
pub fn enforce(content: &str, options: FormatOptions) -> Str {
	let mut output = String::with_capacity(content.len().saturating_add(1));
	for segment in content.split_inclusive('\n') {
		let (line, newline) = segment
			.strip_suffix('\n')
			.map_or((segment, ""), |line| (line, "\n"));
		if options.trim_trailing_whitespace {
			output.push_str(line.trim_end_matches([' ', '\t', '\r']));
		} else {
			output.push_str(line);
		}
		output.push_str(newline);
	}
	if options.trim_final_newlines {
		while output.ends_with("\n\n") {
			output.pop();
		}
	}
	if options.insert_final_newline && !output.ends_with('\n') {
		output.push('\n');
	}
	Str::from(output)
}
