//! Mermaid → ASCII/Unicode renderer.
//!
//! Supported diagram types (output is pinned by `fixtures/mermaid.json`):
//!
//! - Flowcharts (`graph TD` / `flowchart LR`) and state diagrams
//!   (`stateDiagram-v2`): Sugiyama-style layering onto a grid with A* edge
//!   routing ([`flowchart`]).
//! - Sequence diagrams: column-based timeline layout ([`sequence`]).
//! - Class diagrams: level-based UML layout ([`class`]).
//! - ER diagrams: grid layout with crow's-foot notation ([`er`]).
//! - XY charts: bar/line plots ([`xychart`]).
//!
//! # Example
//! ```ignore
//! let art = pi_natives::mermaid::render("graph LR\n  A --> B", &RenderOptions::default())?;
//! ```

use napi::bindgen_prelude::Error as NapiError;
use napi_derive::napi;

pub mod ansi;
pub mod canvas;
pub mod class;
pub mod er;
pub mod flowchart;
pub mod lex;
pub mod sequence;
pub mod text;
pub mod xychart;

pub use ansi::{ColorMode, Theme};
pub use flowchart::Direction;

/// Diagram source that cannot be rendered (empty input, unknown header).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.write_str(&self.0)
	}
}

impl std::error::Error for ParseError {}

/// Rendering options; `Default` matches the TypeScript renderer's defaults.
#[derive(Clone, Debug)]
pub struct RenderOptions {
	/// `+-|>` instead of Unicode box-drawing characters.
	pub use_ascii:          bool,
	/// Horizontal spacing between nodes.
	pub padding_x:          i32,
	/// Vertical spacing between nodes.
	pub padding_y:          i32,
	/// Padding inside node boxes.
	pub box_border_padding: i32,
	/// Force the layout direction of flowcharts and state diagrams,
	/// overriding the direction in the source. Other diagram types ignore it.
	pub direction:          Option<Direction>,
	/// `None` auto-detects from the terminal environment.
	pub color_mode:         Option<ColorMode>,
	pub theme:              Theme,
}

impl Default for RenderOptions {
	fn default() -> Self {
		Self {
			use_ascii:          false,
			padding_x:          5,
			padding_y:          5,
			box_border_padding: 1,
			direction:          None,
			color_mode:         None,
			theme:              Theme::default(),
		}
	}
}

/// Diagram type, detected from the header line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiagramKind {
	Flowchart,
	Sequence,
	Class,
	Er,
	XyChart,
}

/// Detect the diagram type from the first non-blank line of the source.
/// Anything unrecognized is treated as a flowchart (which also covers state
/// diagrams).
pub fn detect_diagram_kind(text: &str) -> DiagramKind {
	let first = text
		.trim()
		.lines()
		.next()
		.unwrap_or("")
		.trim()
		.to_lowercase();
	let starts_with_word = |prefix: &str| {
		first
			.strip_prefix(prefix)
			.is_some_and(|rest| rest.chars().next().is_none_or(|c| !word_char(c)))
	};
	if starts_with_word("xychart-beta") || starts_with_word("xychart") {
		DiagramKind::XyChart
	} else if first == "sequencediagram" {
		DiagramKind::Sequence
	} else if first == "classdiagram" {
		DiagramKind::Class
	} else if first == "erdiagram" {
		DiagramKind::Er
	} else {
		DiagramKind::Flowchart
	}
}

/// JavaScript `\w` as used by the header regex `\b` boundary.
const fn word_char(c: char) -> bool {
	c.is_ascii_alphanumeric() || c == '_'
}

/// Render Mermaid source to a multi-line ASCII/Unicode string, dispatching
/// on the detected diagram type.
///
/// # Errors
/// Flowchart/state sources with an empty body or an unrecognized header.
pub fn render(text: &str, options: &RenderOptions) -> Result<String, ParseError> {
	let config = flowchart::AsciiConfig {
		use_ascii:          options.use_ascii,
		padding_x:          options.padding_x,
		padding_y:          options.padding_y,
		box_border_padding: options.box_border_padding,
		direction:          flowchart::LayoutDirection::TD,
	};
	let mode = options.color_mode.unwrap_or_else(ansi::detect_color_mode);
	let theme = &options.theme;
	Ok(match detect_diagram_kind(text) {
		DiagramKind::XyChart => xychart::render(text, &config, mode, theme),
		DiagramKind::Sequence => sequence::render(text, &config, mode, theme),
		DiagramKind::Class => class::render(text, &config, mode, theme),
		DiagramKind::Er => er::render(text, &config, mode, theme),
		DiagramKind::Flowchart => flowchart::render(text, config, options.direction, mode, theme)?,
	})
}

