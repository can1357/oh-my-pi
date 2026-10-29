//! N-API wrapper for the `pi-mermaid` diagram renderer.

use napi::bindgen_prelude::Error as NapiError;
use napi_derive::napi;
pub use pi_mermaid::*;

/// Theme colors for [`render_mermaid_ascii`]; hex strings, all optional.
#[napi(object)]
#[derive(Debug, Default)]
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
#[derive(Debug, Default)]
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

impl From<MermaidTheme> for ThemeSpec {
	fn from(theme: MermaidTheme) -> Self {
		let MermaidTheme { fg, border, line, arrow, accent, bg, corner, junction } = theme;
		Self { fg, border, line, arrow, accent, bg, corner, junction }
	}
}

impl From<MermaidRenderOptions> for RenderOptionsSpec {
	fn from(options: MermaidRenderOptions) -> Self {
		Self {
			use_ascii:          options.use_ascii,
			padding_x:          options.padding_x,
			padding_y:          options.padding_y,
			box_border_padding: options.box_border_padding,
			direction:          options.direction,
			color_mode:         options.color_mode,
			theme:              options.theme.map(ThemeSpec::from),
		}
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
	let options = RenderOptionsSpec::from(options.unwrap_or_default())
		.resolve()
		.map_err(NapiError::from_reason)?;
	render(&text, &options).map_err(|err| NapiError::from_reason(err.0))
}