/// Theme colors for [`render_mermaid_ascii`]; hex strings, all optional.
#[napi(object)]
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MermaidTheme {
	pub fg:       Option<String>,
	pub border:   Option<String>,
	pub line:     Option<String>,
	pub arrow:    Option<String>,
	pub accent:   Option<String>,
	pub bg:       Option<String>,
	pub corner:   Option<String>,
	pub junction: Option<String>,
}

/// Options for [`render_mermaid_ascii`]; every field defaults like the
/// TypeScript renderer (`useAscii: false`, paddings 5, border padding 1,
/// `colorMode: "auto"`).
#[napi(object)]
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MermaidRenderOptions {
	/// `+-|>` instead of Unicode box-drawing characters.
	pub use_ascii:          Option<bool>,
	pub padding_x:          Option<i32>,
	pub padding_y:          Option<i32>,
	pub box_border_padding: Option<i32>,
	/// Force the flowchart/state layout direction.
	#[napi(ts_type = "'TD' | 'TB' | 'LR' | 'BT' | 'RL'")]
	pub direction:          Option<String>,
	/// `auto` (or omitted) detects from the terminal environment.
	#[napi(ts_type = "'none' | 'auto' | 'ansi16' | 'ansi256' | 'truecolor' | 'html'")]
	pub color_mode:         Option<String>,
	pub theme:              Option<MermaidTheme>,
}

impl MermaidRenderOptions {
	fn resolve(self) -> napi::Result<RenderOptions> {
		let defaults = RenderOptions::default();
		let direction = match self.direction.as_deref() {
			None => None,
			Some(token) => Some(
				Direction::parse(token)
					.ok_or_else(|| NapiError::from_reason(format!("unknown direction: {token}")))?,
			),
		};
		let color_mode = match self.color_mode.as_deref() {
			None | Some("auto") => None,
			Some("none") => Some(ColorMode::None),
			Some("ansi16") => Some(ColorMode::Ansi16),
			Some("ansi256") => Some(ColorMode::Ansi256),
			Some("truecolor") => Some(ColorMode::Truecolor),
			Some("html") => Some(ColorMode::Html),
			Some(other) => return Err(NapiError::from_reason(format!("unknown color mode: {other}"))),
		};
		let mut theme = defaults.theme;
		if let Some(overrides) = self.theme {
			let MermaidTheme { fg, border, line, arrow, accent, bg, corner, junction } = overrides;
			theme.fg = fg.unwrap_or(theme.fg);
			theme.border = border.unwrap_or(theme.border);
			theme.line = line.unwrap_or(theme.line);
			theme.arrow = arrow.unwrap_or(theme.arrow);
			theme.accent = accent.or(theme.accent);
			theme.bg = bg.or(theme.bg);
			theme.corner = corner.or(theme.corner);
			theme.junction = junction.or(theme.junction);
		}
		Ok(RenderOptions {
			use_ascii: self.use_ascii.unwrap_or(defaults.use_ascii),
			padding_x: self.padding_x.unwrap_or(defaults.padding_x),
			padding_y: self.padding_y.unwrap_or(defaults.padding_y),
			box_border_padding: self
				.box_border_padding
				.unwrap_or(defaults.box_border_padding),
			direction,
			color_mode,
			theme,
		})
	}
}

/// Render Mermaid diagram text (flowchart, state, sequence, class, ER, or
/// xychart) to ASCII/Unicode art. Synchronous: callers render inside the
/// TUI compositor.
///
/// # Errors
/// Unparseable flowchart source or an unknown `direction`/`colorMode` value.
#[napi]
pub fn render_mermaid_ascii(
	text: String,
	options: Option<MermaidRenderOptions>,
) -> napi::Result<String> {
	let options = options.unwrap_or_default().resolve()?;
	render(&text, &options).map_err(|err| NapiError::from_reason(err.0))
}

#[cfg(test)]
mod tests {
	use std::fmt::Write;

	use super::*;

	#[test]
	fn bundled_edges_stay_aligned_with_mixed_width_borders() {
		let source = "graph TD\nA --> B[Order Service]\nA --> C\nB --> D[[Queue]]\nB --> E\nD --> E";
		let options = RenderOptions { color_mode: Some(ColorMode::None), ..RenderOptions::default() };
		let art = render(source, &options).unwrap();
		assert!(art.contains("Order Service") && art.contains("Queue"), "{art}");
		assert!(!art.contains("│▼"), "arrowhead must align with its incoming line:\n{art}");
		assert!(!art.contains("┬┬"), "shared exits must attach at the same border column:\n{art}");
	}

	/// One case of `fixtures/mermaid.json`: the exact output (or error
	/// message) for a source and option set. Originally captured from the
	/// TypeScript renderer; flowchart layouts have since been re-baselined
	/// after the Sugiyama layering work, so the file is the golden spec of
	/// this module's output rather than TS parity.
	#[derive(serde::Deserialize)]
	struct Fixture {
		name:    String,
		source:  String,
		options: MermaidRenderOptions,
		output:  Option<String>,
		error:   Option<String>,
	}

	fn first_difference(expected: &str, actual: &str) -> String {
		let mut report = String::new();
		for (i, (e, a)) in expected.split('\n').zip(actual.split('\n')).enumerate() {
			if e != a {
				let _ = writeln!(report, "  line {}:\n    expected {e:?}\n    actual   {a:?}", i + 1);
				break;
			}
		}
		let (el, al) = (expected.split('\n').count(), actual.split('\n').count());
		if el != al {
			let _ = writeln!(report, "  line count: expected {el}, actual {al}");
		}
		report
	}

	/// Compare rendered art against the reviewed diagram gallery.
	///
	/// Filter with `MERMAID_FIXTURE=<name substring>`; show changed art with
	/// `MERMAID_DUMP=1`.
	#[test]
	fn matches_golden_fixtures() {
		let path = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/mermaid.json");
		let fixtures: Vec<Fixture> =
			serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
		let filter = std::env::var("MERMAID_FIXTURE").ok();
		let dump = std::env::var_os("MERMAID_DUMP").is_some();
		let mut failures = String::new();
		let mut ran = 0;
		for fixture in fixtures {
			if filter
				.as_ref()
				.is_some_and(|f| !fixture.name.contains(f.as_str()))
			{
				continue;
			}
			ran += 1;
			let options = fixture.options.resolve().unwrap();
			let actual = render(&fixture.source, &options);
			match (&fixture.output, &fixture.error, actual) {
				(Some(expected), _, Ok(actual)) if *expected == actual => {},
				(Some(expected), _, Ok(actual)) => {
					let _ = write!(
						failures,
						"[{}] output differs\n{}",
						fixture.name,
						first_difference(expected, &actual)
					);
					if dump {
						let _ = writeln!(failures, "--- expected\n{expected}\n--- actual\n{actual}\n---");
					}
				},
				(Some(_), _, Err(err)) => {
					let _ = writeln!(failures, "[{}] unexpected error: {err}", fixture.name);
				},
				(None, Some(expected), Err(err)) if *expected == err.0 => {},
				(None, Some(expected), Err(err)) => {
					let _ = writeln!(
						failures,
						"[{}] error differs\n  expected {expected:?}\n  actual   {:?}",
						fixture.name, err.0
					);
				},
				(None, Some(expected), Ok(_)) => {
					let _ = writeln!(failures, "[{}] expected error {expected:?}", fixture.name);
				},
				(None, None, _) => unreachable!("fixture without output or error"),
			}
		}
		assert!(ran > 0, "no fixtures matched");
		assert!(failures.is_empty(), "{ran} fixtures\n{failures}");
	}
}
